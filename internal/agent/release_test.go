package agent

import (
	"bufio"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"testing"
	"time"
)

/**
 * Ending a process, and what happens when it will not end.
 *
 * `Release` sits on two paths where getting it wrong is invisible until it hurts: the `DELETE` of a session
 * (an HTTP request that answers from it) and shutdown (a server that stops, or does not). Both used to close
 * stdin and then wait for as long as the process lived; now the agent is asked to quit, asked again with end of
 * input, and then left alone.
 *
 * Nothing here asserts that a signal was sent, because nothing sends one: these tests are about the frame that
 * goes in (the agent's own `quit`), the agent that answers it, and the agent that does not.
 */

// manual builds a Process around a running command without going through `Spawn`, which knows about
// AlayaCore's flags and nothing else.
func manual(t *testing.T, script string) (*Process, *exec.Cmd) {
	t.Helper()
	cmd := exec.Command("sh", "-c", script)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatalf("stdin pipe: %v", err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	t.Cleanup(func() {
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
		}
	})
	return &Process{Cmd: cmd, Stdin: bufio.NewWriter(stdin), stdinFile: stdin.(*os.File), startedAt: time.Now()}, cmd
}

// aShortPatience keeps the tests that outlive their agent from taking ten seconds each.
func aShortPatience(t *testing.T) {
	t.Helper()
	previous := releasePatience
	releasePatience = 150 * time.Millisecond
	t.Cleanup(func() { releasePatience = previous })
}

// The agent's own way out: one `CI` frame naming `quit`, in the shape its protocol documents, and a clean exit
// when it is answered.
func TestReleaseAsksTheAgentToQuit(t *testing.T) {
	record := t.TempDir() + "/frames"
	process, cmd := manual(t, `while IFS= read -r line; do printf '%s\n' "$line" >> "`+record+`"; case "$line" in CI*quit*) exit 0;; esac; done`)
	aShortPatience(t)

	process.Release()

	// `Release` reaped it, so `Wait` here would fail on a second call: the state is the answer.
	if cmd.ProcessState == nil {
		t.Fatal("the agent was never reaped")
	}
	if !cmd.ProcessState.Success() {
		t.Errorf("the agent exited with %v, want a clean end", cmd.ProcessState)
	}
	frames, err := os.ReadFile(record)
	if err != nil {
		t.Fatalf("the agent recorded nothing: %v", err)
	}
	if got := strings.TrimSpace(string(frames)); got != `CI{"command_id":"quit","name":"quit","args":""}` {
		t.Errorf("sent %q, want the quit command frame", got)
	}
}

// End of input is the second request, for an agent that did not answer the first: still not a signal.
func TestReleaseFallsBackToEndOfInput(t *testing.T) {
	process, cmd := manual(t, `cat >/dev/null`)
	aShortPatience(t)

	start := time.Now()
	process.Release()

	if elapsed := time.Since(start); elapsed > 3*releasePatience {
		t.Errorf("Release took %s, want it to return once the input ended", elapsed)
	}
	if cmd.ProcessState == nil {
		t.Error("the agent was never reaped, though it had exited")
	}
}

// The one thing this must never do: kill an agent that is busy. It is left to finish its task, and the release
// returns on time regardless.
func TestReleaseLeavesAnAgentThatDoesNotAnswerAloneAndReturns(t *testing.T) {
	// Reads nothing, so neither `quit` nor end of input reaches it: the description of a wedged agent.
	process, cmd := manual(t, `trap "" TERM HUP; while :; do sleep 1; done`)
	aShortPatience(t)

	start := time.Now()
	process.Release()
	elapsed := time.Since(start)

	if elapsed < 2*releasePatience {
		t.Errorf("Release returned in %s, want it to have given the agent both waits", elapsed)
	}
	if elapsed > 4*releasePatience {
		t.Errorf("Release took %s, want it bounded by two waits", elapsed)
	}
	if cmd.ProcessState != nil {
		t.Fatal("the agent exited; this test needs one that ignores both requests")
	}
	if err := cmd.Process.Signal(syscall.Signal(0)); err != nil {
		t.Errorf("the agent was ended after all: %v", err)
	}
}

// Shutting the server down releases every agent it started, not just the last one, and does it without waiting
// for them one at a time.
func TestCloseAllReleasesEverySession(t *testing.T) {
	aShortPatience(t)
	sessions := NewSessions(nil)
	var pids []int
	for _, id := range []string{"canvas:one", "node:two"} {
		process, cmd := manual(t, `cat >/dev/null`)
		pids = append(pids, cmd.Process.Pid)
		sessions.list[id] = &Session{ID: id, proc: process}
	}

	sessions.CloseAll("server stopping")

	if left := sessions.List(); len(left) != 0 {
		t.Errorf("%d session(s) left in the list, want none", len(left))
	}
	deadline := time.Now().Add(releasePatience)
	for _, pid := range pids {
		for {
			if err := syscall.Kill(pid, 0); err != nil {
				break // gone, and reaped by the release that ended it
			}
			if time.Now().After(deadline) {
				t.Fatalf("pid %d is still alive after CloseAll", pid)
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
}
