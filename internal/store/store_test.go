package store

import (
	"os"
	"path/filepath"
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

	// Re-read from disk: the canvas restarts more often than the server.
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

// A speech profile list is somebody's file, so what is read out of it has to be usable: an entry with no address
// is an entry no request can be sent to, and ids that collide or are missing are renumbered rather than trusted.
func TestSpeechProfilesLoadRepairsWhatTheFileSays(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "speech.json")
	document := `{"version":1,"active":99,"profiles":[
	  {"id":3,"name":" one ","url":"http://127.0.0.1:1/v1/audio/transcriptions","model":" refine ","key":" sk-test "},
	  {"id":3,"name":"two","url":"http://127.0.0.1:2/v1/audio/transcriptions"},
	  {"id":0,"name":"three","url":"http://127.0.0.1:3/v1/audio/transcriptions"},
	  {"id":4,"name":"nowhere","url":"  "}
	]}`
	if err := os.WriteFile(file, []byte(document), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	profiles := NewSpeechProfiles(dir, quietLogger())
	profiles.Load()
	views, active := profiles.List()
	if len(views) != 3 {
		t.Fatalf("loaded %d profiles, want the three with an address", len(views))
	}
	seen := map[int]bool{}
	for index, view := range views {
		if view.ID < 1 || seen[view.ID] {
			t.Errorf("profile %d has id %d, want an id of its own", index, view.ID)
		}
		seen[view.ID] = true
	}
	if views[0].Name != "one" || views[0].Model != "refine" || !views[0].HasKey {
		t.Errorf("first profile = %+v, want it trimmed with its key", views[0])
	}
	// An active id naming nothing is the first profile: a list with nothing active is a microphone that fails
	// with nothing on screen explaining it.
	if active != views[0].ID {
		t.Errorf("active = %d, want the first profile %d", active, views[0].ID)
	}
	if profile, ok := profiles.Active(); !ok || profile.Key != "sk-test" || profile.ID != views[0].ID {
		t.Errorf("Active = %+v/%v, want the first profile with its key", profile, ok)
	}
}

// A page adding a profile after the file was written gets an id no other profile has, and the next one gets a
// different one — even when the page sends the list back unchanged in between.
func TestSpeechProfilesNumberNewEntriesAfterTheHighestID(t *testing.T) {
	dir := t.TempDir()
	profiles := NewSpeechProfiles(dir, quietLogger())
	profiles.Load()

	first := SpeechProfileInput{URL: "http://127.0.0.1:1/v1/audio/transcriptions"}
	if err := profiles.Replace([]SpeechProfileInput{first}, 0); err != nil {
		t.Fatalf("first Replace: %v", err)
	}
	views, _ := profiles.List()
	kept := SpeechProfileInput{ID: views[0].ID, URL: views[0].URL}
	second := SpeechProfileInput{URL: "http://127.0.0.1:2/v1/audio/transcriptions"}
	if err := profiles.Replace([]SpeechProfileInput{kept, second}, 0); err != nil {
		t.Fatalf("second Replace: %v", err)
	}
	views, _ = profiles.List()
	if len(views) != 2 || views[0].ID == views[1].ID {
		t.Fatalf("ids after adding a second profile: %+v", views)
	}

	// A restart reads the ids back, and the next addition still does not reuse one.
	reloaded := NewSpeechProfiles(dir, quietLogger())
	reloaded.Load()
	views, _ = reloaded.List()
	third := SpeechProfileInput{URL: "http://127.0.0.1:3/v1/audio/transcriptions"}
	if err := reloaded.Replace([]SpeechProfileInput{{ID: views[0].ID, URL: views[0].URL}, {ID: views[1].ID, URL: views[1].URL}, third}, 0); err != nil {
		t.Fatalf("third Replace: %v", err)
	}
	views, _ = reloaded.List()
	seen := map[int]bool{}
	for _, view := range views {
		if seen[view.ID] {
			t.Errorf("id %d was reused for %q", view.ID, view.Name)
		}
		seen[view.ID] = true
	}
}
