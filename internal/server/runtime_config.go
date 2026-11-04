package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"

	"comfyloft/internal/httpx"
	"comfyloft/internal/util"
)

/**
 * The canvas's first paint.
 *
 * A preferences document that lives on the server cannot be applied before the page draws: the reply
 * arrives after the first frame, so a dark workspace opens white for a moment and a Chinese workspace
 * opens in English. The page can only read something synchronously through a script tag, so it loads
 * `/config.js` before its own bundle and this is what answers.
 *
 * It is a **view of `data/settings.json`**, computed per request, not a second copy of it. It used to be a
 * file the server wrote into `frontend/dist` — the only way to get a synchronous read while a static file
 * server answered for the bundle (#155). That premise ended when the server started serving the bundle
 * itself (#219), and keeping the file meant two writers of one truth: a write that failed only logged a
 * warning, `make frontend` silently replaced the file with the template, and a distributed `dist` carried
 * this machine's settings. A route cannot be stale, cannot fail to be written, and needs no write access to
 * the installation, which is also what a single embeddable binary needs (#220).
 *
 * `RUNTIME_CONFIG_PATH` still exists for the one layout this cannot serve: a canvas published by a static
 * host with no server in the request path. It is opt-in — nothing is written unless the operator names a
 * file — and what it writes is the same script, from the same function.
 */

// handleFirstPaint implements `GET /config.js`: the workspace preferences as the script the page loads
// before its bundle.
func (s *Server) handleFirstPaint(ctx *httpx.Ctx) error {
	script, etag, err := s.firstPaintScript()
	if err != nil {
		return err
	}
	headers := ctx.W.Header()
	headers.Set("Content-Type", "text/javascript; charset=utf-8")
	// Revalidate, do not re-fetch: the document is a few kilobytes and usually unchanged between loads, so
	// the common case is a 304 with no body. `no-store` was what the file got; a route can do better.
	headers.Set("Cache-Control", "no-cache")
	headers.Set("ETag", etag)
	if matchesETag(ctx.R, etag) {
		ctx.W.WriteHeader(http.StatusNotModified)
		return nil
	}
	_, err = ctx.W.Write(script)
	return err
}

// writeFirstPaintFile is the opt-in copy for a canvas served by a static host, or a no-op when the operator
// named no file.
func (s *Server) writeFirstPaintFile() {
	path := s.cfg.RuntimeConfigPath
	if path == "" {
		return
	}
	script, _, err := s.firstPaintScript()
	if err != nil {
		// The address half is still worth writing: a page that cannot reach the server cannot even report
		// the problem.
		s.logger.Warn("first paint: settings unavailable for %s: %s", path, err)
		script, _, err = s.firstPaintScriptWithoutSettings()
		if err != nil {
			s.logger.Warn("first paint: cannot encode %s: %s", path, err)
			return
		}
	}
	if err := writeRuntimeFile(path, script); err != nil {
		s.logger.Warn("first paint: %s", err)
	}
}

// firstPaintScript is the document as JavaScript, with the ETag of exactly the bytes it returns.
func (s *Server) firstPaintScript() ([]byte, string, error) {
	config := map[string]any{}
	if url := s.canvasServerURL(); url != "" {
		config["LOCAL_SERVER_URL"] = url
	}
	document, err := s.settings.Read()
	if err != nil {
		return nil, "", err
	}
	config["SETTINGS"] = json.RawMessage(document)
	return buildFirstPaintScript(config)
}

// firstPaintScriptWithoutSettings is the file for a server that cannot read its own settings: the address
// is still an answer, and it is the one a page needs before it can report anything.
func (s *Server) firstPaintScriptWithoutSettings() ([]byte, string, error) {
	config := map[string]any{}
	if url := s.canvasServerURL(); url != "" {
		config["LOCAL_SERVER_URL"] = url
	}
	return buildFirstPaintScript(config)
}

// buildFirstPaintScript renders one assignment and its ETag.
//
// One `Object.assign` is the whole shape, which is what lets `frontend/public/config.js` — the template a
// static host serves — be the same script with nothing in it.
func buildFirstPaintScript(config map[string]any) ([]byte, string, error) {
	payload, err := json.Marshal(config)
	if err != nil {
		return nil, "", err
	}
	var script bytes.Buffer
	script.WriteString("window.__RUNTIME_CONFIG__ = Object.assign(window.__RUNTIME_CONFIG__ || {}, ")
	script.Write(escapeLineSeparators(payload))
	script.WriteString(");\n")
	body := script.Bytes()
	// `escapeLineSeparators` changes the bytes it is given, so the digest is taken over what is sent.
	sum := sha256.Sum256(body)
	return body, `"` + hex.EncodeToString(sum[:16]) + `"`, nil
}

// matchesETag answers `If-None-Match`. `*` and a list are accepted because they cost two lines and a
// browser is entitled to send either.
func matchesETag(r *http.Request, etag string) bool {
	header := strings.TrimSpace(r.Header.Get("If-None-Match"))
	if header == "" {
		return false
	}
	if header == "*" {
		return true
	}
	for _, candidate := range strings.Split(header, ",") {
		if strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(candidate), "W/")) == etag {
			return true
		}
	}
	return false
}

// canvasServerURL is the address the first paint may need, or "" when there is nothing to say.
//
// A page this server served already knows where it came from, and its own origin is the only address that
// stays right for a phone on the LAN, a DNS name or a reverse proxy — none of which a bind address can
// guess (#219). So the address is worth including only when the operator says the canvas is served
// somewhere else, which `PUBLIC_BASE_URL` is: it names the address the server is reachable at.
func (s *Server) canvasServerURL() string {
	if !s.cfg.PublicBaseURLSet {
		return ""
	}
	return s.cfg.PublicBaseURL
}

// escapeLineSeparators replaces the two characters that are legal inside a JSON string and illegal
// inside a JavaScript one. A channel name or a node title is user text, so either can appear here.
func escapeLineSeparators(payload []byte) []byte {
	return bytes.ReplaceAll(bytes.ReplaceAll(payload, []byte("\u2028"), []byte(`\u2028`)), []byte("\u2029"), []byte(`\u2029`))
}

// writeRuntimeFile replaces the file in one step, so a page loading at that instant reads the old one or the new
// one and never half of either.
func writeRuntimeFile(path string, content []byte) error {
	return util.WriteFileAtomic(path, content)
}
