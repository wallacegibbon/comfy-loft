package server

// The gateway's single execution path. Everything that produces media is submitted here,
// queued on the task store, and then read back by its id. The HTTP routes above this file
// only translate their request shape into a runSpec and decide how to answer.

import (
	"context"
	"net/http"

	"comfyloft/internal/generate"
	"comfyloft/internal/httpx"
	"comfyloft/internal/task"
	"comfyloft/internal/workflow"
)

// runSpec is one validated generation, ready to be queued.
//
// Everything is already resolved here: the entry, the workflow context built from the
// request, and the timeout. Keeping the queue in one place is what makes a run outlive the
// HTTP request that started it — the reason audio no longer blocks a connection for minutes.
type runSpec struct {
	Canvas    string
	Object    string
	Entry     *workflow.Entry
	Context   *workflow.Context
	TimeoutMs int
	RequestID string
	Request   map[string]any
	// Ask is the agent that asked for this run, or nil. It travels with the record so the end of the run
	// can be said to whoever is waiting for it, however long that takes (#225).
	Ask *task.Ask
}

// submitRun queues one run and returns its record. The record's id is the caller's handle.
func (s *Server) submitRun(spec runSpec) *task.Task {
	stored := s.tasks.Create(spec.Canvas, spec.Object, spec.Entry.Name, spec.Request, spec.Ask)
	s.tasks.Enqueue(stored, func(_ *task.Task, progress func(task.Update), jobCtx context.Context) (*task.Result, error) {
		opts := generate.RunOptions{
			Entry:          spec.Entry,
			Context:        spec.Context,
			RequestID:      spec.RequestID,
			LoraCatalog:    s.setup.LoraNames(),
			ModelAliasFor:  s.setup.ModelAliasFor,
			TimeoutMs:      spec.TimeoutMs,
			PollIntervalMs: s.cfg.PollIntervalMs,
			OnProgress: func(event generate.ProgressEvent) {
				progress(task.Update{Progress: event.Progress, PromptID: event.PromptID})
			},
		}

		var (
			result *generate.RunResult
			err    error
		)
		switch spec.Object {
		case task.ObjectVideo:
			result, err = s.runner.RunVideo(jobCtx, opts)
		case task.ObjectAudio:
			result, err = s.runner.RunAudio(jobCtx, opts)
		case task.ObjectImage:
			result, err = s.runner.RunImage(jobCtx, opts)
		default:
			return nil, httpx.Errorf(http.StatusBadRequest, "unsupported_run_object",
				"runs producing %q are not implemented yet", spec.Object)
		}
		if err != nil {
			return nil, err
		}
		return filesResult(spec.Object, result)
	})
	return stored
}

// defaultObjectExt is only a fallback: the real extension comes from the file itself.
func defaultObjectExt(object string) string {
	switch object {
	case task.ObjectAudio:
		return "mp3"
	case task.ObjectImage:
		return "png"
	case task.ObjectText:
		return "txt"
	default:
		return "mp4"
	}
}

// resumeInterruptedRuns picks up the runs the gateway was watching when it stopped.
//
// A task that was submitted and has a prompt id is handed back to the queue with a job that only collects:
// ComfyUI has been rendering it all along, so nothing is submitted again and no GPU time is paid twice. The
// task is marked `Resumed`, which is what tells the canvas there will be no progress to show (#236).
//
// Anything else the restart found is left alone: a task with no prompt id was never submitted, and the store
// has already failed it with the reason.
func (s *Server) resumeInterruptedRuns() {
	for _, stored := range s.tasks.List() {
		if !stored.Resumed || stored.PromptID == nil || *stored.PromptID == "" {
			continue
		}
		if stored.Status != "running" && stored.Status != "queued" {
			continue
		}
		promptID := *stored.PromptID
		object := stored.Object
		// By id: `List` hands out snapshots, and enqueuing one of those would run the job against a copy —
		// writing the output file while the record the canvas reads stayed `running` for ever.
		resumed := s.tasks.Resume(stored.ID, func(_ *task.Task, progress func(task.Update), jobCtx context.Context) (*task.Result, error) {
			opts := generate.RunOptions{
				TimeoutMs:      s.runTimeout(object),
				PollIntervalMs: s.cfg.PollIntervalMs,
				OnProgress: func(event generate.ProgressEvent) {
					progress(task.Update{Progress: event.Progress})
				},
			}
			result, err := s.runner.Collect(jobCtx, promptID, opts)
			if err != nil {
				return nil, err
			}
			return filesResult(object, result)
		})
		if resumed == nil {
			s.logger.Warn("run %s vanished before it could be resumed", stored.ID)
			continue
		}
		s.logger.Info("run %s resumed after a restart (prompt %s)", stored.ID, promptID)
	}
}
