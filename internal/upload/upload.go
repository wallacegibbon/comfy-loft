// Package upload stores the media a run references.
//
// An upload is a file in the canvas it belongs to, and its id is its file name — there is no index any
// more. The index (`uploads.json`) existed to remember which ComfyUI file each upload had become; that
// is now derived instead of remembered, which is why it could go.
package upload

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"comfyloft/internal/canvas"
	"comfyloft/internal/logx"
	"comfyloft/internal/util"
)

// Media kinds. A run's media roles are typed, so an image cannot be passed where a video belongs.
const (
	KindImage = "image"
	KindVideo = "video"
	KindAudio = "audio"
)

// ErrTooLarge is an upload past the configured limit.
var ErrTooLarge = errors.New("upload: file exceeds the size limit")

// extensionsByKind is the accepted container list per kind. It is a filter, not a converter: the
// server never transcodes, so a file whose type it cannot place is refused at upload time instead
// of failing inside ComfyUI later.
var extensionsByKind = map[string][]string{
	KindImage: {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"},
	KindVideo: {".mp4", ".webm", ".mov", ".mkv", ".avi"},
	KindAudio: {".mp3", ".wav", ".flac", ".ogg", ".opus", ".m4a", ".aac"},
}

// File is one uploaded media file.
type File struct {
	// ID is the file name inside the canvas's `files/` directory, and what a run references.
	ID        string `json:"id"`
	Kind      string `json:"kind"`
	Filename  string `json:"filename"`
	MimeType  string `json:"mimeType"`
	Bytes     int64  `json:"bytes"`
	CreatedAt string `json:"createdAt"`
	// Path is where the bytes are, for the push into ComfyUI.
	Path string `json:"-"`
}

// Store writes uploads into their canvas, and remembers what ComfyUI called them.
type Store struct {
	canvases *canvas.Store
	maxBytes int64
	logger   *logx.Logger

	mu sync.RWMutex
	// comfy is a cache of "already pushed": losing it to a restart costs one overwrite, never a
	// duplicate, because the name it would push to is derived (see ComfyNameFor).
	comfy map[string]string
}

// New builds a store over the canvas roots.
func New(canvases *canvas.Store, maxBytes int64, logger *logx.Logger) *Store {
	return &Store{canvases: canvases, maxBytes: maxBytes, logger: logger, comfy: map[string]string{}}
}

// Save writes one upload into a canvas and returns it.
func (s *Store) Save(canvasID, kind, filename, mimeType string, data []byte) (*File, error) {
	if int64(len(data)) > s.maxBytes {
		return nil, ErrTooLarge
	}
	dir, err := s.canvases.FilesPath(canvasID)
	if err != nil {
		return nil, err
	}
	ext := extensionFor(kind, filename)
	if ext == "" {
		return nil, fmt.Errorf("upload: cannot place %q", filename)
	}
	name, err := newName("up", ext)
	if err != nil {
		return nil, err
	}
	target := filepath.Join(dir, name)
	if err := os.WriteFile(target, data, 0o644); err != nil {
		return nil, fmt.Errorf("upload: cannot write %s: %w", target, err)
	}
	stored := &File{
		ID:        name,
		Kind:      kind,
		Filename:  defaultString(filename, name),
		MimeType:  defaultString(mimeType, mimeOf(kind)),
		Bytes:     int64(len(data)),
		CreatedAt: util.NowIso(),
		Path:      target,
	}
	s.logger.Info("upload %s/%s stored (%d bytes)", canvasID, name, stored.Bytes)
	return stored, nil
}

// Get returns an upload that is still on disk, or nil.
//
// It reads the directory rather than a table, so a file deleted by hand or by the sweep is reported as
// gone instead of being remembered as present.
func (s *Store) Get(canvasID, id string) *File {
	path, err := s.canvases.FilePath(canvasID, id)
	if err != nil {
		return nil
	}
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return nil
	}
	kind := KindOf("", id)
	return &File{
		ID:        id,
		Kind:      kind,
		Filename:  id,
		MimeType:  mimeOf(kind),
		Bytes:     info.Size(),
		CreatedAt: info.ModTime().UTC().Format(time.RFC3339Nano),
		Path:      path,
	}
}

// ComfyRef is the ComfyUI name this upload was pushed as, once it has been.
//
// Keyed by canvas and upload, not by the upload alone: an id is unique inside its canvas, and two canvases
// may hold a file with the same name — the name it is pushed under is derived from both (ComfyNameFor), so
// remembering only the file would hand one canvas the other's ComfyUI file.
func (s *Store) ComfyRef(canvasID, id string) (string, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	name, ok := s.comfy[comfyKey(canvasID, id)]
	return name, ok
}

// SetComfyRef records the push. Dropped on restart, deliberately: the name is derived, so the next
// push overwrites the same file in ComfyUI instead of adding one.
func (s *Store) SetComfyRef(canvasID, id, name string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.comfy[comfyKey(canvasID, id)] = name
}

func comfyKey(canvasID, id string) string { return canvasID + "/" + id }

/**
 * ComfyNameFor is the name this upload is pushed into ComfyUI under.
 *
 * Derived, not generated: the same upload always lands on the same file, and the upload endpoint is
 * called with `overwrite=true` (internal/comfy). That is what keeps ComfyUI's input directory bounded.
 * The server used to push under a random suffix per call, so every process restart left another copy
 * of every reference image behind, and nothing on either side ever collected them.
 */
func ComfyNameFor(canvasID, id string) string {
	return util.SafeFileName("cl-" + canvasID + "-" + id)
}

// KindOf maps a mime type and file name onto a media kind, or "" when neither says anything usable.
func KindOf(mimeType, filename string) string {
	lower := strings.ToLower(mimeType)
	ext := strings.ToLower(filepath.Ext(filename))
	for _, kind := range []string{KindImage, KindVideo, KindAudio} {
		if strings.HasPrefix(lower, kind+"/") {
			// An audio mimetype served as `video/mp4` is common enough to special-case by extension.
			if kind == KindVideo && contains(extensionsByKind[KindAudio], ext) {
				return KindAudio
			}
			return kind
		}
		if contains(extensionsByKind[kind], ext) {
			return kind
		}
	}
	return ""
}

// extensionFor picks the stored extension: the uploaded one when the kind allows it, else the kind's
// default. The extension is part of the file name, and the file name is the id, so it decides how a
// browser treats the bytes.
func extensionFor(kind, filename string) string {
	ext := strings.ToLower(filepath.Ext(filename))
	if contains(extensionsByKind[kind], ext) {
		return ext
	}
	switch kind {
	case KindImage:
		return ".png"
	case KindVideo:
		return ".mp4"
	case KindAudio:
		return ".mp3"
	}
	return ""
}

func mimeOf(kind string) string {
	switch kind {
	case KindVideo:
		return "video/mp4"
	case KindAudio:
		return "audio/mpeg"
	}
	return "image/png"
}

// newName is `<prefix>-<8 hex><ext>`: short, readable, unique inside one canvas, and safe in a URL.
func newName(prefix, ext string) (string, error) {
	raw := make([]byte, 4)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("upload: no randomness for a name: %w", err)
	}
	return prefix + "-" + hex.EncodeToString(raw) + ext, nil
}

func contains(values []string, value string) bool {
	for _, item := range values {
		if item == value {
			return true
		}
	}
	return false
}

func defaultString(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}
