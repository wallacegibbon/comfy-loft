package workflow

import (
	"encoding/json"
	"sort"
	"strings"
	"testing"
)

// A workflow's request contract has to reach the client, or every panel that wants to know what a
// workflow needs has to recognise it by name — which is the bug this field exists to end (#63): the
// canvas showed "this text-to-video takes no images" by checking for `video-h3-t2v`, and called an
// interpolation node a text-to-video node because it knew neither.
func TestPublicProjectionCarriesTheRequestContract(t *testing.T) {
	entry := &Entry{
		ID:   "video-rife",
		Name: "video-rife",
		Type: "video",
		Accepts: &Accepts{
			Videos: &MediaLimit{Min: 1, Max: 1},
			Note:   "interpolation takes one clip",
		},
	}

	payload, err := json.Marshal(PublicProjection(entry))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var row map[string]any
	if err := json.Unmarshal(payload, &row); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	accepts, _ := row["accepts"].(map[string]any)
	if accepts == nil {
		t.Fatalf("the row carries no accepts: %v", row)
	}
	videos, _ := accepts["videos"].(map[string]any)
	if videos == nil || videos["min"] != 1.0 || videos["max"] != 1.0 {
		t.Errorf("accepts.videos = %v, want one clip", accepts["videos"])
	}
	if accepts["note"] != "interpolation takes one clip" {
		t.Errorf("accepts.note = %v", accepts["note"])
	}
	if _, present := row["mode"]; present {
		t.Errorf("a workflow that declares no mode must not report one: %v", row["mode"])
	}
}

// A mode is a different graph, so it may need a different media mix. The row says which: the mode a
// reader picks must be the mode whose contract they see, and the same fields are what a run is
// validated against.
func TestPublicProjectionGivesEachVariantItsOwnContract(t *testing.T) {
	entry := &Entry{
		ID:      "image-qwen21",
		Name:    "image-qwen21",
		Type:    "image",
		Accepts: &Accepts{Images: &MediaLimit{Min: 1, Max: 4}},
		Variants: OrderedMap[*Variant]{
			Keys: []string{"edit", "t2i"},
			Values: map[string]*Variant{
				"edit": {File: "edit.json"},
				"t2i":  {File: "t2i.json", Accepts: &Accepts{Images: &MediaLimit{Max: 0}}},
			},
		},
	}

	projected := PublicProjection(entry)
	if projected.VariantContracts["edit"].Accepts == nil || projected.VariantContracts["edit"].Accepts.Images.Max != 4 {
		t.Errorf("edit lost the entry's contract: %+v", projected.VariantContracts["edit"])
	}
	t2i := projected.VariantContracts["t2i"]
	if t2i.Accepts == nil || t2i.Accepts.Images == nil || t2i.Accepts.Images.Max != 0 {
		t.Errorf("t2i must report the contract it declares, not the entry's: %+v", t2i)
	}

	// The run path resolves a mode through the same helper, so the panel and the 400 agree.
	merged := mergeVariant(entry, entry.Variants.Values["t2i"])
	if merged.Accepts.Images.Max != 0 {
		t.Errorf("ResolveForMode kept the entry's accepts: %+v", merged.Accepts.Images)
	}
}

