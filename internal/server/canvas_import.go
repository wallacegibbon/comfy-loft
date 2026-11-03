package server

// Importing an exported canvas.
//
// One canvas is one zip: `canvas.json` (the document), `manifest.json` (the title and the format version) and
// `files/<name>` for its media. The client posts the archive and the server unpacks it into a new canvas
// directory, which is the whole operation — the files keep the names the document uses, so nothing is
// renamed and nothing is rewritten (decisions #172).
//
// The archive is the one thing this server parses out of user input, so the rules are explicit: only the
// three shapes above are accepted (plus the empty directory entries a re-zip adds), an entry may not leave
// the directory, and the unpacked bytes are bounded by the same ceiling as the body.

import (
	"archive/zip"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"

	"comfyloft/internal/canvas"
	"comfyloft/internal/httpx"
)

const (
	// importManifestName is the archive's own description of itself: format version and the title to
	// restore. It is not the document, and the server is the one that reads it.
	importManifestName = "manifest.json"
	// maxImportEntries bounds an archive's file count. A canvas is built by hand, so a zip with tens of
	// thousands of entries is a decompression bomb rather than somebody's work.
	maxImportEntries = 20000
)

// importManifest is what an export writes beside the document.
type importManifest struct {
	App string `json:"app"`
	// Version is the archive format, not the app's version: 1 is "canvas.json + manifest.json + files/".
	Version int    `json:"version"`
	Title   string `json:"title"`
}

// handleCanvasImport implements POST /api/canvases/import: one exported canvas, restored.
func (s *Server) handleCanvasImport(ctx *httpx.Ctx) error {
	limit := s.cfg.MaxImportBytes
	if limit <= 0 {
		return httpx.NewError(http.StatusInternalServerError, "import_disabled", "this server has no import ceiling configured")
	}
	if ctx.R.Body == nil {
		return httpx.BadRequest("import_empty", "the request carried no archive")
	}

	// The archive lands in a file first, not in memory: a canvas with a few clips is gigabytes, and the
	// document has to be read (and validated) before the files are written.
	temp, err := os.CreateTemp(s.cfg.DataDir, ".import-*.zip")
	if err != nil {
		return httpx.NewError(http.StatusInternalServerError, "import_failed", "cannot open a temporary file for the archive: "+err.Error())
	}
	name := temp.Name()
	defer func() { _ = os.Remove(name) }()
	defer func() { _ = temp.Close() }()

	written, err := io.Copy(temp, io.LimitReader(ctx.R.Body, limit+1))
	if err != nil {
		return httpx.BadRequest("import_read_failed", "failed to read the archive")
	}
	if written == 0 {
		return httpx.BadRequest("import_empty", "the request carried no archive")
	}
	if written > limit {
		return httpx.Errorf(http.StatusRequestEntityTooLarge, "import_too_large",
			"the archive exceeds the configured limit (%d bytes)", limit)
	}

	created, err := s.importArchive(name, limit)
	if err != nil {
		return err
	}
	okJSON(ctx.W, map[string]any{"canvas": created})
	return nil
}

