package canvas

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"time"
)

/**
 * The files a canvas owns, and the ones it no longer mentions.
 *
 * Media used to live in the browser: an IndexedDB blob named `image:abc`, kept alive by a sweep that
 * walked every canvas in the store. That sweep died with the browser store (#154) — it could only see
 * the canvases somebody had opened, so running it would have deleted the rest. Here it comes back with
 * the property it always needed: the files sit next to the document, so "what is referenced" can be
 * answered from disk, for every canvas, without loading one into memory.
 *
 * The scan deliberately does not understand nodes. It looks for `files/<name>` anywhere in the
 * document, which is all a reference is: a node that shows an image names the file, and a node type
 * this build has never heard of does the same thing in the same way. Parsing the document would mean
 * the collector knew what a node was, which is the coupling #148 spent an entry removing.
 */

// fileReferencePattern matches the only way a document may name a file: `files/<name>`.
var fileReferencePattern = regexp.MustCompile(`files/([A-Za-z0-9][A-Za-z0-9._-]{0,127})`)

// DocumentReferences returns the file names a document mentions, sorted and de-duplicated.
func DocumentReferences(document []byte) []string {
	seen := map[string]struct{}{}
	for _, match := range fileReferencePattern.FindAllSubmatch(document, -1) {
		seen[string(match[1])] = struct{}{}
	}
	names := make([]string, 0, len(seen))
	for name := range seen {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// Files lists what a canvas currently holds, by name.
func (s *Store) Files(id string) ([]os.FileInfo, error) {
	if _, err := s.readMeta(id); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(filepath.Join(s.root, id, filesName))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	files := make([]os.FileInfo, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		files = append(files, info)
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Name() < files[j].Name() })
	return files, nil
}

// FilePath is where one file of a canvas lives. It does not check that the file exists.
//
// The name is validated before a path is built, for the reason ids are: `../` in a URL is a bug until
// it is a directory traversal.
func (s *Store) FilePath(id, name string) (string, error) {
	if _, err := s.readMeta(id); err != nil {
		return "", err
	}
	if !ValidFileName(name) {
		return "", ErrInvalidFileName
	}
	return filepath.Join(s.root, id, filesName, name), nil
}

// WriteFile puts bytes into a canvas under a name the caller chose.
//
// This exists for the one case where the name is not the gateway's to pick: importing an exported canvas.
// An export is the canvas directory, and its document already names every file (`files/<name>`), so a
// restore has to keep those names. The upload endpoint cannot serve that — it names files itself to keep
// them unique inside a canvas — and renaming on import would mean rewriting every reference in the
// document, which is the document learning about the gateway's naming (decisions #171).
//
// The write is atomic, like every other write here, and it refuses a name that is taken: see ErrFileExists.
func (s *Store) WriteFile(id, name string, data []byte) error {
	path, err := s.FilePath(id, name)
	if err != nil {
		return err
	}
	if _, err := os.Stat(path); err == nil {
		return ErrFileExists
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("canvas: cannot read %s: %w", path, err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("canvas: cannot create %s: %w", filepath.Dir(path), err)
	}
	return writeFile(path, data)
}

// SweepResult is what one sweep did.
type SweepResult struct {
	// Removed are the file names that were deleted.
	Removed []string
	// Kept are the files that survive only because they are younger than the grace window.
	Kept []string
}

// Sweep deletes the files of one canvas that neither its document nor `extra` refers to and that are
// older than grace.
//
// `extra` is how a caller protects something the document does not name yet: a run that has written an
// output the client has not put into a node, or an upload that is about to become a run's input. The
// grace window covers the rest — a file written seconds ago is either referenced by a request in flight
// or by a save that has not arrived, and deleting it in that window would be the one kind of data loss
// this design cannot explain.
func (s *Store) Sweep(id string, extra []string, grace time.Duration) (SweepResult, error) {
	var result SweepResult
	loaded, err := s.readMeta(id)
	if err != nil {
		return result, err
	}
	document, err := os.ReadFile(filepath.Join(s.root, id, documentName))
	if err != nil && !os.IsNotExist(err) {
		return result, err
	}

	alive := make(map[string]struct{}, len(extra)+8)
	for _, name := range DocumentReferences(document) {
		alive[name] = struct{}{}
	}
	for _, name := range extra {
		alive[name] = struct{}{}
	}

	files, err := s.Files(id)
	if err != nil {
		return result, err
	}
	cutoff := s.now().Add(-grace)
	for _, file := range files {
		if _, referenced := alive[file.Name()]; referenced {
			continue
		}
		if file.ModTime().After(cutoff) {
			result.Kept = append(result.Kept, file.Name())
			continue
		}
		if err := os.Remove(filepath.Join(s.root, loaded.ID, filesName, file.Name())); err != nil {
			return result, err
		}
		result.Removed = append(result.Removed, file.Name())
	}
	return result, nil
}

// ValidFileName is a name this store hands out: no separators, no leading dot, nothing that could walk
// out of the directory or hide from a listing.
func ValidFileName(name string) bool {
	if name == "" || len(name) > 128 {
		return false
	}
	if name[0] == '.' {
		return false
	}
	for _, r := range name {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '.', r == '_', r == '-':
		default:
			return false
		}
	}
	return true
}