// The keys a run may take are the client's answer to "this knob belongs to another model". A node keeps its
// params when the model under it changes, so without this list the canvas either sends a value the server
// refuses (a 400 for a field nobody typed) or re-derives the rule and drifts from `ValidateInputs`. The list
// is that same function, and a variant takes its own — Qwen's outpaint binds padding its siblings do not.
func TestPublicProjectionCarriesTheKeysARunMayTake(t *testing.T) {
	entry := &Entry{
		ID:   "image-qwen21",
		Name: "image-qwen21",
		Type: "image",
		RawBindings: OrderedMap[OrderedMap[any]]{
			Keys: []string{"prompt", "seed", "resolution"},
			// A declared parameter is the panel's wording for a key a binding reads; the binding is what
			// makes the key acceptable (#299).
			Values: map[string]OrderedMap[any]{"prompt": kv("node", "5"), "seed": kv("node", "7", "from", "params.seed"), "resolution": kv("node", "5", "from", "params.resolution")},
		},
		Parameters: []any{map[string]any{"key": "resolution", "type": "number"}},
		Variants: OrderedMap[*Variant]{
			Keys: []string{"outpaint"},
			Values: map[string]*Variant{
				"outpaint": {
					File:        "outpaint.json",
					RawBindings: OrderedMap[OrderedMap[any]]{Keys: []string{"left", "prompt"}, Values: map[string]OrderedMap[any]{"left": kv("node", "2", "from", "params.left"), "prompt": kv("node", "10")}},
				},
			},
		},
	}

	projected := PublicProjection(entry)
	accepted := func(keys []string) map[string]bool {
		out := map[string]bool{}
		for _, key := range keys {
			out[key] = true
		}
		return out
	}
	top := accepted(projected.Inputs)
	if !top["prompt"] || !top["seed"] || !top["resolution"] {
		t.Errorf("the entry's own keys are missing from %v", projected.Inputs)
	}
	if top["left"] {
		t.Errorf("a key only the variant binds leaked into the entry's list: %v", projected.Inputs)
	}
	mode := accepted(projected.VariantContracts["outpaint"].Inputs)
	if !mode["left"] || !mode["prompt"] {
		t.Errorf("the variant's own key is missing from %v", projected.VariantContracts["outpaint"].Inputs)
	}

	// The list is the validator's own answer, not a second opinion about it.
	if err := ValidateInputs(entry, map[string]any{"prompt": "x", "seed": 1.0}, InputLimits{}); err != nil {
		t.Errorf("a key the projection offers was refused: %v", err)
	}
}

// A mode's contract is read off the entry that mode runs, not off the variant's bindings alone.
//
// The keys a graph contributes are not only its bindings: an `outputSize` that follows the requested size
// makes `size` readable, and any `outputSize` at all makes `editCanvasSize` readable. The projection used to
// compute a mode's list from a copy of the parent with the variant's bindings swapped in, which is not the
// entry a run is validated against — so Qwen's `t2i` published a contract without `size` while a run of it
// accepted one. Nothing noticed until the canvas began dropping what the contract does not list (#302), and
// then the size picker and the canvas-ratio pills quietly stopped reaching the graph (#303).
func TestAModeContractIsTheEntryItsRunUses(t *testing.T) {
	entry := &Entry{
		ID:   "image-qwen21",
		Name: "image-qwen21",
		Type: "image",
		Variants: OrderedMap[*Variant]{
			Keys: []string{"t2i", "edit"},
			Values: map[string]*Variant{
				// Words only: the picture is the requested size, written into the latent's source node.
				"t2i": {File: "t2i.json", OutputSize: &OutputSize{Node: "13", LatentNode: "10", FromSize: true}},
				// An edit follows the canvas the caller picked, but not a raw size.
				"edit": {File: "edit.json", OutputSize: &OutputSize{Node: "13", LatentNode: "10"}},
			},
		},
	}

	contracts := PublicProjection(entry).VariantContracts
	for _, mode := range []string{"t2i", "edit"} {
		want := mergeVariant(entry, entry.Variants.Values[mode]).AcceptedInputs()
		got := contracts[mode].Inputs
		if strings.Join(sortedInputs(got), ",") != strings.Join(sortedInputs(want), ",") {
			t.Errorf("%s publishes %v but a run of it accepts %v", mode, got, want)
		}
	}
	if !containsKey(contracts["t2i"].Inputs, "size") {
		t.Errorf("an output size that follows the request did not make `size` readable: %v", contracts["t2i"].Inputs)
	}
	// The edit takes the canvas size, not a raw one: an `outputSize` without `fromSize` is where `editCanvasSize`
	// comes from, and `size` stays out of the list rather than being offered and ignored.
	if !containsKey(contracts["edit"].Inputs, "editCanvasSize") || containsKey(contracts["edit"].Inputs, "size") {
		t.Errorf("an edit that follows the canvas published the wrong keys: %v", contracts["edit"].Inputs)
	}
}

func sortedInputs(keys []string) []string {
	out := append([]string{}, keys...)
	sort.Strings(out)
	return out
}

func containsKey(keys []string, key string) bool {
	for _, candidate := range keys {
		if candidate == key {
			return true
		}
	}
	return false
}
