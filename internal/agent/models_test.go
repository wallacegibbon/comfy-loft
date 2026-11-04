package agent

import (
	"encoding/json"
	"strings"
	"testing"
)

// Two models as AlayaCore announces them: every field of the `model.conf` entry, key included.
const modelListFrame = `{"models":[
	{"id":1,"name":"V100 / Qwen","protocol_type":"openai","base_url":"http://172.16.9.7:9999/v1",
	 "api_key":"sk-one","model_name":"qwen3.8-27b","context_limit":262144,"max_tokens":65536,
	 "reasoning_1":{"reasoning_effort":"medium"},"serial_tool_calls":true},
	{"id":2,"name":"DeepSeek / Flash","protocol_type":"openai","base_url":"https://api.deepseek.com",
	 "api_key":"sk-two","model_name":"deepseek-flash","context_limit":1000000}
]}`

func startupWith(t *testing.T, frame string) startup {
	t.Helper()
	state := startup{}
	state.collect("model_list", json.RawMessage(frame))
	if len(state.models) != 2 {
		t.Fatalf("the fixture gave %d model(s), want 2", len(state.models))
	}
	return state
}

// The list a canvas can send is the list it was shown — and `model_sync` replaces *every* model from what
// it is given. So the parts the canvas never saw have to come back from the server's own copy: deleting
// one model must not take the other's key, reasoning blocks or token caps with it.
func TestModelSyncKeepsWhatTheCanvasCannotSee(t *testing.T) {
	session := &Session{ID: "canvas:1", state: startupWith(t, modelListFrame)}

	// The canvas keeps model 2, drops model 1, and adds one of its own.
	sent := `[{"id":2,"name":"DeepSeek / Flash","protocol_type":"openai","base_url":"https://api.deepseek.com","model_name":"deepseek-flash"},
	          {"name":"New / Claude","protocol_type":"anthropic","base_url":"https://api.anthropic.com","model_name":"claude-haiku-4","api_key":"sk-new"}]`
	merged, err := session.mergeModelSync(sent)
	if err != nil {
		t.Fatalf("mergeModelSync: %v", err)
	}
	if len(merged) != 2 {
		t.Fatalf("merged %d model(s), want 2", len(merged))
	}

	kept := merged[0]
	if got := kept.text("api_key"); got != "sk-two" {
		t.Errorf("the kept model's api_key = %q, want sk-two from the agent's own entry", got)
	}
	if got := kept.text("model_name"); got != "deepseek-flash" {
		t.Errorf("model_name = %q, want the canvas's value", got)
	}

	added := merged[1]
	if got := added.text("api_key"); got != "sk-new" {
		t.Errorf("the new model's api_key = %q, want the one the canvas typed", got)
	}
	if _, ok := added["context_limit"]; ok {
		t.Errorf("a new model invented context_limit: %s", added["context_limit"])
	}
}

// The fields a canvas may move are the four it can see, and nothing else: an editor that sent a whole
// entry back must not be able to drop `reasoning_2` from a model it did not touch.
func TestModelSyncReplacesOnlyTheEditedFields(t *testing.T) {
	session := &Session{ID: "canvas:1", state: startupWith(t, modelListFrame)}

	sent := `[{"id":1,"name":"Renamed","protocol_type":"openai","base_url":"http://elsewhere/v1","model_name":"qwen3.8-27b"}]`
	merged, err := session.mergeModelSync(sent)
	if err != nil {
		t.Fatalf("mergeModelSync: %v", err)
	}
	if got := merged[0].text("name"); got != "Renamed" {
		t.Errorf("name = %q, want the canvas's", got)
	}
	if got := merged[0].text("base_url"); got != "http://elsewhere/v1" {
		t.Errorf("base_url = %q, want the canvas's", got)
	}
	for _, field := range []string{"max_tokens", "reasoning_1", "serial_tool_calls", "api_key"} {
		if _, ok := merged[0][field]; !ok {
			t.Errorf("%s went missing from a model the canvas merely renamed", field)
		}
	}
	if got := merged[0].number("max_tokens"); got != 65536 {
		t.Errorf("max_tokens = %d, want 65536", got)
	}
	if !strings.Contains(string(merged[0]["reasoning_1"]), "medium") {
		t.Errorf("reasoning_1 = %s, want the stored block", merged[0]["reasoning_1"])
	}
}

