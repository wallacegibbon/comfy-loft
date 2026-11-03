package server

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sort"
	"strings"
	"testing"
)

// canvasServer is a server with a canvas root of its own, so a test never sees another test's
// canvases (or the developer's).
func canvasServer(t *testing.T) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(newTestServer(t, newFakeComfy(t)).Handler())
	t.Cleanup(server.Close)
	return server
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
	server := canvasServer(t)
	client := server.Client()

	// Create carries the document, so one request makes a canvas that is already something.
	status, payload := doJSON(t, client, http.MethodPost, server.URL+"/api/canvases", map[string]any{
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
	status, payload = doJSON(t, client, http.MethodGet, server.URL+"/api/canvases", nil)
	if status != http.StatusOK {
		t.Fatalf("list status = %d", status)
	}
	canvases, _ := payload["canvases"].([]any)
	if len(canvases) != 1 {
		t.Fatalf("list returned %d canvases: %v", len(canvases), payload)
	}

	// Reading it back gives the same rev and document.
	status, payload = doJSON(t, client, http.MethodGet, server.URL+"/api/canvases/"+id, nil)
	if status != http.StatusOK {
		t.Fatalf("get status = %d", status)
	}
	readID, readRev, readDocument := canvasOf(t, payload)
	if readID != id || readRev != rev || readDocument != document {
		t.Errorf("read %s/%s/%s, created %s/%s/%s", readID, readRev, readDocument, id, rev, document)
	}

	// Saving with the rev that was just read is accepted and moves the rev on.
	status, payload, _ = doJSONRev(t, client, http.MethodPut, server.URL+"/api/canvases/"+id, map[string]any{
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
	if status, payload = doJSON(t, client, http.MethodDelete, server.URL+"/api/canvases/"+id, nil); status != http.StatusOK {
		t.Fatalf("delete status = %d: %v", status, payload)
	}
	if status, _ = doJSON(t, client, http.MethodGet, server.URL+"/api/canvases/"+id, nil); status != http.StatusNotFound {
		t.Errorf("get after delete = %d, want 404", status)
	}
	if status, _ = doJSON(t, client, http.MethodDelete, server.URL+"/api/canvases/"+id, nil); status != http.StatusNotFound {
		t.Errorf("second delete = %d, want 404", status)
	}
}

func TestCanvasSaveOnAStaleRevIsAConflictThatCarriesTheCurrentOne(t *testing.T) {
	server := canvasServer(t)
	client := server.Client()

	_, payload, _ := doJSONRev(t, client, http.MethodPost, server.URL+"/api/canvases", map[string]any{"title": "shared"}, "")
	id, rev, _ := canvasOf(t, payload)

	status, saved, _ := doJSONRev(t, client, http.MethodPut, server.URL+"/api/canvases/"+id, map[string]any{"document": map[string]any{"winner": true}}, rev)
	if status != http.StatusOK {
		t.Fatalf("first save = %d: %v", status, saved)
	}
	currentRev, _ := saved["summary"].(map[string]any)["rev"].(string)

	status, payload, _ = doJSONRev(t, client, http.MethodPut, server.URL+"/api/canvases/"+id, map[string]any{"document": map[string]any{"loser": true}}, rev)
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
	server := canvasServer(t)
	client := server.Client()

	_, payload := doJSON(t, client, http.MethodPost, server.URL+"/api/canvases", map[string]any{"title": "no rev"})
	id, _, _ := canvasOf(t, payload)

	status, saved, _ := doJSONRev(t, client, http.MethodPut, server.URL+"/api/canvases/"+id, map[string]any{"document": map[string]any{"nodes": []any{}}}, "")
	if status != http.StatusOK {
		t.Fatalf("save without If-Match = %d: %v", status, saved)
	}
}

func TestCanvasIdsAndDocumentsThatAreWrongAreBadRequests(t *testing.T) {
	server := canvasServer(t)
	client := server.Client()

	_, payload := doJSON(t, client, http.MethodPost, server.URL+"/api/canvases", map[string]any{"title": "ok"})
	id, rev, _ := canvasOf(t, payload)

	for _, bad := range []string{"ABC", "zzzzzzzzzzzz", "..%2Fetc%2Fpasswd", "abcdefabcdef00"} {
		if status, body := doJSON(t, client, http.MethodGet, server.URL+"/api/canvases/"+bad, nil); status != http.StatusBadRequest {
			t.Errorf("GET %q = %d (%v), want 400", bad, status, body)
		}
	}

	status, body, _ := doJSONRev(t, client, http.MethodPut, server.URL+"/api/canvases/"+id, map[string]any{"document": []any{1, 2, 3}}, rev)
	if status != http.StatusBadRequest {
		t.Errorf("array document = %d (%v), want 400", status, body)
	}
	if failure, _ := body["error"].(map[string]any); failure["code"] != "canvas_invalid_document" {
		t.Errorf("code = %v, want canvas_invalid_document", failure["code"])
	}
}

func TestCanvasSaveKeepsATitleItWasNotGiven(t *testing.T) {
	server := canvasServer(t)
	client := server.Client()

	_, payload := doJSON(t, client, http.MethodPost, server.URL+"/api/canvases", map[string]any{"title": "do not lose me"})
	id, rev, _ := canvasOf(t, payload)

	if status, body, _ := doJSONRev(t, client, http.MethodPut, server.URL+"/api/canvases/"+id, map[string]any{"document": map[string]any{"nodes": []any{}}}, rev); status != http.StatusOK {
		t.Fatalf("save = %d: %v", status, body)
	}
	_, payload = doJSON(t, client, http.MethodGet, server.URL+"/api/canvases/"+id, nil)
	if title, _ := payload["canvas"].(map[string]any)["title"].(string); title != "do not lose me" {
		t.Errorf("title = %q, want it untouched by a save", title)
	}
}

// Media belongs to a canvas: an upload lands in its files, is served from there, and is invisible from
// any other canvas (docs/decisions.md #156).
func TestCanvasFilesBelongToTheirCanvas(t *testing.T) {
	server, _ := settingsServer(t)
	client := server.Client()

	_, payload := doJSON(t, client, http.MethodPost, server.URL+"/api/canvases", map[string]any{"title": "with media"})
	canvasID, _, _ := canvasOf(t, payload)
	otherPayload := mustCreateCanvas(t, client, server.URL, "second")
	otherID, _, _ := canvasOf(t, otherPayload)

	status, body := postUpload(t, server.URL+"/api/canvases/"+canvasID+"/uploads", "note.png", "image/png", []byte("PNG"))
	if status != http.StatusOK {
		t.Fatalf("upload = %d %v", status, body)
	}
	upload, _ := body["upload"].(map[string]any)
	name, _ := upload["id"].(string)
	fileURL, _ := upload["url"].(string)
	if name == "" || fileURL != "/api/canvases/"+canvasID+"/files/"+name {
		t.Fatalf("upload = %v", upload)
	}

	response, err := client.Get(server.URL + fileURL)
	if err != nil {
		t.Fatalf("get file: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("file status = %d", response.StatusCode)
	}
	if cache := response.Header.Get("Cache-Control"); !strings.Contains(cache, "immutable") {
		t.Errorf("cache-control = %q, want it cacheable", cache)
	}

	// Another canvas cannot read it.
	response, err = client.Get(server.URL + "/api/canvases/" + otherID + "/files/" + name)
	if err != nil {
		t.Fatalf("get from the other canvas: %v", err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusNotFound {
		t.Errorf("cross-canvas read = %d, want 404", response.StatusCode)
	}

	// A run or an upload for a canvas that is not there is refused rather than written somewhere.
	if status, _ := doJSON(t, client, http.MethodPost, server.URL+"/api/canvases/0123456789ab/runs", map[string]any{"workflow": "x"}); status != http.StatusNotFound {
		t.Errorf("run for an unknown canvas = %d, want 404", status)
	}
	if status, _ := postUpload(t, server.URL+"/api/canvases/0123456789ab/uploads", "a.png", "image/png", []byte("PNG")); status != http.StatusNotFound {
		t.Errorf("upload for an unknown canvas = %d, want 404", status)
	}
}

// mustCreateCanvas creates a canvas over HTTP and returns its id.
func mustCreateCanvas(t *testing.T, client *http.Client, base, title string) map[string]any {
	t.Helper()
	status, payload := doJSON(t, client, http.MethodPost, base+"/api/canvases", map[string]any{"title": title})
	if status != http.StatusOK {
		t.Fatalf("create canvas %q = %d: %v", title, status, payload)
	}
	return payload
}

// Importing is one archive in, one canvas out: the files keep the names the document uses, the document is
// stored as it came out of the zip, and a failed import leaves nothing behind (decisions #172).
func TestImportingAnArchiveRestoresTheCanvasAsItWasExported(t *testing.T) {
	server := canvasServer(t)
	client := server.Client()

	document := map[string]any{
		"nodes": []any{map[string]any{
			"id": "n1", "type": "image", "title": "red",
			"metadata": map[string]any{"content": "files/up-a1b2c3d4.png", "storageKey": "files/up-a1b2c3d4.png"},
		}},
		"connections":    []any{},
		"backgroundMode": "lines",
		"showImageInfo":  false,
		"viewport":       map[string]any{"x": 0, "y": 0, "k": 1},
	}
	archive := buildImportArchive(t, map[string][]byte{
		"manifest.json":         []byte(`{"app":"comfyloft","version":1,"title":"restored"}`),
		"canvas.json":           mustMarshal(t, document),
		"files/up-a1b2c3d4.png": []byte("PNG-bytes"),
	})

	status, payload := postArchive(t, client, server.URL+"/api/canvases/import", archive)
	if status != http.StatusOK {
		t.Fatalf("import = %d: %v", status, payload)
	}
	id, _, restoredDocument := canvasOf(t, payload)
	if title, _ := payload["canvas"].(map[string]any)["title"].(string); title != "restored" {
		t.Errorf("title = %q, want the manifest's", title)
	}
	var got, want any
	_ = json.Unmarshal([]byte(restoredDocument), &got)
	_ = json.Unmarshal(mustMarshal(t, document), &want)
	if !reflect.DeepEqual(got, want) {
		t.Errorf("document = %s, want the exported one", restoredDocument)
	}

	// The file is there under the name the document uses, byte for byte.
	response, err := client.Get(server.URL + "/api/canvases/" + id + "/files/up-a1b2c3d4.png")
	if err != nil {
		t.Fatalf("get file: %v", err)
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(response.Body)
	if response.StatusCode != http.StatusOK || string(body) != "PNG-bytes" {
		t.Errorf("file = %d %q", response.StatusCode, body)
	}
}

// An export is a directory, and a directory that somebody unzipped and zipped again carries a `files/`
// entry that is an empty directory: `zip -r`, Archive Utility and Explorer all write one. That entry is
// not a canvas file and not an unexpected shape — the ordinary way of moving an export has to import.
func TestAnImportAcceptsTheDirectoryEntriesARezipAdds(t *testing.T) {
	server := canvasServer(t)
	client := server.Client()

	archive := buildImportArchive(t, map[string][]byte{
		"manifest.json":         []byte(`{"app":"comfyloft","version":1,"title":"re-zipped"}`),
		"canvas.json":           []byte(`{"nodes":[],"connections":[]}`),
		"files/":                nil,
		"files/up-a1b2c3d4.png": []byte("PNG-bytes"),
	})

	status, payload := postArchive(t, client, server.URL+"/api/canvases/import", archive)
	if status != http.StatusOK {
		t.Fatalf("import = %d: %v", status, payload)
	}
	id, _, _ := canvasOf(t, payload)
	response, err := client.Get(server.URL + "/api/canvases/" + id + "/files/up-a1b2c3d4.png")
	if err != nil {
		t.Fatalf("get file: %v", err)
	}
	defer response.Body.Close()
	if body, _ := io.ReadAll(response.Body); response.StatusCode != http.StatusOK || string(body) != "PNG-bytes" {
		t.Errorf("file = %d %q", response.StatusCode, body)
	}
}

func TestAnArchiveThatIsNotOneCanvasIsRefused(t *testing.T) {
	server := canvasServer(t)
	client := server.Client()

	old := buildImportArchive(t, map[string][]byte{
		"projects.json":                      []byte(`{"app":"comfyloft","version":3,"projects":[]}`),
		"projects/abc/files/up-a1b2c3d4.png": []byte("PNG"),
	})
	if status, payload := postArchive(t, client, server.URL+"/api/canvases/import", old); status != http.StatusUnprocessableEntity || codeOf(payload) != "import_old_format" {
		t.Errorf("old format = %d %v, want 422 import_old_format", status, payload)
	}

	noDocument := buildImportArchive(t, map[string][]byte{"manifest.json": []byte(`{"title":"x"}`)})
	if status, payload := postArchive(t, client, server.URL+"/api/canvases/import", noDocument); status != http.StatusBadRequest || codeOf(payload) != "import_no_document" {
		t.Errorf("no document = %d %v, want 400 import_no_document", status, payload)
	}

	escaping := buildImportArchive(t, map[string][]byte{
		"canvas.json":         []byte(`{"nodes":[]}`),
		"files/../escape.png": []byte("x"),
	})
	if status, payload := postArchive(t, client, server.URL+"/api/canvases/import", escaping); status != http.StatusUnprocessableEntity || codeOf(payload) != "import_invalid_entry" {
		t.Errorf("escaping entry = %d %v, want 422 import_invalid_entry", status, payload)
	}

	if status, payload := postArchive(t, client, server.URL+"/api/canvases/import", []byte("not a zip")); status != http.StatusBadRequest || codeOf(payload) != "import_not_a_zip" {
		t.Errorf("not a zip = %d %v, want 400 import_not_a_zip", status, payload)
	}

	// Nothing was created by any of that.
	if _, payload := doJSON(t, client, http.MethodGet, server.URL+"/api/canvases", nil); len(payload["canvases"].([]any)) != 0 {
		t.Errorf("a refused import left a canvas behind: %v", payload)
	}
}

// mustCreateCanvas creates a canvas over HTTP and returns its id.
func buildImportArchive(t *testing.T, entries map[string][]byte) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := zip.NewWriter(&buffer)
	names := make([]string, 0, len(entries))
	for name := range entries {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		// A key that ends in a separator is a directory entry: a zip tool writes one for every folder, and
		// a canvas that was unzipped and re-zipped has one for `files/`.
		if strings.HasSuffix(name, "/") {
			if _, err := writer.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Store}); err != nil {
				t.Fatalf("zip directory %s: %v", name, err)
			}
			continue
		}
		// Stored, not deflated: these tests are about the layout, and a tiny archive is quicker to read.
		file, err := writer.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Store})
		if err != nil {
			t.Fatalf("zip entry %s: %v", name, err)
		}
		if _, err := file.Write(entries[name]); err != nil {
			t.Fatalf("zip write %s: %v", name, err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close zip: %v", err)
	}
	return buffer.Bytes()
}

// postArchive sends a body as-is, which is how an import is submitted.
func postArchive(t *testing.T, client *http.Client, url string, body []byte) (int, map[string]any) {
	t.Helper()
	request, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	request.Header.Set("Content-Type", "application/zip")
	response, err := client.Do(request)
	if err != nil {
		t.Fatalf("post archive: %v", err)
	}
	defer response.Body.Close()
	raw, _ := io.ReadAll(response.Body)
	var decoded map[string]any
	_ = json.Unmarshal(raw, &decoded)
	return response.StatusCode, decoded
}

// codeOf reads the stable error code out of a failure envelope.
func codeOf(payload map[string]any) string {
	failure, _ := payload["error"].(map[string]any)
	code, _ := failure["code"].(string)
	return code
}

// mustMarshal encodes a fixture, failing the test rather than returning nothing.
func mustMarshal(t *testing.T, value any) []byte {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return encoded
}

// An import is bounded by its own number, and a refused one leaves no canvas behind: the archive is read
// before anything is created, and the body is capped while it is still being copied.
func TestAnImportPastTheLimitIsRefusedAndLeavesNothing(t *testing.T) {
	srv := newTestServer(t, newFakeComfy(t))
	// A ceiling a real export could never fit under, so the limit is what refuses it.
	srv.cfg.MaxImportBytes = 32
	server := httptest.NewServer(srv.Handler())
	t.Cleanup(server.Close)
	client := server.Client()

	archive := buildImportArchive(t, map[string][]byte{
		"canvas.json":           []byte(`{"nodes":[]}`),
		"files/up-a1b2c3d4.png": []byte("more than thirty-two bytes of picture, certainly"),
	})
	if status, payload := postArchive(t, client, server.URL+"/api/canvases/import", archive); status != http.StatusRequestEntityTooLarge || codeOf(payload) != "import_too_large" {
		t.Errorf("oversized archive = %d %v, want 413 import_too_large", status, payload)
	}
	if _, payload := doJSON(t, client, http.MethodGet, server.URL+"/api/canvases", nil); len(payload["canvases"].([]any)) != 0 {
		t.Errorf("a refused import left a canvas behind: %v", payload)
	}
}
