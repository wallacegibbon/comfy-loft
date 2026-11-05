package workflow

import (
	"testing"

	"comfyloft/internal/util"
)

// qwenSizeGraph is the shape the Qwen entries declare: an EmptyImage the request's size is written into, the
// VAE-encoded copy of it, and a sampler that starts out taking its latent from the text encoder.
//
// The nodes are `map[string]any` because that is what a decoded graph holds — `NodeAt` looks for exactly that.
func qwenSizeGraph() Graph {
	return Graph{
		"5":  map[string]any{"class_type": "TextEncodeQwenImage21", "inputs": map[string]any{}},
		"10": map[string]any{"class_type": "SamplerCustomAdvanced", "inputs": map[string]any{"latent_image": []any{"5", 2}}},
		"13": map[string]any{"class_type": "EmptyImage", "inputs": map[string]any{"width": 1024, "height": 1024}},
		"14": map[string]any{"class_type": "VAEEncode", "inputs": map[string]any{}},
	}
}

func qwenSizeEntry(fromSize bool, skipNativeSquare bool) *Entry {
	return &Entry{
		Name: "image-qwen21",
		OutputSize: &OutputSize{
			Node:             "13",
			LatentNode:       "10",
			LatentInput:      "latent_image",
			LatentSource:     "14",
			FromSize:         fromSize,
			SkipNativeSquare: skipNativeSquare,
		},
	}
}

func nodeInputs(t *testing.T, graph Graph, id string) map[string]any {
	t.Helper()
	node, ok := graph.NodeAt(id)
	if !ok {
		t.Fatalf("node %s is missing from the rendered graph", id)
	}
	return node.Inputs()
}

// The size a request asks for is the size the graph renders.
//
// The canvas aligns to 16 — the panel's step, the `snap16` bindings, and the VAE, which floors anything else
// (measured on ComfyUI 0.43 through this graph: 528x528 stays 528x528, 520x520 becomes 512x512). This path
// snapped to 32, twice as coarse, so a size the canvas had already made legal was moved again: 3840x2160 was
// rendered at 3840x2176, which is also more pixels than the canvas's own ceiling allows (#306).
func TestARequestedSizeIsTheSizeTheGraphRenders(t *testing.T) {
	entry := qwenSizeEntry(true, true)

	graph := qwenSizeGraph()
	ctx := &Context{Size: &util.Size{Width: 1360, Height: 768}, Params: map[string]any{"resolution": 1024.0}}
	if err := applyOutputSize(graph, entry, ctx, nil); err != nil {
		t.Fatalf("applyOutputSize: %v", err)
	}
	inputs := nodeInputs(t, graph, "13")
	if inputs["width"] != 1360 || inputs["height"] != 768 {
		t.Errorf("the canvas kept %vx%v; 1360x768 is a multiple of 16 and needed no rounding", inputs["width"], inputs["height"])
	}
	if link := nodeInputs(t, graph, "10")["latent_image"]; !sameLink(link, []any{"14", 0}) {
		t.Errorf("the sampler still takes the encoder's latent: %v", link)
	}

	// 3840x2160 — the preset that showed the bug: not a multiple of 32, a multiple of 16.
	graph = qwenSizeGraph()
	ctx = &Context{Size: &util.Size{Width: 3840, Height: 2160}, Params: map[string]any{}}
	if err := applyOutputSize(graph, entry, ctx, nil); err != nil {
		t.Fatalf("applyOutputSize: %v", err)
	}
	inputs = nodeInputs(t, graph, "13")
	if inputs["width"] != 3840 || inputs["height"] != 2160 {
		t.Errorf("4k 16:9 came out %vx%v instead of 3840x2160", inputs["width"], inputs["height"])
	}
}

// A size that is not a multiple of 16 is still aligned, because the VAE would floor it silently instead.
func TestASizeTheGraphCannotRenderIsAligned(t *testing.T) {
	graph := qwenSizeGraph()
	entry := qwenSizeEntry(true, false)
	ctx := &Context{Size: &util.Size{Width: 520, Height: 520}, Params: map[string]any{}}
	if err := applyOutputSize(graph, entry, ctx, nil); err != nil {
		t.Fatalf("applyOutputSize: %v", err)
	}
	inputs := nodeInputs(t, graph, "13")
	if inputs["width"] != 528 || inputs["height"] != 528 {
		t.Errorf("520 rounds to %vx%v, not to the 528 the latent can hold", inputs["width"], inputs["height"])
	}
}

// The native square is the one case where the encoder's own canvas is kept — and it is recognised at 16, the
// alignment the rest of this function uses. At 32 a 16-aligned 1040x1040 was rounded to the native 1024 and taken
// for it, so the requested size was dropped and the run came back 1024x1024.
func TestOnlyTheNativeSquareKeepsTheEncoderLatent(t *testing.T) {
	entry := qwenSizeEntry(true, true)

	graph := qwenSizeGraph()
	ctx := &Context{Size: &util.Size{Width: 1024, Height: 1024}, Params: map[string]any{"resolution": 1024.0}}
	if err := applyOutputSize(graph, entry, ctx, nil); err != nil {
		t.Fatalf("applyOutputSize: %v", err)
	}
	if link := nodeInputs(t, graph, "10")["latent_image"]; !sameLink(link, []any{"5", 2}) {
		t.Errorf("the native square was overridden: %v", link)
	}

	graph = qwenSizeGraph()
	ctx = &Context{Size: &util.Size{Width: 1040, Height: 1040}, Params: map[string]any{"resolution": 1024.0}}
	if err := applyOutputSize(graph, entry, ctx, nil); err != nil {
		t.Fatalf("applyOutputSize: %v", err)
	}
	if inputs := nodeInputs(t, graph, "13"); inputs["width"] != 1040 || inputs["height"] != 1040 {
		t.Errorf("1040 was taken for the native square and dropped: %vx%v", inputs["width"], inputs["height"])
	}
	if link := nodeInputs(t, graph, "10")["latent_image"]; !sameLink(link, []any{"14", 0}) {
		t.Errorf("the sampler kept the encoder's latent for a size that is not the native square: %v", link)
	}
}

func sameLink(value any, want []any) bool {
	link, ok := value.([]any)
	if !ok || len(link) != len(want) {
		return false
	}
	for index := range want {
		if link[index] != want[index] {
			return false
		}
	}
	return true
}