// A key is the one field a canvas cannot see, so the two things it can say are "here is a new one" and
// nothing at all. Nothing must never mean "remove it": a page that has never been shown the key is in no
// position to delete it.
func TestModelSyncRotatesAKeyOnlyWhenOneIsSent(t *testing.T) {
	session := &Session{ID: "canvas:1", state: startupWith(t, modelListFrame)}

	for sent, want := range map[string]string{
		`[{"id":2,"name":"DeepSeek / Flash"}]`:                             "sk-two",
		`[{"id":2,"name":"DeepSeek / Flash","api_key":""}]`:                "sk-two",
		`[{"id":2,"name":"DeepSeek / Flash","api_key":"sk-rotated"}]`:      "sk-rotated",
		`[{"id":2,"name":"DeepSeek / Flash","api_key":"  sk-padded  "}]`:   "  sk-padded  ",
		`[{"id":2,"name":"DeepSeek / Flash","api_key":"sk-new"},{"id":1}]`: "sk-new",
	} {
		merged, err := session.mergeModelSync(sent)
		if err != nil {
			t.Fatalf("mergeModelSync(%s): %v", sent, err)
		}
		if got := merged[0].text("api_key"); got != want {
			t.Errorf("%s: api_key = %q, want %q", sent, got, want)
		}
	}
}

// `:model_sync` gives every model the id of its position, and the canvas uses those ids for `model_set`.
func TestModelSyncNumbersTheListItBuilds(t *testing.T) {
	session := &Session{ID: "canvas:1", state: startupWith(t, modelListFrame)}
	merged, err := session.mergeModelSync(`[{"id":2},{"id":1},{"name":"third","model_name":"m3"}]`)
	if err != nil {
		t.Fatalf("mergeModelSync: %v", err)
	}
	for index, object := range merged {
		if got := object.number("id"); got != index+1 {
			t.Errorf("model %d has id %d, want %d", index, got, index+1)
		}
	}
	if got := merged[0].text("model_name"); got != "deepseek-flash" {
		t.Errorf("model 1 is %q, want the one the canvas put first", got)
	}
}

// Something that is not a list is the canvas's mistake, and it is reported as one rather than written.
func TestModelSyncRefusesWhatIsNotAList(t *testing.T) {
	session := &Session{ID: "canvas:1", state: startupWith(t, modelListFrame)}
	if _, err := session.mergeModelSync(`{"models":[]}`); err == nil {
		t.Fatal("mergeModelSync accepted an object, want an error naming the shape")
	} else if !strings.Contains(err.Error(), "model_sync") {
		t.Errorf("error = %q, want it to name the command", err)
	}
}

// The event is the whitelist: a canvas is told there is a key, never what it is — and it is told where the
// model points, which is how two models with one name are told apart.
func TestModelsEventCarriesNoKey(t *testing.T) {
	state := startupWith(t, modelListFrame)
	payload, err := json.Marshal(state.event())
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(payload), "sk-one") || strings.Contains(string(payload), "sk-two") || strings.Contains(string(payload), "api_key") {
		t.Fatalf("the models event carries a key: %s", payload)
	}
	models := state.event().Models
	if len(models) != 2 || !models[0].HasKey || models[0].BaseURL != "http://172.16.9.7:9999/v1" || models[0].ModelName != "qwen3.8-27b" {
		t.Fatalf("models = %+v", models)
	}
}

