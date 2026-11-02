package server

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
)

/**
 * The canvas's first paint.
 *
 * A preferences document that lives on the server cannot be applied before the page draws: the reply
 * arrives after the first frame, so a dark workspace opens white for a moment and a Chinese workspace
 * opens in English. The bundle is static, so the only thing that can be read synchronously is a script
 * tag — hence this file.
 *
 * The gateway writes it, on every start and after every settings save, with the same address and
 * settings document it serves over `/api/*`. `start.sh` used to write it for the address alone; the
 * settings half is why the gateway owns it now, and the whole thing stays one `Object.assign` so the
 * hand-written template in `canvas/public/config.js` is still a valid file to start from.
 */

// runtimeConfigPath is where the write goes, or "" when the operator did not name a file.
func (s *Server) writeRuntimeConfig() {
	path := s.cfg.RuntimeConfigPath
	if path == "" {
		return
	}

	config := map[string]any{}
	if url := s.canvasGatewayURL(); url != "" {
		config["LOCAL_GATEWAY_URL"] = url
	}
	document, err := s.settings.Read()
	if err != nil {
		// The settings file exists and is unreadable. The address is still worth writing: a page that
		// cannot reach the gateway cannot even report the problem.
		s.logger.Warn("runtime config: settings unavailable for %s: %s", path, err)
	} else {
		config["SETTINGS"] = json.RawMessage(document)
	}

	payload, err := json.Marshal(config)
	if err != nil {
		s.logger.Warn("runtime config: cannot encode %s: %s", path, err)
		return
	}

	var file bytes.Buffer
	file.WriteString("// Written by the gateway on every start and after every settings save.\n")
	file.WriteString("// `make frontend` restores the template from frontend/public/config.js.\n")
	file.WriteString("window.__RUNTIME_CONFIG__ = Object.assign(window.__RUNTIME_CONFIG__ || {}, ")
	file.Write(escapeLineSeparators(payload))
	file.WriteString(");\n")

	if err := writeRuntimeFile(path, file.Bytes()); err != nil {
		s.logger.Warn("runtime config: %s", err)
	}
}

// canvasGatewayURL is the address a browser should use for this gateway.
//
// A wildcard bind has no usable address — the browser already knows the host it loaded the page from,
// and the frontend falls back to it — so nothing is injected. That is the rule `start.sh` applied.
func (s *Server) canvasGatewayURL() string {
	switch s.cfg.GatewayHost {
	case "", "0.0.0.0", "::", "[::]":
		return ""
	}
	return "http://" + s.cfg.GatewayHost + ":" + strconv.Itoa(s.cfg.GatewayPort)
}

// escapeLineSeparators replaces the two characters that are legal inside a JSON string and illegal
// inside a JavaScript one. A channel name or a node title is user text, so either can appear here.
func escapeLineSeparators(payload []byte) []byte {
	return bytes.ReplaceAll(bytes.ReplaceAll(payload, []byte("\u2028"), []byte(`\u2028`)), []byte("\u2029"), []byte(`\u2029`))
}

// writeRuntimeFile replaces the file in one step, so a page loading at that instant reads the old one
// or the new one and never half of either.
func writeRuntimeFile(path string, content []byte) error {
	temp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*.tmp")
	if err != nil {
		return err
	}
	// CreateTemp makes the file owner-only; the canvas's browser reads it, so it is 0644 like the rest.
	if err := temp.Chmod(0o644); err != nil {
		_ = temp.Close()
		_ = os.Remove(temp.Name())
		return err
	}
	name := temp.Name()
	defer func() { _ = os.Remove(name) }()
	if _, err := temp.Write(content); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	return os.Rename(name, path)
}
