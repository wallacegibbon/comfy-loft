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
 *
 * **What follows from the protocol being somebody else's.** `POST /v1/audio/transcriptions` is OpenAI's
 * shape, copied by every OpenAI-compatible server, and it fixes `required: [file, model]` while saying
 * nothing about which model, at which address, or with which credential — those are facts about the server
 * at the other end. The page carries the first two, because it is where they are chosen; the credential is
 * the one thing it never touches: it is stored on this server (`GET/PUT /api/speech/key`, mode 0600) and
 * added here as `Authorization: Bearer`, because that is the protocol's only security scheme and a field the
 * server does not know is an error (#246).
 */

const (
	// Longer than a spoken message can be: a minute of WAV transcribes in about seven seconds on a CPU
	// backend (rtf ≈ 0.12, measured), so this is a stall, not a slow model.
	speechTimeout = 3 * time.Minute
	// A transcript is text. A speech server that answers with more than this is not answering.
	speechAnswerBytes = 1 << 20
)

// routesSpeech registers speech-to-text and the credential it may need.
func (s *Server) routesSpeech(mux *http.ServeMux) {
	s.route(mux, "POST /api/speech/transcriptions", s.handleSpeechTranscribe)
	s.route(mux, "GET /api/speech/key", s.handleSpeechKeyStatus)
	s.route(mux, "PUT /api/speech/key", s.handleSpeechKeySave)
}

// handleSpeechKeyStatus implements GET /api/speech/key: whether a credential is stored, and nothing else.
//
// The key itself never comes back over HTTP. The page needs to know whether to say "a key is stored" and
// whether to offer the field at all; the request that uses it is made by this server, so the page never has
// to hold it (#246).
func (s *Server) handleSpeechKeyStatus(ctx *httpx.Ctx) error {
	okJSON(ctx.W, map[string]any{"stored": s.speechKey.Stored()})
	return nil
}

// handleSpeechKeySave implements PUT /api/speech/key with `{key: "…"}`. A blank key removes the stored one.
func (s *Server) handleSpeechKeySave(ctx *httpx.Ctx) error {
	body, err := bodyOrEmpty(ctx)
	if err != nil {
		return err
	}
	raw, present := body["key"]
	if !present || raw == nil {
		return httpx.BadRequest("speech_key_missing", "the request has no key")
	}
	key, isString := raw.(string)
	if !isString {
		return httpx.BadRequest("speech_key_invalid", "the key must be a string")
	}
	if err := s.speechKey.Set(key); err != nil {
		return err
	}
	okJSON(ctx.W, map[string]any{"stored": s.speechKey.Stored()})
	return nil
}

// handleSpeechTranscribe implements POST /api/speech/transcriptions.
//
// The body is multipart: `url` (where the speech server listens), `key` (the credential, if that server wants
// one), `file` (the WAV), and any further text fields (`model`, `language`) which are forwarded as sent.
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
	// The credential is the server's, not the page's: the protocol's only security scheme is
	// `Authorization: Bearer`, and OpenAI refuses a form field it does not know (`additionalProperties:
	// false`), so the key cannot travel in the body either. A server that checks nothing — the audio.cpp
	// build this was measured against — answers a request carrying a bogus Bearer with a 200, so sending
	// one it never asked for costs nothing.
	if key := s.speechKey.Get(); key != "" {
		request.Header.Set("Authorization", "Bearer "+key)
	}

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
		// server refused the request" is not. And its own status, because 401 (the key was refused), 413
		// (the recording is too long) and 429 (too fast) each mean something different to the reader, and a
		// 400 would say all three were the same mistake. A 5xx is the far side failing, which is what 502 is.
		status := response.StatusCode
		if status >= http.StatusInternalServerError {
			status = http.StatusBadGateway
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
// forwarding the parsed request keeps the outgoing body to the fields that mean something: `url` is this
// server's business and stops here, and `key` is a credential this server holds — a body field by that name
// is not the speech server's to read. Nothing else is dropped, because the model name and the language are
// the speech server's to read.
func speechUpload(audio []byte, values map[string][]string) ([]byte, string, error) {
	var buffer bytes.Buffer
	writer := multipart.NewWriter(&buffer)
	for name, entries := range values {
		if name == "url" || name == "key" {
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
