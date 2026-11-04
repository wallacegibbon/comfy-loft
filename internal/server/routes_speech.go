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
	"comfyloft/internal/store"
)

/**
 * What was said, as words, from the speech server the user configured; and the list of those servers.
 *
 * The panel records a WAV in the browser and posts it here; this forwards it, unchanged, to the active
 * profile's OpenAI-compatible `/v1/audio/transcriptions` and answers with its `text`.
 *
 * **Why a route at all.** That address answers no CORS headers — an `OPTIONS` on it is a 404 and a `POST`
 * comes back without `Access-Control-Allow-Origin` — so a page on this origin can send the request and then
 * cannot read the answer. The address is also, usually, `127.0.0.1`, which is true of this machine and of no
 * other: a phone opening the canvas over the LAN would be asking itself for a speech server. The server is
 * the one process that can reach it, so it carries the one file.
 *
 * **Why the address no longer travels with the request.** #239 sent it in the form because the preferences
 * document was the only place a speech server existed, and the server deliberately understands no key in that
 * document. The list lives here now (`GET/PUT /api/speech/profiles`, `store.SpeechProfiles`), so the address,
 * the model name and the credential are one entry in one file that only this process reads — and the request
 * carries the recording and nothing else about where it goes (#252).
 *
 * **What is not here.** No audio is inspected and no language is guessed: `language` is the panel's hint and
 * it travels as given, and whatever the speech server says — including why it refused — is what the user
 * reads. This route's whole job is the hop.
 *
 * **What follows from the protocol being somebody else's.** `POST /v1/audio/transcriptions` is OpenAI's
 * shape, copied by every OpenAI-compatible server, and it fixes `required: [file, model]` while saying
 * nothing about which model, at which address, or with which credential — those are facts about the server at
 * the other end, which is why they are a profile and not a constant (#246). `Authorization: Bearer` is the
 * protocol's only security scheme; OpenAI refuses a form field it does not know (`additionalProperties:
 * false`), so the key cannot travel in the body either.
 */

const (
	// Longer than a spoken message can be: a minute of WAV transcribes in about seven seconds on a CPU
	// backend (rtf ≈ 0.12, measured), so this is a stall, not a slow model.
	speechTimeout = 3 * time.Minute
	// A transcript is text. A speech server that answers with more than this is not answering.
	speechAnswerBytes = 1 << 20
)

// routesSpeech registers speech-to-text and the list of servers it can be sent to.
func (s *Server) routesSpeech(mux *http.ServeMux) {
	s.route(mux, "POST /api/speech/transcriptions", s.handleSpeechTranscribe)
	s.route(mux, "GET /api/speech/profiles", s.handleSpeechProfiles)
	s.route(mux, "PUT /api/speech/profiles", s.handleSpeechProfilesSave)
}

// handleSpeechProfiles implements GET /api/speech/profiles: the list, and which entry is active.
//
// No key is in the answer. A page needs to know whether one is stored — to say so, and to offer to replace or
// clear it — and the request that uses it is made by this server, so the page never has to hold it (#246).
func (s *Server) handleSpeechProfiles(ctx *httpx.Ctx) error {
	okJSON(ctx.W, s.speechProfilesAnswer())
	return nil
}

// handleSpeechProfilesSave implements PUT /api/speech/profiles with `{profiles: [...], active: <id>}`.
//
// The whole list, in the page's order, with one entry added, changed or removed: the list is the file, so an
// entry that is missing is a profile that was deleted. A key travels only when the page has one to give — a
// new profile, or one whose key the user has just retyped — and `""` removes the stored one.
func (s *Server) handleSpeechProfilesSave(ctx *httpx.Ctx) error {
	body, err := bodyOrEmpty(ctx)
	if err != nil {
		return err
	}
	raw, present := body["profiles"]
	if !present || raw == nil {
		return httpx.BadRequest("speech_profiles_missing", "the request has no profiles")
	}
	entries, isList := raw.([]any)
	if !isList {
		return httpx.BadRequest("speech_profiles_invalid", "profiles must be a list")
	}
	inputs := make([]store.SpeechProfileInput, 0, len(entries))
	seen := make(map[int]bool, len(entries))
	for _, entry := range entries {
		object, isObject := entry.(map[string]any)
		if !isObject {
			return httpx.BadRequest("speech_profiles_invalid", "every profile must be an object")
		}
		input := store.SpeechProfileInput{Name: httpx.String(object, "name"), URL: httpx.String(object, "url"), Model: httpx.String(object, "model")}
		if raw, present := object["id"]; present && raw != nil {
			id, ok := wholeNumber(raw)
			if !ok || id < 1 {
				return httpx.BadRequest("speech_profile_id_invalid", "a profile id must be a whole number")
			}
			if seen[id] {
				return httpx.BadRequest("speech_profile_id_invalid", "two profiles cannot share an id")
			}
			seen[id] = true
			input.ID = id
		}
		endpoint, err := speechEndpoint(input.URL)
		if err != nil {
			return err
		}
		input.URL = endpoint
		if raw, present := object["key"]; present && raw != nil {
			key, isString := raw.(string)
			if !isString {
				return httpx.BadRequest("speech_key_invalid", "the key must be a string")
			}
			input.Key = &key
		}
		inputs = append(inputs, input)
	}
	active := 0
	if raw, present := body["active"]; present && raw != nil {
		id, ok := wholeNumber(raw)
		if !ok {
			return httpx.BadRequest("speech_profile_id_invalid", "the active profile must be a whole number")
		}
		active = id
	}
	if err := s.speechProfiles.Replace(inputs, active); err != nil {
		return err
	}
	okJSON(ctx.W, s.speechProfilesAnswer())
	return nil
}

