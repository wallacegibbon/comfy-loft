// Package canvas keeps the canvases on disk.
//
// A canvas is a directory, not a row: <root>/<id>/ holds canvas.meta.json (the facts the list needs),
// canvas.json (the document itself) and files/ (the media its nodes point at). The gateway owns the
// directory, the id and the timestamps; it does not read canvas.json — what a node is, is the
// canvas's business, and a gateway that understood nodes would have to be redeployed every time one
// was added.
//
// Two rules make the directory safe to write on every keystroke. Writes go through a temporary file
// in the same directory and are renamed into place, so a reader never sees half a document. And every
// write bumps `rev`, so a client that saves on top of a version it did not read is refused instead of
// silently overwriting whatever arrived in between — the client is a cache now, and caches lose.
package canvas

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const (
	metaName     = "canvas.meta.json"
	documentName = "canvas.json"
	filesName    = "files"

	// MaxDocumentBytes caps one canvas.json. Media lives in files/, so a document that needs more
	// than this is a document that inlined something it should have referenced.
	MaxDocumentBytes = 16 << 20

	// emptyDocument is what a canvas holds between its creation and the client's first save.
	emptyDocument = "{}"
)

// ErrNotFound is a canvas that was deleted, or never existed.
var ErrNotFound = errors.New("canvas: not found")

// ErrInvalidID is a name that is not one this store hands out. It is checked before any path is
// built, so `../` cannot be one no matter what a request says.
var ErrInvalidID = errors.New("canvas: invalid id")

// ErrInvalidDocument is a document that is not a JSON object, or is too large to be one.
var ErrInvalidDocument = errors.New("canvas: document must be a JSON object under 16 MiB")

// ConflictError is a write made against a version that is no longer current. Current is what the
// canvas looks like now, so the caller can report it without a second read.
type ConflictError struct{ Current Summary }

func (e *ConflictError) Error() string { return "canvas: the canvas changed since it was read" }

// Summary is one canvas as the list shows it: no document, only what a list needs.
type Summary struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
	// Rev changes on every write. A client echoes it back to save.
	Rev   string `json:"rev"`
	Bytes int64  `json:"bytes"`
}

// Canvas is a summary and the document behind it.
type Canvas struct {
	Summary
	Document json.RawMessage `json:"document"`
}

// meta is canvas.meta.json. It duplicates nothing in the document: the title lives here and only
// here, because the list has to show titles without reading (or understanding) every document.
type meta struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
	Rev       string    `json:"rev"`
}

// Store is the canvas root. It is safe for concurrent use: every operation is a handful of
// independent file calls, and the only state a write touches is inside the canvas it names.
type Store struct {
	root string
	now  func() time.Time
}

// New opens (creating if needed) the canvas root.
func New(root string) (*Store, error) {
	if strings.TrimSpace(root) == "" {
		return nil, errors.New("canvas: root is empty")
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return nil, fmt.Errorf("canvas: cannot create %s: %w", root, err)
	}
	return &Store{root: root, now: time.Now}, nil
}

// Root is the directory every canvas lives in.
func (s *Store) Root() string { return s.root }

// List returns every canvas, most recently written first.
//
// Ordering is by UpdatedAt rather than by name: a directory name is an id, and ids carry no order
// worth showing. A directory without a readable meta is skipped, not reported: that is what a crash
// between mkdir and the first write leaves behind, and it is not a canvas.
func (s *Store) List() ([]Summary, error) {
	entries, err := os.ReadDir(s.root)
	if err != nil {
		return nil, fmt.Errorf("canvas: cannot read %s: %w", s.root, err)
	}
	summaries := make([]Summary, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() || !validID(entry.Name()) {
			continue
		}
		loaded, err := s.readMeta(entry.Name())
		if err != nil {
			continue
		}
		summaries = append(summaries, s.summaryOf(loaded))
	}
	sort.Slice(summaries, func(i, j int) bool {
		if summaries[i].UpdatedAt.Equal(summaries[j].UpdatedAt) {
			return summaries[i].ID < summaries[j].ID
		}
		return summaries[i].UpdatedAt.After(summaries[j].UpdatedAt)
	})
	return summaries, nil
}

