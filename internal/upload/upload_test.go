package upload

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"comfyloft/internal/canvas"
	"comfyloft/internal/logx"
)

func newTestStore(t *testing.T) (*Store, string) {
	t.Helper()
	root := t.TempDir()
	canvases, err := canvas.New(root)
	if err != nil {
		t.Fatalf("canvas.New: %v", err)
	}
	summary, err := canvases.Create("test canvas", nil)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	return New(canvases, 1024, logx.NewWithWriter("test", io.Discard)), summary.ID
}

func TestKindOf(t *testing.T) {
	cases := []struct{ mime, name, want string }{
		{"image/png", "a.png", KindImage},
		{"", "clip.mp4", KindVideo},
		{"audio/mpeg", "song.mp3", KindAudio},
		{"video/mp4", "note.m4a", KindAudio},
		{"application/pdf", "file.pdf", ""},
		{"", "", ""},
	}
	for _, item := range cases {
		if got := KindOf(item.mime, item.name); got != item.want {
			t.Errorf("KindOf(%q, %q) = %q, want %q", item.mime, item.name, got, item.want)
		}
	}
}

func TestSaveWritesIntoTheCanvasAndCanBeReadBack(t *testing.T) {
	store, canvasID := newTestStore(t)

	file, err := store.Save(canvasID, KindImage, "reference.png", "image/png", []byte("PNG"))
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	if !strings.HasPrefix(file.ID, "up-") || !strings.HasSuffix(file.ID, ".png") {
		t.Errorf("id = %q, want up-<hex>.png", file.ID)
	}
	if filepath.Dir(file.Path) != filepath.Join(store.canvases.Root(), canvasID, "files") {
		t.Errorf("path = %s, want it inside the canvas", file.Path)
	}
	if data, err := os.ReadFile(file.Path); err != nil || string(data) != "PNG" {
		t.Errorf("bytes = %q, err = %v", data, err)
	}

	readBack := store.Get(canvasID, file.ID)
	if readBack == nil {
		t.Fatal("Get returned nothing for a file that exists")
	}
	if readBack.Bytes != 3 || readBack.Kind != KindImage {
		t.Errorf("read back %+v", readBack)
	}
}

func TestSaveRejectsAnOversizedFile(t *testing.T) {
	store, canvasID := newTestStore(t)
	if _, err := store.Save(canvasID, KindImage, "big.png", "image/png", make([]byte, 2048)); err != ErrTooLarge {
		t.Errorf("err = %v, want ErrTooLarge", err)
	}
}

func TestSaveRefusesAnUnknownCanvas(t *testing.T) {
	store, _ := newTestStore(t)
	if _, err := store.Save("0123456789ab", KindImage, "a.png", "image/png", []byte("PNG")); err == nil {
		t.Error("Save into an unknown canvas returned no error")
	}
}

func TestGetOfADeletedFileIsNothing(t *testing.T) {
	store, canvasID := newTestStore(t)
	file, err := store.Save(canvasID, KindImage, "gone.png", "image/png", []byte("PNG"))
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	if err := os.Remove(file.Path); err != nil {
		t.Fatal(err)
	}
	if got := store.Get(canvasID, file.ID); got != nil {
		t.Errorf("Get = %+v, want nil", got)
	}
}

// The push name is derived, which is what keeps ComfyUI from accumulating a copy per restart.
func TestComfyNameIsTheSameEveryTime(t *testing.T) {
	first := ComfyNameFor("40e8afb47f10", "up-a1b2c3d4.png")
	second := ComfyNameFor("40e8afb47f10", "up-a1b2c3d4.png")
	if first != second {
		t.Errorf("%q != %q", first, second)
	}
	if !strings.Contains(first, "40e8afb47f10") || !strings.Contains(first, "up-a1b2c3d4.png") {
		t.Errorf("name = %q, want both ids in it", first)
	}
	if other := ComfyNameFor("40e8afb47f10", "up-ffffffff.png"); other == first {
		t.Errorf("two uploads share the name %q", first)
	}
	if other := ComfyNameFor("111111111111", "up-a1b2c3d4.png"); other == first {
		t.Errorf("two canvases share the name %q", first)
	}
}

func TestComfyRefCache(t *testing.T) {
	store, _ := newTestStore(t)
	if _, ok := store.ComfyRef("up-a1b2c3d4.png"); ok {
		t.Error("an unpushed upload has a reference")
	}
	store.SetComfyRef("up-a1b2c3d4.png", "cl-x.png")
	if name, ok := store.ComfyRef("up-a1b2c3d4.png"); !ok || name != "cl-x.png" {
		t.Errorf("ref = %q, %v", name, ok)
	}
}
