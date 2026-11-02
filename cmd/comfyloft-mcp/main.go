// Command comfyloft-mcp is the bridge between an AlayaCore process and this gateway's canvas tools.
//
// It is not a server and it listens on nothing: AlayaCore spawns it because `mcp.conf` names it, it
// speaks JSON-RPC on stdin/stdout for as long as that parent lives, and it exits when stdin closes.
// The two things it needs — where the gateway is, and which session it speaks for — arrive in the
// environment, put there by the gateway when it spawned the AlayaCore process this bridge belongs to.
//
// Nothing is written to stdout except protocol. Diagnostics go to stderr, which is where a parent that
// cares will look.
package main

import (
	"fmt"
	"os"
	"time"

	"comfyloft/internal/mcpstdio"
)

func main() {
	endpoint := os.Getenv("COMFY_LOFT_MCP")
	session := os.Getenv("COMFY_LOFT_SESSION")
	if endpoint == "" || session == "" {
		// No protocol answer is possible: this is not a request, it is a bridge that cannot work. The
		// parent sees the exit status and its own handshake fail, and stderr says why.
		fmt.Fprintln(os.Stderr, "comfyloft-mcp: COMFY_LOFT_MCP and COMFY_LOFT_SESSION must both be set; this process is spawned by the gateway's agent, not by hand")
		os.Exit(2)
	}

	err := mcpstdio.Run(os.Stdin, os.Stdout, mcpstdio.Config{
		Endpoint: endpoint,
		Session:  session,
		Version:  mcpstdio.Version,
		Timeout:  2 * time.Minute,
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, "comfyloft-mcp:", err)
		os.Exit(1)
	}
}
