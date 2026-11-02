package server

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"comfyloft/internal/canvas"
	"comfyloft/internal/httpx"
	"comfyloft/internal/util"
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
	s.route(mux, "GET /api/canvases/{id}/files/{name}", s.handleCanvasFile)
	s.route(mux, "PUT /api/canvases/{id}/files/{name}", s.handleCanvasFileWrite)
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
	// The document just said what it still shows, which is one of the two answers the file collector
	// needs. Off the request path: a save must not wait for a directory scan.
	go s.sweepCanvas(summary.ID)
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

// canvasExists answers whether a run or an upload may be written into this canvas.
//
// It reads the metadata rather than the document: the question is "is there a canvas", and a run that
// started while the document was being replaced is not an error.
func (s *Server) canvasExists(id string) bool {
	_, err := s.canvases.Read(id)
	return err == nil
}

// handleCanvasFile implements GET /api/canvases/{id}/files/{name}.
//
// The bytes are the canvas's own, so the response is cacheable for as long as the name lives: a run's
// output and an upload are both named once and never rewritten, which makes the URL its own ETag. That
// is what lets the browser's HTTP cache replace the IndexedDB thumbnails this app used to keep.
func (s *Server) handleCanvasFile(ctx *httpx.Ctx) error {
	id := ctx.R.PathValue("id")
	name := ctx.R.PathValue("name")
	path, err := s.canvases.FilePath(id, name)
	if err != nil {
		return canvasError(err)
	}
	if info, err := os.Stat(path); err != nil || info.IsDir() {
		return httpx.NotFound("file_not_found", "there is no such file in this canvas")
	}
	ctx.W.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	http.ServeFile(ctx.W, ctx.R, path)
	return nil
}

// handleCanvasFileWrite implements PUT /api/canvases/{id}/files/{name}: put bytes at a name the caller chose.
//
// This is the import path, and the only caller. Importing an exported canvas means writing files whose names
// the document already contains (`files/<name>`), so the name has to survive the trip — the upload route
// names files itself, and renaming here would mean rewriting every reference in the document afterwards.
// The body is the file, not a multipart form: there is exactly one file and its name is in the URL.
//
// A name that is taken is refused (409): a file's URL is its own ETag, so overwriting one would leave every
// cache that has seen it showing the old bytes. Import always writes into a canvas that was just created.
func (s *Server) handleCanvasFileWrite(ctx *httpx.Ctx) error {
	id := ctx.R.PathValue("id")
	name := ctx.R.PathValue("name")

	limit := s.cfg.MaxUploadBytes
	if limit <= 0 {
		limit = httpx.MaxFileBytes
	}
	data, err := io.ReadAll(io.LimitReader(ctx.R.Body, limit+1))
	if err != nil {
		return httpx.BadRequest("file_read_failed", "failed to read the request body")
	}
	if int64(len(data)) > limit {
		return httpx.Errorf(http.StatusRequestEntityTooLarge, "upload_too_large",
			"the file exceeds the configured limit (%d bytes)", limit)
	}

	if err := s.canvases.WriteFile(id, name, data); err != nil {
		return canvasError(err)
	}
	okJSON(ctx.W, map[string]any{"file": map[string]any{
		"name":  name,
		"bytes": len(data),
		"mime":  util.MimeFromFilename(name),
		"url":   "/api/canvases/" + url.PathEscape(id) + "/files/" + url.PathEscape(name),
	}})
	return nil
}

// canvasFileGrace is how long an unreferenced file survives.
//
// It covers the gap between a file appearing and the document naming it: a run writes its output, the
// client fetches it, the client saves the node. Deleting anything inside this window would be a data
// loss that cannot be explained to the person who just generated it.
const canvasFileGrace = 24 * time.Hour

// sweepCanvas deletes the files of one canvas that neither its document nor its runs still name.
func (s *Server) sweepCanvas(id string) {
	result, err := s.canvases.Sweep(id, s.tasks.FileNames(id), canvasFileGrace)
	if err != nil {
		return
	}
	if len(result.Removed) > 0 {
		s.logger.Info("canvas %s: collected %d unused file(s)", id, len(result.Removed))
	}
}

// sweepAllCanvasFiles runs the collector over every canvas, once at startup.
func (s *Server) sweepAllCanvasFiles() {
	summaries, err := s.canvases.List()
	if err != nil {
		return
	}
	for _, summary := range summaries {
		s.sweepCanvas(summary.ID)
	}
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
	case errors.Is(err, canvas.ErrInvalidFileName):
		return httpx.BadRequest("canvas_invalid_file_name", "that is not a file name a canvas may hold")
	case errors.Is(err, canvas.ErrFileExists):
		return httpx.NewError(http.StatusConflict, "file_exists", "a file with that name is already in this canvas")
	case errors.Is(err, canvas.ErrInvalidDocument):
		return httpx.BadRequest("canvas_invalid_document", canvas.ErrInvalidDocument.Error())
	}
	return err
}
