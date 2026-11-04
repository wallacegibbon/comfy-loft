package generate

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"comfyloft/internal/comfy"
	"comfyloft/internal/httpx"
	"comfyloft/internal/logx"
	"comfyloft/internal/workflow"
)

// loraGraph is a UNETLoader feeding a sampler, which is the shape LoRA injection
// has to handle.
func loraGraph() workflow.Graph {
	return workflow.Graph{
		"1": map[string]any{
			"class_type": "UNETLoader",
			"inputs":     map[string]any{"unet_name": "model.safetensors"},
		},
		"8": map[string]any{
			"class_type": "KSampler",
			"inputs":     map[string]any{"model": []any{"1", 0}, "steps": 8.0},
		},
		"9": map[string]any{
			"class_type": "SaveImage",
			"inputs":     map[string]any{"images": []any{"8", 0}},
		},
	}
}

func TestApplyLoraChainSplicesLoader(t *testing.T) {
	graph := loraGraph()
	params := map[string]any{
		"loras": []any{
			map[string]any{"name": "H3/turbo.safetensors", "strength": 0.8},
		},
	}

	result, applied, err := ApplyLoraChain(graph, params, LoraOptions{})
	if err != nil {
		t.Fatalf("ApplyLoraChain: %v", err)
	}
	if len(applied) != 1 {
		t.Fatalf("applied = %d, want 1", len(applied))
	}

	// The sampler must now read from the LoRA node, not the raw loader.
	sampler, _ := result.NodeAt("8")
	link, ok := sampler.Inputs()["model"].([]any)
	if !ok || len(link) != 2 {
		t.Fatalf("sampler model input = %v, want a link", sampler.Inputs()["model"])
	}
	loraID, _ := link[0].(string)
	loraNode, ok := result.NodeAt(loraID)
	if !ok {
		t.Fatalf("LoRA node %q missing", loraID)
	}
	if loraNode.ClassType() != "LoraLoaderModelOnly" {
		t.Errorf("class = %q", loraNode.ClassType())
	}
	if got := loraNode.Inputs()["lora_name"]; got != "H3/turbo.safetensors" {
		t.Errorf("lora_name = %v", got)
	}
	if got := loraNode.Inputs()["strength_model"]; got != 0.8 {
		t.Errorf("strength = %v", got)
	}

	// The source graph must be untouched.
	original, _ := graph.NodeAt("8")
	originalLink := original.Inputs()["model"].([]any)
	if originalLink[0] != "1" {
		t.Error("the source graph was mutated")
	}
}

func TestApplyLoraChainChainsMultiple(t *testing.T) {
	params := map[string]any{
		"loras": []any{
			map[string]any{"name": "a.safetensors", "strength": 1.0},
			map[string]any{"name": "b.safetensors", "strength": 0.5},
		},
	}
	result, applied, err := ApplyLoraChain(loraGraph(), params, LoraOptions{})
	if err != nil {
		t.Fatalf("ApplyLoraChain: %v", err)
	}
	if len(applied) != 2 {
		t.Fatalf("applied = %d, want 2", len(applied))
	}

	// The second LoRA must consume the first one's output.
	second, _ := result.NodeAt(applied[1].ID)
	link := second.Inputs()["model"].([]any)
	if link[0] != applied[0].ID {
		t.Errorf("second LoRA reads from %v, want %v", link[0], applied[0].ID)
	}
}

func TestApplyLoraChainSkipsDisabled(t *testing.T) {
	params := map[string]any{
		"loras": []any{
			map[string]any{"name": "off.safetensors", "enabled": false},
			map[string]any{"name": "on.safetensors"},
		},
	}
	_, applied, err := ApplyLoraChain(loraGraph(), params, LoraOptions{})
	if err != nil {
		t.Fatalf("ApplyLoraChain: %v", err)
	}
	if len(applied) != 1 || applied[0].Name != "on.safetensors" {
		t.Errorf("applied = %+v, want only on.safetensors", applied)
	}
}

func TestApplyLoraChainRejectsForeignLora(t *testing.T) {
	params := map[string]any{
		"loras": []any{map[string]any{"name": "other-family/anime.safetensors"}},
	}
	_, _, err := ApplyLoraChain(loraGraph(), params, LoraOptions{Filter: `H3|minimax`})
	if err == nil {
		t.Fatal("expected a rejection for a LoRA outside the workflow's family")
	}
	var appErr *httpx.Error
	if !errors.As(err, &appErr) || appErr.Code != "lora_injection_failed" {
		t.Fatalf("got %v, want lora_injection_failed", err)
	}
}

func TestApplyLoraChainRejectsMissingFile(t *testing.T) {
	params := map[string]any{"loras": []any{map[string]any{"name": "nope.safetensors"}}}
	_, _, err := ApplyLoraChain(loraGraph(), params, LoraOptions{
		Available: []string{"present.safetensors"},
	})
	if err == nil {
		t.Fatal("expected a rejection for an uninstalled LoRA")
	}
}

