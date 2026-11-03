package mcpstdio

// The bridge, against a stand-in server.
//
// Everything here is about the two rules: stdout carries whole protocol lines and nothing else, and a
// request that cannot be answered still gets an answer. A silent bridge is the failure mode that costs
// the most time — AlayaCore simply never finishes its handshake — so most of these assert what comes
// back when things go wrong.

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// fakeServer is a loopback MCP endpoint that records what it was asked and answers with a canned body.
type fakeServer struct {
	*httptest.Server
	mu       sync.Mutex
	requests int
	sessions []string
	bridges  []string
	bodies   []string
	reply    func(w http.ResponseWriter, body string)
}

func newFakeServer(t *testing.T) *fakeServer {
	t.Helper()
	fake := &fakeServer{reply: func(w http.ResponseWriter, body string) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"jsonrpc":"2.0","id":1,"result":{"echo":`+quote(body)+`}}`)
	}}
	fake.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		fake.mu.Lock()
		fake.requests++
		fake.sessions = append(fake.sessions, r.Header.Get("X-Comfyloft-Session"))
		fake.bridges = append(fake.bridges, r.Header.Get("X-Comfyloft-Bridge"))
		fake.bodies = append(fake.bodies, string(body))
		fake.mu.Unlock()
		fake.reply(w, string(body))
	}))
	t.Cleanup(fake.Close)
	return fake
}

func quote(s string) string {
	raw, _ := json.Marshal(s)
	return string(raw)
}

// run feeds lines through the bridge and returns what it wrote, split into lines.
func run(t *testing.T, cfg Config, input string) []string {
	t.Helper()
	var out bytes.Buffer
	if err := Run(strings.NewReader(input), &out, cfg); err != nil {
		t.Fatalf("run: %v", err)
	}
	var lines []string
	scanner := bufio.NewScanner(&out)
	for scanner.Scan() {
		lines = append(lines, scanner.Text())
	}
	return lines
}

func TestRunForwardsTheSessionAndTheBridgeVersion(t *testing.T) {
	fake := newFakeServer(t)
	lines := run(t, Config{Endpoint: fake.URL, Session: "canvas:abc", Version: Version},
		`{"jsonrpc":"2.0","id":7,"method":"tools/list"}`+"\n")

	if len(lines) != 1 {
		t.Fatalf("wrote %d lines, want exactly one answer: %v", len(lines), lines)
	}
	if fake.sessions[0] != "canvas:abc" {
		t.Fatalf("X-Comfyloft-Session = %q, want the session the bridge was given", fake.sessions[0])
	}
	if fake.bridges[0] != Version {
		t.Fatalf("X-Comfyloft-Bridge = %q, want %q", fake.bridges[0], Version)
	}
	if !strings.Contains(fake.bodies[0], "tools/list") {
		t.Fatalf("server was sent %q, want the request unchanged", fake.bodies[0])
	}
}

func TestRunDropsTheAnswerToANotification(t *testing.T) {
	fake := newFakeServer(t)
	fake.reply = func(w http.ResponseWriter, _ string) { w.WriteHeader(http.StatusAccepted) }

	lines := run(t, Config{Endpoint: fake.URL, Session: "s", Version: Version},
		`{"jsonrpc":"2.0","method":"notifications/initialized"}`+"\n")

	if len(lines) != 0 {
		t.Fatalf("wrote %v for a notification, want nothing", lines)
	}
	if fake.requests != 1 {
		t.Fatalf("server saw %d requests, want the notification forwarded once", fake.requests)
	}
}

func TestRunTurnsAServerRefusalIntoAnAnswer(t *testing.T) {
	fake := newFakeServer(t)
	fake.reply = func(w http.ResponseWriter, _ string) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = io.WriteString(w, "comfyloft-mcp speaks bridge 2 and this server speaks 1")
	}

	lines := run(t, Config{Endpoint: fake.URL, Session: "s", Version: "2"},
		`{"jsonrpc":"2.0","id":"abc","method":"tools/call"}`+"\n")

	if len(lines) != 1 {
		t.Fatalf("wrote %v, want one line", lines)
	}
	var answer struct {
		ID    string `json:"id"`
		Error struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal([]byte(lines[0]), &answer); err != nil {
		t.Fatalf("answer %q is not JSON: %v", lines[0], err)
	}
	if answer.ID != "abc" {
		t.Fatalf("answer id = %q, want the request's", answer.ID)
	}
	if answer.Error.Code != -32603 {
		t.Fatalf("error code = %d, want -32603", answer.Error.Code)
	}
	if !strings.Contains(answer.Error.Message, "refused the call") || !strings.Contains(answer.Error.Message, "speaks bridge 2") {
		t.Fatalf("message = %q, want it to carry the server's own words", answer.Error.Message)
	}
}

func TestRunSaysWhenTheServerIsNotThere(t *testing.T) {
	// A port that was closed again: the bridge's normal failure after a server restart.
	dead := httptest.NewServer(http.NotFoundHandler())
	dead.Close()

	lines := run(t, Config{Endpoint: dead.URL, Session: "s", Version: Version},
		`{"jsonrpc":"2.0","id":1,"method":"initialize"}`+"\n")
	if len(lines) != 1 || !strings.Contains(lines[0], "cannot reach the server") {
		t.Fatalf("wrote %v, want one line that says the server is unreachable", lines)
	}
}

// TestRunForwardsWhatItCannotParse: the bridge is not a parser. It treats anything with no readable
// `id` as a request so an answer comes back, but the judgement about what a message means belongs to the
// server — which owns the protocol and already answers a broken line with -32700.
func TestRunForwardsWhatItCannotParse(t *testing.T) {
	fake := newFakeServer(t)
	fake.reply = func(w http.ResponseWriter, _ string) {
		_, _ = io.WriteString(w, `{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"parse error"}}`)
	}

	lines := run(t, Config{Endpoint: fake.URL, Session: "s", Version: Version}, "not json\n")
	if len(lines) != 1 || !strings.Contains(lines[0], "-32700") {
		t.Fatalf("wrote %v, want the server's parse error relayed", lines)
	}
	if fake.requests != 1 || fake.bodies[0] != "not json" {
		t.Fatalf("server saw %d requests (%v), want the line forwarded unchanged", fake.requests, fake.bodies)
	}
}

// TestRunKeepsAnswersWhole: MCP allows several requests in flight, so answers may arrive in any order —
// but two of them must never share a line, or the client parses one JSON object out of two.
func TestRunKeepsAnswersWhole(t *testing.T) {
	fake := newFakeServer(t)
	fake.reply = func(w http.ResponseWriter, body string) {
		_, _ = io.WriteString(w, fmt.Sprintf(`{"jsonrpc":"2.0","id":%s,"result":{"padding":%q}}`, bodyID(body), strings.Repeat("x", 4096)))
	}

	var input strings.Builder
	const count = 24
	for i := 0; i < count; i++ {
		fmt.Fprintf(&input, `{"jsonrpc":"2.0","id":%d,"method":"tools/list"}`+"\n", i)
	}
	lines := run(t, Config{Endpoint: fake.URL, Session: "s", Version: Version}, input.String())

	if len(lines) != count {
		t.Fatalf("wrote %d lines for %d requests", len(lines), count)
	}
	seen := map[string]bool{}
	for _, line := range lines {
		var answer struct {
			ID json.RawMessage `json:"id"`
		}
		if err := json.Unmarshal([]byte(line), &answer); err != nil {
			t.Fatalf("line is not one JSON object: %v", err)
		}
		if seen[string(answer.ID)] {
			t.Fatalf("id %s answered twice", answer.ID)
		}
		seen[string(answer.ID)] = true
	}
}

// bodyID pulls the id out of a request body so the fake can answer in kind.
func bodyID(body string) string {
	var envelope struct {
		ID json.RawMessage `json:"id"`
	}
	if err := json.Unmarshal([]byte(body), &envelope); err != nil || len(envelope.ID) == 0 {
		return "null"
	}
	return string(envelope.ID)
}
