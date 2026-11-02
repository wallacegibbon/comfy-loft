package server

// Where a canvas's agent conversation lives.
//
// A conversation is part of the canvas that owns it, so it is kept inside the canvas directory (#178).
// That is the whole of the rule, and it is what makes deleting a canvas enough: the directory goes, and
// the conversation goes with it.
//
// The session name is still the client's. The canvas panel names its session `canvas:<id>` (the one place
// on the other side of this contract is `canvasAgent` in `frontend/src/services/api/agent.ts`), and that
// prefix is all this file reads about a name. A name that is not a canvas keeps nothing: a node's panel
// asks one question at a time and writes the answer into the node, so a conversation file there would
// carry an earlier question into the next answer and leave one file per node on disk.

import (
	"fmt"
	"strings"
)

// canvasSessionPrefix is how a canvas panel names its session: the canvas it belongs to.
const canvasSessionPrefix = "canvas:"

// sessionFile is where a conversation is kept: inside the canvas that owns it.
func (s *Server) sessionFile(session string) (string, error) {
	id, ok := strings.CutPrefix(session, canvasSessionPrefix)
	if !ok {
		return "", fmt.Errorf("agent: %q is not a canvas, so it keeps no conversation", session)
	}
	return s.canvases.SessionPath(id)
}
