package workflow

// The angle workflow's knobs, guarded where they were actually broken.
//
// `image-qwen21-angle` binds its sliders through `from: params.horizontalAngle` and friends, but declared
// no parameters — and an input is valid only when it is a semantic request key, a declared parameter, or a
// binding addressed by its own name (`params.<binding key>`). So the three names the client sent were
// refused as `unknown_input`, and the binding's own key was refused too: neither side had a path in
// (docs/decisions.md #267). The fix is the declaration, so the declaration is what this pins.

import "testing"

const angleWorkflowID = "image-qwen21-angle"

func TestShippedAngleWorkflowAcceptsItsKnobs(t *testing.T) {
	registry := NewRegistry(RegistryOptions{Dir: shippedWorkflowsDir})
	if err := registry.Load(); err != nil {
		t.Skipf("shipped workflows not available: %v", err)
	}
	var entry *Entry
	for _, candidate := range registry.Entries() {
		if candidate.ID == angleWorkflowID {
			entry = candidate
		}
	}
	if entry == nil {
		t.Fatalf("%s is not registered", angleWorkflowID)
	}

	if err := ValidateInputs(entry, map[string]any{"prompt": "turn the camera left", "horizontalAngle": 30.0, "pitchAngle": 5.0, "cameraDistance": 4.0}, InputLimits{}); err != nil {
		t.Fatalf("the knobs the canvas sends are refused: %v", err)
	}

	// The binding's own key is not an input: nothing reads `params.horizontal`, it reads
	// `params.horizontalAngle`. Accepting both would be two names for one knob.
	if err := ValidateInputs(entry, map[string]any{"horizontal": 30.0}, InputLimits{}); err == nil {
		t.Fatalf("`horizontal` was accepted, but no binding reads it")
	}

	// Declared as numbers, so something that is not one is refused here rather than failing inside ComfyUI
	// after the queue. A string of digits is tolerated on purpose (a hand-edited registry writes those).
	if err := ValidateInputs(entry, map[string]any{"horizontalAngle": "thirty"}, InputLimits{}); err == nil {
		t.Fatalf("a word was accepted for a number")
	}
}
