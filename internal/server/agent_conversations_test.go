package server

import (
	"strings"
	"testing"

	"comfyloft/internal/canvas"
	"comfyloft/internal/config"
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

// TestTheNameDecidesWhetherTheConversationIsKept: which of the two a name is decided here, from the name
// alone — not by a flag on the socket, which is what `?history=1` used to be. A canvas is spawned with the
// file its conversation lives in; the models editor is spawned with none, which is the same as saying
// nothing is written, because AlayaCore only writes what is said.
func TestTheNameDecidesWhetherTheConversationIsKept(t *testing.T) {
	server := &Server{canvases: mustCanvasStore(t), cfg: &config.Config{}}
	summary, err := server.canvases.Create("Talked to", nil)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	kept, err := server.agentOptionsFor("canvas:" + summary.ID)
	if err != nil {
		t.Fatalf("agentOptionsFor a canvas: %v", err)
	}
	if !strings.HasSuffix(kept.Session, summary.ID+"/"+canvas.AgentSessionName) {
		t.Fatalf("a canvas was spawned with %q, want a file in its own directory", kept.Session)
	}

	// The models editor: no canvas, so nowhere to keep anything — and that is not an error, it is the answer.
	dropped, err := server.agentOptionsFor("settings")
	if err != nil {
		t.Fatalf("agentOptionsFor a name that is not a canvas: %v", err)
	}
	if dropped.Session != "" {
		t.Fatalf("a session that is not a canvas was spawned with %q, want no file", dropped.Session)
	}
	// A canvas whose directory cannot be resolved is still a failure: that is a broken canvas, not a name
	// that meant nothing by asking.
	if _, err := server.agentOptionsFor("canvas:0123456789ab"); err == nil {
		t.Fatal("a missing canvas was spawned without complaint")
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