// importArchive unpacks one archive into a new canvas and answers with it.
//
// The canvas is created only after the archive has been read far enough to know it is one, and it is removed
// again if any file fails to write: an import either produces the canvas that was exported or nothing.
func (s *Server) importArchive(archivePath string, limit int64) (canvas.Canvas, error) {
	reader, err := zip.OpenReader(archivePath)
	if err != nil {
		return canvas.Canvas{}, httpx.BadRequest("import_not_a_zip", "the file is not a zip archive")
	}
	defer reader.Close()
	if len(reader.File) > maxImportEntries {
		return canvas.Canvas{}, httpx.Errorf(http.StatusRequestEntityTooLarge, "import_too_large",
			"the archive has %d entries; an import carries at most %d", len(reader.File), maxImportEntries)
	}

	var document []byte
	title := ""
	names := make([]string, 0, len(reader.File))
	files := make([]*zip.File, 0, len(reader.File))
	for _, entry := range reader.File {
		entryName, ok := cleanArchiveName(entry.Name)
		if !ok {
			return canvas.Canvas{}, httpx.Errorf(http.StatusUnprocessableEntity, "import_invalid_entry",
				"the archive holds an entry that would leave the canvas directory: %q", entry.Name)
		}
		// A directory entry is a directory, not a file to restore: `zip -r`, Archive Utility and Explorer
		// all write one for every folder, so a canvas somebody unzipped and re-zipped carries `files/`
		// beside the files themselves. Refusing it would refuse the ordinary way of moving an export.
		if entry.FileInfo().IsDir() {
			continue
		}
		switch {
		case entryName == canvas.DocumentName:
			document, err = readZipEntry(entry, int64(canvas.MaxDocumentBytes))
			if err != nil {
				return canvas.Canvas{}, err
			}
		case entryName == importManifestName:
			raw, readErr := readZipEntry(entry, 1<<20)
			if readErr != nil {
				return canvas.Canvas{}, readErr
			}
			var manifest importManifest
			if json.Unmarshal(raw, &manifest) == nil {
				title = manifest.Title
			}
		case strings.HasPrefix(entryName, canvas.FilesName+"/"):
			fileName := strings.TrimPrefix(entryName, canvas.FilesName+"/")
			if !canvas.ValidFileName(fileName) {
				return canvas.Canvas{}, httpx.Errorf(http.StatusUnprocessableEntity, "import_invalid_entry",
					"the archive holds a file name this canvas cannot take: %q", entry.Name)
			}
			names = append(names, fileName)
			files = append(files, entry)
		case entryName == "projects.json" || strings.HasPrefix(entryName, "projects/"):
			// The multi-canvas format this project exported before #172. Saying so is more useful than
			// "unexpected entry": the file is the user's, and it is not damaged.
			return canvas.Canvas{}, httpx.NewError(http.StatusUnprocessableEntity, "import_old_format",
				"this archive was exported by an older build, which packed several canvases into one zip; export it again from the canvas it belongs to")
		default:
			return canvas.Canvas{}, httpx.Errorf(http.StatusUnprocessableEntity, "import_unexpected_entry",
				"an exported canvas holds canvas.json, manifest.json and files/; this archive also has %q", entry.Name)
		}
	}
	if len(document) == 0 {
		return canvas.Canvas{}, httpx.BadRequest("import_no_document", "the archive holds no canvas.json")
	}

	created, err := s.canvases.Create(title, document)
	if err != nil {
		return canvas.Canvas{}, canvasError(err)
	}
	budget := limit
	for index, entry := range files {
		data, readErr := readZipEntry(entry, budget)
		if readErr != nil {
			_ = s.canvases.Delete(created.ID)
			return canvas.Canvas{}, readErr
		}
		budget -= int64(len(data))
		if writeErr := s.canvases.WriteFile(created.ID, names[index], data); writeErr != nil {
			_ = s.canvases.Delete(created.ID)
			return canvas.Canvas{}, canvasError(writeErr)
		}
	}

	restored, err := s.canvases.Read(created.ID)
	if err != nil {
		return canvas.Canvas{}, canvasError(err)
	}
	s.logger.Info("imported canvas %s: %d file(s) from %s", created.ID, len(files), filepath.Base(archivePath))
	return restored, nil
}

// readZipEntry reads one entry, refusing to expand past max.
func readZipEntry(entry *zip.File, max int64) ([]byte, error) {
	if max <= 0 {
		return nil, httpx.NewError(http.StatusRequestEntityTooLarge, "import_too_large",
			"the archive expands past the configured limit")
	}
	reader, err := entry.Open()
	if err != nil {
		return nil, httpx.BadRequest("import_read_failed", "failed to read "+entry.Name+": "+err.Error())
	}
	defer reader.Close()
	data, err := io.ReadAll(io.LimitReader(reader, max+1))
	if err != nil {
		return nil, httpx.BadRequest("import_read_failed", "failed to read "+entry.Name+": "+err.Error())
	}
	if int64(len(data)) > max {
		return nil, httpx.Errorf(http.StatusRequestEntityTooLarge, "import_too_large",
			"the archive expands past the configured limit (%d bytes)", max)
	}
	return data, nil
}

// cleanArchiveName normalises an entry name, and reports false for one that would leave the directory.
//
// A `..` segment is refused before cleaning, not after: `files/../escape.png` cleans to `escape.png`, which
// no longer looks like a traversal but is exactly what one produces — and a zip entry is not a path the
// caller may steer.
func cleanArchiveName(name string) (string, bool) {
	slashed := strings.ReplaceAll(name, `\`, "/")
	for _, segment := range strings.Split(slashed, "/") {
		if segment == ".." {
			return "", false
		}
	}
	cleaned := strings.TrimPrefix(path.Clean("/"+slashed), "/")
	if cleaned == "" || cleaned == "." {
		return "", false
	}
	return cleaned, true
}
