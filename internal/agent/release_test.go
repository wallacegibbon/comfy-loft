package agent

import (
	"bufio"
	"os"
	"os/exec"
	"syscall"
	"testing"
	"time"
)

/**
 * Ending a process: end of input, and a kill if that does not take.
 *
 * `Release` sits on two paths where getting it wrong is invisible until it hurts: the `DELETE` of a session
 * (an HTTP request that answers from it) and shutdown (a server that stops, or does not). The rules these
 * tests pin are the whole of the decision (#250): an agent that ends when its input closes is never killed,
 * one that does not is killed after `releasePatience`, and neither path waits longer than that.
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

// aShortPatience keeps the tests that outlive their agent from taking two seconds each.
func aShortPatience(t *testing.T) {
	t.Helper()
	previous := releasePatience
	releasePatience = 150 * time.Millisecond
	t.Cleanup(func() { releasePatience = previous })
}

// killed reports whether the child was signalled rather than ending on its own.
func killed(cmd *exec.Cmd) bool {
	status, ok := cmd.ProcessState.Sys().(syscall.WaitStatus)
	return ok && status.Signaled()
}

// An agent that ends when its input closes is not killed, and the release returns as soon as it ends.
func TestReleaseEndsAnAgentWithEndOfInput(t *testing.T) {
	process, cmd := manual(t, `cat >/dev/null`)
	aShortPatience(t)

	start := time.Now()
	process.Release()

	if elapsed := time.Since(start); elapsed > releasePatience {
		t.Errorf("Release took %s, want it to return as soon as the agent ended", elapsed)
	}
	if cmd.ProcessState == nil {
		t.Fatal("the agent was never reaped")
	}
	if killed(cmd) {
		t.Error("the agent was killed; it ended on end of input by itself")
	}
}

// An agent that never reads its input — a task that will not finish, which is exactly the case `quit` cannot
// help with — is killed, and the release still returns on time.
func TestReleaseKillsAnAgentThatDoesNotEndOnItsOwn(t *testing.T) {
	// Reads nothing, so end of input never reaches it: the description of a wedged agent.
	process, cmd := manual(t, `while :; do sleep 1; done`)
	aShortPatience(t)

	start := time.Now()
	process.Release()
	elapsed := time.Since(start)

	if elapsed < releasePatience {
		t.Errorf("Release returned in %s, want it to have waited %s first", elapsed, releasePatience)
	}
	if elapsed > 4*releasePatience {
		t.Errorf("Release took %s, want it bounded by the wait plus a kill", elapsed)
	}
	if cmd.ProcessState == nil {
		t.Fatal("the agent was never reaped")
	}
	if !killed(cmd) {
		t.Errorf("the agent ended %v, want it killed", cmd.ProcessState)
	}
	if err := cmd.Process.Signal(syscall.Signal(0)); err == nil {
		t.Errorf("pid %d is still alive after Release", cmd.Process.Pid)
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
