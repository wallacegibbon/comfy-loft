package server

import (
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"comfyloft/internal/config"
)

// settingsGateway is a gateway with a canvas root and a first-paint file of its own.
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

// The first-paint file is what keeps the theme and the language from arriving one frame late, so it
// has to be written at start and rewritten on every save — and it carries the gateway's address when the
// operator named one, which is how a canvas served from somewhere else finds the gateway (#219).
func TestTheFirstPaintFileCarriesTheAddressAndTheSettings(t *testing.T) {
	gateway, srv := settingsGateway(t, config.WithPublicBaseURL("http://127.0.0.1:8190"))
	path := srv.cfg.RuntimeConfigPath
	if path == "" {
		t.Fatal("the test gateway has no runtime config path")
	}

	atStart, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("no first-paint file after start: %v", err)
	}
	if !strings.Contains(string(atStart), `"LOCAL_GATEWAY_URL":"http://127.0.0.1:8190"`) {
		t.Errorf("start file does not carry the address the operator named:\n%s", atStart)
	}
	if !strings.Contains(string(atStart), "SETTINGS") {
		t.Errorf("start file has no settings:\n%s", atStart)
	}

	if status, body := doJSON(t, gateway.Client(), http.MethodPut, gateway.URL+"/api/settings", map[string]any{
		"settings": map[string]any{"theme": map[string]any{"theme": "light"}, "locale": "en-US"},
	}); status != http.StatusOK {
		t.Fatalf("put = %d: %v", status, body)
	}

	afterSave, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read after save: %v", err)
	}
	text := string(afterSave)
	if !strings.Contains(text, `"theme":"light"`) {
		t.Errorf("the save did not reach the first-paint file:\n%s", text)
	}
	if !strings.Contains(text, "window.__RUNTIME_CONFIG__ = Object.assign(window.__RUNTIME_CONFIG__ || {},") {
		t.Errorf("the file is not the assignment the frontend expects:\n%s", text)
	}
	if !strings.HasSuffix(strings.TrimSpace(text), ");") {
		t.Errorf("the file does not end with the assignment:\n%s", text)
	}
}

// A gateway that serves the canvas itself names no address (#219).
//
// The page came from this origin, and its own origin is the only address that stays right behind a LAN
// name, a phone, or a reverse proxy — so writing `host:port` from the bind would replace a correct answer
// with a guess. A gateway that serves no bundle keeps saying where it is, for a canvas served elsewhere.
func TestTheFirstPaintFileSaysNoAddressWhenTheGatewayServesTheCanvas(t *testing.T) {
	_, srv := settingsGateway(t, config.WithWebDir(t.TempDir()))
	path := srv.cfg.RuntimeConfigPath
	if path == "" {
		t.Fatal("the test gateway has no runtime config path")
	}
	written, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("no first-paint file after start: %v", err)
	}
	if strings.Contains(string(written), "LOCAL_GATEWAY_URL") {
		t.Errorf("a gateway serving the canvas wrote an address of its own:\n%s", written)
	}
	if !strings.Contains(string(written), "SETTINGS") {
		t.Errorf("the settings half is still owed to the page:\n%s", written)
	}
}
