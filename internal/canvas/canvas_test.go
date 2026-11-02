package canvas

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// openTestStore is a store in a temporary directory with a clock that advances a second per read,
// so list ordering is decided by the test rather than by how fast the machine is.
func openTestStore(t *testing.T) *Store {
	t.Helper()
	store, err := New(t.TempDir())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	clock := time.Date(2026, 3, 1, 9, 0, 0, 0, time.UTC)
	store.now = func() time.Time {
		clock = clock.Add(time.Second)
		return clock
	}
	return store
}

func mustCreate(t *testing.T, store *Store, title string) Summary {
	t.Helper()
	summary, err := store.Create(title, nil)
	if err != nil {
		t.Fatalf("Create(%q): %v", title, err)
	}
	return summary
}

func TestCreateWritesTheWholeLayout(t *testing.T) {
	store := openTestStore(t)

	summary := mustCreate(t, store, "  A canvas  ")
	if !ValidID(summary.ID) {
		t.Fatalf("id %q is not the shape this store hands out", summary.ID)
	}
	if summary.Title != "A canvas" {
		t.Errorf("title = %q, want it trimmed", summary.Title)
	}
	if summary.Rev == "" {
		t.Error("a new canvas has no rev")
	}
	if summary.Bytes != int64(len(emptyDocument)) {
		t.Errorf("bytes = %d, want %d", summary.Bytes, len(emptyDocument))
	}

	for _, name := range []string{DocumentName, metaName, FilesName} {
		if _, err := os.Stat(filepath.Join(store.Root(), summary.ID, name)); err != nil {
			t.Errorf("%s missing: %v", name, err)
		}
	}

	loaded, err := store.Read(summary.ID)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if string(loaded.Document) != emptyDocument {
		t.Errorf("document = %s, want %s", loaded.Document, emptyDocument)
	}
	if loaded.Rev != summary.Rev || loaded.Title != summary.Title {
		t.Errorf("read back %+v, created %+v", loaded.Summary, summary)
	}
}

func TestCreateKeepsTheDocumentItWasGiven(t *testing.T) {
	store := openTestStore(t)

	document := []byte(`{"nodes":[{"id":"n1","type":"text"}],"viewport":{"x":1,"y":2,"k":0.5}}`)
	summary, err := store.Create("with nodes", document)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	loaded, err := store.Read(summary.ID)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if string(loaded.Document) != string(document) {
		t.Errorf("document = %s, want the bytes as written", loaded.Document)
	}
}

