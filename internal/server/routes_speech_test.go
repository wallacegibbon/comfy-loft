package server

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"comfyloft/internal/httpx"
)

/**
 * The hop to the speech server.
 *
 * Everything worth asserting here is invisible from the outside: that the audio arrives at the configured
 * address as a multipart `file`, that the fields the page sent are the fields that got there (and that the
 * address itself did not), and that a refusal is passed on in the speech server's own words rather than
 * being translated into something vaguer.
 */

// speechAnswer is what the fake speech server makes of one request.
type speechAnswer struct {
	path     string
	model    string
	language string
	auth     string
	key      string
	audio    []byte
	url      string
	filename string
}

// fakeSpeech starts a stand-in for the OpenAI-compatible endpoint. `reply` writes the answer.
func fakeSpeech(t *testing.T, got *speechAnswer, reply func(w http.ResponseWriter)) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		form, err := httpx.ParseMultipart(r, 0)
		if err != nil {
			t.Errorf("the forwarded request is not multipart: %v", err)
			http.Error(w, "not multipart", http.StatusBadRequest)
			return
		}
		if got != nil {
			got.path = r.URL.Path
			got.model = firstValue(form.Values, "model")
			got.language = firstValue(form.Values, "language")
			got.auth = r.Header.Get("Authorization")
			got.key = firstValue(form.Values, "key")
			got.url = firstValue(form.Values, "url")
			if len(form.Files) > 0 {
				got.audio = form.Files[0].Bytes
				got.filename = form.Files[0].Filename
			}
		}
		reply(w)
	}))
}

// speechPost sends one recording through the server.
func speechPost(t *testing.T, server *httptest.Server, fields map[string]string, audio []byte) (int, map[string]any) {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for name, value := range fields {
		if err := writer.WriteField(name, value); err != nil {
			t.Fatalf("write field %s: %v", name, err)
		}
	}
	if audio != nil {
		part, err := writer.CreateFormFile("file", "speech.wav")
		if err != nil {
			t.Fatalf("create file part: %v", err)
		}
		if _, err := part.Write(audio); err != nil {
			t.Fatalf("write audio: %v", err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close multipart: %v", err)
	}
	request, err := http.NewRequest(http.MethodPost, server.URL+"/api/speech/transcriptions", &body)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	request.Header.Set("Content-Type", writer.FormDataContentType())
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatalf("post speech: %v", err)
	}
	defer response.Body.Close()
	var decoded map[string]any
	_ = json.NewDecoder(response.Body).Decode(&decoded)
	return response.StatusCode, decoded
}

func TestSpeechForwardsTheRecordingToTheAddressItWasGiven(t *testing.T) {
	var got speechAnswer
	speech := fakeSpeech(t, &got, func(w http.ResponseWriter) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"text":   "帮我画一只猫",
			"timing": map[string]any{"wall_ms": 271.5, "audio_duration_ms": 1000, "rtf": 0.2715},
		})
	})
	defer speech.Close()

	server := newTestServer(t, newFakeComfy(t))
	if err := server.speechKey.Set("sk-test"); err != nil {
		t.Fatalf("store the key: %v", err)
	}
	httpServer := httptest.NewServer(server.Handler())
	defer httpServer.Close()

	audio := []byte("RIFF\x24\x00\x00\x00WAVEfmt " + string(make([]byte, 16)))
	// A model name this build has never heard of, because the name is the page's to know: a build that
	// forwarded its own constant would pass a test that sent `refine`.
	status, payload := speechPost(t, httpServer, map[string]string{
		"url":      speech.URL + "/v1/audio/transcriptions",
		"model":    "whisper-1",
		"language": "zh",
		"key":      "sk-from-the-request",
	}, audio)
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200: %v", status, payload)
	}
	if payload["text"] != "帮我画一只猫" {
		t.Errorf("text = %v, want the speech server's transcript", payload["text"])
	}

	if got.path != "/v1/audio/transcriptions" {
		t.Errorf("path = %q, want /v1/audio/transcriptions", got.path)
	}
	if got.model != "whisper-1" || got.language != "zh" {
		t.Errorf("model/language = %q/%q, want whisper-1/zh", got.model, got.language)
	}
	if !bytes.Equal(got.audio, audio) {
		t.Errorf("the audio arrived as %d bytes, want the %d that were sent", len(got.audio), len(audio))
	}
	if got.filename != "speech.wav" {
		t.Errorf("filename = %q, want speech.wav", got.filename)
	}
	// The address is this server's business: a speech server that receives `url` is one that could be
	// pointed at itself by a field that was only ever meant to be a destination.
	if got.url != "" {
		t.Errorf("the forwarded request carries url = %q, want it dropped", got.url)
	}
	// The credential comes from this server's own store and from nowhere else: a `key` field in the request
	// is not an override, and it is not a form field either — the protocol has no such field.
	if got.auth != "Bearer sk-test" {
		t.Errorf("Authorization = %q, want the stored key as a Bearer token", got.auth)
	}
	if got.key != "" {
		t.Errorf("the forwarded request carries key = %q, want it dropped", got.key)
	}
}

