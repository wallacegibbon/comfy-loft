package server

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
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
			got.url = firstValue(form.Values, "url")
			if len(form.Files) > 0 {
				got.audio = form.Files[0].Bytes
				got.filename = form.Files[0].Filename
			}
		}
		reply(w)
	}))
}

// speechPost sends one recording through the gateway.
func speechPost(t *testing.T, gateway *httptest.Server, fields map[string]string, audio []byte) (int, map[string]any) {
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
	request, err := http.NewRequest(http.MethodPost, gateway.URL+"/api/speech/transcriptions", &body)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	request.Header.Set("Content-Type", writer.FormDataContentType())
	response, err := gateway.Client().Do(request)
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

	gateway := httptest.NewServer(newTestGateway(t, newFakeComfy(t)).Handler())
	defer gateway.Close()

	audio := []byte("RIFF\x24\x00\x00\x00WAVEfmt " + string(make([]byte, 16)))
	status, payload := speechPost(t, gateway, map[string]string{
		"url":      speech.URL + "/v1/audio/transcriptions",
		"model":    "refine",
		"language": "zh",
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
	if got.model != "refine" || got.language != "zh" {
		t.Errorf("model/language = %q/%q, want refine/zh", got.model, got.language)
	}
	if !bytes.Equal(got.audio, audio) {
		t.Errorf("the audio arrived as %d bytes, want the %d that were sent", len(got.audio), len(audio))
	}
	if got.filename != "speech.wav" {
		t.Errorf("filename = %q, want speech.wav", got.filename)
	}
	// The address is this gateway's business: a speech server that receives `url` is one that could be
	// pointed at itself by a field that was only ever meant to be a destination.
	if got.url != "" {
		t.Errorf("the forwarded request carries url = %q, want it dropped", got.url)
	}
}

func TestSpeechPassesOnWhyTheServerRefused(t *testing.T) {
	speech := fakeSpeech(t, nil, func(w http.ResponseWriter) {
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error": map[string]any{"message": "only WAV audio uploads are currently supported for transcription"},
		})
	})
	defer speech.Close()

	gateway := httptest.NewServer(newTestGateway(t, newFakeComfy(t)).Handler())
	defer gateway.Close()

	status, payload := speechPost(t, gateway, map[string]string{"url": speech.URL, "model": "refine"}, []byte("not a wav"))
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
	gateway := httptest.NewServer(newTestGateway(t, newFakeComfy(t)).Handler())
	defer gateway.Close()

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
			status, payload := speechPost(t, gateway, testCase.fields, testCase.audio)
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
	gateway := httptest.NewServer(newTestGateway(t, newFakeComfy(t)).Handler())
	defer gateway.Close()

	// A closed port: opened and closed here, so it is a real refusal rather than a slow dial.
	dead := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	address := dead.URL + "/v1/audio/transcriptions"
	dead.Close()

	status, payload := speechPost(t, gateway, map[string]string{"url": address, "model": "refine"}, []byte("RIFF"))
	if status != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502: %v", status, payload)
	}
	failure, _ := payload["error"].(map[string]any)
	message, _ := failure["message"].(string)
	if !bytes.Contains([]byte(message), []byte(address)) {
		t.Errorf("message = %q, want it to name %s", message, address)
	}
}