func TestApplyLoraChainNoLorasIsIdentity(t *testing.T) {
	graph := loraGraph()
	result, applied, err := ApplyLoraChain(graph, map[string]any{}, LoraOptions{})
	if err != nil {
		t.Fatalf("ApplyLoraChain: %v", err)
	}
	if len(applied) != 0 {
		t.Errorf("applied = %d, want 0", len(applied))
	}
	if len(result) != len(graph) {
		t.Errorf("graph size changed from %d to %d", len(graph), len(result))
	}
}

func TestApplyLoraChainWithoutModelLoaderFails(t *testing.T) {
	graph := workflow.Graph{
		"9": map[string]any{"class_type": "SaveImage", "inputs": map[string]any{}},
	}
	params := map[string]any{"loras": []any{map[string]any{"name": "x.safetensors"}}}
	_, _, err := ApplyLoraChain(graph, params, LoraOptions{})
	if err == nil {
		t.Fatal("expected an error when no model loader exists")
	}
}

func TestFindModelSourcePrefersConsumedUnetLoader(t *testing.T) {
	graph := workflow.Graph{
		"1": map[string]any{"class_type": "CheckpointLoaderSimple", "inputs": map[string]any{"ckpt_name": "c.safetensors"}},
		"2": map[string]any{"class_type": "UNETLoader", "inputs": map[string]any{"unet_name": "u.safetensors"}},
		"8": map[string]any{"class_type": "KSampler", "inputs": map[string]any{"model": []any{"2", 0}}},
	}
	if got := findModelSource(graph, ""); got != "2" {
		t.Errorf("source = %q, want 2 (the loader that is actually consumed)", got)
	}
	if got := findModelSource(graph, "1"); got != "1" {
		t.Errorf("explicit source was not honored: %q", got)
	}
}

func TestEstimateStepPlan(t *testing.T) {
	graph := workflow.Graph{
		"8": map[string]any{"class_type": "KSampler", "inputs": map[string]any{"steps": 8.0}},
		"9": map[string]any{"class_type": "KSamplerAdvanced", "inputs": map[string]any{
			"steps": 20.0, "start_at_step": 10.0, "end_at_step": 20.0,
		}},
	}
	plan := EstimateStepPlan(graph)
	if plan.Total != 18 {
		t.Errorf("total = %d, want 8 + 10 = 18", plan.Total)
	}
	if plan.Steps["8"] != 8 || plan.Steps["9"] != 10 {
		t.Errorf("per-node steps = %v", plan.Steps)
	}
}

func TestEstimateStepPlanSelfLiftIsAbsolute(t *testing.T) {
	graph := workflow.Graph{
		"10": map[string]any{"class_type": "BasicScheduler", "inputs": map[string]any{"steps": 4.0}},
		"20": map[string]any{"class_type": "SelfLiftH3Sampler", "inputs": map[string]any{
			"sigmas": []any{"10", 0},
		}},
	}
	plan := EstimateStepPlan(graph)
	if !plan.Absolute["20"] {
		t.Error("SelfLift reports a global step index and must be marked absolute")
	}
	if plan.Total != 4 {
		t.Errorf("total = %d, want 4", plan.Total)
	}
}

// SaveAudio / SaveAudioAdvanced report under "audio", a key the collector used to skip;
// without it an audio workflow looks like it produced nothing at all.
func TestCollectOutputFilesIncludesAudio(t *testing.T) {
	history := map[string]any{
		"outputs": map[string]any{
			"35": map[string]any{
				"audio": []any{
					map[string]any{"filename": "canvas_minimax_music3_00001_.mp3", "subfolder": "audio", "type": "output"},
				},
			},
		},
	}
	files := collectOutputFiles(history, false)
	if len(files) != 1 {
		t.Fatalf("files = %d, want 1", len(files))
	}
	if files[0].Filename != "canvas_minimax_music3_00001_.mp3" || files[0].Type != "output" {
		t.Errorf("collected %+v", files[0])
	}
}

func TestIsAudioExtension(t *testing.T) {
	cases := map[string]bool{
		"song.mp3":  true,
		"song.FLAC": true,
		"song.opus": true,
		"song.wav":  true,
		"song.mp4":  false,
		"song.png":  false,
	}
	for name, want := range cases {
		if got := isAudioExtension(name); got != want {
			t.Errorf("isAudioExtension(%q) = %v, want %v", name, got, want)
		}
	}
}

