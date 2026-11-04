package agent

import (
	"encoding/json"
	"fmt"
	"strconv"
)

// The one command whose arguments a canvas may not fill in on its own.
//
// `model_sync` takes the whole list — AlayaCore replaces every model in `model.conf` with what it is given
// and writes the file — while the list a canvas was shown is `Model`: every field an editor can read, no
// `api_key`, and nothing this build has not been taught. Forwarded as sent, one edit would delete every key
// on the machine.
const modelSyncCommand = "model_sync"

// modelEditorFields are the fields an editor may replace on a model the server already knows — which is every
// field of the entry a form can show (#249). Everything else in the stored object (an `api_key`, and whatever
// AlayaCore adds tomorrow) is the server's to keep, because the canvas has never seen it.
var modelEditorFields = [...]string{
	"name", "protocol_type", "base_url", "model_name",
	"context_limit", "max_tokens", "reasoning_field", "serial_tool_calls",
}

// modelReasoningFields are the reasoning blocks: raw JSON merged into a request body per level. They are
// edited as JSON text, and a blank box is a decision — it removes the block — where a blank field elsewhere
// would be a silence.
var modelReasoningFields = [...]string{"reasoning_0", "reasoning_1", "reasoning_2"}

// mergeModelSync completes the list a canvas sent into the list `model_sync` expects.
//
// The canvas says which models stay, in which order, what is new and what changed:
//
//   - an id the server knows is rebuilt from the entry the agent announced, with the four fields above
//     replaced by whatever the canvas sent — so deleting one model does not take another's key or
//     reasoning blocks with it;
//   - an id nobody knows is new, and travels as sent, the `api_key` it carries included;
//   - a key travels whenever the canvas has one to send, which is a model being created or one whose key
//     the user has just retyped. An absent or empty one says nothing rather than "no key": the canvas was
//     never shown the stored key, so it is in no position to mean it away.
//
// Ids are rewritten to the models' positions, which is what `:model_sync` assigns them (1-based, in list
// order) — the ids a `model_set` from the canvas will have to use once the list is written.
func (s *Session) mergeModelSync(args string) ([]modelObject, error) {
	var sent []modelObject
	if err := json.Unmarshal([]byte(args), &sent); err != nil {
		return nil, fmt.Errorf("%s: the list is not a JSON array of models: %v", modelSyncCommand, err)
	}

	state := s.snapshot()
	merged := make([]modelObject, 0, len(sent))
	for index, entry := range sent {
		object := entry
		if stored := state.modelByID(entry.number("id")); stored != nil {
			object = stored.clone()
			for _, field := range modelEditorFields {
				if raw, ok := entry[field]; ok {
					object[field] = raw
				}
			}
			if key := entry.text("api_key"); key != "" {
				object["api_key"] = entry["api_key"]
			}
		}
		// The reasoning blocks are the one field where a blank box is an answer: a form showed the value, so
		// an emptied one means "remove it". Absent still says nothing — a page that has never heard of these
		// fields keeps what is stored, which is what makes this merge safe for a bundle older than it.
		for _, field := range modelReasoningFields {
			raw, sent := entry[field]
			if !sent {
				continue
			}
			if len(raw) == 0 || string(raw) == "null" || string(raw) == `""` {
				delete(object, field)
				continue
			}
			var block map[string]any
			if err := json.Unmarshal(raw, &block); err != nil || block == nil {
				return nil, fmt.Errorf("%s: %s must be a JSON object, or empty to remove it", modelSyncCommand, field)
			}
			object[field] = raw
		}
		delete(object, "id")
		object["id"] = json.RawMessage(strconv.Itoa(index + 1))
		merged = append(merged, object)
	}
	return merged, nil
}

// ModelSync is `mergeModelSync` for the server, plus the other half of one file shared by many processes.
//
// `model.conf` is one file for the whole host and every agent process reads it into its own memory at
// startup, so a list edited on one surface is wrong on every other until that process is replaced: the
// canvas's own model picker would go on offering a model that was just deleted, and not the one that was
// just added. The server is the only layer that knows both sides — it is about to write this list through
// the agent — so it hands the list to the other sessions as well. Their `active` model is their own and is
// left alone; if it is the model that went away, the agent finds out when it is next asked a question.
//
// A rejection on the agent's side (an entry it will not accept, a file it cannot write) is reported by the
// command's own answer, and leaves those sessions a list slightly ahead of the file until their next start.
func (s *Sessions) ModelSync(session *Session, args string) (string, error) {
	merged, err := session.mergeModelSync(args)
	if err != nil {
		return "", err
	}
	payload, err := json.Marshal(merged)
	if err != nil {
		return "", fmt.Errorf("%s: %v", modelSyncCommand, err)
	}
	s.tellModels(merged, session.ID)
	return string(payload), nil
}

// tellModels gives every session but one the list that is about to be written. The entries are shared
// rather than copied: nothing writes to a list once it is built (`mergeModelSync` clones what it changes).
func (s *Sessions) tellModels(models []modelObject, except string) {
	for _, session := range s.List() {
		if session.ID != except {
			session.adoptModels(models)
		}
	}
}

// adoptModels replaces the list this session holds and tells whoever is reading it. `active` and `level`
// stay as they were: they are this session's, and the file they came from does not decide them.
func (s *Session) adoptModels(models []modelObject) {
	s.stateMu.Lock()
	s.state.models = models
	event := s.state.event()
	s.stateMu.Unlock()
	s.publish(event)
}
