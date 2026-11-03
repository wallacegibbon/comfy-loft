package server

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"comfyloft/internal/config"
)

// settingsGateway is a gateway with a canvas root and, when asked for one, a first-paint file.
func settingsGateway(t *testing.T, options ...config.Option) (*httptest.Server, *Server) {
	t.Helper()
	srv := newTestGateway(t, newFakeComfy(t), options...)
	gateway := httptest.NewServer(srv.Handler())
	t.Cleanup(gateway.Close)
	return gateway, srv
}

func TestSettingsStartEmptyAndRoundTrip(t *testing.T) {
	gateway, _ := settingsGateway(t)
	client := gateway.Client()

	status, payload := doJSON(t, client, http.MethodGet, gateway.URL+"/api/settings", nil)
	if status != http.StatusOK {
		t.Fatalf("get status = %d: %v", status, payload)
	}
	if stored, _ := payload["settings"].(map[string]any); len(stored) != 0 {
		t.Errorf("settings = %v, want an empty object", stored)
	}

	document := map[string]any{
		"theme":  map[string]any{"theme": "light"},
		"locale": "en-US",
	}
	status, payload = doJSON(t, client, http.MethodPut, gateway.URL+"/api/settings", map[string]any{"settings": document})
	if status != http.StatusOK {
		t.Fatalf("put status = %d: %v", status, payload)
	}

	status, payload = doJSON(t, client, http.MethodGet, gateway.URL+"/api/settings", nil)
	if status != http.StatusOK {
		t.Fatalf("get after put status = %d", status)
	}
	stored, _ := payload["settings"].(map[string]any)
	if stored["locale"] != "en-US" {
		t.Errorf("locale = %v, want en-US", stored["locale"])
	}
	theme, _ := stored["theme"].(map[string]any)
	if theme["theme"] != "light" {
		t.Errorf("theme.theme = %v", theme["theme"])
	}
}

// The second save replaces the first: there is no merge to get wrong.
func TestSettingsSaveReplacesTheWholeDocument(t *testing.T) {
	gateway, _ := settingsGateway(t)
	client := gateway.Client()

	if status, body := doJSON(t, client, http.MethodPut, gateway.URL+"/api/settings", map[string]any{"settings": map[string]any{"locale": "en-US", "theme": map[string]any{"theme": "light"}}}); status != http.StatusOK {
		t.Fatalf("first put = %d: %v", status, body)
	}
	if status, body := doJSON(t, client, http.MethodPut, gateway.URL+"/api/settings", map[string]any{"settings": map[string]any{"locale": "zh-CN"}}); status != http.StatusOK {
		t.Fatalf("second put = %d: %v", status, body)
	}

	_, payload := doJSON(t, client, http.MethodGet, gateway.URL+"/api/settings", nil)
	stored, _ := payload["settings"].(map[string]any)
	if _, present := stored["theme"]; present {
		t.Errorf("the first document was merged in: %v", stored)
	}
	if stored["locale"] != "zh-CN" {
		t.Errorf("locale = %v", stored["locale"])
	}
}

func TestSettingsRejectWhatIsNotAnObject(t *testing.T) {
	gateway, _ := settingsGateway(t)
	client := gateway.Client()

	status, body := doJSON(t, client, http.MethodPut, gateway.URL+"/api/settings", map[string]any{"settings": []any{1, 2, 3}})
	if status != http.StatusBadRequest {
		t.Errorf("array = %d (%v), want 400", status, body)
	}
	if failure, _ := body["error"].(map[string]any); failure["code"] != "settings_invalid" {
		t.Errorf("code = %v", failure["code"])
	}

	status, body = doJSON(t, client, http.MethodPut, gateway.URL+"/api/settings", map[string]any{})
	if status != http.StatusBadRequest {
		t.Errorf("no document = %d (%v), want 400", status, body)
	}
	if failure, _ := body["error"].(map[string]any); failure["code"] != "settings_missing" {
		t.Errorf("code = %v", failure["code"])
	}
}

// The page loads `/config.js` before its bundle, so this is the one document that can be applied to the
// first frame — and it is the live settings document, not a copy taken when the gateway started (#220).
func TestTheFirstPaintScriptIsTheSettingsDocument(t *testing.T) {
	gateway, _ := settingsGateway(t, config.WithPublicBaseURL("http://127.0.0.1:8190"))

	// Nothing saved yet: the script exists and carries an empty document, which is what tells the store it
	// may start saving (an absent it would fall back to HTTP and refuse to write).
	status, body, headers := doScript(t, gateway)
	if status != http.StatusOK {
		t.Fatalf("status = %d (%s), want 200", status, body)
	}
	if !strings.Contains(body, `"SETTINGS":{}`) {
		t.Errorf("the script does not carry the settings document:\n%s", body)
	}
	if !strings.Contains(body, `"LOCAL_GATEWAY_URL":"http://127.0.0.1:8190"`) {
		t.Errorf("the script does not carry the address the operator named:\n%s", body)
	}
	if !strings.HasPrefix(body, "window.__RUNTIME_CONFIG__ = Object.assign(window.__RUNTIME_CONFIG__ || {}, ") {
		t.Errorf("the script is not the assignment the frontend expects:\n%s", body)
	}
	if contentType := headers.Get("Content-Type"); !strings.HasPrefix(contentType, "text/javascript") {
		t.Errorf("content-type = %q, want text/javascript", contentType)
	}

	// A save is visible on the next request, in the same process, with no file written anywhere.
	if putStatus, putBody := doJSON(t, gateway.Client(), http.MethodPut, gateway.URL+"/api/settings", map[string]any{
		"settings": map[string]any{"theme": map[string]any{"theme": "light"}, "locale": "en-US"},
	}); putStatus != http.StatusOK {
		t.Fatalf("put = %d: %v", putStatus, putBody)
	}
	_, after, _ := doScript(t, gateway)
	if !strings.Contains(after, `"theme":{"theme":"light"}`) || !strings.Contains(after, `"locale":"en-US"`) {
		t.Errorf("the save did not reach the first paint:\n%s", after)
	}
}

