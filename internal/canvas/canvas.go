// Package canvas keeps the canvases on disk.
//
// A canvas is a directory, not a row: <root>/<id>/ holds canvas.meta.json (the facts the list needs),
// canvas.json (the document itself), files/ (the media its nodes point at) and, once somebody has talked
// to its agent, session.alaya (the conversation). The gateway owns the
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
	metaName = "canvas.meta.json"
	// DocumentName is the document's file name inside a canvas directory, and FilesName is the directory its
	// media lives in. Both are part of the workspace layout (`import/export` writes and reads them), so they
	// are exported rather than repeated as strings.
	DocumentName = "canvas.json"
	FilesName    = "files"
	// AgentSessionName is the canvas's agent conversation, written by the agent rather than here. The suffix is
	// the agent's own — a session file it can read — and it is not part of the document: an export carries the
	// nodes and the files they point at, and what was said about them stays with the canvas it was said on.
	AgentSessionName = "session.alaya"

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

// ErrInvalidFileName is a file name this store would never have written: a separator, a leading dot, or
// something that is not a plain name. A file name is not an id, so it gets its own error — the fix a caller
// needs to hear is different.
var ErrInvalidFileName = errors.New("canvas: invalid file name")

// ErrFileExists is a write to a name that is already taken.
//
// Names are immutable: a file's URL is its own ETag (the route answers `immutable`), so overwriting one
// would leave every cache that has seen it showing the old bytes.
var ErrFileExists = errors.New("canvas: the file already exists")

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
		if !entry.IsDir() || !ValidID(entry.Name()) {
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
	document, err := os.ReadFile(filepath.Join(s.root, id, DocumentName))
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
		if err := os.MkdirAll(filepath.Join(dir, FilesName), 0o755); err != nil {
			_ = os.RemoveAll(dir)
			return Summary{}, fmt.Errorf("canvas: cannot create %s: %w", id, err)
		}
		if err := writeFile(filepath.Join(dir, DocumentName), document); err != nil {
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
	if err := writeFile(filepath.Join(s.root, id, DocumentName), document); err != nil {
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
	dir := filepath.Join(s.root, id, FilesName)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("canvas: cannot create %s: %w", dir, err)
	}
	return dir, nil
}

// SessionPath is where a canvas keeps its agent's conversation.
//
// The conversation is part of the canvas, so it lives inside the canvas directory: deleting the canvas
// deletes it, copying the directory copies it, and no file can outlive the canvas it belongs to. It is a
// file of its own rather than a field of canvas.json because it is not part of the document — it is the
// agent's, in the agent's format, and what a canvas is exported *for* is the nodes.
//
// The directory is not created here. A canvas that does not exist has no conversation, and making a
// directory for one would leave exactly the stray directory this arrangement removes.
func (s *Store) SessionPath(id string) (string, error) {
	if _, err := s.readMeta(id); err != nil {
		return "", err
	}
	return filepath.Join(s.root, id, AgentSessionName), nil
}

// readMeta loads one canvas's meta, refusing ids this store would never have written.
func (s *Store) readMeta(id string) (meta, error) {
	if !ValidID(id) {
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
	if info, err := os.Stat(filepath.Join(s.root, loaded.ID, DocumentName)); err == nil {
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
	// CreateTemp makes the file owner-only; everything written here is meant to be 0644, which is what the
	// direct writes use. A temporary file nobody can see yet is the one place that is safe to correct.
	if err := temp.Chmod(0o644); err != nil {
		_ = temp.Close()
		_ = os.Remove(temp.Name())
		return fmt.Errorf("canvas: cannot set the mode of %s: %w", path, err)
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

// ValidID is the shape newID produces — nothing else is a canvas. It is exported because the session a
// canvas panel names carries the id, and a reader of a name has to know what a canvas id looks like.
func ValidID(id string) bool {
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
