package workflow

import (
	"io"
	"sort"
	"strings"
	"testing"

	"comfyloft/internal/logx"
)

// bindings builds an OrderedMap the way JSON decoding does: keys in order, values by key.
func bindings(pairs ...any) OrderedMap[OrderedMap[any]] {
	out := OrderedMap[OrderedMap[any]]{Values: map[string]OrderedMap[any]{}}
	for index := 0; index < len(pairs); index += 2 {
		key := pairs[index].(string)
		value := pairs[index+1].(map[string]any)
		out.Keys = append(out.Keys, key)
		out.Values[key] = OrderedMap[any]{Keys: mapKeysInOrder(value), Values: value}
	}
	return out
}

func mapKeysInOrder(value map[string]any) []string {
	keys := make([]string, 0, len(value))
	for key := range value {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func inputEntry() *Entry {
	stepsMax := 30.0
	stepsMin := 1.0
	return &Entry{
		Name: "inputs-test",
		RawBindings: bindings(
			"prompt", map[string]any{"node": "4", "input": "text", "required": true},
			"seed", map[string]any{"node": "8", "input": "seed", "from": "params.seed", "random": true},
			"steps", map[string]any{"node": "8", "input": "steps", "from": "params.steps"},
			// A parameter is the panel's wording for a key a binding reads; the binding is what accepts it (#299).
			"sampler", map[string]any{"node": "8", "input": "sampler_name", "from": "params.sampler"},
			"refs", map[string]any{
				"node": "9", "input": "images", "from": "image", "array": true, "inputPrefix": "ref_",
			},
		),
		Parameters: []any{
			map[string]any{"key": "steps", "type": "number", "min": stepsMin, "max": stepsMax},
			map[string]any{"key": "sampler", "type": "select", "options": []any{"euler", "dpmpp_2m"}},
		},
		Presets: map[string]any{"quality": map[string]any{"low": map[string]any{}, "high": map[string]any{}}},
	}
}

func TestValidateInputsAcceptsTheDeclaredSurface(t *testing.T) {
	entry := inputEntry()
	inputs := map[string]any{
		"prompt":  "a cat",
		"size":    "1024x1024",
		"quality": "high",
		"seconds": 5,
		"seed":    0,
		"steps":   8,
		// Advisory: ComfyUI has more samplers than the UI lists, so the list cannot reject.
		"sampler": "dpmpp_2m_sde_gpu",
	}
	if err := ValidateInputs(entry, inputs, InputLimits{}); err != nil {
		t.Fatalf("valid inputs rejected: %v", err)
	}
}

func TestValidateInputsRejections(t *testing.T) {
	cases := []struct {
		name   string
		inputs map[string]any
		code   string
		text   string
	}{
		{"unknown key", map[string]any{"prompt": "x", "setps": 4}, "unknown_input", "unknown input"},
		{"missing prompt", map[string]any{}, "missing_input", "requires a non-empty prompt"},
		{"blank prompt", map[string]any{"prompt": "   "}, "missing_input", "non-empty prompt"},
		{"bad size", map[string]any{"prompt": "x", "size": "huge"}, "invalid_input", "size string"},
		{"steps out of range", map[string]any{"prompt": "x", "steps": 99}, "invalid_input", "at most 30"},
		{"steps not numeric", map[string]any{"prompt": "x", "steps": "many"}, "invalid_input", "must be a number"},
		{"unknown quality", map[string]any{"prompt": "x", "quality": "ultra"}, "invalid_input", "must be one of"},
	}
	for _, testCase := range cases {
		err := ValidateInputs(inputEntry(), testCase.inputs, InputLimits{})
		if err == nil {
			t.Errorf("%s: accepted", testCase.name)
			continue
		}
		if got := errorCode(t, err); got != testCase.code {
			t.Errorf("%s: code = %q, want %q", testCase.name, got, testCase.code)
		}
		if !strings.Contains(err.Error(), testCase.text) {
			t.Errorf("%s: message %q does not contain %q", testCase.name, err.Error(), testCase.text)
		}
	}
}

// Media binding keys are not inputs: pointing the caller at media.<role> is more useful than a bare
// "unknown input".
func TestValidateInputsPointsMediaAtTheMediaMap(t *testing.T) {
	err := ValidateInputs(inputEntry(), map[string]any{"prompt": "x", "refs": []any{"upl_1"}}, InputLimits{})
	if err == nil {
		t.Fatal("a media binding key was accepted as an input")
	}
	if !strings.Contains(err.Error(), "use media.<role>") {
		t.Errorf("message = %q", err.Error())
	}
}

// The two video-only inputs belong to video workflows and nowhere else: on an image workflow they are
// typos, and `interpolation` is a value the server itself executes, so its set is closed.
func TestVideoOnlyInputs(t *testing.T) {
	image := inputEntry()
	if err := ValidateInputs(image, map[string]any{"prompt": "x", "frameMode": "first"}, InputLimits{}); err == nil {
		t.Error("frameMode was accepted on an image workflow")
	}

	video := inputEntry()
	video.Type = "video"
	if err := ValidateInputs(video, map[string]any{"prompt": "x", "frameMode": "last"}, InputLimits{}); err != nil {
		t.Errorf("video inputs rejected: %v", err)
	}
	// `interpolation` used to be accepted here as a server-executed input; raising a clip's frame
	// rate is now a run of its own workflow, so the key must be gone rather than silently ignored.
	if err := ValidateInputs(video, map[string]any{"prompt": "x", "interpolation": "2x"}, InputLimits{}); err == nil {
		t.Error("interpolation is still accepted as an input")
	}
}

// The schema served by /api/workflows/{id}/schema describes exactly what a run accepts.
func TestSchemaListsTypedInputs(t *testing.T) {
	entry := inputEntry()
	schema := BuildSchema(entry)
	byKey := map[string]InputSpec{}
	for _, spec := range schema.Inputs {
		byKey[spec.Key] = spec
	}
	for _, key := range []string{"prompt", "size", "quality", "seconds", "mode", "steps", "sampler", "seed"} {
		if _, ok := byKey[key]; !ok {
			t.Errorf("schema is missing %q", key)
		}
	}
	if !byKey["prompt"].Required {
		t.Error("prompt must be required")
	}
	if !byKey["quality"].StrictOptions {
		t.Error("quality must enforce its declared options")
	}
	if byKey["sampler"].StrictOptions {
		t.Error("sampler options are advisory, not a closed set")
	}
}

// Every shipped workflow must accept the one input it always needs (a prompt) and reject a typo.
func TestShippedWorkflowsValidateTheirInputs(t *testing.T) {
	registry := NewRegistry(RegistryOptions{Dir: shippedWorkflowsDir, Logger: logx.NewWithWriter("test", io.Discard)})
	if err := registry.Load(); err != nil {
		t.Fatalf("load shipped registry: %v", err)
	}
	for _, entry := range registry.Entries() {
		specs := entry.InputSpecs(InputLimits{})
		hasPrompt := false
		for _, spec := range specs {
			if spec.Key == "prompt" {
				hasPrompt = true
			}
		}
		if !hasPrompt {
			t.Errorf("%s has no prompt input", entry.ID)
		}
		if err := ValidateInputs(entry, map[string]any{"prompt": "a cat"}, InputLimits{}); err != nil {
			t.Errorf("%s rejected a minimal request: %v", entry.ID, err)
		}
		if err := ValidateInputs(entry, map[string]any{"prompt": "a cat", "nonsense": 1}, InputLimits{}); err == nil {
			t.Errorf("%s accepted an unknown input", entry.ID)
		}
	}
}

// A binding that reads its value from somewhere else is not a knob: accepting the key would mean
// accepting a value that reaches nothing. `size.width` is the usual culprit.
func TestDerivedBindingsAreNotInputs(t *testing.T) {
	entry := inputEntry()
	entry.RawBindings = bindings(
		"prompt", map[string]any{"node": "4", "input": "text", "required": true},
		"width", map[string]any{"node": "8", "input": "width", "from": "size.width"},
		"seed", map[string]any{"node": "8", "input": "seed", "from": "params.seed", "random": true},
	)

	for _, key := range []string{"width"} {
		err := ValidateInputs(entry, map[string]any{"prompt": "x", key: 1024}, InputLimits{})
		if err == nil {
			t.Errorf("%s was accepted although its binding ignores it", key)
			continue
		}
		if !strings.Contains(err.Error(), "unknown input") {
			t.Errorf("%s: message = %q", key, err.Error())
		}
	}
	// The self-named binding is still the way to set it.
	if err := ValidateInputs(entry, map[string]any{"prompt": "x", "seed": 7}, InputLimits{}); err != nil {
		t.Errorf("seed rejected: %v", err)
	}
}

// The key a binding contributes is the one it reads, not the name it has.
//
// `horizontal` reads `params.horizontalAngle`, so `horizontalAngle` is the caller's key. Naming the
// binding had made the knob unreachable: the parameter was accepted (it was added on its own) and the
// binding was not (its name matched no parameter), so the request's value reached nothing (#299).
func TestABindingContributesTheKeyItReads(t *testing.T) {
	entry := inputEntry()
	entry.RawBindings = bindings(
		"prompt", map[string]any{"node": "4", "input": "text", "required": true},
		"horizontal", map[string]any{"node": "8", "input": "horizontal_angle", "from": "params.horizontalAngle", "transform": "int"},
		// A value derived from something other than a request key accepts no key at all.
		"frameRate", map[string]any{"node": "8", "input": "frame_rate", "from": "params.horizontalAngle", "transform": "multiply", "factor": 24},
	)
	entry.Parameters = []any{map[string]any{"key": "horizontalAngle", "type": "number"}}

	keys := map[string]bool{}
	for _, key := range entry.AcceptedInputs() {
		keys[key] = true
	}
	if !keys["horizontalAngle"] {
		t.Errorf("the key the binding reads is missing from %v", entry.AcceptedInputs())
	}
	if keys["horizontal"] {
		t.Errorf("the binding's own name became an input: %v", entry.AcceptedInputs())
	}
	if keys["frameRate"] {
		t.Errorf("a derived binding contributed a key: %v", entry.AcceptedInputs())
	}
}

// A declared parameter is the panel's wording for a key that exists. On its own it accepts nothing: the
// audio workflow declares its length bound that way, and accepting `duration` there would be a value the
// render never reads (#299).
func TestAParameterNothingReadsIsNotAnInput(t *testing.T) {
	entry := inputEntry()
	entry.Parameters = append(entry.Parameters, map[string]any{"key": "volume", "type": "number", "min": 0, "max": 100})

	if err := ValidateInputs(entry, map[string]any{"prompt": "x", "volume": 50}, InputLimits{}); err == nil {
		t.Error("a parameter no binding reads was accepted")
	} else if !strings.Contains(err.Error(), "unknown input") {
		t.Errorf("message = %q, want an unknown-input refusal", err.Error())
	}
	for _, spec := range entry.InputSpecs(InputLimits{}) {
		if spec.Key == "volume" {
			t.Errorf("a parameter no binding reads appeared in the contract: %+v", spec)
		}
	}
}

// ...and where the key does exist, the parameter is what the panel reads: wording, range, options, and the
// value shown before anything is typed.
func TestParametersDecorateTheKeyTheyDescribe(t *testing.T) {
	entry := inputEntry()
	spec := map[string]InputSpec{}
	for _, item := range entry.InputSpecs(InputLimits{}) {
		spec[item.Key] = item
	}
	steps := spec["steps"]
	if steps.Min == nil || *steps.Min != 1 || steps.Max == nil || *steps.Max != 30 {
		t.Errorf("steps = %+v, want the declared range 1..30", steps)
	}
	if steps.Label == "" {
		t.Error("steps has no label: the panel would show a bare key")
	}
	sampler := spec["sampler"]
	if sampler.Type != "string" || len(sampler.Options) != 2 || sampler.Options[0] != "euler" {
		t.Errorf("sampler = %+v, want the declared options", sampler)
	}
}

// Every parameter a shipped workflow declares describes an input that workflow accepts. A parameter that
// describes nothing is prose the contract cannot honour (#299).
func TestShippedParametersAllDescribeAnInput(t *testing.T) {
	registry := NewRegistry(RegistryOptions{Dir: shippedWorkflowsDir, Logger: logx.NewWithWriter("test", io.Discard)})
	if err := registry.Load(); err != nil {
		t.Fatalf("load shipped registry: %v", err)
	}
	for _, entry := range registry.Entries() {
		accepted := map[string]bool{}
		for _, key := range entry.AcceptedInputs() {
			accepted[key] = true
		}
		for _, raw := range entry.Parameters {
			object, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			key, _ := object["key"].(string)
			if key != "" && !accepted[key] {
				t.Errorf("%s: parameter %q describes no input", entry.ID, key)
			}
		}
	}
}
