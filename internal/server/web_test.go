package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"comfyloft/internal/config"
)

/**
 * The canvas bundle, from the server's own origin.
 *
 * `start.sh` used to run `vite preview` beside the server, which made every picture cross-origin: an editor
 * that drew one could not export what it drew. These tests hold the two halves of serving it here — a file
 * of the bundle answers, a client-side route answers with the entry point — and the two ways it must not
 * answer: an unknown `/api/*` path and a missing chunk are errors, never the page (#219).
 */

// webServer is a server with a bundle of its own: one page, one hashed asset, and the `config.js` template
// a build puts there for a static host.
func webServer(t *testing.T) (*httptest.Server, string) {
	t.Helper()
	dir := t.TempDir()
	writeBundleFile(t, dir, "index.html", "<!doctype html><title>canvas</title>")
	writeBundleFile(t, dir, "config.js", "window.__RUNTIME_CONFIG__ = {};")
	writeBundleFile(t, dir, "assets/index-BlfT9xKg.js", "console.log(1);")

	srv := newTestServer(t, newFakeComfy(t), config.WithWebDir(dir))
	server := httptest.NewServer(srv.Handler())
	t.Cleanup(server.Close)
	return server, dir
}

func writeBundleFile(t *testing.T, root, name, body string) {
	t.Helper()
	path := filepath.Join(root, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

// get fetches a path and returns the response with the body read.
func get(t *testing.T, server *httptest.Server, path string) (*http.Response, string) {
	t.Helper()
	response, err := server.Client().Get(server.URL + path)
	if err != nil {
		t.Fatalf("get %s: %v", path, err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return response, string(raw)
}

// errorCode is the envelope's code, or "" when the body is not that envelope.
func errorCode(t *testing.T, body string) string {
	t.Helper()
	var envelope struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal([]byte(body), &envelope); err != nil {
		return ""
	}
	return envelope.Error.Code
}

func TestTheRootServesThePageAndIsNeverCached(t *testing.T) {
	server, _ := webServer(t)
	response, body := get(t, server, "/")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d (%s), want 200", response.StatusCode, body)
	}
	if !strings.Contains(body, "<title>canvas</title>") {
		t.Errorf("body is not the page: %q", body)
	}
	if got := response.Header.Get("Cache-Control"); got != "no-store" {
		t.Errorf("cache-control = %q, want no-store: a cached entry point outlives an upgrade and asks "+
			"for chunks that are gone", got)
	}
	if contentType := response.Header.Get("Content-Type"); !strings.HasPrefix(contentType, "text/html") {
		t.Errorf("content-type = %q, want text/html", contentType)
	}
}

// A route the client owns is not a file, so it answers with the page and the client decides what it means.
func TestAClientRouteAnswersWithThePage(t *testing.T) {
	server, _ := webServer(t)
	response, body := get(t, server, "/canvas/349b70cf4764")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d (%s), want 200", response.StatusCode, body)
	}
	if !strings.Contains(body, "<title>canvas</title>") {
		t.Errorf("a client route did not get the entry point: %q", body)
	}
}

// The hash in a name is a promise that the bytes never change, so the browser is told to keep them.
func TestAHashedAssetIsCacheableForever(t *testing.T) {
	server, _ := webServer(t)
	response, body := get(t, server, "/assets/index-BlfT9xKg.js")
	if response.StatusCode != http.StatusOK || body != "console.log(1);" {
		t.Fatalf("status = %d, body = %q", response.StatusCode, body)
	}
	if got := response.Header.Get("Cache-Control"); !strings.Contains(got, "immutable") {
		t.Errorf("cache-control = %q, want immutable", got)
	}
}

// The bundle carries a `config.js` of its own — the template `make frontend` copies from
// `frontend/public/` for a static host — and the server must never serve it. What it serves is the
// document it is holding, computed per request (#220): a template answered from the bundle is exactly the
// stale copy this route replaced.
func TestTheFirstPaintScriptWinsOverTheTemplateInTheBundle(t *testing.T) {
	server, dir := webServer(t)
	writeBundleFile(t, dir, "config.js", `window.__RUNTIME_CONFIG__ = {"STALE":"from the bundle"};`)
	response, body := get(t, server, "/config.js")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d (%s), want 200", response.StatusCode, body)
	}
	if strings.Contains(body, "STALE") {
		t.Errorf("the bundle's copy answered instead of the document:\n%s", body)
	}
	if !strings.Contains(body, "SETTINGS") {
		t.Errorf("the served script carries no settings:\n%s", body)
	}
}

// A missing chunk is a missing chunk. Answering with the page turns a broken bundle into a page that loads
// and then does nothing, which is the one failure nobody can read from the network tab.
func TestAMissingAssetIsNotThePage(t *testing.T) {
	server, _ := webServer(t)
	response, body := get(t, server, "/assets/index-gone.js")
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d (%s), want 404", response.StatusCode, body)
	}
	if strings.Contains(body, "<title>canvas</title>") {
		t.Errorf("a missing asset answered with the page")
	}
	if code := errorCode(t, body); code != "not_found" {
		t.Errorf("code = %q, want not_found: %s", code, body)
	}
}

// `/api/*` is a protocol, not a set of files: a typo there must not look like a server that answers 200 to
// everything with a page.
func TestAnUnknownAPIPathStaysJSONEvenWithABundle(t *testing.T) {
	server, _ := webServer(t)
	response, body := get(t, server, "/api/canvases/nope/nonsense")
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d (%s), want 404", response.StatusCode, body)
	}
	if strings.Contains(body, "<title>canvas</title>") {
		t.Errorf("an API path answered with the page: %q", body)
	}
	if code := errorCode(t, body); code != "not_found" {
		t.Errorf("code = %q, want not_found: %s", code, body)
	}
}

// No bundle configured — a development server is serving the canvas — and `/` is the 404 it always was.
func TestWithoutABundleTheRootIsStill404(t *testing.T) {
	srv := newTestServer(t, newFakeComfy(t))
	server := httptest.NewServer(srv.Handler())
	t.Cleanup(server.Close)
	response, body := get(t, server, "/")
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d (%s), want 404", response.StatusCode, body)
	}
}

// A request cannot name a file outside the bundle, however it is written: `path.Clean` resolves the `..`
// against the root before anything is joined to it.
func TestNothingOutsideTheBundleIsServed(t *testing.T) {
	server, dir := webServer(t)
	secret := filepath.Join(filepath.Dir(dir), "secret.txt")
	if err := os.WriteFile(secret, []byte("not yours"), 0o644); err != nil {
		t.Fatalf("write secret: %v", err)
	}
	for _, path := range []string{"/../secret.txt", "/assets/../../secret.txt", "/..%2fsecret.txt"} {
		response, body := get(t, server, path)
		if response.StatusCode == http.StatusOK && strings.Contains(body, "not yours") {
			t.Errorf("%s served a file outside the bundle", path)
		}
	}
}