// Revalidating is the cheap path: the body is a few kilobytes and usually unchanged between loads.
func TestTheFirstPaintScriptRevalidates(t *testing.T) {
	gateway, _ := settingsGateway(t)
	_, _, headers := doScript(t, gateway)
	etag := headers.Get("ETag")
	if etag == "" {
		t.Fatal("no ETag: every load would be a full body")
	}
	if cacheControl := headers.Get("Cache-Control"); cacheControl != "no-cache" {
		t.Errorf("cache-control = %q, want no-cache", cacheControl)
	}

	request, err := http.NewRequest(http.MethodGet, gateway.URL+"/config.js", nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	request.Header.Set("If-None-Match", etag)
	response, err := gateway.Client().Do(request)
	if err != nil {
		t.Fatalf("conditional get: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNotModified {
		t.Errorf("status = %d, want 304", response.StatusCode)
	}

	// A different document is a different ETag, so a revalidating page cannot keep stale preferences.
	if status, body := doJSON(t, gateway.Client(), http.MethodPut, gateway.URL+"/api/settings", map[string]any{
		"settings": map[string]any{"locale": "zh-CN"},
	}); status != http.StatusOK {
		t.Fatalf("put = %d: %v", status, body)
	}
	_, changed, changedHeaders := doScript(t, gateway)
	if changedHeaders.Get("ETag") == etag {
		t.Errorf("the ETag survived a settings save:\n%s", changed)
	}
	if !strings.Contains(changed, `"locale":"zh-CN"`) {
		t.Errorf("the script still says the old document:\n%s", changed)
	}
}

// A gateway that serves the canvas itself names no address (#219).
//
// The page came from this origin, and its own origin is the only address that stays right behind a LAN
// name, a phone, or a reverse proxy — so writing `host:port` from the bind would replace a correct answer
// with a guess.
func TestTheFirstPaintScriptSaysNoAddressWhenTheGatewayServesTheCanvas(t *testing.T) {
	gateway, _ := settingsGateway(t, config.WithWebDir(t.TempDir()))
	_, body, _ := doScript(t, gateway)
	if strings.Contains(body, "LOCAL_GATEWAY_URL") {
		t.Errorf("a gateway serving the canvas named an address of its own:\n%s", body)
	}
	if !strings.Contains(body, "SETTINGS") {
		t.Errorf("the settings half is still owed to the page:\n%s", body)
	}
}

// The opt-in copy is for a canvas a static host publishes, and only then: nothing is written into the
// installation otherwise (#220). A bundle directory is build output, and writing preferences into it is
// how a `dist` came to carry this machine's model list.
func TestTheFirstPaintFileIsWrittenOnlyWhenTheOperatorNamesOne(t *testing.T) {
	webDir := t.TempDir()
	_, srv := settingsGateway(t, config.WithWebDir(webDir), config.WithRuntimeConfigPath(""))
	if srv.cfg.RuntimeConfigPath != "" {
		t.Fatalf("runtime config path = %q, want none", srv.cfg.RuntimeConfigPath)
	}
	if _, err := os.Stat(filepath.Join(webDir, "config.js")); !os.IsNotExist(err) {
		t.Errorf("a gateway that was not asked to write a file wrote into the bundle: %v", err)
	}

	// Named, it is written at start and after every save — the two moments a page could load it.
	path := filepath.Join(t.TempDir(), "config.js")
	gateway, _ := settingsGateway(t, config.WithRuntimeConfigPath(path))
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("no first-paint file after start: %v", err)
	}
	if status, body := doJSON(t, gateway.Client(), http.MethodPut, gateway.URL+"/api/settings", map[string]any{
		"settings": map[string]any{"locale": "zh-CN"},
	}); status != http.StatusOK {
		t.Fatalf("put = %d: %v", status, body)
	}
	written, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read after save: %v", err)
	}
	if !strings.Contains(string(written), `"locale":"zh-CN"`) {
		t.Errorf("the save did not reach the named file:\n%s", written)
	}
}

// doScript fetches the first-paint script with the body read.
func doScript(t *testing.T, gateway *httptest.Server) (int, string, http.Header) {
	t.Helper()
	response, err := gateway.Client().Get(gateway.URL + "/config.js")
	if err != nil {
		t.Fatalf("get /config.js: %v", err)
	}
	defer response.Body.Close()
	raw, _ := io.ReadAll(response.Body)
	return response.StatusCode, string(raw), response.Header
}
