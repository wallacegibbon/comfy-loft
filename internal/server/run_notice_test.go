package server

import (
	"strings"
	"testing"

	"comfyloft/internal/task"
)

// The request says who is waiting to hear about a run, and a page that does not say leaves nobody to
// tell — a run the user started is not news to the agent that did not start it (#225).
func TestAskedByReadsTheRequest(t *testing.T) {
	cases := []struct {
		name string
		body map[string]any
		want *task.Ask
	}{
		{"a run the user started", map[string]any{"workflow": "flux"}, nil},
		{"no session named", map[string]any{"askedBy": map[string]any{"node": "n1"}}, nil},
		{"a blank session", map[string]any{"askedBy": map[string]any{"session": "  "}}, nil},
		{"not an object at all", map[string]any{"askedBy": "canvas:abc"}, nil},
		{"an asker with a node", map[string]any{"askedBy": map[string]any{"session": "canvas:abc", "node": "n1"}}, &task.Ask{Session: "canvas:abc", Node: "n1"}},
		{"an asker with no node", map[string]any{"askedBy": map[string]any{"session": "node:n1"}}, &task.Ask{Session: "node:n1"}},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			got := askedBy(test.body)
			switch {
			case test.want == nil && got != nil:
				t.Fatalf("askedBy = %+v, want nobody", got)
			case test.want != nil && (got == nil || *got != *test.want):
				t.Fatalf("askedBy = %+v, want %+v", got, test.want)
			}
		})
	}
}

// A run that ends while its conversation is not open is owed, not lost (#285).
//
// The notice leaves with `Tell`, and `Tell` needs a session that is open: a panel closed while a picture
// rendered, an agent process that went with the page, a server restarting between the two. None of that is
// a reason for the conversation to stop where it stands, so the run stays owed to the session it named, and
// `flushRunNotices` pays it when that session opens. A different session is owed nothing.
func TestTheNoticeSurvivesASessionThatWasNotThere(t *testing.T) {
	server := newTestServer(t, newFakeComfy(t))

	ask := &task.Ask{Session: "canvas:closed", Node: "n9"}
	stored := server.tasks.Create("canvas-owed", task.ObjectImage, "image-test", nil, ask)
	cancelled := server.tasks.Cancel(stored.ID)
	if cancelled == nil || cancelled.Status != "cancelled" {
		t.Fatalf("cancelled run = %+v, want a terminal record", cancelled)
	}

	// The hook runs when a run ends, and it is the only place the debt can be paid.
	server.onRunFinished(cancelled)

	if got := server.tasks.OwedTo(ask.Session); len(got) != 1 || got[0].ID != stored.ID {
		t.Fatalf("owed to %s = %v, want the run nobody could be told about", ask.Session, got)
	}
	if got := server.tasks.OwedTo("canvas:somewhere-else"); len(got) != 0 {
		t.Errorf("owed to another session = %v, want nothing", got)
	}
}

// What the agent is told: which node, what happened, and where the result is. An agent that is told only
// "the run ended" cannot carry on, and one that is told nothing waits forever.
func TestRunNoticeNamesTheNodeAndWhatHappened(t *testing.T) {
	errorOf := func(message string) *string { return &message }
	one := []task.TaskOutput{{File: "/canvases/a/files/task_1.png", MimeType: "image/png"}}

	cases := []struct {
		name  string
		task  *task.Task
		wants []string
	}{
		{
			name:  "a picture",
			task:  &task.Task{Object: task.ObjectImage, Status: "completed", Outputs: one, Ask: &task.Ask{Session: "canvas:a", Node: "n12"}},
			wants: []string{"image generation on n12", "has finished", "1 file", "canvas_read_media"},
		},
		{
			name:  "a batch",
			task:  &task.Task{Object: task.ObjectImage, Status: "completed", Outputs: []task.TaskOutput{one[0], one[0], one[0]}, Ask: &task.Ask{Session: "canvas:a", Node: "n1"}},
			wants: []string{"3 files"},
		},
		{
			name:  "a film, cancelled",
			task:  &task.Task{Object: task.ObjectVideo, Status: "cancelled", Error: errorOf("task cancelled"), Ask: &task.Ask{Session: "canvas:a", Node: "n2"}},
			wants: []string{"video generation on n2", "was cancelled", "nothing was produced"},
		},
		{
			name:  "a failure keeps the agent's own words",
			task:  &task.Task{Object: task.ObjectAudio, Status: "failed", Error: errorOf("the model refused"), Ask: &task.Ask{Session: "canvas:a"}},
			wants: []string{"audio generation", "failed: the model refused"},
		},
		{
			name:  "a failure with no reason still says what failed",
			task:  &task.Task{Object: task.ObjectImage, Status: "failed", Ask: &task.Ask{Session: "canvas:a", Node: "n3"}},
			wants: []string{"image generation on n3", "failed", "did not say why"},
		},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			notice := runNotice(test.task)
			if !strings.HasPrefix(notice, "[comfyloft] ") {
				t.Errorf("notice = %q, want it marked as the server speaking", notice)
			}
			for _, want := range test.wants {
				if !strings.Contains(notice, want) {
					t.Errorf("notice = %q, want it to mention %q", notice, want)
				}
			}
		})
	}
}
