package server

// Where a canvas's agent conversation lives.
//
// A conversation is part of the canvas that owns it, so it is kept inside the canvas directory (#178).
// That is the whole of the rule, and it is what makes deleting a canvas enough: the directory goes, and
// the conversation goes with it.
//
// The session name is still the client's. The canvas panel names its session `canvas:<id>` (the one place
// on the other side of this contract is `canvasAgent` in `frontend/src/services/api/agent.ts`), and that
// prefix is all this file reads about a name. A name that is not a canvas keeps nothing: the models editor
// is a session that lives while its window is open and is asked one command, so a file for it would be a
// conversation nobody can come back to.

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
