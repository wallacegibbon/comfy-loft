package server

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

// canvasGateway is a gateway with a canvas root of its own, so a test never sees another test's
// canvases (or the developer's).
func canvasGateway(t *testing.T) *httptest.Server {
	t.Helper()
	gateway := httptest.NewServer(newTestGateway(t, newFakeComfy(t)).Handler())
	t.Cleanup(gateway.Close)
	return gateway
}

// doJSONRev is doJSON with a body and an If-Match header.
func doJSONRev(t *testing.T, client *http.Client, method, url string, body any, rev string) (int, map[string]any, http.Header) {
	t.Helper()
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal request: %v", err)
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequest(method, url, reader)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if rev != "" {
		request.Header.Set("If-Match", `"`+rev+`"`)
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatalf("%s %s: %v", method, url, err)
	}
	defer response.Body.Close()
	raw, _ := io.ReadAll(response.Body)
	var decoded map[string]any
	_ = json.Unmarshal(raw, &decoded)
	return response.StatusCode, decoded, response.Header
}

// canvasOf unwraps the {ok, canvas} payload these endpoints return.
func canvasOf(t *testing.T, payload map[string]any) (id, rev, document string) {
	t.Helper()
	canvas, ok := payload["canvas"].(map[string]any)
	if !ok {
		t.Fatalf("payload has no canvas: %v", payload)
	}
	id, _ = canvas["id"].(string)
	rev, _ = canvas["rev"].(string)
	if raw, present := canvas["document"]; present {
		encoded, err := json.Marshal(raw)
		if err != nil {
			t.Fatalf("marshal document: %v", err)
		}
		document = string(encoded)
	}
	if id == "" || rev == "" {
		t.Fatalf("canvas payload lacks id or rev: %v", canvas)
	}
	return id, rev, document
}

func TestCanvasLifecycleOverHTTP(t *testing.T) {
	gateway := canvasGateway(t)
	client := gateway.Client()

	// Create carries the document, so one request makes a canvas that is already something.
	status, payload := doJSON(t, client, http.MethodPost, gateway.URL+"/api/canvases", map[string]any{
		"title":    "First canvas",
		"document": map[string]any{"nodes": []any{map[string]any{"id": "n1", "type": "text"}}, "viewport": map[string]any{"x": 0, "y": 0, "k": 1}},
	})
	if status != http.StatusOK {
		t.Fatalf("create status = %d: %v", status, payload)
	}
	id, rev, document := canvasOf(t, payload)
	if title, _ := payload["canvas"].(map[string]any)["title"].(string); title != "First canvas" {
		t.Errorf("title = %q", title)
	}
	if document == "" || document == "{}" {
		t.Errorf("document = %q, want the one that was sent", document)
	}

	// It is in the list.
	status, payload = doJSON(t, client, http.MethodGet, gateway.URL+"/api/canvases", nil)
	if status != http.StatusOK {
		t.Fatalf("list status = %d", status)
	}
	canvases, _ := payload["canvases"].([]any)
	if len(canvases) != 1 {
		t.Fatalf("list returned %d canvases: %v", len(canvases), payload)
	}

	// Reading it back gives the same rev and document.
	status, payload = doJSON(t, client, http.MethodGet, gateway.URL+"/api/canvases/"+id, nil)
	if status != http.StatusOK {
		t.Fatalf("get status = %d", status)
	}
	readID, readRev, readDocument := canvasOf(t, payload)
	if readID != id || readRev != rev || readDocument != document {
		t.Errorf("read %s/%s/%s, created %s/%s/%s", readID, readRev, readDocument, id, rev, document)
	}

	// Saving with the rev that was just read is accepted and moves the rev on.
	status, payload, _ = doJSONRev(t, client, http.MethodPut, gateway.URL+"/api/canvases/"+id, map[string]any{
		"document": map[string]any{"nodes": []any{}},
	}, rev)
	if status != http.StatusOK {
		t.Fatalf("save status = %d: %v", status, payload)
	}
	summary, _ := payload["summary"].(map[string]any)
	nextRev, _ := summary["rev"].(string)
	if nextRev == "" || nextRev == rev {
		t.Errorf("rev after save = %q, want a new one", nextRev)
	}

	// Deleting it makes it not found, twice over.
	if status, payload = doJSON(t, client, http.MethodDelete, gateway.URL+"/api/canvases/"+id, nil); status != http.StatusOK {
		t.Fatalf("delete status = %d: %v", status, payload)
	}
	if status, _ = doJSON(t, client, http.MethodGet, gateway.URL+"/api/canvases/"+id, nil); status != http.StatusNotFound {
		t.Errorf("get after delete = %d, want 404", status)
	}
	if status, _ = doJSON(t, client, http.MethodDelete, gateway.URL+"/api/canvases/"+id, nil); status != http.StatusNotFound {
		t.Errorf("second delete = %d, want 404", status)
	}
}

