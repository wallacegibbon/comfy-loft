package workflow

// Typed request inputs, validated at submission.
//
// `inputs` is open by design: a workflow's knobs are its bindings (`seed`, `steps`, `sampler`,
// `format`, a LoRA list), so a new workflow needs no new route or struct. Open is not the same as
// unchecked, though: an unknown key is a typo that would otherwise be ignored silently, and a value
// of the wrong type only fails minutes later inside ComfyUI. This file is the one place that says
// what a run may carry.

import (
	"fmt"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"

	"comfyloft/internal/httpx"
	"comfyloft/internal/util"
)

// InputLimits are engine-wide bounds that are not a property of one workflow.
type InputLimits struct{}

// InputSpec is one accepted input field.
type InputSpec struct {
	Key      string   `json:"key"`
	Type     string   `json:"type"` // string, number, integer, size, boolean
	Required bool     `json:"required,omitempty"`
	Min      *float64 `json:"min,omitempty"`
	Max      *float64 `json:"max,omitempty"`
	Options  []string `json:"options,omitempty"`
	// StrictOptions is set only where the server owns the value set (a quality preset name).
	// A sampler name, by contrast, is ComfyUI's vocabulary: the list in registry.json is a UI
	// suggestion and must not reject a valid value the UI never offered.
	StrictOptions bool   `json:"-"`
	Default       any    `json:"default,omitempty"`
	Label         string `json:"label,omitempty"`
}

// There is no `negative` request key anywhere: a graph that has a negative text encoder carries its own string,
// and the server never writes one (#288).
// The request-level keys the engine itself reads. Each is offered to a workflow only where the thing that reads it
// is there (`semanticSpecs`), so none of them is a key that would be accepted and ignored (#302). There is no
// `duration`: nothing ever read it — the audio workflow takes its length in `seconds`, and the `duration`
// parameter of that name is the panel's bound, not an input.

// AcceptedInputs lists the keys a run of this workflow may carry, which is exactly the set
// `ValidateInputs` will not refuse. It is the same list the client needs to keep a knob it no longer
// knows out of a request: a value left over from another model used to reach the server and be answered
// with `unknown_input`, failing the run for a field nobody typed (docs/decisions.md #274).
func (e *Entry) AcceptedInputs() []string {
	specs := e.InputSpecs(InputLimits{})
	keys := make([]string, 0, len(specs))
	for _, spec := range specs {
		keys = append(keys, spec.Key)
	}
	return keys
}

// InputSpecs is the typed contract of a workflow: which keys a run may carry, and what each one takes.
//
// Two sources say a key exists — the request-level keys above, which the engine itself reads, and the
// workflow's bindings, which write request values into the graph. The workflow's declared `parameters`
// are a *third* thing and not a source: they are the presentation of those keys (label, range, options,
// the value the panel shows before anything is typed). A parameter nothing reads is prose for the panel —
// the audio workflow declares its length bound that way — and must not become an accepted input, which is
// the "accepted and then ignored" failure this build refuses to have (#299).
func (e *Entry) InputSpecs(limits InputLimits) []InputSpec {
	if e == nil {
		return nil
	}
	specs := make([]InputSpec, 0, len(e.Parameters)+12)
	at := map[string]int{}
	add := func(spec InputSpec) {
		if spec.Key == "" {
			return
		}
		if _, ok := at[spec.Key]; ok {
			return
		}
		at[spec.Key] = len(specs)
		specs = append(specs, spec)
	}

	bindings := e.Bindings()
	for _, spec := range e.semanticSpecs(bindings) {
		add(spec)
	}

	// Any remaining non-media binding is a valid input too (a model file override, for example).
	keys := make([]string, 0, len(bindings))
	for key := range bindings {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		binding := bindings[key]
		if binding.IsMedia() {
			continue
		}
		// The key a binding contributes is the one it *reads*, which need not be the name it has:
		// `horizontal` reads `params.horizontalAngle`, so the caller's key is `horizontalAngle`. A binding
		// derived from anywhere else (`size.width`, `seconds`, `quality.steps`) reads no request key at all
		// and so contributes none; a binding with no `from` writes the key it is named after.
		name := key
		if from := binding.String(keyFrom); from != "" {
			if !strings.HasPrefix(from, "params.") {
				continue
			}
			name = strings.TrimPrefix(from, "params.")
		}
		add(InputSpec{Key: name, Type: bindingInputType(binding), Label: name})
	}

	// Declared parameters decorate a key that already exists. They are authoritative for what the panel
	// shows — range, wording, the initial value — and for nothing else: a parameter whose key no binding and
	// no request-level rule reads does not make that key acceptable (#299).
	for _, raw := range e.Parameters {
		object, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		key, _ := object["key"].(string)
		position, exists := at[key]
		if key == "" || !exists {
			continue
		}
		spec := &specs[position]
		if label := stringField(object, "label"); label != "" {
			spec.Label = label
		}
		spec.Min = numberPointer(object["min"])
		spec.Max = numberPointer(object["max"])
		spec.Default = object["default"]
		spec.Options = stringList(object["options"])
		if declared := parameterType(object); declared != "" {
			spec.Type = declared
		}
	}
	return specs
}