// One file, several processes: a list written through one session is the list every other session should
// be offering, without anybody reloading a page.
func TestModelSyncTellsTheOtherSessions(t *testing.T) {
	edited := &Session{ID: "settings", state: startupWith(t, modelListFrame)}
	other := &Session{ID: "canvas:1", state: startupWith(t, modelListFrame)}
	sessions := &Sessions{list: map[string]*Session{edited.ID: edited, other.ID: other}}

	if _, err := sessions.ModelSync(edited, `[{"id":1,"name":"V100 / Qwen","model_name":"qwen3.8-27b"}]`); err != nil {
		t.Fatalf("ModelSync: %v", err)
	}

	// The session that sent it hears the agent's own `model_list`; the others are told here.
	if got := len(other.snapshot().models); got != 1 {
		t.Errorf("the other session holds %d model(s), want the 1 that was written", got)
	}
	if got := edited.snapshot().models; len(got) != 2 {
		t.Errorf("ModelSync changed the sending session's own list (%d models)", len(got))
	}
}

// Everything a form can edit has to reach it first. The list a canvas is shown is `Model`, and a field that
// is missing there is a field the user cannot set — which is what made `max_tokens`, the reasoning blocks and
// the tool-call mode invisible while AlayaCore was reading all of them (#249).
func TestTheListACanvasSeesCarriesEveryFieldAFormEdits(t *testing.T) {
	state := startupWith(t, modelListFrame)
	event := state.event()

	first := event.Models[0]
	if first.MaxTokens != 65536 || first.ContextLimit != 262144 {
		t.Errorf("tokens = %d/%d, want 65536 max and 262144 context", first.MaxTokens, first.ContextLimit)
	}
	if !strings.Contains(string(first.Reasoning1), "medium") {
		t.Errorf("reasoning_1 = %s, want the block the agent announced", first.Reasoning1)
	}
	if first.Reasoning0 != nil || first.Reasoning2 != nil {
		t.Errorf("reasoning_0/reasoning_2 = %s/%s, want nothing: neither is in this entry", first.Reasoning0, first.Reasoning2)
	}
	if !first.SerialToolCalls {
		t.Error("serial_tool_calls = false, want true")
	}
	// The key is the one thing that stays here, and the page says so instead (`hasKey`).
	if strings.Contains(string(mustJSON(t, first)), "sk-one") {
		t.Error("the model event carries the api_key")
	}

	second := event.Models[1]
	if second.SerialToolCalls {
		t.Error("a model with no serial_tool_calls is not serial, and says so")
	}
	if second.MaxTokens != 0 {
		t.Errorf("max_tokens = %d, want 0 for an entry that names none", second.MaxTokens)
	}
}

// Every field a form shows is a field an edit may replace — and only the ones it sent.
func TestModelSyncEditsEveryFieldAFormShows(t *testing.T) {
	session := &Session{ID: "canvas:1", state: startupWith(t, modelListFrame)}

	sent := `[{"id":1,"name":"DeepSeek / Flash","protocol_type":"openai","base_url":"https://api.deepseek.com",` +
		`"model_name":"deepseek-flash","context_limit":1000000,"max_tokens":8192,"reasoning_field":"reasoning_text",` +
		`"serial_tool_calls":false,"reasoning_0":{"thinking":{"type":"disabled"}},` +
		`"reasoning_1":{"thinking":{"type":"enabled"},"reasoning_effort":"high"}}]`
	merged, err := session.mergeModelSync(sent)
	if err != nil {
		t.Fatalf("mergeModelSync: %v", err)
	}

	edited := merged[0]
	if got := edited.number("context_limit"); got != 1000000 {
		t.Errorf("context_limit = %d, want the page's value", got)
	}
	if got := edited.number("max_tokens"); got != 8192 {
		t.Errorf("max_tokens = %d, want the page's value", got)
	}
	if got := edited.text("reasoning_field"); got != "reasoning_text" {
		t.Errorf("reasoning_field = %q, want the page's value", got)
	}
	if edited.boolean("serial_tool_calls") {
		t.Error("serial_tool_calls = true, want the page's false")
	}
	if got := string(edited["reasoning_0"]); !strings.Contains(got, "disabled") {
		t.Errorf("reasoning_0 = %s, want the page's block", got)
	}
	if got := string(edited["reasoning_1"]); !strings.Contains(got, "high") {
		t.Errorf("reasoning_1 = %s, want the page's block", got)
	}
	// Untouched, so still there: the key.
	if got := edited.text("api_key"); got != "sk-one" {
		t.Errorf("api_key = %q, want sk-one kept", got)
	}
}

