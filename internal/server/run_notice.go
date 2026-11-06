package server

// Telling an agent what became of the work it asked for.
//
// `generate` answers at once — a picture takes minutes, and a tool call is not a progress bar — so the
// agent's turn can end with a run still going, and nothing in the conversation says otherwise. When the
// run ends, the agent is told, as a message from the user: it goes in through the same door as anything
// typed into the panel, AlayaCore echoes it, and the panel draws it like any other message (#225).
//
// The pairing is on the run record, not in a page's memory, because the run is the thing that finishes
// and the server is what finishes it: a reloaded tab, another tab, or a canvas reopened while a video
// renders all find the same record and the same answer to "who is waiting to hear about this".

import (
	"fmt"
	"strings"

	"comfyloft/internal/httpx"
	"comfyloft/internal/task"
)

// askedBy is the agent waiting to be told how this run went, read off the request body.
//
// It is the page saying which conversation asked — the session that called `generate`, and the node it
// asked about — because only the page knows both: the tool call is answered by the tab that runs it, and
// that tab starts the run with the same function the user's own button presses. A body that names no
// session is a run the user started, and nobody has to be told about their own button.
func askedBy(body map[string]any) *task.Ask {
	asked := httpx.Object(body, "askedBy")
	if asked == nil {
		return nil
	}
	session := strings.TrimSpace(httpx.String(asked, "session"))
	if session == "" {
		return nil
	}
	return &task.Ask{Session: session, Node: strings.TrimSpace(httpx.String(asked, "node"))}
}

// onRunFinished tells the agent that asked for a run how it went.
//
// It runs once per run, off the queue's worker (see task.Store.SetOnFinish). A session that is no longer
// open is not an error worth raising: its panel was closed and the agent went with it, and the result is
// on the node for whoever comes back. What it is not is the end of the conversation's side of it — the
// notice stays owed, and `flushRunNotices` pays it when that session is next open (docs/decisions.md #285).
func (s *Server) onRunFinished(stored *task.Task) {
	if stored == nil || stored.Ask == nil || stored.Ask.Session == "" {
		return
	}
	if err := s.agentSessions.Tell(stored.Ask.Session, runNotice(stored)); err != nil {
		if s.logger != nil {
			s.logger.Info("agent: run %s ended with nobody to tell (%s: %s), and the notice is owed", stored.ID, stored.Ask.Session, err)
		}
		return
	}
	s.tasks.MarkNotified(stored.ID)
	if s.logger != nil {
		s.logger.Info("agent: told %s that run %s %s", stored.Ask.Session, stored.ID, stored.Status)
	}
}

// flushRunNotices pays the notices one session is owed.
//
// Called when a conversation opens: the runs that ended while its panel was closed, while the server was
// restarting, or while its agent process was gone are all the same debt, and this is the first moment any
// of them can be paid. Oldest first, so a turn that asked for three pictures hears about them in the order
// it asked.
func (s *Server) flushRunNotices(session string) {
	for _, stored := range s.tasks.OwedTo(session) {
		if err := s.agentSessions.Tell(session, runNotice(stored)); err != nil {
			if s.logger != nil {
				s.logger.Info("agent: run %s is still owed to %s (%s)", stored.ID, session, err)
			}
			// The session answered nothing for this one, so it will answer nothing for the rest either.
			return
		}
		s.tasks.MarkNotified(stored.ID)
		if s.logger != nil {
			s.logger.Info("agent: told %s, late, that run %s %s", session, stored.ID, stored.Status)
		}
	}
}

// runNotice is what an agent is told when a run it asked for ends.
//
// It names the node the agent pressed, because that is the handle it used and the one thing it can act on;
// it says what happened, because "finished" and "failed" are different instructions; and it points at the
// result rather than pasting it, because a picture through this socket is megabytes and the file is
// already in the canvas. It does not say the node *holds* the result: pressing a config or a text node's
// button makes a node beside it and fills that one, so "in the canvas" is the claim that is always true.
func runNotice(stored *task.Task) string {
	what := "the " + stored.Object + " generation"
	if node := stored.Ask.Node; node != "" {
		what += " on " + node
	}
	switch stored.Status {
	case "completed":
		return fmt.Sprintf("[comfyloft] %s you asked for has finished: %s, written into the canvas. canvas_read_media it if you need to look at it, then carry on.", what, producedFiles(len(stored.Outputs)))
	case "cancelled":
		return fmt.Sprintf("[comfyloft] %s you asked for was cancelled; nothing was produced.", what)
	default:
		reason := "the server did not say why"
		if stored.Error != nil && strings.TrimSpace(*stored.Error) != "" {
			reason = strings.TrimSpace(*stored.Error)
		}
		return fmt.Sprintf("[comfyloft] %s you asked for failed: %s.", what, reason)
	}
}

// producedFiles is how many artifacts a finished run wrote, in words: one run, one sentence.
func producedFiles(count int) string {
	switch count {
	case 0:
		return "no file was written"
	case 1:
		return "1 file"
	default:
		return fmt.Sprintf("%d files", count)
	}
}
