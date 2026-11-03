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

## 2. Radix hides the page from assistive tech while a focused button sits in it

**Symptom** Opening a confirmation (`kit/confirm`, radix's `AlertDialog`) over the trigger that has focus logs
`Blocked aria-hidden on an element because its descendant retained focus` once per open, in the console only.

**Cause** `@radix-ui/react-dialog` calls `aria-hidden`'s `hideOthers` as the modal layer opens, before focus
has moved into it, and Chrome refuses the attribute — which is the outcome we want, since the page stays
readable.

**Fix to decide** Upgrade radix once it uses `inert` for `hideOthers`, or move focus into the dialog from the
trigger's `onPointerDown`. #33 records leaving it alone.

---

## 3. The Go half has no "nothing calls this" gate, and thirteen exported symbols have no caller

The canvas fails on an export nobody imports (`scripts/check-exports.cjs`) and `tsc` fails on an unused local.
Neither has a Go counterpart, so an exported function whose last caller a refactor removed stays behind:

`Queue` (`internal/comfy`), `WithAudioTimeout` / `WithGatewayPort` / `WithMaxImportBytes` /
`WithPublicBaseURL` (`internal/config`), `WriteJSONError` (`internal/httpx`), `DerivedDependencies`
(`internal/resource` — its comment still calls it "the single source of truth for a workflow's dependency
list"), `IsAvailable` / `ModelCandidates` (`internal/setup`), `Snapshot` (`internal/store`),
`NormalizeModelPath` (`internal/workflow/helpers.go`), `ReadGraphFile` (`internal/workflow/registry.go`),
`OutputPath` and the two helpers only it uses (`internal/task`). `Hub.promptByRequest` (`internal/generate`)
is written and never read.

**Fix to decide** Delete them, or add a check to `make check` that fails on an exported Go identifier with no
reference outside its own file.

---

## 4. A few strings stay Chinese in the source, because they are data

UI copy goes through `t()`, and so do comments (#216). What is left is 60 lines in six files, every one of
them a value rather than prose:

| Lines | File | What it is |
| --- | --- | --- |
| 45 | `lib/resource-copy-zh.ts` | the resource catalogue's Chinese, keyed by id: `resources.json` is English data (#66, #67) |
| 10 | `components/canvas/canvas-node-prompt-panel.tsx` | the instructions sent to the agent: the H3 task types, the two rewrite prompts (`输出语言：…` belongs to the image one), the caption request |
| 2 | `components/canvas/canvas-node-moss-layout-dialog.tsx` | the caption prefix and regex the MOSS workflow parses |
| 1 | `lib/canvas/agent-references.ts` | `MARKERS`: the citation marker in both languages, so a message reads back after a UI language switch |
| 1 | `services/api/prompts.ts` | the `PromptOptimizeMode` union, as a type |
| 1 | `components/layout/user-status-actions.tsx` | the endonym on the language switcher |
