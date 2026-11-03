package server

import (
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"strings"
	"time"

	"comfyloft/internal/httpx"
)

/**
 * What was said, as words, from the speech server the user configured.
 *
 * The panel records a WAV in the browser and posts it here; this forwards it, unchanged, to the
 * OpenAI-compatible `/v1/audio/transcriptions` address the page named, and answers with its `text`.
 *
 * **Why a route at all.** That address answers no CORS headers — an `OPTIONS` on it is a 404 and a `POST`
 * comes back without `Access-Control-Allow-Origin` — so a page on this origin can send the request and then
 * cannot read the answer. The address is also, usually, `127.0.0.1`, which is true of this machine and of no
 * other: a phone opening the canvas over the LAN would be asking itself for a speech server. The server is
 * the one process that can reach it, so it carries the one file.
 *
 * **Why the address travels with the request** instead of being read out of `data/settings.json`. The
 * preferences document is the canvas's and the server deliberately understands no key in it
 * (internal/settings); a route that parsed it would be the first exception, and it would have to parse it
 * again on every request. The page already knows the address, and passes it the way it passes the audio.
 *
 * **What is not here.** No model is named, no language is guessed, no audio is inspected: the fields the
 * page sends are the fields the speech server gets, and whatever it says — including why it refused — is
 * what the user reads. This route's whole job is the hop (docs/decisions.md #239).
 */

const (
	// Longer than a spoken message can be: a minute of WAV transcribes in about seven seconds on a CPU
	// backend (rtf ≈ 0.12, measured), so this is a stall, not a slow model.
	speechTimeout = 3 * time.Minute
	// A transcript is text. A speech server that answers with more than this is not answering.
	speechAnswerBytes = 1 << 20
)

// routesSpeech registers speech-to-text.
func (s *Server) routesSpeech(mux *http.ServeMux) {
	s.route(mux, "POST /api/speech/transcriptions", s.handleSpeechTranscribe)
}

// handleSpeechTranscribe implements POST /api/speech/transcriptions.
//
// The body is multipart: `url` (where the speech server listens), `file` (the WAV), and any further text
// fields (`model`, `language`) which are forwarded as sent.
func (s *Server) handleSpeechTranscribe(ctx *httpx.Ctx) error {
	form, err := ctx.Form()
	if err != nil {
		return err
	}
	endpoint := strings.TrimSpace(firstValue(form.Values, "url"))
	if err := checkSpeechEndpoint(endpoint); err != nil {
		return err
	}
	files := ctx.Files()
	if len(files) == 0 || len(files[0].Bytes) == 0 {
		return httpx.BadRequest("speech_no_audio", "the request carries no audio")
	}

	body, contentType, err := speechUpload(files[0].Bytes, form.Values)
	if err != nil {
		return httpx.NewError(http.StatusInternalServerError, "speech_request_failed", "could not build the speech request: "+err.Error())
	}
	request, err := http.NewRequestWithContext(ctx.R.Context(), http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return httpx.BadRequest("speech_address_invalid", "the speech address is not a usable URL")
	}
	request.Header.Set("Content-Type", contentType)

	client := &http.Client{Timeout: speechTimeout}
	response, err := client.Do(request)
	if err != nil {
		// The address is the user's, so the failure to reach it is said with the address in it: a typo in
		// a port and a server that is not running are the same error otherwise.
		return httpx.NewError(http.StatusBadGateway, "speech_unreachable", "could not reach the speech server at "+endpoint+": "+err.Error())
	}
	defer response.Body.Close()
	answer, err := io.ReadAll(io.LimitReader(response.Body, speechAnswerBytes))
	if err != nil {
		return httpx.NewError(http.StatusBadGateway, "speech_unreachable", "the speech server stopped mid-answer: "+err.Error())
	}

	var payload struct {
		Text  string `json:"text"`
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	_ = json.Unmarshal(answer, &payload)
	if message := strings.TrimSpace(payload.Error.Message); message != "" {
		// Its own words: "only WAV audio uploads are currently supported" is actionable where "the speech
		// server refused the request" is not. A 4xx is about what was sent and a 5xx about the server, and
		// that distinction is worth keeping in the status the canvas sees.
		status := http.StatusBadGateway
		if response.StatusCode < http.StatusInternalServerError {
			status = http.StatusBadRequest
		}
		return httpx.NewError(status, "speech_failed", message)
	}
	if response.StatusCode != http.StatusOK {
		return httpx.Errorf(http.StatusBadGateway, "speech_failed", "the speech server answered %d", response.StatusCode)
	}
	okJSON(ctx.W, map[string]any{"text": payload.Text})
	return nil
}

// checkSpeechEndpoint refuses anything that is not a plain http(s) address, so a typo is a 400 with a
// sentence rather than a dial error from deep inside the client.
func checkSpeechEndpoint(endpoint string) error {
	if endpoint == "" {
		return httpx.BadRequest("speech_address_missing", "the request names no speech address")
	}
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return httpx.BadRequest("speech_address_invalid", "the speech address must be an http or https URL")
	}
	return nil
}

// speechUpload rebuilds the multipart body the speech server expects: every text field the page sent,
// then the audio as `file`.
//
// The file is named and typed as a WAV because that is what it is — the browser encoded it (the speech
// server only accepts real WAV, which is why the panel writes the header itself). Rebuilding rather than
// forwarding the parsed request keeps the outgoing body to the fields that mean something.
func speechUpload(audio []byte, values map[string][]string) ([]byte, string, error) {
	var buffer bytes.Buffer
	writer := multipart.NewWriter(&buffer)
	for name, entries := range values {
		// `url` is this server's business and stops here.
		if name == "url" {
			continue
		}
		for _, entry := range entries {
			if err := writer.WriteField(name, entry); err != nil {
				return nil, "", err
			}
		}
	}
	part, err := writer.CreateFormFile("file", "speech.wav")
	if err != nil {
		return nil, "", err
	}
	if _, err := part.Write(audio); err != nil {
		return nil, "", err
	}
	if err := writer.Close(); err != nil {
		return nil, "", err
	}
	return buffer.Bytes(), writer.FormDataContentType(), nil
}

// firstValue is the first value of a multipart field, or "".
func firstValue(values map[string][]string, name string) string {
	if entries := values[name]; len(entries) > 0 {
		return entries[0]
	}
	return ""
}
