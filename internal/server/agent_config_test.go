package server

import (
	"os"
	"path/filepath"
	"testing"
)

// TestBridgePathFindsABridgeOnPath: a gateway that was not installed anywhere has no bridge beside it —
// `go run` puts the executable in a temporary directory that holds nothing — so the file it writes into
// `mcp.conf` has to name one the agent can actually start. This test binary is in exactly that position.
func TestBridgePathFindsABridgeOnPath(t *testing.T) {
	dir := t.TempDir()
	bridge := filepath.Join(dir, "comfyloft-mcp")
	if err := os.WriteFile(bridge, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatalf("write bridge: %v", err)
	}
	t.Setenv("MCP_BIN", "")
	t.Setenv("PATH", dir)

	if got := (&Server{}).mcpBridgePath(); got != bridge {
		t.Fatalf("bridge path = %q, want the one on PATH (%q)", got, bridge)
	}
}

// TestBridgePathPrefersMCPBin: the operator's word wins, wherever the executable happens to live.
func TestBridgePathPrefersMCPBin(t *testing.T) {
	t.Setenv("MCP_BIN", "/opt/comfyloft/comfyloft-mcp")

	if got := (&Server{}).mcpBridgePath(); got != "/opt/comfyloft/comfyloft-mcp" {
		t.Fatalf("bridge path = %q, want MCP_BIN", got)
	}
}
