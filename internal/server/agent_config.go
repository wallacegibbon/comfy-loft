package server

// The agent's configuration, and the one file the gateway writes into it.
//
// There is one configuration directory per host, shared by every session: `<UserConfigDir>/comfyui-gateway/
// <host>/alayacore/`. The operator's `model.conf` lives there and so does the `mcp.conf` this gateway
// writes at startup; the host in the path exists because the URL in `mcp.conf` is the address an agent
// dials, and a machine reachable at two addresses needs two answers.
//
// The session is not in the path any more. It arrives in the spawned process's environment
// (`COMFYLOFT_SESSION`), which AlayaCore hands to the bridge it starts from the static `mcp.conf`. That
// is what lets one file serve every session: before this, each session needed its own copy because the
// MCP URL named it.
//
// What is deliberately NOT here: the conversation. It is the user's words, it survives restarts, and it
// is kept inside the canvas directory it belongs to (`agent_conversations.go`), so a canvas and its
// conversation are one thing on disk.

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"comfyloft/internal/agent"
	"comfyloft/internal/mcpstdio"
)

// mcpConfPath is where the agent reads its MCP servers from.
func (s *Server) mcpConfPath() string { return filepath.Join(s.cfg.AgentConfigPath, "mcp.conf") }

// writeMCPConf writes the static `mcp.conf` that points AlayaCore at the bridge.
//
// Rewritten on every start, not only when missing: the `command` is an absolute path to a file that can
// move with the release directory, and a stale one fails as `handshake: EOF` — an error that names the
// symptom and not the cause. The file carries nothing session-specific; two sessions read the same one.
func (s *Server) writeMCPConf() {
	if s.cfg.AgentConfigPath == "" {
		return
	}
	bridge := s.mcpBridgePath()
	if !bridgeExists(bridge) {
		// Not fatal: the gateway is still a workflow runner without an agent. Every agent turn will fail,
		// so say where the file was expected rather than leaving the turn to explain it.
		s.logger.Warn("agent: %s is missing; every agent session will fail at its MCP handshake (build it with `make build`, or point MCP_BIN at it)", bridge)
	}
	content := fmt.Sprintf("server: canvas\ncommand: %q\nargs: []\nproto-version: %s\n", bridge, mcpProtocolVersion)
	if err := os.MkdirAll(s.cfg.AgentConfigPath, 0o755); err != nil {
		s.logger.Warn("agent: cannot create %s: %s", s.cfg.AgentConfigPath, err)
		return
	}
	// Written through a temporary file in the same directory: a session spawned while the gateway is
	// rewriting this must find either the old file or the new one, never half of either.
	target := s.mcpConfPath()
	temp := target + ".tmp"
	if err := os.WriteFile(temp, []byte(content), 0o644); err != nil {
		s.logger.Warn("agent: cannot write %s: %s", temp, err)
		return
	}
	if err := os.Rename(temp, target); err != nil {
		s.logger.Warn("agent: cannot install %s: %s", target, err)
		_ = os.Remove(temp)
	}
}

// bridgeExists reports whether the bridge a `command` names can be started: a path is a file, a bare name
// is looked up the way the agent's own spawn will look it up.
func bridgeExists(bridge string) bool {
	if strings.ContainsRune(bridge, os.PathSeparator) {
		_, err := os.Stat(bridge)
		return err == nil
	}
	_, err := exec.LookPath(bridge)
	return err == nil
}

// mcpBridgePath is the bridge binary: `MCP_BIN` when the operator says so, else beside this executable —
// what an installed release looks like — and otherwise what `PATH` offers.
//
// The last step is for a gateway that was not installed anywhere: `go run` puts the gateway in a temporary
// directory that holds no bridge, and writing that directory into `mcp.conf` names a path that is gone the
// moment the run ends. The same order `agent.findBinary` uses for the agent itself.
func (s *Server) mcpBridgePath() string {
	if override := strings.TrimSpace(os.Getenv("MCP_BIN")); override != "" {
		return override
	}
	if exe, err := os.Executable(); err == nil {
		beside := filepath.Join(filepath.Dir(exe), "comfyloft-mcp")
		if info, err := os.Stat(beside); err == nil && info.Size() > 0 {
			return beside
		}
	}
	if path, err := exec.LookPath("comfyloft-mcp"); err == nil {
		return path
	}
	return "comfyloft-mcp"
}

// agentOptionsFor is what one session's spawn needs: the shared operator configuration, the two facts
// this bridge needs about itself, and — when the client says this name is a conversation rather than a
// question — the file inside its canvas to keep it in.
//
// A node's agent is asked one thing at a time and writes the answer into the node; keeping that in a file
// would leave one per node on disk, and would carry an earlier question into the next answer. So a name
// that is not a canvas keeps nothing (`agent_conversations.go`).
func (s *Server) agentOptionsFor(session string, history bool) (agent.SpawnOptions, error) {
	opts := s.agentOptions()
	opts.Env = append(opts.Env,
		"COMFYLOFT_MCP="+s.mcpEndpoint(),
		"COMFYLOFT_SESSION="+session,
		// The bridge version travels beside the session so a mixed install fails with a sentence that
		// names both sides instead of a handshake EOF.
		"COMFYLOFT_BRIDGE="+mcpstdio.Version,
	)
	if !history {
		return opts, nil
	}
	file, err := s.sessionFile(session)
	if err != nil {
		return opts, err
	}
	opts.Session = file
	return opts, nil
}
