package server

// The agent's hands.
//
// AlayaCore runs its own built-in tools, so the only way for it to do something this server knows
// about is MCP (`mcp.conf` in its config directory). The server is already the process holding the
// socket to the browser, so it is also the natural MCP server: a tool call arrives here, goes down the
// session's socket, and comes back with whatever the canvas did.
//
// What is here is the protocol only — the tool table and the JSON-RPC envelope. Where a call is routed,
// and what the tools mean, is the next layer.

import (
	"encoding/json"
	"net/http"

	"comfyloft/internal/agent"
	"comfyloft/internal/httpx"
)

// mcpRequest is one JSON-RPC call.
type mcpRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

// mcpTool is one entry of `tools/list`.
type mcpTool struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"inputSchema"`
}

// mcpResult is what `tools/call` answers: content blocks, and whether the tool failed.
//
// The blocks are carried as the page produced them — `json.RawMessage` and not a struct, because the
// protocol's content is self-describing and grows: text, image and audio carry their own `mimeType`,
// `resource` carries a blob, and a field this server has never heard of is still a field the client may
// need. Nothing here inspects them, and nothing converts one kind into another.
type mcpResult struct {
	Content json.RawMessage `json:"content"`
	IsError bool            `json:"isError,omitempty"`
}

// mcpProtocolVersion is what this server speaks. The client announces its own; a mismatch is the
// client's to reconcile, and AlayaCore's `proto-version` field is where it says which it wants.
const mcpProtocolVersion = "2025-11-25"

// handleMCP speaks just enough of the protocol for a client to discover and call tools.
//
// Registered on the loopback listener only (see mcp_server.go), so the identity is not a URL segment a
// stranger could guess: it is a header the bridge writes from the environment its parent inherited.
func (s *Server) handleMCP(ctx *httpx.Ctx) error {
	if err := s.checkBridge(ctx.R); err != nil {
		return err
	}
	session, err := s.sessionOf(ctx.R)
	if err != nil {
		return err
	}

	var request mcpRequest
	if err := json.Unmarshal(mustBody(ctx), &request); err != nil {
		return mcpError(ctx, nil, -32700, "parse error")
	}

	// A notification has no id and no answer. The only one that matters is `notifications/initialized`,
	// which says the client is done handshaking.
	if len(request.ID) == 0 || string(request.ID) == "null" {
		ctx.W.WriteHeader(http.StatusAccepted)
		return nil
	}

	switch request.Method {
	case "initialize":
		return mcpReply(ctx, request.ID, map[string]any{
			"protocolVersion": mcpProtocolVersion,
			"capabilities":    map[string]any{"tools": map[string]any{}},
			"serverInfo":      map[string]any{"name": "comfyloft", "version": "0.1.0"},
		})
	case "tools/list":
		return mcpReply(ctx, request.ID, map[string]any{"tools": s.mcpTools()})
	case "tools/call":
		var params struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		if err := json.Unmarshal(request.Params, &params); err != nil {
			return mcpError(ctx, request.ID, -32602, "invalid params")
		}
		result, err := s.callMCPTool(session, params.Name, params.Arguments)
		if err != nil {
			return mcpError(ctx, request.ID, -32603, err.Error())
		}
		return mcpReply(ctx, request.ID, result)
	default:
		return mcpError(ctx, request.ID, -32601, "unknown method: "+request.Method)
	}
}

// mcpTools is the list the agent is offered. The names are the vocabulary; running one is the canvas's.
//
// A tool's name here is not the name the model sees: AlayaCore prefixes it with the server's name, so
// this `ping` is the model's `canvas_ping`, and calling it arrives here again as `ping`. Naming a tool
// `canvas_ping` would show the model `canvas_canvas_ping` (measured, not guessed).
func (s *Server) mcpTools() []mcpTool {
	noArguments := json.RawMessage(`{"type":"object","properties":{},"additionalProperties":false}`)
	return []mcpTool{{
		Name:        "ping",
		Description: "Check that the canvas is listening. Answers with how much is on it.",
		InputSchema: noArguments,
	}, {
		Name:        "list_nodes",
		Description: "Every node on the canvas, one line each — id, type, position and the size of its card, then the picture's own size when that is not the card's, and how long a clip or a sound runs, then which group it is in (`in group <id>`, and a group's own line names its members), then what made its content and when, then `content:`: the words it holds (a text node's text). What a node will be asked is not here; read one node's prompt with read_prompt. Then every connection between them. The ids are what the other tools act on.",
		InputSchema: noArguments,
	}, {
		Name:        "create_node",
		Description: "Make one node on the canvas, the way the user's own button makes one: it appears where the view is looking, selected, with its panel open when that is what pressing the button does. Answers with the new node's id and position. Make one only when the canvas holds nothing that would do: reusing what is there is a connection, not a copy. A group is the one type that holds nodes rather than content: it is made empty and nothing can be asked of it, and wrapping nodes that already exist is one call with group_nodes.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"type": {"type": "string", "enum": ["image", "video", "audio", "text"], "description": "What kind of node. A group is structure rather than content, and a LoRA node names a file the user has to pick in its own panel, so neither is made here."},
				"prompt": {"type": "string", "description": "What the node starts with: a text node's body, or the prompt the node's own panel shows."},
				"position": {
					"type": "object",
					"properties": {"x": {"type": "number"}, "y": {"type": "number"}},
					"required": ["x", "y"],
					"additionalProperties": false,
					"description": "Top-left corner in canvas coordinates. Omit it and the node lands in the middle of the view."
				}
			},
			"required": ["type"],
			"additionalProperties": false
		}`),
	}, {
		Name:        "connect",
		Description: "Connect two nodes, the way dragging from one handle to the other does: what the source node holds becomes an input to the target — a picture connected into an image node is what makes its next generation an edit of it. This is how what is already on the canvas is reused: a node that holds what another needs is connected to it, not copied. The words into the picture: fromNodeId is the text node, toNodeId is the image node. The other order is real too — a picture into a text node is a reference that text node reads. A text node's words are added to the target's own prompt when it generates, so a target that already says them in its own prompt would say them twice: clear that prompt first.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"fromNodeId": {"type": "string", "description": "The node whose content flows out."},
				"toNodeId": {"type": "string", "description": "The node that receives it."}
			},
			"required": ["fromNodeId", "toNodeId"],
			"additionalProperties": false
		}`),
	}, {
		Name:        "capture_frame",
		Description: "Take a film's first and/or last frame out of it, as picture nodes wired to the film it came from — the card's own menu, and the one way a longer clip is made, because the last frame of one clip is the first frame of the next. Nothing is asked of a model: the frame is decoded in the browser and becomes an ordinary picture, and what it makes holds no model, so it is material — connect it to the node that should run from it. A picture is one frame already, and a film that is still generating holds no clip to take a frame out of. The frame the user is looking at is theirs to take from the card; a playhead is not something a tool can see.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"nodeId": {"type": "string", "description": "The film to take a frame from."},
				"frame": {"type": "string", "enum": ["first", "last", "both"], "description": "Which frame: the one the clip starts on, the one it ends on, or both. Both by default — a chain needs the end, and the start is what tells a reader where the clip came from."}
			},
			"required": ["nodeId"],
			"additionalProperties": false
		}`),
	}, {
		Name:        "join_clips",
		Description: "Join several clips into one, in the order the call names them — the end of a chain: each clip was made from the frame the one before it ended on, and this is what turns five clips into the one video the user asked for. It is not a run: no model, no GPU, no queue, and nothing comes back later. The order is the list, not the order the clips were connected in. The joined clip holds no model, so it is material like a captured frame. Clips that were not made the same way — a different codec, size, pixel format, frame rate, or an extra audio track — are refused with the file and the field that differ, because a stream copy cannot join them; reencode is the caller saying it wants the whole result re-encoded instead.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"nodeIds": {
					"type": "array",
					"items": {"type": "string"},
					"description": "The clips to join, in the order they should play."
				},
				"reencode": {"type": "boolean", "description": "Re-encode the whole result instead of copying the streams, which is the only way to join clips that were not made the same way. It changes every frame, so ask for it rather than assuming it."}
			},
			"required": ["nodeIds"],
			"additionalProperties": false
		}`),
	}, {
		Name:        "set_prompt",
		Description: "Change the words that will make this node — the prompt its own panel shows. Running it again afterwards replaces that node's result (docs/decisions.md #77); a variant is a new node. A text node has no prompt: it holds words that nothing asks for, so write those with set_text, and this refuses rather than writing a field no surface shows.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"nodeId": {"type": "string", "description": "The id list_nodes reported."},
				"prompt": {"type": "string", "description": "The words the node should hold."}
			},
			"required": ["nodeId", "prompt"],
			"additionalProperties": false
		}`),
	}, {
		Name:        "set_text",
		Description: "Write a text node's words, the way editing the card on the canvas does: what the node says becomes this. It is the only way to change a text node — there is no prompt behind the words. A picture, a film or a sound has no text to write: give it a prompt with set_prompt and press generate.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"nodeId": {"type": "string", "description": "The id list_nodes reported."},
				"text": {"type": "string", "description": "The words the node should say. An empty string clears it."}
			},
			"required": ["nodeId", "text"],
			"additionalProperties": false
		}`),
	}, {
		Name:        "set_node",
		Description: "Set what this node's next run is: the workflow it generates with and the mode it is asked in, and the shape of that run — its size, how long it runs, its quality tier, the seed it is drawn with, a picture's background, a sound's container and words, and the workflow's own knobs. Both halves land together or not at all: the settings are checked against the workflow that will run them, so a call that names a new model and a size judges the size by the new model's contract, and one that gets any of it wrong writes none of it. It writes no words: a text node's card is set_text's, and the question a node will be asked is set_prompt's. Answers with what the node is now set to, in the same words read_node gives.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"nodeId": {"type": "string", "description": "The id list_nodes reported."},
				"model": {"type": "string", "description": "The workflow to run, as read_node reports it (image-qwen21), or the picker's value (default::image-qwen21). Omit it to leave the run as it is."},
				"mode": {"type": "string", "description": "The mode to run in: t2i, edit, inpaint or outpaint on a picture family, or text, frames or reference for a film. On a film it names the workflow too. Omitted, a picture keeps the mode it has and a film takes the one its workflow declares."},
				"size": {"type": "string", "description": "The size in pixels a picture is made at, like 1360x768 — a shape such as 16:9 is not a size, so state the pixels. On a film it is the shape the tier makes numbers for: state 1280x720 for 16:9 at 720p, and a size the tier would not make is refused with the one it does. \"auto\" leaves it to the workflow. Sides are aligned up to 16, and a size outside what a picture may be (655360 to 8294400 pixels in total, longest side at most 3840, at most three times the shortest) is refused with the reason."},
				"seconds": {"type": "number", "description": "How long a clip or a sound runs, in whole seconds. Refused outside the lengths the workflow declares, rather than clamped into them."},
				"quality": {"type": "number", "description": "A film's quality tier, the short side in pixels — 480, 720, 1080. A film's size is derived from this tier and the shape it states, so a size the tier would not make is refused with the one it does. A picture has no such setting: its size is the size."},
				"background": {"type": "string", "description": "A picture's own background: \"transparent\", or \"\" for the workflow's default. Only a workflow that declares a background prompt takes one."},
				"seed": {"type": ["number", "string"], "description": "A fixed seed, 1 to 2147483647, so the same prompt draws the same thing again; the string \"random\" leaves it to the graph. A seed travels only while the node says it is fixed, so this writes that with it."},
				"format": {"type": "string", "enum": ["mp3", "wav", "opus", "aac", "flac", "pcm"], "description": "A sound's container. A picture or a film has none."},
				"instructions": {"type": "string", "description": "A sound's own words rather than its description — the lyrics a music workflow sings. Not the prompt: that is set_prompt."},
				"frameMode": {"type": "string", "enum": ["first", "last", "both"], "description": "On a film that takes frames: what the connected pictures are — first continues from a frame, last ends on one, both is one of each in the order they were connected. A workflow that declares no frames refuses it, because nothing would read it."},
				"params": {"type": "object", "description": "The workflow's own knobs, under the names its contract publishes — steps, cfg, sampler, resolution, horizontalAngle, upscale_model and the rest. A key its contract does not list is refused, and the refusal names the ones it reads. Two keys are never set here: loras comes from the LoRA nodes connected to this one, and layout from the MOSS layout editor.", "additionalProperties": true}
			},
			"required": ["nodeId"],
			"additionalProperties": false
		}`),
	}, {
		Name:        "generate",
		Description: "Press one node's generate button — the same thing the node's own panel does. It starts the work and answers at once; the node shows its own progress and holds the result. A picture, a film or a sound takes minutes, so do not wait for it and do not poll the node: when the run ends you are sent a message saying how it went, and you can carry on. A text node generates nothing — write its words with set_text.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"nodeId": {"type": "string", "description": "The id list_nodes reported."}
			},
			"required": ["nodeId"],
			"additionalProperties": false
		}`),
	}, {
		Name:        "list_models",
		Description: "What this canvas can run, grouped by the kind of content, with the ones that are steps named apart. Ask this before answering any question about models: the names an agent has seen are the ones on nodes it happened to read, and reciting those is how a canvas with five image generators answers \"four\", counts an upscaler among them, and misses the workflow nothing on screen uses. A name here is what set_node's model takes, and what a run reports itself as. Each entry also says what the workflow takes (words, or how many pictures or clips) and the modes a family offers — including any whose own node pack is missing, which a run would be refused for. What each workflow reads is not here: that is the contract of the node it runs on, where set_node refuses a key it does not read. A base model is a file inside a family rather than a workflow, and the node's own picker lists those.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"capability": {"type": "string", "enum": ["image", "video", "audio"], "description": "One kind of content to list. Leave it out for all three, which is the shape a question about models usually has."}
			},
			"additionalProperties": false
		}`),
	}, {
		Name:        "stop_node",
		Description: "Stop what this node is generating — its panel's stop button, without the question the button asks: a call is the sure part. The node keeps what it held before the run started, and is idle again; the work in progress is thrown away on the server too (the ComfyUI prompt is interrupted, so the GPU is free). Answers one of three things, and they are not the same: the run was cancelled; there was nothing running; or the server did not confirm the cancel, in which case the call failed and the run may still be rendering there. A text node generates nothing, so it has nothing to stop.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"nodeId": {"type": "string", "description": "The id list_nodes reported."}
			},
			"required": ["nodeId"],
			"additionalProperties": false
		}`),
	}, {
		Name:        "read_node",
		Description: "Read what this node's next run is set to: the workflow and mode it runs, the shape that run takes (size, length, quality, seed, background, container, its own knobs), and what a press would still need — the media it takes and what is connected in front of it. It carries no words and no media: a card is read_text's, the question is read_prompt's, and the picture, film or sound itself is read_media's. What a node did — whether it is generating, how its last run failed, and which workflow and moment made its content — is on its list_nodes line, and the maker comes back with read_media as a caption. A text node has no run, and this says so.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"nodeId": {"type": "string", "description": "The id list_nodes reported."}
			},
			"required": ["nodeId"],
			"additionalProperties": false
		}`),
	}, {
		Name:        "read_prompt",
		Description: "Read the words a node will be asked — the prompt its own panel shows, and the words set_prompt writes. The words and nothing else: the settings standing behind them are read_node's. A text node has no prompt at all, and this says so: what it holds is words, which read_text answers with and set_text writes. A node nobody has asked anything of has no prompt, and that is the answer too.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"nodeId": {"type": "string", "description": "The id list_nodes reported."}
			},
			"required": ["nodeId"],
			"additionalProperties": false
		}`),
	}, {
		Name:        "read_text",
		Description: "Read a text node's card: the words it holds, whole. This is what set_text writes, and the only thing a text node holds — it has no prompt, and nothing generates it. A picture, a film or a sound has no card of words: what it holds is read_media's, and what it will be asked is read_prompt's. list_nodes shows the first 300 characters of every card, which is a glance across the canvas; this is the card.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"nodeId": {"type": "string", "description": "The id list_nodes reported."}
			},
			"required": ["nodeId"],
			"additionalProperties": false
		}`),
	}, {
		Name:        "read_media",
		Description: "Read the picture, the film or the sound a node holds — the bytes themselves, not a description of them — with one line naming the node and the workflow and moment that made it. This is the one read that costs real context, so ask for it when you need to see the thing: everything else about a node is a few hundred bytes through read_node, read_prompt and read_text. A node that holds no media yet, and a text node, are refused and say so.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"nodeId": {"type": "string", "description": "The id list_nodes reported."}
			},
			"required": ["nodeId"],
			"additionalProperties": false
		}`),
	}, {
		Name:        "delete_node",
		Description: "Delete one node, the way the Delete key does: the node goes, and so does every connection that touched it. A group left with nothing in it is removed too, since a box drawn around nothing is what this delete made; a box that was already empty is left alone. Answers with what disappeared. The user can undo it.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"nodeId": {"type": "string", "description": "The id list_nodes reported."}
			},
			"required": ["nodeId"],
			"additionalProperties": false
		}`),
	}, {
		Name:        "focus_node",
		Description: "Select one node and move the user's view to it, the way clicking its row in the side panel does. This moves what the user is looking at: use it to show them something that changed or is out of sight.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"nodeId": {"type": "string", "description": "The id list_nodes reported."}
			},
			"required": ["nodeId"],
			"additionalProperties": false
		}`),
	}, {
		Name:        "move_node",
		Description: "Move one node so its top-left corner lands where you say, the way dragging it does: a node dropped on a group becomes one of its members and a node drawn out of its group leaves it, and the answer names that change; a group moves its members with it and keeps them — the card and the nodes it is drawn around are one thing to move, and the answer says how many came along. A group left with nothing in it is removed, since a box drawn around nothing is debris the move made; a box that was already empty is left alone. It changes nothing else about the node — moving is not running it, and the node keeps its prompt and its result.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"nodeId": {"type": "string", "description": "The id list_nodes reported."},
				"position": {
					"type": "object",
					"properties": {"x": {"type": "number"}, "y": {"type": "number"}},
					"required": ["x", "y"],
					"additionalProperties": false,
					"description": "Top-left corner in canvas coordinates, the same space list_nodes reports."
				}
			},
			"required": ["nodeId", "position"],
			"additionalProperties": false
		}`),
	}, {
		Name:        "group_nodes",
		Description: "Wrap nodes in one group, the way the Group button does: a card is drawn around them, they stay exactly where they are and keep their prompts and results, and moving the group moves them. Name at least two. A group named among the ids is absorbed into the new one, so two groups become one by naming both. A group is structure, not content: nothing generates it and it cannot be connected, so it exists to hold nodes — this fills one in a single call, which is the state the canvas keeps, and is the tool for wrapping or merging.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"nodeIds": {
					"type": "array",
					"items": {"type": "string"},
					"minItems": 2,
					"description": "The ids list_nodes reported: the nodes to wrap, or a group to absorb into the new one."
				}
			},
			"required": ["nodeIds"],
			"additionalProperties": false
		}`),
	}, {
		Name:        "ungroup_nodes",
		Description: "Take nodes out of their groups, the way Ungroup does: name a group and it is dissolved, its members left on the canvas exactly as they were; name a node and it leaves the group it is in. A group left with no members goes away. Nothing else changes — prompts, results and connections were never inside the group — and the user can undo it.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"nodeIds": {
					"type": "array",
					"items": {"type": "string"},
					"minItems": 1,
					"description": "The ids list_nodes reported: a group to dissolve, or the nodes to take out of theirs."
				}
			},
			"required": ["nodeIds"],
			"additionalProperties": false
		}`),
	}, {
		Name:        "resize_node",
		Description: "Set one card's size, the way the end of a corner drag does: its top-left corner stays where it is, so a node you have just placed does not move. A card that frames a picture or a film is that picture's shape, so it has one size to give — state the width, and the height follows; stating both is allowed and checked, and a pair that disagrees is refused with the height that fits. A card holding words, a sound or a group changes in both directions, and a height you leave out is the one it keeps. There is a floor (the same one dragging respects); a call under it is refused with the number. This is layout, not zoom: a card is measured in canvas coordinates, so making one bigger is not making the user see it better — that is focus_node's job, and the user's view is not yours to change.",
		InputSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"nodeId": {"type": "string", "description": "The id list_nodes reported."},
				"size": {
					"type": "object",
					"properties": {"width": {"type": "number"}, "height": {"type": "number"}},
					"required": ["width"],
					"additionalProperties": false,
					"description": "The card's box in canvas pixels, as list_nodes reports it. Height follows the picture's shape on a card that keeps it, and is optional there."
				}
			},
			"required": ["nodeId", "size"],
			"additionalProperties": false
		}`),
	}}
}

// callMCPTool hands one call to the session's canvas, which is the only thing that can run it: the
// server knows the vocabulary, the page knows the nodes.
//
// Everything that goes wrong is a tool result with `isError`, not a JSON-RPC error. The agent is holding
// a turn open waiting for this write; telling it "the canvas did not answer" lets it say so, while a
// broken response leaves it with nothing to report. The message names the side: a session that is gone is
// the browser's story (the tab closed), an unknown tool is this install's (two builds disagreeing).
func (s *Server) callMCPTool(sessionID, name string, args json.RawMessage) (mcpResult, error) {
	session, ok := s.agentSessions.Lookup(sessionID)
	if !ok {
		return mcpResult{Content: agent.TextContent("no agent is attached to " + sessionID + " any more — its canvas tab was closed or its process was released"), IsError: true}, nil
	}
	if !s.hasMCPTool(name) {
		return mcpResult{Content: agent.TextContent("this server has no tool named " + name + "; it offers what tools/list advertises"), IsError: true}, nil
	}
	content, failed := session.CallTool(name, args)
	return mcpResult{Content: content, IsError: failed}, nil
}

// hasMCPTool reports whether the advertised table contains this name: the server owns the vocabulary
// even though the canvas is what runs a tool, so an unknown name is refused before it leaves.
func (s *Server) hasMCPTool(name string) bool {
	for _, tool := range s.mcpTools() {
		if tool.Name == name {
			return true
		}
	}
	return false
}

func mcpReply(ctx *httpx.Ctx, id json.RawMessage, result any) error {
	httpx.JSON(ctx.W, http.StatusOK, map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
	return nil
}

func mcpError(ctx *httpx.Ctx, id json.RawMessage, code int, message string) error {
	if len(id) == 0 {
		id = json.RawMessage("null")
	}
	httpx.JSON(ctx.W, http.StatusOK, map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"error":   map[string]any{"code": code, "message": message},
	})
	return nil
}

// mustBody reads the request body, or an empty object when it cannot be read — a malformed call is
// answered as a parse error, not as a panic.
func mustBody(ctx *httpx.Ctx) []byte {
	body, err := ctx.Body()
	if err != nil || body == nil {
		return []byte("{}")
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		return []byte("{}")
	}
	return encoded
}
