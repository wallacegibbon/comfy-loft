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
