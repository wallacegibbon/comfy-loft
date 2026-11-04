package agent

import (
	"strings"
	"testing"
)

// TestArgsCarryTheSystemPrompt: AlayaCore appends every `--system` to its own system prompt, which is
// the only place a rule that chooses between tools can live — a tool description explains one tool, and
// a skill has to be read before it can help.
func TestArgsCarryTheSystemPrompt(t *testing.T) {
	args := SpawnOptions{Tools: "read_file", System: []string{"first", "second"}}.args()
	want := []string{"--rawio", "--builtin-tools=read_file", "--system", "first", "--system", "second"}
	if strings.Join(args, " ") != strings.Join(want, " ") {
		t.Fatalf("args = %q, want %q", args, want)
	}
}

// TestAutoSummarizeIsAFlagOnlyWhenAskedFor: the threshold is AlayaCore's own (`--auto-summarize`, a
// percentage of the context), and "the operator did not set one" is the absence of the argument rather
// than `--auto-summarize=0`. Both mean the same thing to the agent; only one of them is a statement the
// server had no business making.
func TestAutoSummarizeIsAFlagOnlyWhenAskedFor(t *testing.T) {
	for _, tc := range []struct {
		threshold int
		want      string
	}{
		{threshold: 0, want: "--rawio --builtin-tools=read_file"},
		{threshold: 65, want: "--rawio --builtin-tools=read_file --auto-summarize=65"},
		{threshold: 100, want: "--rawio --builtin-tools=read_file --auto-summarize=100"},
	} {
		args := SpawnOptions{Tools: "read_file", AutoSummarize: tc.threshold}.args()
		if got := strings.Join(args, " "); got != tc.want {
			t.Errorf("threshold %d: args = %q, want %q", tc.threshold, got, tc.want)
		}
	}
}
