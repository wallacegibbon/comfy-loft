package canvas

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestDocumentReferencesFindsOnlyFileNames(t *testing.T) {
	document := []byte(`{"nodes":[
		{"id":"n1","metadata":{"storageKey":"files/up-a1b2c3d4.png"}},
		{"id":"n2","metadata":{"storageKey":"files/gen-77.webp","preview":"files/gen-77.webp"}},
		{"id":"n3","metadata":{"content":"text with files/words.txt inside it"}}
	]}`)

	names := DocumentReferences(document)
	want := []string{"gen-77.webp", "up-a1b2c3d4.png", "words.txt"}
	if len(names) != len(want) {
		t.Fatalf("names = %v, want %v", names, want)
	}
	for i := range want {
		if names[i] != want[i] {
			t.Errorf("names[%d] = %q, want %q", i, names[i], want[i])
		}
	}
}

func TestDocumentReferencesIgnoresWhatCannotBeAFileName(t *testing.T) {
	// A traversal attempt and an empty name are not references. A path with a slash yields only its
	// first segment (`files/sub/dir.png` reads as `sub`), which protects a file that does not exist and
	// therefore cannot delete one that does — the direction a collector must always err in.
	document := []byte(`{"a":"files/../etc/passwd","b":"files/","c":"files/"}`)
	if names := DocumentReferences(document); len(names) != 0 {
		t.Errorf("names = %v, want none", names)
	}
}

func TestSweepKeepsReferencesAndYoungFilesAndDeletesTheRest(t *testing.T) {
	store := openTestStore(t)
	created := mustCreate(t, store, "sweepable")
	dir, err := store.FilesPath(created.ID)
	if err != nil {
		t.Fatalf("FilesPath: %v", err)
	}

	// Ages are measured against the store's own clock, which the test controls.
	now := store.now()
	write := func(name string, age time.Duration) {
		t.Helper()
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte("bytes"), 0o644); err != nil {
			t.Fatal(err)
		}
		stamp := now.Add(-age)
		if err := os.Chtimes(path, stamp, stamp); err != nil {
			t.Fatal(err)
		}
	}

	write("referenced.png", 48*time.Hour)
	write("from-a-run.png", 48*time.Hour)
	write("unreferenced.png", 48*time.Hour)
	write("fresh.png", time.Minute)

	document := []byte(`{"nodes":[{"metadata":{"storageKey":"files/referenced.png"}}]}`)
	if _, err := store.Write(created.ID, created.Rev, nil, document); err != nil {
		t.Fatalf("Write: %v", err)
	}

	result, err := store.Sweep(created.ID, []string{"from-a-run.png"}, 24*time.Hour)
	if err != nil {
		t.Fatalf("Sweep: %v", err)
	}
	if len(result.Removed) != 1 || result.Removed[0] != "unreferenced.png" {
		t.Errorf("removed = %v, want [unreferenced.png]", result.Removed)
	}
	if len(result.Kept) != 1 || result.Kept[0] != "fresh.png" {
		t.Errorf("kept = %v, want [fresh.png]", result.Kept)
	}

	for name, want := range map[string]bool{"referenced.png": true, "from-a-run.png": true, "fresh.png": true, "unreferenced.png": false} {
		_, err := os.Stat(filepath.Join(dir, name))
		if present := err == nil; present != want {
			t.Errorf("%s present = %v, want %v", name, present, want)
		}
	}
}

func TestFilePathRefusesNamesThatCouldLeaveTheDirectory(t *testing.T) {
	store := openTestStore(t)
	created := mustCreate(t, store, "paths")

	for _, name := range []string{"../outside.png", "sub/dir.png", ".hidden", "", "a b.png"} {
		if _, err := store.FilePath(created.ID, name); err == nil {
			t.Errorf("FilePath(%q) was accepted", name)
		}
	}
	path, err := store.FilePath(created.ID, "up-a1b2c3d4.png")
	if err != nil {
		t.Fatalf("FilePath: %v", err)
	}
	if filepath.Dir(path) != filepath.Join(store.Root(), created.ID, filesName) {
		t.Errorf("path = %s", path)
	}
}

func TestSweepOfAMissingCanvasIsNotFound(t *testing.T) {
	store := openTestStore(t)
	if _, err := store.Sweep("0123456789ab", nil, time.Hour); err == nil {
		t.Error("Sweep of an unknown canvas returned no error")
	}
}
