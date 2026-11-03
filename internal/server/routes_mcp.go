package server

// The agent's hands.
//
// AlayaCore runs its own built-in tools, so the only way for it to do something this gateway knows
// about is MCP (`mcp.conf` in its config directory). The gateway is already the process holding the
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
// `resource` carries a blob, and a field this gateway has never heard of is still a field the client may
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
		Description: "Every node on the canvas, one line each — id, type, title, position, what made its content and when, then `content:`: the words it holds (a text node's text). What a node will be asked is not here; read one node's prompt with read_prompt. Then every connection between them. The ids are what the other tools act on.",
		InputSchema: noArguments,
	}, {
		Name:        "create_node",
		Description: "Make one node on the canvas, the way the user's own button makes one: it appears where the view is looking, selected, with its panel open when that is what pressing the button does. Answers with the new node's id and position. Make one only when the canvas holds nothing that would do: reusing what is there is a connection, not a copy.",
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
		Name:        "set_prompt",
		Description: "Change the words that will make this node — the prompt its own panel shows. Running it again afterwards replaces that node's result (docs/decisions.md #77); a variant is a new node. On a text node that already says something this changes the question, not the text: the node will be asked this next, and what it says now stays. Write the text itself with set_text.",
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
		Description: "Write a text node's words, the way editing the card on the canvas does: what the node says becomes this. Its prompt is left alone — that is the question that made the words. A picture, a film or a sound has no text to write: give it a prompt with set_prompt and press generate.",
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
		Name:        "generate",
		Description: "Press one node's generate button — the same thing the node's own panel does. It starts the work and answers at once; the node shows its own progress and holds the result. A picture, a film or a sound takes minutes, so do not wait for it and do not poll the node: when the run ends you are sent a message saying how it went, and you can carry on. A text node is different — it writes its answer itself as it streams.",
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
		Description: "Read what one node holds: a text node's text, or the image, video or audio itself — not a description of it, and not the words it will be asked next. A text node holding a batch answers with every text, the one its card shows first. A node something generated ends with a line naming the workflow that made it and the moment that run finished; both are facts the canvas recorded, so they are the answer to \"which model drew this, and when\" rather than a guess.",
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
		Description: "Read the words a node will be asked — the prompt its own panel shows, and the words set_prompt writes. This is the pair to read_node: read_node answers with what the node holds, this answers with the question behind it. A text node is where the two are easiest to confuse: its card is what it says, its prompt is what it will be asked next. A node nobody has asked anything of has no prompt, and that is the answer.",
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
		Description: "Delete one node, the way the Delete key does: the node goes, and so does every connection that touched it. Answers with what disappeared. The user can undo it.",
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
		Description: "Move one node so its top-left corner lands where you say, the way dragging it does: a node dropped on a group becomes one of its members. It changes nothing else about the node — moving is not running it, and the node keeps its prompt and its result.",
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
	}}
}

// callMCPTool hands one call to the session's canvas, which is the only thing that can run it: the
// gateway knows the vocabulary, the page knows the nodes.
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
		return mcpResult{Content: agent.TextContent("this gateway has no tool named " + name + "; it offers what tools/list advertises"), IsError: true}, nil
	}
	content, failed := session.CallTool(name, args)
	return mcpResult{Content: content, IsError: failed}, nil
}

// hasMCPTool reports whether the advertised table contains this name: the gateway owns the vocabulary
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