// A server no credential was given must not be sent one: an `Authorization` header invented on behalf of a
// stored key that does not exist is a header the user never asked for.
func TestSpeechInvitesNoCredentialWhenNoneIsStored(t *testing.T) {
	var got speechAnswer
	speech := fakeSpeech(t, &got, func(w http.ResponseWriter) {
		_ = json.NewEncoder(w).Encode(map[string]any{"text": "你好"})
	})
	defer speech.Close()

	server := httptest.NewServer(newTestServer(t, newFakeComfy(t)).Handler())
	defer server.Close()

	status, payload := speechPost(t, server, map[string]string{"url": speech.URL, "model": "refine"}, []byte("RIFF"))
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200: %v", status, payload)
	}
	if got.auth != "" {
		t.Errorf("Authorization = %q, want no header at all", got.auth)
	}
}

// The key is write-only over HTTP: it can be stored and cleared, and the only thing that ever comes back is
// whether one is there. The page is not allowed to hold it — `data/settings.json` is served to every browser
// that loads the canvas, so a key in it would be a key for anyone who can reach the server (#246).
func TestSpeechKeyIsStoredOnDiskAndNeverSentBack(t *testing.T) {
	server := newTestServer(t, newFakeComfy(t))
	httpServer := httptest.NewServer(server.Handler())
	defer httpServer.Close()

	status, payload := keyGet(t, httpServer)
	if status != http.StatusOK || payload["stored"] != false {
		t.Fatalf("status/stored = %d/%v, want 200/false", status, payload["stored"])
	}

	status, payload = keyPut(t, httpServer, map[string]any{"key": "  sk-test  "})
	if status != http.StatusOK || payload["stored"] != true {
		t.Fatalf("status/stored = %d/%v, want 200/true: %v", status, payload["stored"], payload)
	}
	if server.speechKey.Get() != "sk-test" {
		t.Errorf("stored key = %q, want it trimmed to sk-test", server.speechKey.Get())
	}
	info, err := os.Stat(filepath.Join(server.cfg.DataDir, "speech-key.json"))
	if err != nil {
		t.Fatalf("the key was not written: %v", err)
	}
	// Owner-only: a task index that only its owner can read is a workspace somebody cannot copy; a credential
	// that a second account can read is a credential that has leaked.
	if mode := info.Mode().Perm(); mode != 0o600 {
		t.Errorf("file mode = %o, want 600", mode)
	}

	// The status is the only answer that ever carries anything: no route returns the key itself.
	status, payload = keyGet(t, httpServer)
	if status != http.StatusOK || payload["stored"] != true {
		t.Errorf("status/stored = %d/%v, want 200/true", status, payload["stored"])
	}
	for name, value := range payload {
		if value == "sk-test" {
			t.Errorf("GET /api/speech/key answered the key itself in %q", name)
		}
	}

	// Blank clears it, and the file goes with it.
	status, payload = keyPut(t, httpServer, map[string]any{"key": ""})
	if status != http.StatusOK || payload["stored"] != false {
		t.Fatalf("status/stored = %d/%v, want 200/false", status, payload["stored"])
	}
	if _, err := os.Stat(filepath.Join(server.cfg.DataDir, "speech-key.json")); !os.IsNotExist(err) {
		t.Errorf("the cleared key is still on disk: %v", err)
	}
}

// 401, 413 and 429 are three different things to the person reading the panel — a wrong key, a recording
// that is too long, and a provider asking for less traffic — and a 400 for all three says none of them.
func TestSpeechKeepsTheStatusThatSaysWhatWentWrong(t *testing.T) {
	cases := []struct {
		name   string
		status int
		want   int
	}{
		{"the key was refused", http.StatusUnauthorized, http.StatusUnauthorized},
		{"the recording is too long", http.StatusRequestEntityTooLarge, http.StatusRequestEntityTooLarge},
		{"too fast", http.StatusTooManyRequests, http.StatusTooManyRequests},
		{"the far side is broken", http.StatusInternalServerError, http.StatusBadGateway},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			speech := fakeSpeech(t, nil, func(w http.ResponseWriter) {
				w.WriteHeader(testCase.status)
				_ = json.NewEncoder(w).Encode(map[string]any{
					"error": map[string]any{"message": "Incorrect API key provided"},
				})
			})
			defer speech.Close()

			server := httptest.NewServer(newTestServer(t, newFakeComfy(t)).Handler())
			defer server.Close()

			status, payload := speechPost(t, server, map[string]string{"url": speech.URL, "model": "whisper-1"}, []byte("RIFF"))
			if status != testCase.want {
				t.Fatalf("status = %d, want %d: %v", status, testCase.want, payload)
			}
			failure, _ := payload["error"].(map[string]any)
			if failure["message"] != "Incorrect API key provided" {
				t.Errorf("message = %v, want the speech server's own sentence", failure["message"])
			}
		})
	}
}