// A reasoning block is the one field where a blank box is an answer: the form showed the value, so clearing it
// removes the block. Not sending the field at all still means "I know nothing about it", which is what keeps
// this merge safe for a page older than these fields.
func TestModelSyncRemovesAReasoningBlockOnlyWhenThePageClearsIt(t *testing.T) {
	session := &Session{ID: "canvas:1", state: startupWith(t, modelListFrame)}

	untouched, err := session.mergeModelSync(`[{"id":1,"name":"V100 / Qwen"}]`)
	if err != nil {
		t.Fatalf("mergeModelSync: %v", err)
	}
	if _, ok := untouched[0]["reasoning_1"]; !ok {
		t.Error("reasoning_1 was removed by a page that never mentioned it")
	}

	cleared, err := session.mergeModelSync(`[{"id":1,"name":"V100 / Qwen","reasoning_1":null}]`)
	if err != nil {
		t.Fatalf("mergeModelSync: %v", err)
	}
	if _, ok := cleared[0]["reasoning_1"]; ok {
		t.Errorf("reasoning_1 = %s, want it gone after the page cleared it", cleared[0]["reasoning_1"])
	}
	if got := cleared[0].text("api_key"); got != "sk-one" {
		t.Errorf("api_key = %q, want it kept: clearing a reasoning block is not clearing the model", got)
	}
}

// The blocks are merged into a request body, so anything that is not an object is a request AlayaCore would
// send malformed. Refused here, where the sentence can name the field.
func TestModelSyncRefusesAReasoningBlockThatIsNotAnObject(t *testing.T) {
	session := &Session{ID: "canvas:1", state: startupWith(t, modelListFrame)}

	for _, sent := range []string{
		`[{"id":1,"name":"V100 / Qwen","reasoning_1":"{\"reasoning_effort\":\"high\"}"}]`,
		`[{"id":1,"name":"V100 / Qwen","reasoning_1":5}]`,
		`[{"id":1,"name":"V100 / Qwen","reasoning_1":[1,2]}]`,
	} {
		_, err := session.mergeModelSync(sent)
		if err == nil {
			t.Fatalf("mergeModelSync(%s) was accepted, want a refusal naming reasoning_1", sent)
		}
		if !strings.Contains(err.Error(), "reasoning_1") {
			t.Errorf("error = %q, want it to name the field", err)
		}
	}
}

// mustJSON renders a value for an assertion that is about what is *not* in it.
func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	payload, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return payload
}

// `input_modalities` has three states, and the file's meaning depends on telling them apart: a line that is
// not there means "the protocol decides", `[]` means "declared, no media", and a list means that list. A page
// that hears `[]` as absent widens the model on its next save, so the distinction has to survive both hops.
func TestInputModalitiesAreNotWidenedOnTheWayOutOrBack(t *testing.T) {
	frame := `{"models":[{"id":1,"name":"declared none","protocol_type":"openai","base_url":"http://x/v1","input_modalities":[]},` +
		`{"id":2,"name":"declared some","protocol_type":"openai","base_url":"http://x/v1","input_modalities":["text","image"]},` +
		`{"id":3,"name":"declared nothing","protocol_type":"openai","base_url":"http://x/v1"}]}`
	state := startup{}
	state.collect("model_list", json.RawMessage(frame))

	models := state.event().Models
	if models[0].InputModalities == nil || len(models[0].InputModalities) != 0 {
		t.Errorf("[] came out as %#v, want an empty declaration, not an absent one", models[0].InputModalities)
	}
	if got := strings.Join(models[1].InputModalities, ","); got != "text,image" {
		t.Errorf("the declared list came out as %q, want text,image", got)
	}
	if models[2].InputModalities != nil {
		t.Errorf("an entry with no line came out as %#v, want nil", models[2].InputModalities)
	}

	// Always stated, so a page can tell "not declared" from "no media" without guessing.
	payload := string(mustJSON(t, models[2]))
	if !strings.Contains(payload, `"inputModalities":null`) {
		t.Errorf("an undeclared model does not say so: %s", payload)
	}
}

