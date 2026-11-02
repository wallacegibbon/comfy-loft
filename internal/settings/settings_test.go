package settings

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func openTestStore(t *testing.T) *Store {
	t.Helper()
	store, err := New(t.TempDir())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return store
}

func TestReadIsAnEmptyObjectBeforeAnythingIsSaved(t *testing.T) {
	store := openTestStore(t)

	raw, err := store.Read()
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if string(raw) != "{}" {
		t.Errorf("raw = %s, want {}", raw)
	}
	if _, err := os.Stat(store.Path()); !os.IsNotExist(err) {
		t.Errorf("Read created the file: %v", err)
	}
}

func TestWriteThenReadRoundTripsTheBytes(t *testing.T) {
	store := openTestStore(t)
	document := `{"theme":{"theme":"light"},"locale":"en-US","panel":{"width":320}}`

	if err := store.Write([]byte(document)); err != nil {
		t.Fatalf("Write: %v", err)
	}
	raw, err := store.Read()
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if string(raw) != document {
		t.Errorf("raw = %s, want the bytes as written", raw)
	}
}

func TestWriteReplacesRatherThanMerges(t *testing.T) {
	store := openTestStore(t)
	if err := store.Write([]byte(`{"a":1,"b":2}`)); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if err := store.Write([]byte(`{"b":3}`)); err != nil {
		t.Fatalf("Write: %v", err)
	}

	var document map[string]any
	raw, err := store.Read()
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if err := json.Unmarshal(raw, &document); err != nil {
		t.Fatal(err)
	}
	if _, present := document["a"]; present {
		t.Errorf("the previous document was merged into the new one: %v", document)
	}
	if document["b"] != float64(3) {
		t.Errorf("b = %v", document["b"])
	}
}

func TestOnlyAnObjectIsAccepted(t *testing.T) {
	store := openTestStore(t)

	for name, document := range map[string]string{
		"array":     `[1,2,3]`,
		"string":    `"hello"`,
		"number":    `12`,
		"truncated": `{"theme":`,
		"empty":     ``,
	} {
		if err := store.Write([]byte(document)); err == nil {
			t.Errorf("%s was accepted", name)
		}
	}
	if _, err := os.Stat(store.Path()); !os.IsNotExist(err) {
		t.Errorf("a rejected write created the file: %v", err)
	}
}

func TestAnOversizedDocumentIsRejected(t *testing.T) {
	store := openTestStore(t)

	huge := make([]byte, MaxBytes+1)
	huge[0] = '{'
	if err := store.Write(huge); err == nil {
		t.Fatal("an oversized document was accepted")
	}
}

func TestAnUnreadableFileIsReportedRatherThanTreatedAsEmpty(t *testing.T) {
	store := openTestStore(t)
	if err := os.WriteFile(store.Path(), []byte("{oh no"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Read(); err == nil {
		t.Error("a corrupt settings file was read as empty")
	} else if !strings.Contains(err.Error(), "settings") {
		t.Errorf("err = %v", err)
	}
}

func TestWriteLeavesNoTemporaryFilesBehind(t *testing.T) {
	store := openTestStore(t)
	if err := store.Write([]byte(`{"a":1}`)); err != nil {
		t.Fatalf("Write: %v", err)
	}

	entries, err := os.ReadDir(filepath.Dir(store.Path()))
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".tmp") {
			t.Errorf("a temporary file survived the write: %s", entry.Name())
		}
	}
}

func TestNewRejectsAnEmptyDirectoryAndCreatesTheOneItIsGiven(t *testing.T) {
	if _, err := New(""); err == nil {
		t.Error("New accepted an empty directory")
	}
	dir := filepath.Join(t.TempDir(), "nested")
	store, err := New(dir)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		t.Errorf("the data directory was not created: %v", err)
	}
	if store.Path() != filepath.Join(dir, fileName) {
		t.Errorf("path = %s", store.Path())
	}
}