// The key endpoint takes a string and nothing else: a document with no `key` is a typo, not a clear, and a
// clear has to be spellable as one (`{"key":""}`).
func TestSpeechKeyRefusesWhatItCannotRead(t *testing.T) {
	server := httptest.NewServer(newTestServer(t, newFakeComfy(t)).Handler())
	defer server.Close()

	cases := []struct {
		name string
		body map[string]any
		code string
	}{
		{"no key field", map[string]any{}, "speech_key_missing"},
		{"a key that is not a string", map[string]any{"key": 5}, "speech_key_invalid"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			status, payload := keyPut(t, server, testCase.body)
			if status != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400: %v", status, payload)
			}
			failure, _ := payload["error"].(map[string]any)
			if failure["code"] != testCase.code {
				t.Errorf("code = %v, want %s", failure["code"], testCase.code)
			}
		})
	}
}

// keyGet reads GET /api/speech/key.
func keyGet(t *testing.T, server *httptest.Server) (int, map[string]any) {
	t.Helper()
	response, err := server.Client().Get(server.URL + "/api/speech/key")
	if err != nil {
		t.Fatalf("get speech key: %v", err)
	}
	defer response.Body.Close()
	var decoded map[string]any
	_ = json.NewDecoder(response.Body).Decode(&decoded)
	return response.StatusCode, decoded
}

// keyPut writes PUT /api/speech/key.
func keyPut(t *testing.T, server *httptest.Server, body map[string]any) (int, map[string]any) {
	t.Helper()
	payload, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	request, err := http.NewRequest(http.MethodPut, server.URL+"/api/speech/key", bytes.NewReader(payload))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := server.Client().Do(request)
	if err != nil {
		t.Fatalf("put speech key: %v", err)
	}
	defer response.Body.Close()
	var decoded map[string]any
	_ = json.NewDecoder(response.Body).Decode(&decoded)
	return response.StatusCode, decoded
}

func TestSpeechPassesOnWhyTheServerRefused(t *testing.T) {
	speech := fakeSpeech(t, nil, func(w http.ResponseWriter) {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error": map[string]any{"message": "only WAV audio uploads are currently supported for transcription"},
		})
	})
	defer speech.Close()

	server := httptest.NewServer(newTestServer(t, newFakeComfy(t)).Handler())
	defer server.Close()

	status, payload := speechPost(t, server, map[string]string{"url": speech.URL, "model": "refine"}, []byte("not a wav"))
	if status != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", status)
	}
	// Word for word: it names the thing to change, and this route has nothing better to say.
	failure, _ := payload["error"].(map[string]any)
	if failure["message"] != "only WAV audio uploads are currently supported for transcription" {
		t.Errorf("message = %v, want the speech server's own sentence", failure["message"])
	}
}

func TestSpeechRefusesWhatItCannotSend(t *testing.T) {
	server := httptest.NewServer(newTestServer(t, newFakeComfy(t)).Handler())
	defer server.Close()

	cases := []struct {
		name   string
		fields map[string]string
		audio  []byte
		code   string
	}{
		{"no address", map[string]string{}, []byte("RIFF"), "speech_address_missing"},
		{"not an http address", map[string]string{"url": "ftp://127.0.0.1:18080/v1/audio/transcriptions"}, []byte("RIFF"), "speech_address_invalid"},
		{"no audio", map[string]string{"url": "http://127.0.0.1:18080/v1/audio/transcriptions"}, nil, "speech_no_audio"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			status, payload := speechPost(t, server, testCase.fields, testCase.audio)
			if status != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400: %v", status, payload)
			}
			failure, _ := payload["error"].(map[string]any)
			if failure["code"] != testCase.code {
				t.Errorf("code = %v, want %s", failure["code"], testCase.code)
			}
		})
	}
}

// An address that nothing is listening on is the likely failure of a hand-typed port, and the sentence has
// to carry the address: "could not reach anything" leaves the user looking at the wrong setting.
func TestSpeechSaysWhichAddressItCouldNotReach(t *testing.T) {
	server := httptest.NewServer(newTestServer(t, newFakeComfy(t)).Handler())
	defer server.Close()

	// A closed port: opened and closed here, so it is a real refusal rather than a slow dial.
	dead := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	address := dead.URL + "/v1/audio/transcriptions"
	dead.Close()

	status, payload := speechPost(t, server, map[string]string{"url": address, "model": "refine"}, []byte("RIFF"))
	if status != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502: %v", status, payload)
	}
	failure, _ := payload["error"].(map[string]any)
	message, _ := failure["message"].(string)
	if !bytes.Contains([]byte(message), []byte(address)) {
		t.Errorf("message = %q, want it to name %s", message, address)
	}
}