// Read returns one canvas with its document.
func (s *Store) Read(id string) (Canvas, error) {
	loaded, err := s.readMeta(id)
	if err != nil {
		return Canvas{}, err
	}
	document, err := os.ReadFile(filepath.Join(s.root, id, documentName))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return Canvas{}, ErrNotFound
		}
		return Canvas{}, fmt.Errorf("canvas: cannot read %s: %w", id, err)
	}
	return Canvas{Summary: s.summaryOf(loaded), Document: document}, nil
}

// Create writes a new canvas and returns it.
//
// The id is the directory name and is never derived from the title: renaming a canvas must not move
// a directory, and a title may be anything a person can type.
func (s *Store) Create(title string, document []byte) (Summary, error) {
	if len(document) == 0 {
		document = []byte(emptyDocument)
	}
	if err := validateDocument(document); err != nil {
		return Summary{}, err
	}
	now := s.now().UTC()
	loaded := meta{Title: strings.TrimSpace(title), CreatedAt: now, UpdatedAt: now, Rev: newRev()}
	for attempt := 0; attempt < 4; attempt++ {
		id, err := newID()
		if err != nil {
			return Summary{}, err
		}
		dir := filepath.Join(s.root, id)
		// Mkdir is the uniqueness check: two creations that picked the same id cannot both win.
		if err := os.Mkdir(dir, 0o755); err != nil {
			if errors.Is(err, os.ErrExist) {
				continue
			}
			return Summary{}, fmt.Errorf("canvas: cannot create %s: %w", id, err)
		}
		loaded.ID = id
		if err := os.MkdirAll(filepath.Join(dir, filesName), 0o755); err != nil {
			_ = os.RemoveAll(dir)
			return Summary{}, fmt.Errorf("canvas: cannot create %s: %w", id, err)
		}
		if err := writeFile(filepath.Join(dir, documentName), document); err != nil {
			_ = os.RemoveAll(dir)
			return Summary{}, err
		}
		// Meta last: a directory without one is invisible to List, so a crash here leaves a
		// stray directory rather than a canvas with no document.
		if err := s.writeMeta(loaded); err != nil {
			_ = os.RemoveAll(dir)
			return Summary{}, err
		}
		return s.summaryOf(loaded), nil
	}
	return Summary{}, errors.New("canvas: could not pick an unused id")
}

// Write replaces a canvas's document. An empty rev means "whatever is there", which only the
// creation path should need; a client that read the canvas has a rev and must send it.
//
// title is left alone when nil — renaming is a separate thing a person does, and a save must not
// undo it.
func (s *Store) Write(id, rev string, title *string, document []byte) (Summary, error) {
	loaded, err := s.readMeta(id)
	if err != nil {
		return Summary{}, err
	}
	if err := validateDocument(document); err != nil {
		return Summary{}, err
	}
	if rev != "" && rev != loaded.Rev {
		return Summary{}, &ConflictError{Current: s.summaryOf(loaded)}
	}
	if err := writeFile(filepath.Join(s.root, id, documentName), document); err != nil {
		return Summary{}, err
	}
	if title != nil {
		loaded.Title = strings.TrimSpace(*title)
	}
	loaded.UpdatedAt = s.now().UTC()
	loaded.Rev = newRev()
	if err := s.writeMeta(loaded); err != nil {
		return Summary{}, err
	}
	return s.summaryOf(loaded), nil
}

// Delete removes a canvas and everything under it.
//
// This is a delete, not a move to a trash directory: a canvas nobody wants back is the common case,
// and a trash nobody empties is a second lifetime rule to explain. Undo belongs to the editor that
// still holds the nodes in memory, not to the server.
func (s *Store) Delete(id string) error {
	if _, err := s.readMeta(id); err != nil {
		return err
	}
	if err := os.RemoveAll(filepath.Join(s.root, id)); err != nil {
		return fmt.Errorf("canvas: cannot delete %s: %w", id, err)
	}
	return nil
}

