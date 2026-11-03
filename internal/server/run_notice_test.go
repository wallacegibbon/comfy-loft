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
			wants: []string{"image generation on n12", "has finished", "1 file", "canvas_read_node"},
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
				t.Errorf("notice = %q, want it marked as the gateway speaking", notice)
			}
			for _, want := range test.wants {
				if !strings.Contains(notice, want) {
					t.Errorf("notice = %q, want it to mention %q", notice, want)
				}
			}
		})
	}
}