// MediaBindingKeys lists the binding names that carry media. They are not valid `inputs`: media goes
// in the run's `media` map, by role.
func (e *Entry) MediaBindingKeys() []string {
	if e == nil {
		return nil
	}
	keys := make([]string, 0)
	for key, binding := range e.Bindings() {
		if binding.IsMedia() {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	return keys
}

// ValidateInputs rejects unknown keys, wrong types and out-of-range values before a run is queued.
//
// The check runs at submission because a binding error happens inside the runner, which for a
// queued run means the caller gets a failed run minutes later instead of a `400` now.
func ValidateInputs(entry *Entry, inputs map[string]any, limits InputLimits) error {
	specs := entry.InputSpecs(limits)
	byKey := make(map[string]InputSpec, len(specs))
	accepted := make([]string, 0, len(specs))
	for _, spec := range specs {
		byKey[spec.Key] = spec
		accepted = append(accepted, spec.Key)
	}
	sort.Strings(accepted)

	mediaKeys := map[string]bool{}
	for _, key := range entry.MediaBindingKeys() {
		mediaKeys[key] = true
	}

	for key, value := range inputs {
		if value == nil {
			continue
		}
		spec, ok := byKey[key]
		if !ok {
			if mediaKeys[key] {
				return httpx.Errorf(http.StatusBadRequest, "unknown_input",
					"%s carries media; use media.<role> instead of inputs (accepted inputs: %s)",
					key, strings.Join(accepted, ", "))
			}
			return httpx.Errorf(http.StatusBadRequest, "unknown_input",
				"unknown input %q; workflow %s accepts: %s", key, entry.Name, strings.Join(accepted, ", "))
		}
		if err := validateInputValue(entry, spec, value); err != nil {
			return err
		}
	}

	if spec, ok := byKey["prompt"]; ok && spec.Required {
		prompt, _ := inputs["prompt"].(string)
		if strings.TrimSpace(prompt) == "" {
			return httpx.Errorf(http.StatusBadRequest, "missing_input",
				"workflow %s requires a non-empty prompt", entry.Name)
		}
	}
	return nil
}

func validateInputValue(entry *Entry, spec InputSpec, value any) error {
	fail := func(reason string) error {
		return httpx.Errorf(http.StatusBadRequest, "invalid_input",
			"input %q %s (workflow %s)", spec.Key, reason, entry.Name)
	}

	switch spec.Type {
	case "size":
		text, ok := value.(string)
		if !ok {
			return fail("must be a size string like 1024x1024")
		}
		if util.ParseSize(strings.TrimSpace(text)) == nil {
			return fail("must be a size string like 1024x1024")
		}
	case "string":
		text, ok := coerceString(value)
		if !ok {
			return fail("must be a string")
		}
		if len(spec.Options) > 0 && spec.StrictOptions && !containsString(spec.Options, text) {
			return fail("must be one of: " + strings.Join(spec.Options, ", "))
		}
	case "number", "integer":
		number, ok := coerceNumber(value)
		if !ok {
			return fail("must be a number")
		}
		if spec.Type == "integer" && math.Trunc(number) != number {
			return fail("must be a whole number")
		}
		if spec.Min != nil && number < *spec.Min {
			return fail("must be at least " + formatNumber(*spec.Min))
		}
		if spec.Max != nil && number > *spec.Max {
			return fail("must be at most " + formatNumber(*spec.Max))
		}
	case "boolean":
		if _, ok := value.(bool); !ok {
			return fail("must be true or false")
		}
	case "any":
		// A structured value the server consumes itself (the MOSS layout) is passed through.
	default:
		// An inferred binding type accepts anything the binding engine can coerce.
	}
	return nil
}

// IsMedia reports whether a binding consumes uploaded media rather than a scalar value.
func (b *Binding) IsMedia() bool {
	if b == nil {
		return false
	}
	switch b.String(keyFrom) {
	case "image", "video", "audio":
		return true
	}
	return b.Bool(keyArray) || b.Bool(keyFrameMode) || b.Has(keyImageIndex) ||
		b.Has(keyVideoIndex) || b.String(keyLoadType) != ""
}

func (e *Entry) qualityOptions() []string {
	quality, ok := e.Presets["quality"].(map[string]any)
	if !ok {
		return nil
	}
	options := make([]string, 0, len(quality)+1)
	for name := range quality {
		options = append(options, name)
	}
	sort.Strings(options)
	// "auto" means "no preset", which is the default every adapter sends.
	return append([]string{"auto"}, options...)
}

func parameterType(object map[string]any) string {
	switch stringField(object, "type") {
	case "number":
		return "number"
	case "boolean":
		return "boolean"
	default:
		return "string"
	}
}

// bindingInputType infers a type from the binding it feeds, so an inferred key is still checked
// when the binding makes the expectation obvious.
func bindingInputType(binding *Binding) string {
	if binding == nil {
		return ""
	}
	switch binding.String(keyTransform) {
	case "int", "round", "snap16", "snap32", "secondsToFrames", "secondsToFrames17":
		return "integer"
	}
	if binding.Bool(keyRandom) || binding.Has(keyDefault) {
		switch binding.Value(keyDefault).(type) {
		case float64, int:
			return "number"
		case string:
			return "string"
		}
	}
	return ""
}

func coerceString(value any) (string, bool) {
	switch typed := value.(type) {
	case string:
		return typed, true
	case float64:
		return strconv.FormatFloat(typed, 'g', -1, 64), true
	case int:
		return strconv.Itoa(typed), true
	}
	return "", false
}

func coerceNumber(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		return typed, true
	case int:
		return float64(typed), true
	case string:
		parsed, err := strconv.ParseFloat(strings.TrimSpace(typed), 64)
		if err != nil {
			return 0, false
		}
		return parsed, true
	}
	return 0, false
}

func numberPointer(value any) *float64 {
	number, ok := coerceNumber(value)
	if !ok {
		return nil
	}
	return &number
}

func stringField(object map[string]any, key string) string {
	text, _ := object[key].(string)
	return text
}

func stringList(value any) []string {
	items, ok := value.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		if text, ok := item.(string); ok {
			out = append(out, text)
		}
	}
	return out
}

