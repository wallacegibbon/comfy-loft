package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"comfyloft/internal/canvas"
	"comfyloft/internal/httpx"
)

// routesCanvas registers the canvas documents.
//
// These are the workspace: everything else the gateway serves is either a capability (workflows,
// models, LoRAs) or bookkeeping (runs, uploads). A canvas directory outlives all of it, which is why
// this is the one endpoint whose data is meant to be backed up.
func (s *Server) routesCanvas(mux *http.ServeMux) {
	s.route(mux, "GET /api/canvases", s.handleCanvasList)
	s.route(mux, "POST /api/canvases", s.handleCanvasCreate)
	s.route(mux, "GET /api/canvases/{id}", s.handleCanvasGet)
	s.route(mux, "PUT /api/canvases/{id}", s.handleCanvasSave)
	s.route(mux, "DELETE /api/canvases/{id}", s.handleCanvasDelete)
}

// handleCanvasList implements GET /api/canvases.
func (s *Server) handleCanvasList(ctx *httpx.Ctx) error {
	summaries, err := s.canvases.List()
	if err != nil {
		return canvasError(err)
	}
	okJSON(ctx.W, map[string]any{"canvases": summaries})
	return nil
}

// handleCanvasCreate implements POST /api/canvases.
//
// A canvas is created with its document in the same request: the client's first save is usually the
// content it just made, and two round trips would leave a canvas that exists but is not yet anything.
func (s *Server) handleCanvasCreate(ctx *httpx.Ctx) error {
	body, err := bodyOrEmpty(ctx)
	if err != nil {
		return err
	}
	document, err := documentOf(body)
	if err != nil {
		return err
	}
	summary, err := s.canvases.Create(httpx.String(body, "title"), document)
	if err != nil {
		return canvasError(err)
	}
	created, err := s.canvases.Read(summary.ID)
	if err != nil {
		return canvasError(err)
	}
	okJSON(ctx.W, map[string]any{"canvas": created})
	return nil
}

// handleCanvasGet implements GET /api/canvases/{id}.
func (s *Server) handleCanvasGet(ctx *httpx.Ctx) error {
	loaded, err := s.canvases.Read(ctx.R.PathValue("id"))
	if err != nil {
		return canvasError(err)
	}
	okJSON(ctx.W, map[string]any{"canvas": loaded})
	return nil
}

// handleCanvasSave implements PUT /api/canvases/{id}.
//
// The rev travels in `If-Match` rather than in the body, because that is what it is: a precondition
// on the version the client believes it is writing over. A body field would be the same information
// with one more thing to forget, and the answer to a stale one is a 409 carrying the current canvas
// so the client can merge instead of guessing.
func (s *Server) handleCanvasSave(ctx *httpx.Ctx) error {
	body, err := bodyOrEmpty(ctx)
	if err != nil {
		return err
	}
	document, err := documentOf(body)
	if err != nil {
		return err
	}
	title := optionalString(body, "title")
	summary, err := s.canvases.Write(ctx.R.PathValue("id"), matchRev(ctx.R), title, document)
	if err != nil {
		return canvasError(err)
	}
	okJSON(ctx.W, map[string]any{"summary": summary})
	return nil
}

// handleCanvasDelete implements DELETE /api/canvases/{id}.
func (s *Server) handleCanvasDelete(ctx *httpx.Ctx) error {
	if err := s.canvases.Delete(ctx.R.PathValue("id")); err != nil {
		return canvasError(err)
	}
	okJSON(ctx.W, nil)
	return nil
}

// documentOf grabs the document out of a body.
//
// It is re-encoded here rather than passed through as bytes because the body has already been parsed
// into a map by the time a handler sees it; the cost is formatting and float precision, both of which
// the canvas re-writes on the next save anyway. An absent document is not an empty one: a save that
// names no document is a mistake, and creating does not need one (the store fills in `{}`).
func documentOf(body map[string]any) ([]byte, error) {
	raw, present := body["document"]
	if !present || raw == nil {
		return nil, nil
	}
	document, err := json.Marshal(raw)
	if err != nil {
		return nil, httpx.BadRequest("invalid_document", "the canvas document is not encodable")
	}
	return document, nil
}

// matchRev reads the version precondition. `If-Match` may arrive as a bare rev or quoted like an
// ETag; both mean the same thing here, and a client that sends neither is not asking to be checked.
func matchRev(r *http.Request) string {
	value := strings.TrimSpace(r.Header.Get("If-Match"))
	return strings.Trim(strings.TrimSpace(value), `"`)
}

// canvasError maps the store's errors onto the wire.
func canvasError(err error) error {
	var conflict *canvas.ConflictError
	switch {
	case errors.As(err, &conflict):
		return httpx.NewError(http.StatusConflict, "canvas_conflict", "the canvas changed since it was read").
			WithDetails(map[string]any{"current": conflict.Current})
	case errors.Is(err, canvas.ErrNotFound):
		return httpx.NotFound("canvas_not_found", "there is no canvas with that id")
	case errors.Is(err, canvas.ErrInvalidID):
		return httpx.BadRequest("canvas_invalid_id", "that is not a canvas id")
	case errors.Is(err, canvas.ErrInvalidDocument):
		return httpx.BadRequest("canvas_invalid_document", canvas.ErrInvalidDocument.Error())
	}
	return err
}