func TestListIsNewestFirstAndSkipsThingsThatAreNotCanvases(t *testing.T) {
	store := openTestStore(t)

	first := mustCreate(t, store, "first")
	second := mustCreate(t, store, "second")

	// A stray directory, a directory with no meta, and a file: none of them is a canvas.
	if err := os.Mkdir(filepath.Join(store.Root(), "deadbeefcafe"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(store.Root(), ".trash"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(store.Root(), "notes.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Writing the first canvas again is what makes it newest.
	if _, err := store.Write(first.ID, first.Rev, nil, []byte(`{"nodes":[]}`)); err != nil {
		t.Fatalf("Write: %v", err)
	}

	summaries, err := store.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(summaries) != 2 {
		t.Fatalf("List returned %d canvases, want 2: %+v", len(summaries), summaries)
	}
	if summaries[0].ID != first.ID || summaries[1].ID != second.ID {
		t.Errorf("order = %s, %s; want the just-written canvas first", summaries[0].ID, summaries[1].ID)
	}
}

func TestWriteBumpsTheRevAndLeavesTheTitleAlone(t *testing.T) {
	store := openTestStore(t)

	created := mustCreate(t, store, "keep me")
	written, err := store.Write(created.ID, created.Rev, nil, []byte(`{"nodes":[1]}`))
	if err != nil {
		t.Fatalf("Write: %v", err)
	}
	if written.Rev == created.Rev {
		t.Error("rev did not change")
	}
	if written.Title != "keep me" {
		t.Errorf("title = %q, want it untouched", written.Title)
	}
	if !written.UpdatedAt.After(created.UpdatedAt) {
		t.Errorf("updatedAt = %v, want it later than %v", written.UpdatedAt, created.UpdatedAt)
	}
	if written.Bytes != int64(len(`{"nodes":[1]}`)) {
		t.Errorf("bytes = %d", written.Bytes)
	}

	renamed, err := store.Write(created.ID, written.Rev, ptr("  renamed  "), []byte(`{"nodes":[1]}`))
	if err != nil {
		t.Fatalf("Write with title: %v", err)
	}
	if renamed.Title != "renamed" {
		t.Errorf("title = %q, want it renamed and trimmed", renamed.Title)
	}
}

func TestWriteWithAStaleRevIsRefusedAndChangesNothing(t *testing.T) {
	store := openTestStore(t)

	created := mustCreate(t, store, "shared")
	current, err := store.Write(created.ID, created.Rev, nil, []byte(`{"winner":true}`))
	if err != nil {
		t.Fatalf("Write: %v", err)
	}

	_, err = store.Write(created.ID, created.Rev, nil, []byte(`{"loser":true}`))
	var conflict *ConflictError
	if !errors.As(err, &conflict) {
		t.Fatalf("err = %v, want a ConflictError", err)
	}
	if conflict.Current.Rev != current.Rev {
		t.Errorf("conflict carries rev %q, want the current %q", conflict.Current.Rev, current.Rev)
	}

	loaded, err := store.Read(created.ID)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if string(loaded.Document) != `{"winner":true}` {
		t.Errorf("document = %s, want the refused write not to have landed", loaded.Document)
	}
}

func TestWriteWithoutARevIsAllowed(t *testing.T) {
	store := openTestStore(t)

	created := mustCreate(t, store, "no rev")
	if _, err := store.Write(created.ID, "", nil, []byte(`{"forced":true}`)); err != nil {
		t.Fatalf("Write with an empty rev: %v", err)
	}
}

// Two saves against one rev: exactly one may win, and the other has to hear that it lost.
//
// The check and the write are one step (Store.writeMu). Without that, both saves read the same rev, both
// pass the check, and the later rename silently replaces the earlier document — a lost edit that no client
// is ever told about. The count is what makes this fail rather than the flakiness of the interleaving.
func TestTwoSavesAgainstOneRevHaveExactlyOneWinner(t *testing.T) {
	store := openTestStore(t)
	created := mustCreate(t, store, "contended")

	const writers = 8
	var (
		wait    sync.WaitGroup
		lock    sync.Mutex
		wins    int
		conflic int
		other   []error
	)
	start := make(chan struct{})
	for index := 0; index < writers; index++ {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			<-start
			document := []byte(fmt.Sprintf(`{"writer":%d}`, index))
			_, err := store.Write(created.ID, created.Rev, nil, document)
			lock.Lock()
			defer lock.Unlock()
			var conflict *ConflictError
			switch {
			case err == nil:
				wins++
			case errors.As(err, &conflict):
				conflic++
			default:
				other = append(other, err)
			}
		}(index)
	}
	close(start)
	wait.Wait()

	if len(other) > 0 {
		t.Fatalf("unexpected failures: %v", other)
	}
	if wins != 1 {
		t.Errorf("%d saves won, want exactly one", wins)
	}
	if conflic != writers-1 {
		t.Errorf("%d conflicts, want %d", conflic, writers-1)
	}

	// What landed is the winner's document, and it is a whole one.
	loaded, err := store.Read(created.ID)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	var decoded struct {
		Writer *int `json:"writer"`
	}
	if err := json.Unmarshal(loaded.Document, &decoded); err != nil || decoded.Writer == nil {
		t.Fatalf("document = %s (%v), want one writer's object", loaded.Document, err)
	}
}

func TestIdsThatAreNotOursAreRefusedBeforeAnyPathIsBuilt(t *testing.T) {
	store := openTestStore(t)

	outside := filepath.Join(filepath.Dir(store.Root()), "outside.json")
	if err := os.WriteFile(outside, []byte(`{}`), 0o644); err != nil {
		t.Fatal(err)
	}

	for _, id := range []string{"../outside", "../../etc/passwd", "", "ABC", strings.Repeat("a", 12) + "b", "abcdefabcdef\n"} {
		if _, err := store.Read(id); !errors.Is(err, ErrInvalidID) {
			t.Errorf("Read(%q) = %v, want ErrInvalidID", id, err)
		}
		if err := store.Delete(id); !errors.Is(err, ErrInvalidID) {
			t.Errorf("Delete(%q) = %v, want ErrInvalidID", id, err)
		}
	}
}

func TestADocumentMustBeAnObject(t *testing.T) {
	store := openTestStore(t)
	created := mustCreate(t, store, "shape")

	for name, document := range map[string]string{
		"array":     `[1,2,3]`,
		"string":    `"hello"`,
		"truncated": `{"nodes":`,
		"empty":     `{}`[:0],
	} {
		if _, err := store.Write(created.ID, created.Rev, nil, []byte(document)); !errors.Is(err, ErrInvalidDocument) {
			t.Errorf("%s: err = %v, want ErrInvalidDocument", name, err)
		}
	}

	// The refused writes must not have touched the document.
	loaded, err := store.Read(created.ID)
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if string(loaded.Document) != emptyDocument {
		t.Errorf("document = %s, want it unchanged", loaded.Document)
	}
}

func TestAnOversizedDocumentIsRefused(t *testing.T) {
	store := openTestStore(t)
	created := mustCreate(t, store, "big")

	huge := make([]byte, MaxDocumentBytes+1)
	huge[0] = '{'
	if _, err := store.Write(created.ID, created.Rev, nil, huge); !errors.Is(err, ErrInvalidDocument) {
		t.Fatalf("err = %v, want ErrInvalidDocument", err)
	}
}

func TestDeleteRemovesTheDirectoryAndTheSecondOneIsNotFound(t *testing.T) {
	store := openTestStore(t)
	created := mustCreate(t, store, "gone")

	if _, err := store.FilesPath(created.ID); err != nil {
		t.Fatalf("FilesPath: %v", err)
	}
	if err := os.WriteFile(filepath.Join(store.Root(), created.ID, FilesName, "a.png"), []byte("png"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := store.Delete(created.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := os.Stat(filepath.Join(store.Root(), created.ID)); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("directory survived the delete: %v", err)
	}
	if err := store.Delete(created.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("second Delete = %v, want ErrNotFound", err)
	}
	if _, err := store.Read(created.ID); !errors.Is(err, ErrNotFound) {
		t.Errorf("Read after delete = %v, want ErrNotFound", err)
	}
}

func TestFilesPathCreatesTheDirectoryAndNeedsACanvas(t *testing.T) {
	store := openTestStore(t)
	created := mustCreate(t, store, "has files")

	dir, err := store.FilesPath(created.ID)
	if err != nil {
		t.Fatalf("FilesPath: %v", err)
	}
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		t.Fatalf("FilesPath returned %s, which is not a directory: %v", dir, err)
	}
	if _, err := store.FilesPath("0123456789ab"); !errors.Is(err, ErrNotFound) {
		t.Errorf("FilesPath for an unknown canvas = %v, want ErrNotFound", err)
	}
}

func TestWriteLeavesNoTemporaryFilesBehind(t *testing.T) {
	store := openTestStore(t)
	created := mustCreate(t, store, "tidy")

	if _, err := store.Write(created.ID, created.Rev, nil, []byte(`{"nodes":[]}`)); err != nil {
		t.Fatalf("Write: %v", err)
	}
	entries, err := os.ReadDir(filepath.Join(store.Root(), created.ID))
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".tmp") {
			t.Errorf("a temporary file survived the write: %s", entry.Name())
		}
	}
}

func TestMetaMustBelongToItsDirectory(t *testing.T) {
	store := openTestStore(t)
	created := mustCreate(t, store, "mine")

	foreign, err := json.Marshal(meta{ID: "0123456789ab", Title: "theirs", Rev: "r"})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(store.Root(), created.ID, metaName), foreign, 0o644); err != nil {
		t.Fatal(err)
	}

	if _, err := store.Read(created.ID); err == nil || !strings.Contains(err.Error(), "holds a meta for") {
		t.Errorf("Read = %v, want a complaint about the borrowed meta", err)
	}
}

func TestAnUnreadableMetaIsSkippedByListButReportedByRead(t *testing.T) {
	store := openTestStore(t)
	created := mustCreate(t, store, "broken")

	if err := os.WriteFile(filepath.Join(store.Root(), created.ID, metaName), []byte("{oh no"), 0o644); err != nil {
		t.Fatal(err)
	}

	summaries, err := store.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(summaries) != 0 {
		t.Errorf("List reported %d canvases, want the broken one skipped", len(summaries))
	}
	if _, err := store.Read(created.ID); err == nil {
		t.Error("Read of a broken canvas returned no error")
	}
}

func TestNewRejectsAnEmptyRootAndCreatesTheDirectory(t *testing.T) {
	if _, err := New("   "); err == nil {
		t.Error("New accepted an empty root")
	}
	root := filepath.Join(t.TempDir(), "nested", "canvases")
	store, err := New(root)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if info, err := os.Stat(store.Root()); err != nil || !info.IsDir() {
		t.Errorf("root was not created: %v", err)
	}
}

func ptr(value string) *string { return &value }

// TestSessionPathIsInsideTheCanvas: the agent's conversation is part of the canvas it belongs to, so it
// is a file in the canvas directory and there is nothing to clean up when the canvas goes (#178).
func TestSessionPathIsInsideTheCanvas(t *testing.T) {
	store := openTestStore(t)
	summary := mustCreate(t, store, "Talked to")

	path, err := store.SessionPath(summary.ID)
	if err != nil {
		t.Fatalf("SessionPath: %v", err)
	}
	if want := filepath.Join(store.Root(), summary.ID, AgentSessionName); path != want {
		t.Fatalf("SessionPath = %q, want %q", path, want)
	}
	// The path is not a file until the agent has something to say.
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("SessionPath created the file: %v", err)
	}

	// A canvas that does not exist has no conversation, and asking for one does not make a directory.
	absent := "0123456789ab"
	if _, err := store.SessionPath(absent); !errors.Is(err, ErrNotFound) {
		t.Fatalf("SessionPath(%q) = %v, want ErrNotFound", absent, err)
	}
	if _, err := store.SessionPath("../x"); !errors.Is(err, ErrInvalidID) {
		t.Fatalf("SessionPath(../x) = %v, want ErrInvalidID", err)
	}
	if _, err := os.Stat(filepath.Join(store.Root(), absent)); !os.IsNotExist(err) {
		t.Fatalf("a path for a missing canvas made a directory: %v", err)
	}

	// And it goes with the canvas, because it is inside it.
	if err := os.WriteFile(path, []byte("a conversation"), 0o644); err != nil {
		t.Fatalf("write the conversation: %v", err)
	}
	if err := store.Delete(summary.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("the conversation outlived its canvas: %v", err)
	}
}