func formatNumber(value float64) string {
	if value == math.Trunc(value) {
		return strconv.FormatInt(int64(value), 10)
	}
	return fmt.Sprintf("%g", value)
}

// semanticSpecs answers, per request-level key, whether *this* workflow reads it.
//
// These keys are not bindings: the engine applies them — `size` sizes the latent, `quality` selects a preset,
// `seconds` becomes frames, `mode` chooses a variant, `layout` is rendered into the prompt, `background` wraps
// the words, `loras` is a chain. Offering one where nothing reads it is the same failure as a knob that reaches
// nothing (#302), so each is derived from the declaration that consumes it.
func (e *Entry) semanticSpecs(bindings map[string]*Binding) []InputSpec {
	from := map[string]bool{}
	for _, set := range e.bindingsWithVariants() {
		for _, binding := range set {
			if source := binding.String(keyFrom); source != "" {
				from[source] = true
			}
		}
	}
	readsQuality := false
	for source := range from {
		if strings.HasPrefix(source, "quality.") {
			readsQuality = true
		}
	}

	specs := make([]InputSpec, 0, 10)
	if binding, ok := bindings["prompt"]; ok {
		// A prompt binding is required unless it names a default: without one the node input would keep whatever
		// the export happened to contain.
		required := !binding.Has("default") || binding.Bool("required")
		specs = append(specs, InputSpec{Key: "prompt", Type: "string", Required: required, Label: "Prompt"})
	}
	if from["size.width"] || from["size.height"] || (e.OutputSize != nil && e.OutputSize.FromSize) {
		specs = append(specs, InputSpec{Key: "size", Type: "size", Label: "Size"})
	}
	if readsQuality {
		options := e.qualityOptions()
		specs = append(specs, InputSpec{Key: "quality", Type: "string", Options: options, StrictOptions: len(options) > 0, Label: "Quality"})
	}
	if from["seconds"] {
		minimum := 0.0
		specs = append(specs, InputSpec{Key: "seconds", Type: "number", Min: &minimum, Label: "Seconds"})
	}
	if len(e.VariantModes()) > 0 {
		specs = append(specs, InputSpec{Key: "mode", Type: "string", Options: e.VariantModes(), Label: "Mode"})
	}
	if e.frameModeDeclared() {
		// Which frames a request supplies (first, last or both) and how many images each of those needs is the
		// workflow's own declaration, so `frameMode` is accepted here and judged by PlanMedia — one owner for the
		// rule, one message for the caller.
		specs = append(specs, InputSpec{Key: "frameMode", Type: "string", Label: "Frame mode"})
	}
	if e.BackgroundPrompt != "" {
		specs = append(specs, InputSpec{Key: "background", Type: "string", Label: "Background"})
	}
	// Two ways to say how big the picture is, and a graph reads exactly one of them: a `fromSize` output size
	// takes the request's `size`, anything else takes the canvas size. Offering both left the unused one to be
	// accepted and dropped — the failure this list exists to prevent, one layer deeper (#306).
	if e.OutputSize != nil && !e.OutputSize.FromSize {
		specs = append(specs, InputSpec{Key: "editCanvasSize", Type: "size", Label: "Edit canvas size"})
	}
	if e.injectsLayout() {
		// The structured layout a MOSS workflow renders into its prompt; the server owns its shape, so it is
		// passed through rather than described here.
		specs = append(specs, InputSpec{Key: "layout", Type: "any", Label: "Layout"}, InputSpec{Key: "layoutEnabled", Type: "boolean", Label: "Layout enabled"})
	}
	// The LoRA stack is applied by the engine (ApplyLoraChain), not by a binding. It stays open to every workflow
	// because the engine answers for it: a stack sent to a graph with no model loader is refused with
	// `lora_injection_failed` rather than ignored.
	specs = append(specs, InputSpec{Key: "loras", Type: "any", Label: "LoRAs"})
	return specs
}

// bindingsWithVariants is every binding a workflow can run, its own and its modes'.
func (e *Entry) bindingsWithVariants() []map[string]*Binding {
	sets := []map[string]*Binding{e.Bindings()}
	for _, mode := range e.VariantModes() {
		if variant, ok := e.Variants.Get(mode); ok && variant != nil {
			sets = append(sets, variant.Bindings())
		}
	}
	return sets
}

// profileOf mirrors the "promptInject" names that ask the server to render a layout into the prompt.
func (e *Entry) injectsLayout() bool {
	if e.PromptInject == PromptInjectLayout {
		return true
	}
	for _, mode := range e.VariantModes() {
		if variant, ok := e.Variants.Get(mode); ok && variant != nil && variant.PromptInject == PromptInjectLayout {
			return true
		}
	}
	return false
}

// frameModeDeclared reports whether the workflow, or one of its modes, says how a request's images map to frames.
func (e *Entry) frameModeDeclared() bool {
	if e.FrameMode != nil {
		return true
	}
	for _, mode := range e.VariantModes() {
		if variant, ok := e.Variants.Get(mode); ok && variant != nil && variant.FrameMode != nil {
			return true
		}
	}
	return false
}
