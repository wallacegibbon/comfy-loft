package server

import (
	"strings"
	"testing"

	"comfyloft/internal/canvas"
)

// TestSessionFileIsTheCanvasesOwn: a conversation is a file inside the canvas it belongs to, and a name
// that is not a canvas has none — so there is nothing to keep and nothing to clean up (#178).
func TestSessionFileIsTheCanvasesOwn(t *testing.T) {
	server := &Server{canvases: mustCanvasStore(t)}
	summary, err := server.canvases.Create("Talked to", nil)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	path, err := server.sessionFile("canvas:" + summary.ID)
	if err != nil {
		t.Fatalf("sessionFile: %v", err)
	}
	if !strings.HasSuffix(path, summary.ID+"/"+canvas.AgentSessionName) {
		t.Fatalf("sessionFile = %q, want the canvas's own %s", path, canvas.AgentSessionName)
	}

	// A session that is not a canvas has nowhere to keep one, and that is not a failure: it is the answer.
	if file, err := server.sessionFile("settings"); err == nil {
		t.Fatalf("a session that is not a canvas has a conversation file: %s", file)
	}
	// And a canvas that does not exist has no conversation, rather than a directory made for one.
	if file, err := server.sessionFile("canvas:0123456789ab"); err == nil {
		t.Fatalf("a missing canvas has a conversation file: %s", file)
	}
}

func mustCanvasStore(t *testing.T) *canvas.Store {
	t.Helper()
	store, err := canvas.New(t.TempDir())
	if err != nil {
		t.Fatalf("canvas.New: %v", err)
	}
	return store
}