// FilesPath is where a canvas's media lives, created if this is the first file.
func (s *Store) FilesPath(id string) (string, error) {
	if _, err := s.readMeta(id); err != nil {
		return "", err
	}
	dir := filepath.Join(s.root, id, filesName)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("canvas: cannot create %s: %w", dir, err)
	}
	return dir, nil
}

// readMeta loads one canvas's meta, refusing ids this store would never have written.
func (s *Store) readMeta(id string) (meta, error) {
	if !validID(id) {
		return meta{}, ErrInvalidID
	}
	raw, err := os.ReadFile(filepath.Join(s.root, id, metaName))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return meta{}, ErrNotFound
		}
		return meta{}, fmt.Errorf("canvas: cannot read %s: %w", id, err)
	}
	var loaded meta
	if err := json.Unmarshal(raw, &loaded); err != nil {
		return meta{}, fmt.Errorf("canvas: %s has an unreadable %s: %w", id, metaName, err)
	}
	if loaded.ID != id {
		return meta{}, fmt.Errorf("canvas: %s holds a meta for %s", id, loaded.ID)
	}
	return loaded, nil
}

func (s *Store) writeMeta(loaded meta) error {
	raw, err := json.MarshalIndent(loaded, "", "  ")
	if err != nil {
		return fmt.Errorf("canvas: cannot encode meta: %w", err)
	}
	return writeFile(filepath.Join(s.root, loaded.ID, metaName), append(raw, '\n'))
}

// summaryOf pairs a meta with the size of the document it describes.
func (s *Store) summaryOf(loaded meta) Summary {
	summary := Summary{
		ID:        loaded.ID,
		Title:     loaded.Title,
		CreatedAt: loaded.CreatedAt,
		UpdatedAt: loaded.UpdatedAt,
		Rev:       loaded.Rev,
	}
	if info, err := os.Stat(filepath.Join(s.root, loaded.ID, documentName)); err == nil {
		summary.Bytes = info.Size()
	}
	return summary
}

// validateDocument is the only thing the gateway checks about a document: that it is an object, and
// that it is not so big that the caller has inlined media. What the object holds is not its business.
func validateDocument(document []byte) error {
	trimmed := bytes.TrimSpace(document)
	if len(trimmed) == 0 || len(trimmed) > MaxDocumentBytes || trimmed[0] != '{' || !json.Valid(trimmed) {
		return ErrInvalidDocument
	}
	return nil
}

// writeFile writes through a temporary file and renames it into place.
//
// The temporary file is created in the destination directory so the rename is a rename and not a
// copy, and it is removed on every failure path — a crash leaves one, a returned error leaves none.
func writeFile(path string, data []byte) error {
	temp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*.tmp")
	if err != nil {
		return fmt.Errorf("canvas: cannot open a temporary file for %s: %w", path, err)
	}
	name := temp.Name()
	defer func() { _ = os.Remove(name) }()
	if _, err := temp.Write(data); err != nil {
		_ = temp.Close()
		return fmt.Errorf("canvas: cannot write %s: %w", path, err)
	}
	if err := temp.Close(); err != nil {
		return fmt.Errorf("canvas: cannot close %s: %w", path, err)
	}
	if err := os.Rename(name, path); err != nil {
		return fmt.Errorf("canvas: cannot install %s: %w", path, err)
	}
	return nil
}

// validID is the shape newID produces — nothing else is a canvas.
func validID(id string) bool {
	if len(id) != 12 {
		return false
	}
	for _, r := range id {
		if (r < '0' || r > '9') && (r < 'a' || r > 'f') {
			return false
		}
	}
	return true
}

func newID() (string, error) {
	raw := make([]byte, 6)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("canvas: no randomness for an id: %w", err)
	}
	return hex.EncodeToString(raw), nil
}

func newRev() string {
	raw := make([]byte, 8)
	if _, err := rand.Read(raw); err != nil {
		// A rev only has to differ from the last one; time is enough when randomness is not.
		return fmt.Sprintf("t%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(raw)
}