// speechProfilesAnswer is what both profile routes say: the list, and which entry is active.
func (s *Server) speechProfilesAnswer() map[string]any {
	profiles, active := s.speechProfiles.List()
	return map[string]any{"profiles": profiles, "active": active}
}

// handleSpeechTranscribe implements POST /api/speech/transcriptions.
//
// The body is multipart: `file` (the WAV) and `language`, a hint about the sound. The address, the model name
// and the credential come from the active profile — nothing in this request can name a different server, which
// is what keeps a recording from being posted somewhere the user did not choose.
func (s *Server) handleSpeechTranscribe(ctx *httpx.Ctx) error {
	form, err := ctx.Form()
	if err != nil {
		return err
	}
	files := ctx.Files()
	if len(files) == 0 || len(files[0].Bytes) == 0 {
		return httpx.BadRequest("speech_no_audio", "the request carries no audio")
	}
	profile, configured := s.speechProfiles.Active()
	if !configured {
		return httpx.BadRequest("speech_profile_missing", "no speech server is configured: add one in the preferences")
	}
	endpoint, err := speechEndpoint(profile.URL)
	if err != nil {
		return err
	}

	// Where the recording is going, on the line before it goes: the failure message carries the address when the
	// hop fails, but a transcript that comes back empty has no message at all, and the answer to "which server did
	// that?" is this line (decisions #255).
	s.logger.Info("speech: transcribing %d bytes with %s", len(files[0].Bytes), profile.Destination())

	body, contentType, err := speechUpload(files[0].Bytes, profile.Model, firstValue(form.Values, "language"))
	if err != nil {
		return httpx.NewError(http.StatusInternalServerError, "speech_request_failed", "could not build the speech request: "+err.Error())
	}
	request, err := http.NewRequestWithContext(ctx.R.Context(), http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return httpx.BadRequest("speech_address_invalid", "the speech address is not a usable URL")
	}
	request.Header.Set("Content-Type", contentType)
	// The credential is the profile's, not the page's. A server that checks nothing — the audio.cpp build this
	// was measured against answers a request carrying a bogus Bearer with a 200 — so sending one it never asked
	// for costs nothing, and a key is only ever stored because the user typed one.
	if profile.Key != "" {
		request.Header.Set("Authorization", "Bearer "+profile.Key)
	}

	client := &http.Client{Timeout: speechTimeout}
	response, err := client.Do(request)
	if err != nil {
		// The address is the user's, so the failure to reach it is said with the address in it: a typo in a port
		// and a server that is not running are the same error otherwise.
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

// speechEndpoint validates a profile's address and returns it trimmed, so a typo is a 400 with a sentence
// rather than a dial error from deep inside the client.
func speechEndpoint(raw string) (string, error) {
	endpoint := strings.TrimSpace(raw)
	if endpoint == "" {
		return "", httpx.BadRequest("speech_address_missing", "every speech profile needs an address")
	}
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return "", httpx.BadRequest("speech_address_invalid", "the speech address must be an http or https URL")
	}
	return endpoint, nil
}

// speechUpload rebuilds the multipart body the speech server expects: the model the profile names, the
// language the page heard, then the audio as `file`.
//
// Built here rather than forwarded, and from two named parts rather than from everything the page sent: a
// request that forwarded its own fields would let a page name a model — or a `key` — that is not in the profile
// it chose, which is exactly the indirection the list exists to remove.
//
// The file is named and typed as a WAV because that is what it is — the browser encoded it (the speech server
// only accepts real WAV, which is why the panel writes the header itself).
func speechUpload(audio []byte, model, language string) ([]byte, string, error) {
	var buffer bytes.Buffer
	writer := multipart.NewWriter(&buffer)
	// A model the profile leaves blank is no field at all: the protocol requires one, and the server that wants
	// it says so in its own words, where a name this build invented would come back as an unknown model id.
	if model != "" {
		if err := writer.WriteField("model", model); err != nil {
			return nil, "", err
		}
	}
	if language != "" {
		if err := writer.WriteField("language", language); err != nil {
			return nil, "", err
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

// wholeNumber reads a JSON number that is an integer, which is what an id is.
func wholeNumber(value any) (int, bool) {
	number, ok := value.(float64)
	if !ok || number != float64(int(number)) || number > float64(1<<31) || number < -(1<<31) {
		return 0, false
	}
	return int(number), true
}
