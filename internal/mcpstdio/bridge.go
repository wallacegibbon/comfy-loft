// Package mcpstdio is the agent's end of the canvas tools.
//
// AlayaCore speaks MCP over stdin/stdout to whatever `mcp.conf` names, and this is what that name
// points at: a process with no state of its own that reads one JSON-RPC message per line, hands it to
// the gateway over loopback, and writes the answer back. The gateway is where the sessions live and
// where a call is routed to a browser tab; this bridge only carries it there.
//
// Two rules make it correct, and both are about stdout:
//
//   - stdout carries protocol and nothing else. One stray line — a log, a banner — and the handshake
//     fails with a message that names neither the cause nor the side.
//   - every answer is written whole, under one lock. MCP allows several requests in flight, so the
//     replies can arrive out of order but must never interleave mid-line.
//
// The session this bridge speaks for arrives in the environment, because that is the only thing that
// can differ between two bridges without differing in `mcp.conf` — which is a static file.
package mcpstdio

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Config is what one bridge run needs. Nothing here comes from a file: the gateway writes it into the
// environment of the process it spawns, and AlayaCore passes it on to us.
type Config struct {
	// Endpoint is the gateway's loopback base URL, e.g. http://127.0.0.1:41235.
	Endpoint string
	// Session is the agent session this bridge belongs to — usually a canvas, sometimes one node.
	Session string
	// Version is the wire contract this build speaks. The gateway refuses a bridge it does not know,
	// because with two binaries a mixed install is a real possibility.
	Version string
	// Timeout bounds one round trip. A tool that starts a generation answers at once; a tool that
	// reads an image answers when the bytes are there. This is the "something is wrong" bound, not a
	// work bound.
	Timeout time.Duration
}

// Version is the bridge↔gateway contract. Bump it when the two sides stop understanding each other.
const Version = "1"

// Run reads JSON-RPC from in and writes answers to out until in is exhausted.
//
// A line without an `id` is a notification: it is forwarded, its answer is dropped, and nothing is
// written. Everything else gets exactly one line back — including the failures, because a caller that
// asked a question and got silence is worse off than one that got a clear error.
func Run(in io.Reader, out io.Writer, cfg Config) error {
	if cfg.Timeout <= 0 {
		cfg.Timeout = 2 * time.Minute
	}
	client := &http.Client{Timeout: cfg.Timeout}
	sink := &lineWriter{out: out}

	var pending sync.WaitGroup
	scanner := bufio.NewScanner(in)
	// A prompt can be long, and a generous line budget costs nothing: it removes a whole class of "the
	// bridge truncated my request" bug from being possible at all.
	scanner.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		request := append([]byte(nil), line...)
		id, isRequest := requestID(request)
		pending.Add(1)
		go func(id json.RawMessage, isRequest bool, request []byte) {
			defer pending.Done()
			answer, err := forward(client, cfg, request)
			if err != nil {
				if isRequest {
					sink.write(errorReply(id, err))
				}
				return
			}
			if isRequest {
				sink.write(answer)
			}
		}(id, isRequest, request)
	}
	pending.Wait()
	if err := scanner.Err(); err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	return nil
}

// forward hands one message to the gateway and returns its answer.
func forward(client *http.Client, cfg Config, message []byte) ([]byte, error) {
	if cfg.Endpoint == "" {
		return nil, errors.New("COMFY_LOFT_MCP is not set, so this bridge has nowhere to send the call")
	}
	request, err := http.NewRequest(http.MethodPost, strings.TrimRight(cfg.Endpoint, "/")+"/mcp", bytes.NewReader(message))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Comfy-Loft-Session", cfg.Session)
	request.Header.Set("X-Comfy-Loft-Bridge", cfg.Version)

	response, err := client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("cannot reach the gateway at %s (%v) — it is not running, or it restarted and this bridge belongs to the previous one", cfg.Endpoint, err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 64<<20))
	if err != nil {
		return nil, err
	}
	if response.StatusCode/100 != 2 {
		return nil, fmt.Errorf("the gateway refused the call: %s: %s", response.Status, strings.TrimSpace(string(body)))
	}
	if len(bytes.TrimSpace(body)) == 0 {
		return nil, errors.New("the gateway answered with an empty body")
	}
	return body, nil
}

// requestID reads the id out of a message and reports whether an answer is expected.
//
// A message that cannot be parsed counts as a request: the gateway owns the protocol and answers a broken
// line with `-32700`, and that answer is worth relaying. What must not happen is a message being dropped
// because the bridge did not recognise it.
func requestID(message []byte) (json.RawMessage, bool) {
	var envelope struct {
		ID json.RawMessage `json:"id"`
	}
	if err := json.Unmarshal(message, &envelope); err != nil {
		return nil, true
	}
	if len(envelope.ID) == 0 || string(envelope.ID) == "null" {
		return nil, false
	}
	return envelope.ID, true
}

// errorReply is one JSON-RPC error line. `-32603` is "internal error" and is the honest one here: the
// bridge could not complete the call, and -32601/-32602 would claim the request was at fault.
func errorReply(id json.RawMessage, err error) []byte {
	if len(id) == 0 {
		id = json.RawMessage("null")
	}
	reply, marshalErr := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"error":   map[string]any{"code": -32603, "message": err.Error()},
	})
	if marshalErr != nil {
		return []byte(`{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"the bridge could not describe its own failure"}}` + "\n")
	}
	return append(reply, '\n')
}

// lineWriter serialises whole answers. Concurrent requests may finish in any order; their bytes may not
// be mixed.
type lineWriter struct {
	mu  sync.Mutex
	out io.Writer
}

func (w *lineWriter) write(line []byte) {
	w.mu.Lock()
	defer w.mu.Unlock()
	_, _ = w.out.Write(append(bytes.TrimSpace(line), '\n'))
}
