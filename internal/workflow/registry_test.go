package workflow

import (
	"io"
	"os"
	"path/filepath"
	"testing"

	"comfyloft/internal/logx"
)

// A graph the loader accepts: API format, one save node, so InferType sees an image.
func writeGraph(t *testing.T, dir, name string) {
	t.Helper()
	graph := `{
  "1": {"class_type": "KSampler", "inputs": {"seed": 1}},
  "2": {"class_type": "SaveImage", "inputs": {"images": ["1", 0]}}
}`
	if err := os.WriteFile(filepath.Join(dir, name), []byte(graph), 0o644); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
}

// An id is the identity of a workflow. Two rows claiming one must not silently make the last row win and
// the same workflow appear twice in the list — that is a hand-edited registry.json being half-honoured.
func TestDuplicateRegistryIDsKeepTheFirstAndWarn(t *testing.T) {
	dir := t.TempDir()
	writeGraph(t, dir, "image-first.json")
	writeGraph(t, dir, "image-second.json")
	registry := `{
  "version": 1,
  "workflows": [
    {"id": "dup", "name": "image-first", "type": "image", "file": "image-first.json"},
    {"id": "dup", "name": "image-second", "type": "image", "file": "image-second.json"}
  ]
}`
	if err := os.WriteFile(filepath.Join(dir, "registry.json"), []byte(registry), 0o644); err != nil {
		t.Fatalf("write registry: %v", err)
	}

	loaded := NewRegistry(RegistryOptions{Dir: dir, Logger: logx.NewWithWriter("test", io.Discard)})
	if err := loaded.Load(); err != nil {
		t.Fatalf("load: %v", err)
	}
	if got := loaded.Len(); got != 1 {
		t.Errorf("Len = %d, want 1: one id is one workflow", got)
	}
	entry := loaded.Resolve("dup")
	if entry == nil {
		t.Fatal("the id resolved to nothing")
	}
	if entry.File != "image-first.json" {
		t.Errorf("File = %q, want the first row to win", entry.File)
	}
	if list := loaded.List(); len(list) != 1 {
		t.Errorf("List = %d rows, want 1", len(list))
	}
}
