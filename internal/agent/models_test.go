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
// it is given. So the parts the canvas never saw have to come back from the gateway's own copy: deleting
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
