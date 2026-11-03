package task

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"comfyloft/internal/logx"
)

// testCanvas is the canvas every task in these tests writes into.
const testCanvas = "40e8afb47f10"

func newStore(t *testing.T) *Store {
	t.Helper()
	dir := t.TempDir()
	files := filepath.Join(dir, "files")
	if err := os.MkdirAll(files, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	store, err := New(Options{
		DataDir:       dir,
		FilesDirFor:   func(string) (string, error) { return files, nil },
		PublicBaseURL: "http://127.0.0.1:8190",
		Logger:        logx.NewWithWriter("test", os.Stderr),
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	// Close stops the debounced writer before t.TempDir removal runs; without it the
	// pending persist races with the teardown.
	t.Cleanup(store.Close)
	return store
}

// waitFor polls until the condition holds or the deadline passes.
func waitFor(t *testing.T, what string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

// A panic inside a run is that run's failure, not the server's.
//
// Go has no per-goroutine recovery: an unrecovered panic in the worker kills the process, taking every
// canvas and every other run with it. The run executes graph- and request-shaped data, so it is the place
// this can happen, and the queue has to survive it and go on to the next task.
func TestAPanickingRunFailsItsTaskAndTheQueueCarriesOn(t *testing.T) {
	store := newStore(t)

	first := store.Create(testCanvas, ObjectImage, "image-boom", map[string]any{"prompt": "x"}, nil)
	store.Enqueue(first, func(_ *Task, _ func(Update), _ context.Context) (*Result, error) {
		panic("a workflow the code did not expect")
	})
	waitFor(t, "the panicking run to fail", func() bool { return store.Get(first.ID).Status == "failed" })

	failed := store.Get(first.ID)
	if failed.Error == nil || !strings.Contains(*failed.Error, "panicked") {
		t.Errorf("error = %v, want it to say the run panicked", failed.Error)
	}

	// The queue is still alive: the next task runs to completion.
	second := store.Create(testCanvas, ObjectImage, "image-after", map[string]any{"prompt": "y"}, nil)
	store.Enqueue(second, func(_ *Task, _ func(Update), _ context.Context) (*Result, error) {
		return &Result{Outputs: []ResultFile{{Buffer: []byte("PNG"), Ext: "png", MimeType: "image/png"}}}, nil
	})
	waitFor(t, "the next run to complete", func() bool { return store.Get(second.ID).Status == "completed" })
}

func TestTaskCompletesAndPersists(t *testing.T) {
	store := newStore(t)
	created := store.Create(testCanvas, ObjectVideo, "video-test", map[string]any{"prompt": "x"}, nil)
	if created.Status != "queued" {
		t.Fatalf("initial status = %q, want queued", created.Status)
	}

	store.Enqueue(created, func(_ *Task, progress func(Update), _ context.Context) (*Result, error) {
		progress(Update{Progress: 0.5, PromptID: "p1"})
		return &Result{Outputs: []ResultFile{{Buffer: []byte("VIDEO"), Ext: "mp4", MimeType: "video/mp4"}}, PromptID: "p1"}, nil
	})

	waitFor(t, "completion", func() bool { return store.Get(created.ID).Status == "completed" })

	done := store.Get(created.ID)
	if done.File == nil || !fileExists(*done.File) {
		t.Fatalf("output file was not written: %v", done.File)
	}
	if done.URL == nil || *done.URL == "" {
		t.Error("expected a public URL")
	}
	if done.Bytes != int64(len("VIDEO")) {
		t.Errorf("bytes = %d, want %d", done.Bytes, len("VIDEO"))
	}

	path := store.OutputPath(testCanvas, created.ID, 0)
	if path == "" {
		t.Fatal("ContentPath returned empty for a completed task")
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "VIDEO" {
		t.Errorf("content = %q, err = %v", data, err)
	}

	// A fresh store must reconcile the persisted record rather than mark it failed.
	reloaded, err := New(Options{
		DataDir:       filepath.Dir(filepath.Dir(*done.File)),
		FilesDirFor:   func(string) (string, error) { return filepath.Dir(*done.File), nil },
		PublicBaseURL: "http://127.0.0.1:8190",
		Logger:        logx.NewWithWriter("test", os.Stderr),
	})
	if err != nil {
		t.Fatalf("reload New: %v", err)
	}
	t.Cleanup(reloaded.Close)
	reloaded.Load()
	if got := reloaded.Get(created.ID); got == nil || got.Status != "completed" {
		t.Errorf("reloaded status = %v, want completed", got)
	}
}

func TestTaskFailureIsRecorded(t *testing.T) {
	store := newStore(t)
	created := store.Create(testCanvas, ObjectVideo, "video-test", nil, nil)
	store.Enqueue(created, func(_ *Task, _ func(Update), _ context.Context) (*Result, error) {
		return nil, errors.New("boom")
	})

	waitFor(t, "failure", func() bool { return store.Get(created.ID).Status == "failed" })

	failed := store.Get(created.ID)
	if failed.Error == nil || *failed.Error != "boom" {
		t.Errorf("error = %v, want boom", failed.Error)
	}
	if failed.CompletedAt == nil {
		t.Error("completedAt should be set on failure")
	}
}

func TestCancelQueuedTask(t *testing.T) {
	store := newStore(t)

	// Occupy the single worker so the second task stays queued.
	blocker := make(chan struct{})
	first := store.Create(testCanvas, ObjectVideo, "video-test", nil, nil)
	store.Enqueue(first, func(_ *Task, _ func(Update), _ context.Context) (*Result, error) {
		<-blocker
		return &Result{Outputs: []ResultFile{{Buffer: []byte("A"), Ext: "mp4"}}}, nil
	})
	waitFor(t, "first task running", func() bool { return store.Get(first.ID).Status == "running" })

	second := store.Create(testCanvas, ObjectVideo, "video-test", nil, nil)
	store.Enqueue(second, func(_ *Task, _ func(Update), _ context.Context) (*Result, error) {
		return &Result{Outputs: []ResultFile{{Buffer: []byte("B"), Ext: "mp4"}}}, nil
	})
	waitFor(t, "second task queued", func() bool { return store.Get(second.ID).Status == "queued" })

	if cancelled := store.Cancel(second.ID); cancelled == nil || cancelled.Status != "cancelled" {
		t.Fatalf("cancel result = %v", cancelled)
	}

	close(blocker)
	waitFor(t, "first task completion", func() bool { return store.Get(first.ID).Status == "completed" })
	if got := store.Get(second.ID).Status; got != "cancelled" {
		t.Errorf("second status = %q, want cancelled", got)
	}
}

func TestCancelRunningTaskAbortsContext(t *testing.T) {
	store := newStore(t)
	created := store.Create(testCanvas, ObjectVideo, "video-test", nil, nil)
	aborted := make(chan struct{})

	store.Enqueue(created, func(_ *Task, _ func(Update), ctx context.Context) (*Result, error) {
		<-ctx.Done()
		close(aborted)
		return nil, ctx.Err()
	})
	waitFor(t, "task running", func() bool { return store.Get(created.ID).Status == "running" })

	// The cancel is reported immediately, not only after the worker unwinds.
	if cancelled := store.Cancel(created.ID); cancelled == nil || cancelled.Status != "cancelled" {
		t.Errorf("immediate status = %v, want cancelled", cancelled)
	}

	select {
	case <-aborted:
	case <-time.After(3 * time.Second):
		t.Fatal("cancelling a running task must cancel its context")
	}
	waitFor(t, "cancelled status", func() bool { return store.Get(created.ID).Status == "cancelled" })
}

func TestCleanupRespectsLimits(t *testing.T) {
	store := newStore(t)

	// Both limits at zero means "keep everything": that is the documented default,
	// so cleanup must be a no-op rather than wiping the history.
	keep := store.Create(testCanvas, ObjectVideo, "video-test", nil, nil)
	store.Enqueue(keep, func(_ *Task, _ func(Update), _ context.Context) (*Result, error) {
		return &Result{Outputs: []ResultFile{{Buffer: []byte("KEEP"), Ext: "mp4"}}}, nil
	})
	waitFor(t, "first completion", func() bool { return store.Get(keep.ID).Status == "completed" })

	if removed, files := store.Cleanup(0, 0); removed != 0 || files != 0 {
		t.Fatalf("cleanup(0,0) = %d/%d, want 0/0", removed, files)
	}

	// With maxTasks=1, the oldest terminal task record is pruned. Its file stays: it belongs to the
	// canvas, and whether anything still shows it is the canvas's answer to give (#156).
	extra := store.Create(testCanvas, ObjectVideo, "video-test", nil, nil)
	store.Enqueue(extra, func(_ *Task, _ func(Update), _ context.Context) (*Result, error) {
		return &Result{Outputs: []ResultFile{{Buffer: []byte("EXTRA"), Ext: "mp4"}}}, nil
	})
	waitFor(t, "second completion", func() bool { return store.Get(extra.ID).Status == "completed" })
	// Guarantee distinct completion timestamps so "oldest" is unambiguous.
	time.Sleep(2 * time.Millisecond)

	removed, filesDeleted := store.Cleanup(0, 1)
	if removed != 1 || filesDeleted != 0 {
		t.Fatalf("cleanup(0,1) = removed %d, files %d; want 1/0", removed, filesDeleted)
	}
	if _, err := os.Stat(*keep.File); err != nil {
		t.Errorf("pruning a task deleted a file its canvas still owns: %v", err)
	}
	// Retention keeps the newest task, so the first one is the one that goes.
	if store.Get(keep.ID) != nil {
		t.Error("the oldest task should have been pruned")
	}
	if store.Get(extra.ID) == nil {
		t.Error("the newest task must be retained")
	}
	if len(store.List()) != 1 {
		t.Errorf("remaining tasks = %d, want 1", len(store.List()))
	}
}

func TestContentPathRejectsEscapingFile(t *testing.T) {
	store := newStore(t)
	created := store.Create(testCanvas, ObjectVideo, "video-test", nil, nil)

	// Simulate a corrupted record pointing outside the output directory.
	outside := filepath.Join(t.TempDir(), "secret.mp4")
	if err := os.WriteFile(outside, []byte("secret"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	created.File = &outside

	if got := store.OutputPath(testCanvas, created.ID, 0); got != "" {
		t.Errorf("ContentPath = %q, want empty for a path outside the output dir", got)
	}
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

// The queue used to assume video everywhere: object, fallback MIME type and the file
// extension reconciliation looks for. An audio run has to persist the same way.
func TestAudioTaskStoresMp3AndReconciles(t *testing.T) {
	store := newStore(t)
	created := store.Create(testCanvas, ObjectAudio, "audio-test", nil, nil)
	store.Enqueue(created, func(_ *Task, _ func(Update), _ context.Context) (*Result, error) {
		return &Result{Outputs: []ResultFile{{Buffer: []byte("MP3"), Ext: "mp3", MimeType: "audio/mpeg"}}}, nil
	})

	waitFor(t, "audio completion", func() bool { return store.Get(created.ID).Status == "completed" })
	done := store.Get(created.ID)
	if done.MimeType == nil || *done.MimeType != "audio/mpeg" {
		t.Errorf("mime = %v, want audio/mpeg", done.MimeType)
	}
	if done.File == nil || filepath.Ext(*done.File) != ".mp3" {
		t.Fatalf("file = %v, want a .mp3 path", done.File)
	}
	if done.Object != ObjectAudio {
		t.Errorf("object = %v, want audio", done.Object)
	}

	// A record that never stored its path (older format) must be found by extension, in its canvas.
	orphan := &Task{ID: "task_orphan", Canvas: testCanvas, Object: ObjectAudio, Status: "queued"}
	dir, err := store.filesDirFor(testCanvas)
	if err != nil {
		t.Fatalf("filesDirFor: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "task_orphan.flac"), []byte("FLAC"), 0o644); err != nil {
		t.Fatalf("write orphan: %v", err)
	}
	store.reconcileLocked(orphan)
	if orphan.Status != "completed" {
		t.Errorf("orphan status = %q, want completed", orphan.Status)
	}
	if orphan.MimeType != nil {
		t.Errorf("reconciled record invented a mime type: %v", *orphan.MimeType)
	}
}

// The queue must persist the structured failure, not only the message: an adapter (and
// later a run reader) needs the code, and callers must not have to parse English.
func TestTaskFailureKeepsCodeAndDetails(t *testing.T) {
	store := newStore(t)
	created := store.Create(testCanvas, ObjectAudio, "audio-test", nil, nil)
	store.Enqueue(created, func(_ *Task, _ func(Update), _ context.Context) (*Result, error) {
		return nil, &codedTestError{code: "comfy_execution_failed", message: "boom", details: map[string]any{"node": "35"}}
	})

	waitFor(t, "coded failure", func() bool { return store.Get(created.ID).Status == "failed" })
	done := store.Get(created.ID)
	if done.Error == nil || *done.Error != "boom" {
		t.Fatalf("error = %v", done.Error)
	}
	if done.ErrorCode == nil || *done.ErrorCode != "comfy_execution_failed" {
		t.Errorf("errorCode = %v", done.ErrorCode)
	}
	if details, ok := done.ErrorDetails.(map[string]any); !ok || details["node"] != "35" {
		t.Errorf("errorDetails = %v", done.ErrorDetails)
	}
	if done.ErrorStatus != 400 {
		t.Errorf("errorStatus = %d, want the reporter's 400", done.ErrorStatus)
	}
}

type codedTestError struct {
	code    string
	message string
	details any
}

func (e *codedTestError) Error() string       { return e.message }
func (e *codedTestError) FailureCode() string { return e.code }
func (e *codedTestError) FailureDetails() any { return e.details }
func (e *codedTestError) StatusCode() int     { return 400 }

// A batch image request stores every artifact, in order, and the first one keeps the legacy
// single-file fields so an older client still finds it.
func TestTaskStoresEveryOutput(t *testing.T) {
	store := newStore(t)
	created := store.Create(testCanvas, ObjectImage, "image-test", nil, nil)
	store.Enqueue(created, func(_ *Task, _ func(Update), _ context.Context) (*Result, error) {
		return &Result{Outputs: []ResultFile{
			{Buffer: []byte("ONE"), Ext: "png", MimeType: "image/png"},
			{Buffer: []byte("TWO"), Ext: "png", MimeType: "image/png"},
		}}, nil
	})

	waitFor(t, "batch completion", func() bool { return store.Get(created.ID).Status == "completed" })
	done := store.Get(created.ID)
	if len(done.Outputs) != 2 {
		t.Fatalf("outputs = %d, want 2", len(done.Outputs))
	}
	for index, want := range []string{"ONE", "TWO"} {
		path := store.OutputPath(testCanvas, created.ID, index)
		if path == "" {
			t.Fatalf("output %d has no path", index)
		}
		data, err := os.ReadFile(path)
		if err != nil || string(data) != want {
			t.Errorf("output %d = %q, err = %v", index, data, err)
		}
	}
	if done.File == nil || *done.File != done.Outputs[0].File {
		t.Errorf("legacy File does not mirror the first output")
	}
	if store.OutputPath(testCanvas, created.ID, 5) != "" {
		t.Error("an out-of-range index returned a path")
	}
	if len(done.Outputs) != 2 {
		t.Errorf("outputs = %v", done.Outputs)
	}
}

// reports collects what the finish hook was told, from whichever goroutine said it.
type reports struct {
	mu   sync.Mutex
	seen []*Task
}

func (r *reports) sink(finished *Task) {
	r.mu.Lock()
	r.seen = append(r.seen, finished)
	r.mu.Unlock()
}

func (r *reports) all() []*Task {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]*Task(nil), r.seen...)
}

// of is the reports there are about one run.
func (r *reports) of(id string) []*Task {
	var found []*Task
	for _, report := range r.all() {
		if report.ID == id {
			found = append(found, report)
		}
	}
	return found
}

// The end of a run reaches whoever asked for it, with the record as it stands and the ask intact — the
// session that called `generate` and the node it asked about (#225).
//
// Every run is reported, including one no agent asked for: who is interested in a run is the hook's
// business, and the store's job is to say that it ended.
func TestTheEndOfARunIsReported(t *testing.T) {
	store := newStore(t)
	reported := &reports{}
	store.SetOnFinish(reported.sink)

	ask := &Ask{Session: "canvas:40e8afb47f10", Node: "n12"}
	worked := store.Create(testCanvas, ObjectImage, "image-test", map[string]any{"prompt": "a cat"}, ask)
	store.Enqueue(worked, func(_ *Task, _ func(Update), _ context.Context) (*Result, error) {
		return &Result{Outputs: []ResultFile{{Buffer: []byte("PNG"), Ext: "png", MimeType: "image/png"}}}, nil
	})
	waitFor(t, "the report of a run that worked", func() bool { return len(reported.of(worked.ID)) == 1 })

	report := reported.of(worked.ID)[0]
	if report.Status != "completed" {
		t.Errorf("reported status = %q, want completed", report.Status)
	}
	if report.Ask == nil || report.Ask.Session != ask.Session || report.Ask.Node != "n12" {
		t.Errorf("ask = %+v, want the session and node that asked", report.Ask)
	}
	if len(report.Outputs) != 1 {
		t.Errorf("outputs = %v, want the artifact the run wrote", report.Outputs)
	}

	// A failure is an ending too, and it is reported with the reason the run gave.
	broken := store.Create(testCanvas, ObjectVideo, "video-test", nil, &Ask{Session: "canvas:other"})
	store.Enqueue(broken, func(_ *Task, _ func(Update), _ context.Context) (*Result, error) {
		return nil, errors.New("the model refused")
	})
	waitFor(t, "the report of a failure", func() bool { return len(reported.of(broken.ID)) == 1 })
	failed := reported.of(broken.ID)[0]
	if failed.Status != "failed" || failed.Error == nil || *failed.Error != "the model refused" {
		t.Errorf("reported failure = %+v", failed)
	}

	// A run nobody asked about is still reported: the hook decides who to tell.
	plain := store.Create(testCanvas, ObjectAudio, "audio-test", nil, nil)
	store.Enqueue(plain, func(_ *Task, _ func(Update), _ context.Context) (*Result, error) {
		return &Result{Outputs: []ResultFile{{Buffer: []byte("MP3"), Ext: "mp3", MimeType: "audio/mpeg"}}}, nil
	})
	waitFor(t, "the report of a run the user started", func() bool { return len(reported.of(plain.ID)) == 1 })
	if ask := reported.of(plain.ID)[0].Ask; ask != nil {
		t.Errorf("a run the user started named an asker: %+v", ask)
	}
}

// A cancelled run is reported once, whoever ended it: the cancel itself for a job the queue never reached,
// and only once for the run the worker then unwinds.
func TestACancelledRunIsReportedOnce(t *testing.T) {
	store := newStore(t)
	reported := &reports{}
	store.SetOnFinish(reported.sink)

	// One worker, held: the next run stays queued, so its cancel has no worker to report it.
	blocker := make(chan struct{})
	var release sync.Once
	releaseBlocker := func() { release.Do(func() { close(blocker) }) }
	t.Cleanup(releaseBlocker)
	holding := store.Create(testCanvas, ObjectImage, "image-test", nil, nil)
	store.Enqueue(holding, func(_ *Task, _ func(Update), _ context.Context) (*Result, error) {
		<-blocker
		return &Result{Outputs: []ResultFile{{Buffer: []byte("A"), Ext: "png"}}}, nil
	})
	waitFor(t, "the worker to be busy", func() bool { return store.Get(holding.ID).Status == "running" })

	queued := store.Create(testCanvas, ObjectImage, "image-test", nil, &Ask{Session: "canvas:x", Node: "n1"})
	store.Enqueue(queued, func(_ *Task, _ func(Update), _ context.Context) (*Result, error) {
		return &Result{Outputs: []ResultFile{{Buffer: []byte("B"), Ext: "png"}}}, nil
	})
	waitFor(t, "the second run to be queued", func() bool { return store.Get(queued.ID).Status == "queued" })
	store.Cancel(queued.ID)
	waitFor(t, "the queued cancel to be reported", func() bool { return len(reported.of(queued.ID)) == 1 })
	if status := reported.of(queued.ID)[0].Status; status != "cancelled" {
		t.Errorf("reported status = %q, want cancelled", status)
	}

	// A cancel that lands mid-run: the worker unwinds afterwards and must not report it again.
	releaseBlocker()
	waitFor(t, "the held run to finish", func() bool { return store.Get(holding.ID).Status == "completed" })
	running := store.Create(testCanvas, ObjectVideo, "video-test", nil, &Ask{Session: "canvas:x", Node: "n2"})
	store.Enqueue(running, func(_ *Task, _ func(Update), ctx context.Context) (*Result, error) {
		<-ctx.Done()
		return nil, ctx.Err()
	})
	waitFor(t, "the third run to start", func() bool { return store.Get(running.ID).Status == "running" })
	store.Cancel(running.ID)
	waitFor(t, "the cancel to be reported", func() bool { return len(reported.of(running.ID)) == 1 })
	// The worker needs a moment to finish unwinding; it would be the second report.
	time.Sleep(50 * time.Millisecond)
	if got := len(reported.of(running.ID)); got != 1 {
		t.Errorf("reports for one cancelled run = %d, want 1", got)
	}
}

// The ask lives on the run record, which is on disk — so a server that comes back to a run it started
// still knows who was waiting. Nothing is reported for a record it merely found there: the agent that
// asked went with the process, and a restart is not an ending anybody is left to hear about.
func TestTheAskIsOnTheRecordAndAReplayedOneReportsNobody(t *testing.T) {
	dir := t.TempDir()
	files := filepath.Join(dir, "files")
	if err := os.MkdirAll(files, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	options := Options{
		DataDir:       dir,
		FilesDirFor:   func(string) (string, error) { return files, nil },
		PublicBaseURL: "http://127.0.0.1:8190",
		Logger:        logx.NewWithWriter("test", os.Stderr),
	}

	first, err := New(options)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	created := first.Create(testCanvas, ObjectImage, "image-test", nil, &Ask{Session: "canvas:a", Node: "n12"})
	first.PersistNow()
	first.Close()

	reloaded, err := New(options)
	if err != nil {
		t.Fatalf("reload New: %v", err)
	}
	t.Cleanup(reloaded.Close)
	reported := &reports{}
	reloaded.SetOnFinish(reported.sink)
	reloaded.Load()

	replayed := reloaded.Get(created.ID)
	if replayed == nil {
		t.Fatal("the run did not come back from the task index")
	}
	if replayed.Ask == nil || replayed.Ask.Session != "canvas:a" || replayed.Ask.Node != "n12" {
		t.Errorf("ask = %+v, want the session and node that asked", replayed.Ask)
	}
	time.Sleep(20 * time.Millisecond)
	if got := len(reported.of(created.ID)); got != 0 {
		t.Errorf("a run found on disk reported itself %d time(s)", got)
	}
}

// A run that was out when the server stopped is not a run that failed.
//
// The render belongs to ComfyUI and did not stop because this process did, so the record keeps its prompt id
// and comes back marked `Resumed` for the server to re-attach to. A task that never got a prompt id was
// never submitted — there is nothing to pick up, and saying so is the honest answer (#236).
func TestARestartKeepsASubmittedTaskAndFailsAnUnsubmittedOne(t *testing.T) {
	store := newStore(t)
	submitted := store.Create(testCanvas, ObjectVideo, "video-test", map[string]any{"prompt": "x"}, nil)
	store.Enqueue(submitted, func(_ *Task, progress func(Update), ctx context.Context) (*Result, error) {
		progress(Update{Progress: 0.3, PromptID: "p_kept"})
		<-ctx.Done() // still rendering when the process goes away
		return nil, ctx.Err()
	})
	waitFor(t, "prompt id", func() bool { return store.Get(submitted.ID).PromptID != nil })

	// A second task that was queued behind it and never submitted.
	unsubmitted := store.Create(testCanvas, ObjectImage, "image-test", map[string]any{"prompt": "y"}, nil)
	if unsubmitted.Status != "queued" {
		t.Fatalf("initial status = %q, want queued", unsubmitted.Status)
	}

	store.Close()
	store = reopen(t, store)
	store.Load()

	kept := store.Get(submitted.ID)
	if kept == nil {
		t.Fatal("the submitted task disappeared")
	}
	if !kept.Resumed {
		t.Error("a submitted task must come back marked Resumed")
	}
	if kept.Status != "running" && kept.Status != "queued" {
		t.Errorf("status = %q, want it left alone for the server to re-attach", kept.Status)
	}
	if kept.PromptID == nil || *kept.PromptID != "p_kept" {
		t.Errorf("prompt id = %v, want p_kept", kept.PromptID)
	}

	dropped := store.Get(unsubmitted.ID)
	if dropped == nil {
		t.Fatal("the unsubmitted task disappeared")
	}
	if dropped.Status != "failed" {
		t.Errorf("unsubmitted status = %q, want failed", dropped.Status)
	}

	// Resuming runs the job against the record the store serves, not against the snapshot the caller is
	// holding: a copy would write the output file and leave the task `running` for ever (#236).
	if resumed := store.Resume(kept.ID, func(_ *Task, _ func(Update), _ context.Context) (*Result, error) {
		return &Result{Outputs: []ResultFile{{Buffer: []byte("VIDEO"), Ext: "mp4", MimeType: "video/mp4"}}, PromptID: "p_kept"}, nil
	}); resumed == nil {
		t.Fatal("Resume returned nil for a task the store holds")
	}
	waitFor(t, "resumed completion", func() bool { return store.Get(kept.ID).Status == "completed" })
}

func reopen(t *testing.T, store *Store) *Store {
	t.Helper()
	dir := store.dataDir
	files := filepath.Join(dir, "files")
	reopened, err := New(Options{
		DataDir:       dir,
		FilesDirFor:   func(string) (string, error) { return files, nil },
		PublicBaseURL: "http://127.0.0.1:8190",
		Logger:        logx.NewWithWriter("test", os.Stderr),
	})
	if err != nil {
		t.Fatalf("reopen New: %v", err)
	}
	t.Cleanup(reopened.Close)
	return reopened
}
