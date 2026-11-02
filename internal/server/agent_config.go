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
// belongs beside the canvas it belongs to — `data/agent/sessions/` until canvases become directories.

import (
	"crypto/sha1"
	"fmt"
	"os"
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
	if _, err := os.Stat(bridge); err != nil {
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

// mcpBridgePath is the bridge binary: `MCP_BIN` when the operator says so, else beside this executable,
// which is what an installed release looks like.
func (s *Server) mcpBridgePath() string {
	if override := strings.TrimSpace(os.Getenv("MCP_BIN")); override != "" {
		return override
	}
	exe, err := os.Executable()
	if err != nil {
		return "comfyloft-mcp"
	}
	return filepath.Join(filepath.Dir(exe), "comfyloft-mcp")
}

// adoptLegacyAgentConfig copies a configuration written before the per-host split into its new home.
//
// `model.conf` holds the operator's models and their API keys. Orphaning it would take an agent that
// worked a minute ago and leave it with no models and no explanation, which is not the same kind of
// cheap as an empty browser store. The old file is left where it is: this is a copy, not a move, and a
// user who edits the old one can still see what they meant.
func (s *Server) adoptLegacyAgentConfig(legacyDir string) {
	if legacyDir == "" || legacyDir == s.cfg.AgentConfigPath {
		return
	}
	if _, err := os.Stat(filepath.Join(s.cfg.AgentConfigPath, "model.conf")); err == nil {
		return
	}
	for _, name := range []string{"model.conf", "runtime.conf"} {
		data, err := os.ReadFile(filepath.Join(legacyDir, name))
		if err != nil {
			continue
		}
		if err := os.MkdirAll(s.cfg.AgentConfigPath, 0o755); err != nil {
			s.logger.Warn("agent: cannot create %s: %s", s.cfg.AgentConfigPath, err)
			return
		}
		if err := os.WriteFile(filepath.Join(s.cfg.AgentConfigPath, name), data, 0o644); err != nil {
			s.logger.Warn("agent: cannot adopt %s: %s", name, err)
			return
		}
		s.logger.Info("agent: adopted %s from %s", name, legacyDir)
	}
}

// sessionFile is where a conversation is kept, created if this is the first time.
func (s *Server) sessionFile(session string) (string, error) {
	root := sessionsRoot(s.cfg.DataDir)
	if err := os.MkdirAll(root, 0o755); err != nil {
		return "", err
	}
	return filepath.Join(root, sessionKey(session)+".session"), nil
}

// sessionsRoot holds one conversation per session.
func sessionsRoot(dataDir string) string { return filepath.Join(dataDir, "agent", "sessions") }

// sessionKey is a session name as a file name: readable, and unique by hash.
//
// The hash is here because the readable half is lossy — `node:n1` and `node-n1` both survive as
// `node-n1` — and two conversations sharing one file would be a bug nobody would look for.
func sessionKey(session string) string {
	var safe strings.Builder
	for _, r := range session {
		if safe.Len() >= 40 {
			break
		}
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_', r == '.':
			safe.WriteRune(r)
		default:
			safe.WriteByte('-')
		}
	}
	sum := sha1.Sum([]byte(session))
	return fmt.Sprintf("%s-%x", safe.String(), sum[:4])
}

// agentOptionsFor is what one session's spawn needs: the shared operator configuration, the two facts
// this bridge needs about itself, and — when the client says this name is a conversation rather than a
// question — a session file to keep it in.
//
// A node's agent is asked one thing at a time and writes the answer into the node; keeping that in a file
// would leave one per node on disk, and would carry an earlier question into the next answer.
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

// clearLegacyAgentState removes the per-session directories an older layout left under `data/agent/`.
//
// Nothing reads them again: sessions no longer own a config copy, because `mcp.conf` is static and the
// session name travels in the environment. Conversations are kept — they are the user's words, and a
// gateway restart is not a reason to forget them.
func clearLegacyAgentState(dataDir string) {
	root := filepath.Join(dataDir, "agent")
	entries, err := os.ReadDir(root)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if !entry.IsDir() || entry.Name() == "sessions" {
			continue
		}
		_ = os.RemoveAll(filepath.Join(root, entry.Name()))
	}
}
