// Package settings keeps the workspace's preferences in one file.
//
// The gateway does not understand a single key in it. Preferences are the canvas's business — which
// theme, which language, which panel width — and the gateway's job is to hold the bytes so that they
// survive a cleared browser, follow the workspace to another machine, and can be backed up with the
// canvases. That is the same division #152 drew for a canvas document, applied to the smaller thing.
package settings

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

const (
	fileName = "settings.json"

	// MaxBytes caps the file. Preferences are a few kilobytes of names, numbers and flags; a blob that
	// needs more than this is a bug that would otherwise be written on every keystroke.
	MaxBytes = 1 << 20
)

// ErrInvalid is anything that is not a JSON object of a sane size.
var ErrInvalid = errors.New("settings must be a JSON object under 1 MiB")

// Store is one file, read whole and written whole.
//
// There is no merge and no partial update, on purpose: two writers would otherwise interleave keys and
// produce a settings file nobody could reason about. The client owns the whole document and saves it
// whole, and the mutex here is what keeps two saves from tearing the file.
type Store struct {
	mu   sync.Mutex
	path string
}

// New opens (creating the directory for) the settings file inside dataDir.
func New(dataDir string) (*Store, error) {
	if dataDir == "" {
		return nil, errors.New("settings: data directory is empty")
	}
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return nil, fmt.Errorf("settings: cannot create %s: %w", dataDir, err)
	}
	return &Store{path: filepath.Join(dataDir, fileName)}, nil
}

// Path is the file this store owns.
func (s *Store) Path() string { return s.path }

// Read returns the stored document, or `{}` when nothing has been saved yet.
//
// An unreadable file is an error rather than an empty answer: silently starting from the defaults would
// overwrite the user's preferences with them on the next save.
func (s *Store) Read() (json.RawMessage, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.readLocked()
}

func (s *Store) readLocked() (json.RawMessage, error) {
	raw, err := os.ReadFile(s.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return json.RawMessage("{}"), nil
		}
		return nil, fmt.Errorf("settings: cannot read %s: %w", s.path, err)
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return json.RawMessage("{}"), nil
	}
	if err := validate(trimmed); err != nil {
		return nil, fmt.Errorf("settings: %s: %w", s.path, err)
	}
	return json.RawMessage(trimmed), nil
}

// Write replaces the document.
func (s *Store) Write(document []byte) error {
	trimmed := bytes.TrimSpace(document)
	if err := validate(trimmed); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return writeFile(s.path, trimmed)
}

// validate is the only check the gateway makes: an object, and not an absurdly large one.
func validate(document []byte) error {
	if len(document) == 0 || len(document) > MaxBytes || document[0] != '{' || !json.Valid(document) {
		return ErrInvalid
	}
	return nil
}

// writeFile writes through a temporary file in the same directory and renames it into place, so a
// reader never sees half a document and a failed write leaves nothing behind.
func writeFile(path string, data []byte) error {
	temp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*.tmp")
	if err != nil {
		return fmt.Errorf("settings: cannot open a temporary file for %s: %w", path, err)
	}
	name := temp.Name()
	defer func() { _ = os.Remove(name) }()
	if _, err := temp.Write(append(data, '\n')); err != nil {
		_ = temp.Close()
		return fmt.Errorf("settings: cannot write %s: %w", path, err)
	}
	if err := temp.Close(); err != nil {
		return fmt.Errorf("settings: cannot close %s: %w", path, err)
	}
	if err := os.Rename(name, path); err != nil {
		return fmt.Errorf("settings: cannot install %s: %w", path, err)
	}
	return nil
}
