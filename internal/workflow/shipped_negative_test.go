package workflow

// `negative` is not a universal input: only a graph with a negative text encoder can read it.
//
// Z-Image and all four H3 video workflows wire `ConditioningZeroOut(positive)` as their negative — there is
// no second text encoder to write to — ESREGAN has no text at all, and `image-qwen21-angle`'s negative text
// is baked into the graph with no binding. Declaring the key for those five made `/api/workflows` advertise a
// knob that a run would accept and drop (docs/decisions.md #275). The declaration is now derived from the
// binding; this pins both sides: the workflows that read the key accept it, the ones that cannot refuse it.

import (
	"strings"
	"testing"
)

// readsNegative are the shipped workflows whose graph binds the key, with the modes that carry it.
var readsNegative = map[string][]string{
	"image-qwen21":              {"t2i", "edit", "inpaint", "outpaint"},
	"image-moss-sft-8step":      {""},
	"image-moss-balanced-8step": {""},
	"image-moss-sft-int8-8step": {""},
}

// silentNegative are the shipped workflows that cannot read it: they must not accept it.
var silentNegative = []string{
	"image-z-image-turbo",
	"image-esrgan-upscale",
	"image-qwen21-angle",
	"video-h3-t2v",
	"video-h3-frames",
	"video-h3-ref2va",
	"video-h3-character-swap",
	"video-rife",
	"audio-minimax-music-3",
}

func TestShippedNegativeIsAcceptedOnlyWhereItIsRead(t *testing.T) {
	registry := NewRegistry(RegistryOptions{Dir: shippedWorkflowsDir})
	if err := registry.Load(); err != nil {
		t.Skipf("shipped workflows not available: %v", err)
	}
	byID := map[string]*Entry{}
	for _, entry := range registry.Entries() {
		byID[entry.ID] = entry
	}

	for id, modes := range readsNegative {
		entry, ok := byID[id]
		if !ok {
			t.Errorf("%s is not registered", id)
			continue
		}
		for _, mode := range modes {
			resolved := registry.ResolveForMode(entry, mode)
			label := id
			if mode != "" {
				label += " (" + mode + ")"
			}
			if err := ValidateInputs(resolved, map[string]any{"prompt": "a cat", "negative": "watermark"}, InputLimits{}); err != nil {
				t.Errorf("%s binds `negative` but refuses it: %v", label, err)
			}
		}
	}

	for _, id := range silentNegative {
		entry, ok := byID[id]
		if !ok {
			t.Errorf("%s is not registered", id)
			continue
		}
		if containsString(entry.AcceptedInputs(), "negative") {
			t.Errorf("%s advertises `negative` but no binding reads it", id)
		}
		err := ValidateInputs(entry, map[string]any{"prompt": "a cat", "negative": "watermark"}, InputLimits{})
		if err == nil {
			t.Errorf("%s accepted `negative`, which it would have dropped", id)
			continue
		}
		// The refusal must be the ordinary unknown-key one, naming the key, so a caller can act on it.
		if !strings.Contains(err.Error(), "negative") {
			t.Errorf("%s refused `negative` with an unrelated message: %v", id, err)
		}
	}
}

// The rule itself, independent of what ships today: a `from`-less binding reads the field of its own name,
// so only that shape makes the field live. A binding named `negative` that reads somewhere else does not.
func TestNegativeIsAnInputOnlyWhenABindingReadsThatField(t *testing.T) {
	bound := &Entry{Name: "x", RawBindings: bindings("negative", map[string]any{"node": "5", "input": "text"})}
	if !containsString(bound.AcceptedInputs(), "negative") {
		t.Fatal("a binding that reads the negative field did not make it an input")
	}

	elsewhere := &Entry{Name: "x", RawBindings: bindings(
		"negative", map[string]any{"node": "5", "input": "text", "from": "params.other"},
	)}
	if containsString(elsewhere.AcceptedInputs(), "negative") {
		t.Fatal("a binding that reads something else made `negative` an input")
	}

	absent := &Entry{Name: "x", RawBindings: bindings("prompt", map[string]any{"node": "5", "input": "text"})}
	if containsString(absent.AcceptedInputs(), "negative") {
		t.Fatal("a workflow with no negative binding advertises `negative`")
	}
}
