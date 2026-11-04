package workflow

import (
	"encoding/json"
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
	merged := *entry
	mergeVariantContract(&merged, entry.Variants.Values["t2i"])
	if merged.Accepts.Images.Max != 0 {
		t.Errorf("ResolveForMode kept the entry's accepts: %+v", merged.Accepts.Images)
	}
}
