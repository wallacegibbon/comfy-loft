package store

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"comfyloft/internal/logx"
)

/**
 * The credential the configured speech server wants, if it wants one.
 *
 * **Why not the preferences document.** `data/settings.json` is read by every browser that loads the page —
 * `GET /config.js` carries the whole document so the first paint can be themed — and, when the operator names
 * `RUNTIME_CONFIG_PATH`, it is written out as a file for a static host with no server in the request path. A
 * credential in it would be handed to every client that can reach the server and published to whatever host
 * serves that file. So the key lives in a file of its own, mode 0600, and the page only ever learns whether
 * one is stored (`GET /api/speech/key`). That is the same rule the agent's model keys already follow: the
 * server holds them and never sends them out (`config.preferences.apiKeyStored`).
 *
 * The key is one value, not a keyring: this build talks to one speech server (#239), and a second provider
 * would be a second file, not a second field here.
 */
type SpeechKey struct {
	file   string
	logger *logx.Logger
	mu     sync.RWMutex
	key    string
}

// NewSpeechKey builds the store for <dataDir>/speech-key.json.
func NewSpeechKey(dataDir string, logger *logx.Logger) *SpeechKey {
	return &SpeechKey{file: filepath.Join(dataDir, "speech-key.json"), logger: logger}
}

// Load reads the stored key. A missing file is the ordinary case — no key — and says nothing.
func (s *SpeechKey) Load() {
	data, err := os.ReadFile(s.file)
	if err != nil {
		if !os.IsNotExist(err) {
			s.logger.Warn("failed to read the speech key: %s", err)
		}
		return
	}
	var document struct {
		Key string `json:"key"`
	}
	if err := json.Unmarshal(stripBOM(data), &document); err != nil {
		s.logger.Warn("failed to read the speech key: %s", err)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.key = strings.TrimSpace(document.Key)
}

// Get is the key, or "" when none is stored.
func (s *SpeechKey) Get() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.key
}

// Stored reports whether a key is stored, which is all the page is told.
func (s *SpeechKey) Stored() bool { return s.Get() != "" }

// Set stores the key, or removes the file when the key is blank.
//
// Owner-only, unlike every other file here: a task index that only its owner can read is a workspace somebody
// cannot copy, and a credential that a second account can read is a credential that has leaked. The temporary
// file is created 0600 for the same reason — a rename would otherwise publish the mode the umask chose.
func (s *SpeechKey) Set(key string) error {
	trimmed := strings.TrimSpace(key)
	if trimmed == "" {
		s.mu.Lock()
		s.key = ""
		s.mu.Unlock()
		if err := os.Remove(s.file); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("store: cannot remove the speech key: %w", err)
		}
		return nil
	}

	if err := os.MkdirAll(filepath.Dir(s.file), 0o755); err != nil {
		return fmt.Errorf("store: cannot create %s: %w", filepath.Dir(s.file), err)
	}
	payload, err := json.Marshal(map[string]string{"key": trimmed})
	if err != nil {
		return fmt.Errorf("store: cannot encode the speech key: %w", err)
	}
	temp, err := os.CreateTemp(filepath.Dir(s.file), "."+filepath.Base(s.file)+".*.tmp")
	if err != nil {
		return fmt.Errorf("store: cannot open a temporary file for %s: %w", s.file, err)
	}
	name := temp.Name()
	defer func() { _ = os.Remove(name) }()
	if err := temp.Chmod(0o600); err != nil {
		_ = temp.Close()
		return fmt.Errorf("store: cannot set the mode of %s: %w", name, err)
	}
	if _, err := temp.Write(append(payload, '\n')); err != nil {
		_ = temp.Close()
		return fmt.Errorf("store: cannot write %s: %w", name, err)
	}
	if err := temp.Close(); err != nil {
		return fmt.Errorf("store: cannot close %s: %w", name, err)
	}
	if err := os.Rename(name, s.file); err != nil {
		return fmt.Errorf("store: cannot install %s: %w", s.file, err)
	}
	s.mu.Lock()
	s.key = trimmed
	s.mu.Unlock()
	return nil
}
