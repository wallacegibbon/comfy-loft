package store

import (
	"os"
	"testing"

	"comfyloft/internal/logx"
)

func quietLogger() *logx.Logger { return logx.NewWithWriter("test", os.Stderr) }

func TestVisibilityPersists(t *testing.T) {
	dir := t.TempDir()
	visibility := NewVisibility(dir, quietLogger())
	visibility.Load()

	if err := visibility.SetHidden("image-a", true); err != nil {
		t.Fatalf("SetHidden: %v", err)
	}
	if !visibility.IsHidden("image-a") {
		t.Error("image-a should be hidden")
	}
	if visibility.IsHidden("image-b") {
		t.Error("image-b should not be hidden")
	}

	// Re-read from disk: the canvas restarts more often than the gateway.
	reloaded := NewVisibility(dir, quietLogger())
	reloaded.Load()
	if !reloaded.IsHidden("image-a") {
		t.Error("hidden state did not survive a reload")
	}

	if err := reloaded.SetHidden("image-a", false); err != nil {
		t.Fatalf("SetHidden(false): %v", err)
	}
	if reloaded.IsHidden("image-a") {
		t.Error("image-a should be visible again")
	}
}

func TestVisibilityRejectsEmptyID(t *testing.T) {
	visibility := NewVisibility(t.TempDir(), quietLogger())
	if err := visibility.SetHidden("", true); err == nil {
		t.Fatal("expected an error for an empty workflow id")
	}
}

func TestMainModelsPerPackAndWorkflow(t *testing.T) {
	dir := t.TempDir()
	models := NewMainModels(dir, quietLogger())
	models.Load()

	if err := models.Set("moss", "moss_balanced.safetensors", []string{"image-moss-sft-8step"}); err != nil {
		t.Fatalf("Set: %v", err)
	}
	if got := models.FileForPack("moss"); got != "moss_balanced.safetensors" {
		t.Errorf("FileForPack = %q", got)
	}
	// The pack-level choice is the fallback for its workflows.
	if got := models.FileForWorkflow("image-moss-sft-8step"); got != "moss_balanced.safetensors" {
		t.Errorf("FileForWorkflow = %q", got)
	}

	// A workflow-scoped override wins and can also mean "use the authored default".
	if err := models.SetForWorkflow("image-z-image-turbo", "zit_fp8.safetensors"); err != nil {
		t.Fatalf("SetForWorkflow: %v", err)
	}
	if got := models.FileForWorkflow("image-z-image-turbo"); got != "zit_fp8.safetensors" {
		t.Errorf("override = %q", got)
	}
	if err := models.SetForWorkflow("image-z-image-turbo", ""); err != nil {
		t.Fatalf("clear override: %v", err)
	}
	if got := models.FileForWorkflow("image-z-image-turbo"); got != "" {
		t.Errorf("cleared override = %q, want empty", got)
	}

	reloaded := NewMainModels(dir, quietLogger())
	reloaded.Load()
	if got := reloaded.FileForPack("moss"); got != "moss_balanced.safetensors" {
		t.Errorf("pack selection did not persist: %q", got)
	}
}

func TestMainModelsErrors(t *testing.T) {
	models := NewMainModels(t.TempDir(), quietLogger())
	models.Load()

	if err := models.Set("", "f", nil); err == nil {
		t.Error("expected an error for a missing pack id")
	}
	if err := models.SetForWorkflow("", "f"); err == nil {
		t.Error("expected an error for a missing workflow id")
	}
	if err := models.SetForWorkflow("wf", ""); err != nil {
		t.Errorf("clearing an override should be allowed: %v", err)
	}
}

func TestStripBOM(t *testing.T) {
	withBOM := []byte{0xEF, 0xBB, 0xBF, 'h', 'i'}
	if got := string(stripBOM(withBOM)); got != "hi" {
		t.Errorf("stripBOM = %q", got)
	}
	without := []byte("hi")
	if got := string(stripBOM(without)); got != "hi" {
		t.Errorf("stripBOM mutated a clean payload: %q", got)
	}
}
