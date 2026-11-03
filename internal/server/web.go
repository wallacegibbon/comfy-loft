package server

import (
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"

	"comfyloft/internal/httpx"
)

/**
 * The canvas bundle, served by the server.
 *
 * The canvas used to be a second process — `vite preview` on :3000 talking to the server on :8190 — which
 * made every picture a cross-origin image. That was not a detail: `canvas.toDataURL()` refuses a canvas that
 * has drawn one ("tainted canvases may not be exported"), so InPaint, crop and split could not export what
 * they drew, CORS had to be listed per address, and a release could not ship at all because `vite` is a
 * development dependency. The bytes are static files that already sit beside the binary (`frontend/dist`),
 * so serving them from the server's own origin is one process, one port and one firewall rule (#219). The
 * one thing in that directory the server does not serve is `config.js`: that is a route, computed from
 * `data/settings.json` (#220).
 *
 * This file is the only place in the server that knows the bundle exists, and it still does not know what a
 * node is: what it serves is bytes. `/api/*` remains the whole protocol.
 */

// handleWeb implements `GET /`: a static file from WEB_DIR, or the bundle's entry point for a client-side
// route (`/canvas/<id>`, which no file on disk is named after).
func (s *Server) handleWeb(ctx *httpx.Ctx) error {
	webDir := s.cfg.WebDir
	if webDir == "" {
		return notFound(ctx.R)
	}
	// An unknown API path stays JSON. A page is the worst answer to a service call: it parses as a
	// response, so a typo in a path would look like a server that answers 200 to everything.
	if strings.HasPrefix(ctx.R.URL.Path, "/api/") {
		return notFound(ctx.R)
	}
	// Clean before joining: it resolves `..` against the root, so no request can name a file outside the
	// bundle however it is encoded.
	requested := path.Clean("/" + ctx.R.URL.Path)
	file := filepath.Join(webDir, filepath.FromSlash(requested))
	if info, err := os.Stat(file); err == nil && info.Mode().IsRegular() {
		ctx.W.Header().Set("Cache-Control", cacheControlFor(requested))
		http.ServeFile(ctx.W, ctx.R, file)
		return nil
	}
	// A missing file that has an extension is a missing file, not a route: answering with the page turns a
	// bundle that lost a chunk into a page that loads and then does nothing.
	if path.Ext(requested) != "" {
		return notFound(ctx.R)
	}
	index := filepath.Join(webDir, "index.html")
	if info, err := os.Stat(index); err != nil || !info.Mode().IsRegular() {
		return notFound(ctx.R)
	}
	// Never cached, for the reason the whole cache policy exists: this file names the hashed assets, so a
	// cached copy outlives an upgrade and asks for chunks that are gone. A reload cannot fix a white page
	// whose cause is the cached copy the reload reads.
	ctx.W.Header().Set("Cache-Control", "no-store")
	http.ServeFile(ctx.W, ctx.R, index)
	return nil
}

// cacheControlFor is the whole cache policy of the bundle.
//
// Vite puts a content hash in every name under `assets/`, so those can be kept without ever asking again —
// the same argument a canvas file's name makes (#156). Nothing else under the root may be: `index.html`
// changes under a fixed name (`config.js` is not a file here at all, see #220), and losing that race is a
// white page rather than a slow one. The remaining files (favicon, icons) are small enough that
// revalidating them costs nothing.
func cacheControlFor(requested string) string {
	if strings.HasPrefix(requested, "/assets/") {
		return "public, max-age=31536000, immutable"
	}
	return "no-store"
}

// notFound is the envelope every unmatched path answers with, static or not: one shape for "there is
// nothing here", so a client never has to tell an HTML 404 from a JSON one.
func notFound(r *http.Request) error {
	return httpx.NotFound("not_found", "Not found: "+r.Method+" "+r.URL.Path)
}