// A poll that could not be made is not an answer: ComfyUI going away for a moment leaves the render where it
// was, so the watch waits for it to come back instead of failing the task (#234).
func TestWaitForHistoryOutlivesAnOutage(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) <= 2 {
			// Down: no answer at all, which is what a restart looks like from here.
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"p1":{"status":{"completed":true,"status_str":"success"},"outputs":{"9":{"images":[{"filename":"a.png","subfolder":"","type":"output"}]}}}}`))
	}))
	t.Cleanup(server.Close)

	client := newComfyClient(t, server.URL)
	runner := NewRunner(client, nil, logx.NewWithWriter("test", io.Discard), 5000, 1)

	history, err := runner.waitForHistory(t.Context(), "p1", 5000, 1)
	if err != nil {
		t.Fatalf("waitForHistory: %v", err)
	}
	if history == nil {
		t.Fatal("history is nil: the completed answer was not passed on")
	}
	if calls.Load() < 3 {
		t.Fatalf("asked %d times, want at least 3: the outage was not waited through", calls.Load())
	}
}

// A ComfyUI that is gone is not a render that is coming: the watch waits out a blip, and then says so.
//
// Without this the task stays running until a ceiling hours away, and an agent that pressed generate holds
// its turn open for a message that will not come until then (#285).
func TestWaitForHistoryGivesUpOnAComfyUIThatNeverComesBack(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	t.Cleanup(server.Close)

	client := newComfyClient(t, server.URL)
	runner := NewRunner(client, nil, logx.NewWithWriter("test", io.Discard), 600_000, 1)
	runner.unreachableBudget = 20 * time.Millisecond

	_, err := runner.waitForHistory(t.Context(), "p1", 600_000, 1)
	if err == nil {
		t.Fatal("waitForHistory: want an error for a ComfyUI that never answered, got nil")
	}
	if !strings.Contains(err.Error(), "could not be reached") || !strings.Contains(err.Error(), "cannot be watched to its end") {
		t.Fatalf("error = %v, want the silence named as the reason", err)
	}
	// The run's own timeout is ten minutes away: the budget is what ended this, not the ceiling.
	if strings.Contains(err.Error(), "timed out") {
		t.Fatalf("error = %v, want the unreachable budget rather than the timeout", err)
	}
}

// A refusal will get the same answer next time, so it ends the task at once rather than burning the timeout.
func TestWaitForHistoryFailsFastOnARefusal(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":"bad graph"}`))
	}))
	t.Cleanup(server.Close)

	client := newComfyClient(t, server.URL)
	runner := NewRunner(client, nil, logx.NewWithWriter("test", io.Discard), 5000, 1)

	if _, err := runner.waitForHistory(t.Context(), "p1", 5000, 1); err == nil {
		t.Fatal("waitForHistory: want an error for a refusal, got nil")
	}
	// The client retries a GET a few times on a 5xx, but a 400 is not retried at all.
	if got := calls.Load(); got > 3 {
		t.Fatalf("asked %d times for a refusal, want at most 3", got)
	}
}

func newComfyClient(t *testing.T, url string) *comfy.Client {
	t.Helper()
	client, err := comfy.New(comfy.Options{
		BaseURL:       url,
		TimeoutMs:     5000,
		RetryAttempts: 1,
		RetryDelayMs:  1,
		Logger:        logx.NewWithWriter("test", io.Discard),
	})
	if err != nil {
		t.Fatalf("comfy.New: %v", err)
	}
	return client
}

// Collect re-attaches to a prompt ComfyUI is already working on: it asks, it collects, and it never submits.
// That is the whole point of a restart being survivable — the render was never ours to lose (#236).
func TestCollectReattachesWithoutSubmittingAnything(t *testing.T) {
	var submissions atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/history/"):
			_, _ = w.Write([]byte(`{"p1":{"status":{"completed":true,"status_str":"success"},"outputs":{"9":{"images":[{"filename":"a.png","subfolder":"","type":"output"}]}}}}`))
		case r.URL.Path == "/view":
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write([]byte("PNGDATA"))
		default:
			submissions.Add(1)
			w.WriteHeader(http.StatusTeapot)
		}
	}))
	t.Cleanup(server.Close)

	runner := NewRunner(newComfyClient(t, server.URL), nil, logx.NewWithWriter("test", io.Discard), 5000, 1)
	result, err := runner.Collect(context.Background(), "p1", RunOptions{TimeoutMs: 5000, PollIntervalMs: 1})
	if err != nil {
		t.Fatalf("Collect: %v", err)
	}
	if len(result.Files) != 1 || string(result.Files[0].Buffer) != "PNGDATA" {
		t.Fatalf("files = %d (%v), want the one ComfyUI produced", len(result.Files), result.Files)
	}
	if result.Files[0].MimeType != "image/png" {
		t.Errorf("mime = %q, want image/png from the view response", result.Files[0].MimeType)
	}
	if submissions.Load() != 0 {
		t.Errorf("Collect submitted %d workflows: a resumed run must not be submitted again", submissions.Load())
	}
}

// A prompt ComfyUI does not know is not collectable: the answer is a failure, honestly reported.
func TestCollectFailsWhenComfyUIHasNoSuchPrompt(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":"prompt not found"}`))
	}))
	t.Cleanup(server.Close)

	runner := NewRunner(newComfyClient(t, server.URL), nil, logx.NewWithWriter("test", io.Discard), 5000, 1)
	if _, err := runner.Collect(context.Background(), "gone", RunOptions{TimeoutMs: 5000, PollIntervalMs: 1}); err == nil {
		t.Fatal("Collect: want an error for a prompt ComfyUI does not know, got nil")
	}
}
