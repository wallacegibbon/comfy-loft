package workflow

import (
	"fmt"
	"io"
	"math"
	"testing"

	"comfyloft/internal/logx"
)

// A binding that *derives* its value carries no default; the graph holds it.
//
// The default is chosen first and transformed afterwards, so a default written in the graph's domain comes out
// of the conversion wrong: RIFE's output frame rate said 48 where the binding multiplies by 24 (a run that
// omitted the multiplier would have asked for 1152 fps), and the H3 workflows' frame counts said 124 where the
// binding converts seconds (an omitted length became ~2980 frames). Both were dormant only because the canvas
// always sent the parameter the binding reads. Where the conversion *was* idempotent — a size already snapped
// to 16 — the default was a copy of the graph, which is the same fact written twice (#300).
func TestDerivedBindingsCarryNoDefault(t *testing.T) {
	derived := []string{"multiply", "secondsToFrames", "secondsToFrames17", "snap16", "snap32", "invert10"}
	shipped := loadShippedRegistry(t)

	check := func(label string, binding *Binding) {
		transform := binding.String(keyTransform)
		for _, name := range derived {
			if transform != name {
				continue
			}
			if binding.Has(keyDefault) {
				t.Errorf("%s: transform %q with default %v — the graph holds that value, and the default is in the wrong domain", label, name, binding.Value(keyDefault))
			}
		}
	}
	for _, entry := range shipped.Entries() {
		walkBindings(t, entry, check)
	}
}

// A default that is written verbatim must be the value the graph was authored with.
//
// Only where the graph belongs to one workflow: three H3 workflows share `video-h3-ref2va-drama-vdn.json` and
// re-parameterise it (`task_type`, the length), so there the binding is the truth for that workflow and the file
// is the other workflow's. Anywhere else, a default that disagrees with the graph is a run that quietly does
// something the workflow's author did not: Z-Image's steps said 10 where the graph says 8, and every
// quality=auto run paid a step that the model — an 8-step distill — never asked for (#300).
func TestBindingDefaultsMatchTheCanonicalGraph(t *testing.T) {
	shipped := loadShippedRegistry(t)
	shared := sharedGraphFiles(shipped)

	check := func(label string, graph Graph, binding *Binding) {
		if binding.IsMedia() || !binding.Has(keyDefault) || graph == nil {
			return
		}
		nodeID := binding.String(keyNode)
		input := binding.String(keyInput)
		if nodeID == "" || input == "" {
			return
		}
		node, ok := graph.NodeAt(nodeID)
		if !ok {
			return
		}
		authored, ok := node.Inputs()[input]
		if !ok {
			return
		}
		applied := applyTransform(binding.Value(keyDefault), binding)
		if !sameValue(applied, authored) {
			t.Errorf("%s defaults to %v (→ %v), but its graph says %v", label, binding.Value(keyDefault), applied, authored)
		}
	}

	for _, entry := range shipped.Entries() {
		if !shared[entry.File] {
			for name, binding := range entry.Bindings() {
				check(entry.ID+"."+name, entry.Workflow, binding)
			}
		}
		for _, mode := range entry.VariantModes() {
			variant, _ := entry.Variants.Get(mode)
			if variant == nil || shared[variant.File] {
				continue
			}
			for name, binding := range variant.Bindings() {
				check(entry.ID+"/"+mode+"."+name, variant.Workflow, binding)
			}
		}
	}
}

// The value the panel shows and the value a render uses are the same declaration, for every parameter that
// publishes one.
//
// A parameter's `default` is what the canvas draws as selected; a binding's is what a run writes when the
// request omits the key. Two declarations for one fact — this is what keeps them one fact, and it is the
// reason a node can be created without writing any params at all (#300).
func TestPublishedDefaultsMatchTheBindingsThatReadThem(t *testing.T) {
	shipped := loadShippedRegistry(t)
	for _, entry := range shipped.Entries() {
		for _, raw := range entry.Parameters {
			object, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			key, _ := object["key"].(string)
			published, hasPublished := object["default"]
			if key == "" || !hasPublished {
				continue
			}
			for name, binding := range entry.Bindings() {
				if binding.String(keyFrom) != "params."+key || !binding.Has(keyDefault) {
					continue
				}
				if got := binding.Value(keyDefault); !sameValue(got, published) {
					t.Errorf("%s.%s: the panel shows %v, binding %q writes %v", entry.ID, key, published, name, got)
				}
			}
		}
	}
}

func loadShippedRegistry(t *testing.T) *Registry {
	t.Helper()
	shipped := NewRegistry(RegistryOptions{Dir: shippedWorkflowsDir, Logger: logx.NewWithWriter("test", io.Discard)})
	if err := shipped.Load(); err != nil {
		t.Fatalf("load shipped registry: %v", err)
	}
	return shipped
}

// walkBindings visits every binding a workflow runs, its own and its variants'.
func walkBindings(t *testing.T, entry *Entry, visit func(label string, binding *Binding)) {
	t.Helper()
	for name, binding := range entry.Bindings() {
		visit(entry.ID+"."+name, binding)
	}
	for _, mode := range entry.VariantModes() {
		variant, _ := entry.Variants.Get(mode)
		if variant == nil {
			continue
		}
		for name, binding := range variant.Bindings() {
			visit(entry.ID+"/"+mode+"."+name, binding)
		}
	}
}

// sharedGraphFiles names the graph files more than one workflow renders from.
func sharedGraphFiles(shipped *Registry) map[string]bool {
	count := map[string]int{}
	total := func(file string) {
		if file != "" {
			count[file]++
		}
	}
	for _, entry := range shipped.Entries() {
		total(entry.File)
		for _, mode := range entry.VariantModes() {
			if variant, ok := entry.Variants.Get(mode); ok && variant != nil {
				total(variant.File)
			}
		}
	}
	out := map[string]bool{}
	for file, seen := range count {
		out[file] = seen > 1
	}
	return out
}

// sameValue compares what a binding produced with what the graph holds: JSON numbers arrive as float64 and a
// transform may hand back an int, so numbers compare numerically and everything else by its printed form.
func sameValue(got, want any) bool {
	if gotNumber, ok := asNumber(got); ok {
		if wantNumber, ok := asNumber(want); ok {
			return math.Abs(gotNumber-wantNumber) < 1e-9
		}
		return false
	}
	return fmt.Sprint(got) == fmt.Sprint(want)
}

func asNumber(value any) (float64, bool) {
	switch number := value.(type) {
	case float64:
		return number, true
	case float32:
		return float64(number), true
	case int:
		return float64(number), true
	case int64:
		return float64(number), true
	}
	return 0, false
}