func TestCanvasSaveOnAStaleRevIsAConflictThatCarriesTheCurrentOne(t *testing.T) {
	gateway := canvasGateway(t)
	client := gateway.Client()

	_, payload, _ := doJSONRev(t, client, http.MethodPost, gateway.URL+"/api/canvases", map[string]any{"title": "shared"}, "")
	id, rev, _ := canvasOf(t, payload)

	status, saved, _ := doJSONRev(t, client, http.MethodPut, gateway.URL+"/api/canvases/"+id, map[string]any{"document": map[string]any{"winner": true}}, rev)
	if status != http.StatusOK {
		t.Fatalf("first save = %d: %v", status, saved)
	}
	currentRev, _ := saved["summary"].(map[string]any)["rev"].(string)

	status, payload, _ = doJSONRev(t, client, http.MethodPut, gateway.URL+"/api/canvases/"+id, map[string]any{"document": map[string]any{"loser": true}}, rev)
	if status != http.StatusConflict {
		t.Fatalf("stale save = %d, want 409: %v", status, payload)
	}
	failure, _ := payload["error"].(map[string]any)
	if code, _ := failure["code"].(string); code != "canvas_conflict" {
		t.Errorf("code = %q, want canvas_conflict", code)
	}
	details, _ := failure["details"].(map[string]any)
	conflict, _ := details["current"].(map[string]any)
	if conflictRev, _ := conflict["rev"].(string); conflictRev != currentRev {
		t.Errorf("conflict carries rev %q, want %q", conflictRev, currentRev)
	}
}

func TestCanvasSaveWithoutAPreconditionIsAccepted(t *testing.T) {
	gateway := canvasGateway(t)
	client := gateway.Client()

	_, payload := doJSON(t, client, http.MethodPost, gateway.URL+"/api/canvases", map[string]any{"title": "no rev"})
	id, _, _ := canvasOf(t, payload)

	status, saved, _ := doJSONRev(t, client, http.MethodPut, gateway.URL+"/api/canvases/"+id, map[string]any{"document": map[string]any{"nodes": []any{}}}, "")
	if status != http.StatusOK {
		t.Fatalf("save without If-Match = %d: %v", status, saved)
	}
}

func TestCanvasIdsAndDocumentsThatAreWrongAreBadRequests(t *testing.T) {
	gateway := canvasGateway(t)
	client := gateway.Client()

	_, payload := doJSON(t, client, http.MethodPost, gateway.URL+"/api/canvases", map[string]any{"title": "ok"})
	id, rev, _ := canvasOf(t, payload)

	for _, bad := range []string{"ABC", "zzzzzzzzzzzz", "..%2Fetc%2Fpasswd", "abcdefabcdef00"} {
		if status, body := doJSON(t, client, http.MethodGet, gateway.URL+"/api/canvases/"+bad, nil); status != http.StatusBadRequest {
			t.Errorf("GET %q = %d (%v), want 400", bad, status, body)
		}
	}

	status, body, _ := doJSONRev(t, client, http.MethodPut, gateway.URL+"/api/canvases/"+id, map[string]any{"document": []any{1, 2, 3}}, rev)
	if status != http.StatusBadRequest {
		t.Errorf("array document = %d (%v), want 400", status, body)
	}
	if failure, _ := body["error"].(map[string]any); failure["code"] != "canvas_invalid_document" {
		t.Errorf("code = %v, want canvas_invalid_document", failure["code"])
	}
}

func TestCanvasSaveKeepsATitleItWasNotGiven(t *testing.T) {
	gateway := canvasGateway(t)
	client := gateway.Client()

	_, payload := doJSON(t, client, http.MethodPost, gateway.URL+"/api/canvases", map[string]any{"title": "do not lose me"})
	id, rev, _ := canvasOf(t, payload)

	if status, body, _ := doJSONRev(t, client, http.MethodPut, gateway.URL+"/api/canvases/"+id, map[string]any{"document": map[string]any{"nodes": []any{}}}, rev); status != http.StatusOK {
		t.Fatalf("save = %d: %v", status, body)
	}
	_, payload = doJSON(t, client, http.MethodGet, gateway.URL+"/api/canvases/"+id, nil)
	if title, _ := payload["canvas"].(map[string]any)["title"].(string); title != "do not lose me" {
		t.Errorf("title = %q, want it untouched by a save", title)
	}
}
