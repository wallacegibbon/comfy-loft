package server

import (
	"encoding/json"
	"net/http"

	"comfyloft/internal/httpx"
	"comfyloft/internal/settings"
)

// routesSettings registers the workspace preferences.
//
// One document, read and written whole. There is no per-key endpoint because there is no per-key
// conflict to resolve: the canvas owns the whole shape, and a save that named one key would have to
// merge with a document it never read.
func (s *Server) routesSettings(mux *http.ServeMux) {
	s.route(mux, "GET /api/settings", s.handleSettingsGet)
	s.route(mux, "PUT /api/settings", s.handleSettingsPut)
}

// handleSettingsGet implements GET /api/settings.
func (s *Server) handleSettingsGet(ctx *httpx.Ctx) error {
	document, err := s.settings.Read()
	if err != nil {
		return err
	}
	okJSON(ctx.W, map[string]any{"settings": document})
	return nil
}

// handleSettingsPut implements PUT /api/settings.
//
// The body is `{settings: {...}}` and it replaces the stored document. The first-paint file is
// rewritten here rather than on a timer: the next page load is the only thing that reads it, and it
// should already be saying what this save said.
func (s *Server) handleSettingsPut(ctx *httpx.Ctx) error {
	body, err := bodyOrEmpty(ctx)
	if err != nil {
		return err
	}
	raw, present := body["settings"]
	if !present || raw == nil {
		return httpx.BadRequest("settings_missing", "the request has no settings document")
	}
	document, err := json.Marshal(raw)
	if err != nil {
		return httpx.BadRequest("settings_invalid", "the settings document is not encodable")
	}
	if err := s.settings.Write(document); err != nil {
		if err == settings.ErrInvalid {
			return httpx.BadRequest("settings_invalid", settings.ErrInvalid.Error())
		}
		return err
	}
	s.writeRuntimeConfig()
	stored, err := s.settings.Read()
	if err != nil {
		return err
	}
	okJSON(ctx.W, map[string]any{"settings": stored})
	return nil
}
