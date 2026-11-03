# Known issues

Open problems, verified against the current tree. Each entry says what breaks, why, and what the fix is,
so nobody has to rediscover it. Only a defect belongs here: a fix, and the reason it was chosen, live in
[`decisions.md`](decisions.md), and an entry leaves this file the moment it stops being one.

---

## 1. Interpolating a silent clip fails inside VHS

**Symptom** `video-rife` fails with `VHS failed to extract audio` when the clip has no audio track.

**Cause** `VHS_VideoCombine.audio` is `["1", 2]`, the audio output of `VHS_LoadVideo`
(`workflows/video-rife.json`). A silent source leaves nothing there to combine. Both H3 graphs wire audio the
same way and always produce it, so this only bites an imported or trimmed clip.

**Fix to decide** Detach the audio input when the source has no audio stream, at the cost of never carrying
audio through the interpolation. The media plan is declared in `registry.json` (`video-rife`), so this is an
`accepts`/binding question rather than a code branch.

---

## 2. The Go half has no "nothing calls this" gate, and thirteen exported symbols have no caller

The canvas fails on an export nobody imports (`scripts/check-exports.cjs`) and `tsc` fails on an unused local.
Neither has a Go counterpart, so an exported function whose last caller a refactor removed stays behind:

`Queue` (`internal/comfy`), `WithAudioTimeout` / `WithServerPort` / `WithMaxImportBytes` /
`WithPublicBaseURL` (`internal/config`), `WriteJSONError` (`internal/httpx`), `DerivedDependencies`
(`internal/resource` — its comment still calls it "the single source of truth for a workflow's dependency
list"), `IsAvailable` / `ModelCandidates` (`internal/setup`), `Snapshot` (`internal/store`),
`NormalizeModelPath` (`internal/workflow/helpers.go`), `ReadGraphFile` (`internal/workflow/registry.go`),
`OutputPath` and the two helpers only it uses (`internal/task`). `Hub.promptByRequest` (`internal/generate`)
is written and never read.

**Fix to decide** Delete them, or add a check to `make check` that fails on an exported Go identifier with no
reference outside its own file.