// The page sends all three back: a list, `[]`, and `null` for the switch that is off. `null` has to remove
// the line — leaving the stored declaration would be the opposite of what the user chose.
func TestModelSyncKeepsWhatAnInputModalitiesEditMeans(t *testing.T) {
	frame := `{"models":[{"id":1,"name":"one","protocol_type":"openai","base_url":"http://x/v1","input_modalities":["text"]},` +
		`{"id":2,"name":"two","protocol_type":"openai","base_url":"http://x/v1"}]}`
	session := &Session{ID: "canvas:1", state: startupWith(t, frame)}

	merged, err := session.mergeModelSync(`[{"id":1,"name":"one","input_modalities":["image","audio"]},{"id":2,"name":"two","input_modalities":["video"]}]`)
	if err != nil {
		t.Fatalf("mergeModelSync: %v", err)
	}
	if got := string(merged[0]["input_modalities"]); got != `["image","audio"]` {
		t.Errorf("input_modalities = %s, want the page's list", got)
	}

	// `[]` is a declaration, not a silence, and it has to stay one.
	emptied, err := session.mergeModelSync(`[{"id":1,"name":"one","input_modalities":[]}]`)
	if err != nil {
		t.Fatalf("mergeModelSync: %v", err)
	}
	if got := string(emptied[0]["input_modalities"]); got != `[]` {
		t.Errorf("input_modalities = %s, want [] kept as []", got)
	}

	// A page that says nothing about the field keeps what is stored — it has never seen it.
	silent, err := session.mergeModelSync(`[{"id":1,"name":"one"}]`)
	if err != nil {
		t.Fatalf("mergeModelSync: %v", err)
	}
	if got := string(silent[0]["input_modalities"]); got != `["text"]` {
		t.Errorf("input_modalities = %s, want the stored declaration kept", got)
	}

	// The switch, off.
	removed, err := session.mergeModelSync(`[{"id":1,"name":"one","input_modalities":null}]`)
	if err != nil {
		t.Fatalf("mergeModelSync: %v", err)
	}
	if raw, ok := removed[0]["input_modalities"]; ok {
		t.Errorf("input_modalities = %s after the page removed it, want no line at all", raw)
	}
	if got := removed[0].text("name"); got != "one" {
		t.Errorf("name = %q, want the rest of the entry untouched", got)
	}
}

// The words are AlayaCore's to accept or reject; what this server can see is the shape, and a shape it cannot
// write is refused rather than handed on to make one model disappear from `model.conf`.
func TestModelSyncRefusesInputModalitiesThatAreNotAList(t *testing.T) {
	session := &Session{ID: "canvas:1", state: startupWith(t, modelListFrame)}
	for _, sent := range []string{
		`[{"id":1,"name":"V100 / Qwen","input_modalities":"image"}]`,
		`[{"id":1,"name":"V100 / Qwen","input_modalities":{"image":true}}]`,
		`[{"id":1,"name":"V100 / Qwen","input_modalities":[1,2]}]`,
	} {
		_, err := session.mergeModelSync(sent)
		if err == nil {
			t.Fatalf("mergeModelSync(%s) was accepted, want a refusal naming input_modalities", sent)
		}
		if !strings.Contains(err.Error(), "input_modalities") {
			t.Errorf("error = %q, want it to name the field", err)
		}
	}
}
