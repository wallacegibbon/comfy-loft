# Known issues

Open problems, verified against the current tree. Each entry says what breaks, why, and what the fix
is, so nobody has to rediscover it. Fixes that only need a command are written out as commands.

Fixed entries are not kept here: they are in [`decisions.md`](decisions.md), which is where the reason
for the fix lives. The last section lists the ones this file used to carry.

---

## 1. H3 prompt rewrites come back in English, because the skill says to

**Symptom** The panel asks the agent for a Chinese rewrite — `…输出语言：中文。…`, composed in
`optimizePrompt` — and the prompt that comes back is English.

**State** Not undiagnosed any more, and not the model's doing: `prompts/skills/h3-prompt-writing/SKILL.md`
says, under *Output Rules*, "Write rewrite sections in English; preserve dialogue, lyrics, and visible
scene text in their original language." That skill's `description` is exactly this job — "Write MiniMax H3
video generation prompts …" — so the rewrite happens under a rule that says English while the request says
Chinese, and the more specific instruction wins. The setting behind the request has no control either:
`promptOptimizeLanguage` defaults to `"zh"` in `use-config-store.ts` and nothing on screen sets it, so the
ask is Chinese for everyone who has not hand-edited a settings document. The symptom itself was reproduced
on a local `qwen3.8-27b` with thinking disabled in the model's `model.conf`; the skill's rule was not
removed to measure the difference.

**Fix to decide** One of the two has to go, and the English rule may be the right one —
`references/base-en.txt` and `references/ref-en.txt` are the guides the skill tells the agent to follow,
and H3 may simply write better English. If so, the whole `输出语言` clause leaves `optimizePrompt` (and
`optimizeImagePrompt`, which carries the same clause), and `promptOptimizeLanguage` goes with it. If the
language is worth having, the change is that line of the skill, the setting needs a control, and the
guides' quality is what has to be re-measured.

**Where** `frontend/src/components/canvas/canvas-node-prompt-panel.tsx`,
`frontend/src/stores/use-config-store.ts` (`promptOptimizeLanguage`),
`prompts/skills/h3-prompt-writing/SKILL.md`.

---

## 2. Interpolating a silent clip fails inside VHS

**Symptom** `video-rife` on a clip with no audio track fails with `VHS failed to extract audio`.

**Cause** The graph wires the source's audio into the output node: `VHS_VideoCombine.audio` is `["1", 2]`,
the audio output of `VHS_LoadVideo` (`workflows/video-rife.json`). A clip with no audio stream has nothing
there, and VHS fails rather than combining silently. Both shipped H3 graphs — the source of every clip the
canvas makes itself — wire audio the same way, which is why this only bites an imported or trimmed silent
clip.

**Fix to decide** Detach the audio input when the source has no audio stream, at the cost of never carrying
audio through the interpolation. The media plan is declared in `registry.json` (`video-rife`), so this is an
`accepts`/binding question rather than a code branch.

---

## 3. Radix hides the page from assistive tech while a focused button sits in it

**Symptom** Opening a confirmation (`kit/confirm`, which is radix's `AlertDialog`) over a button that
currently has focus logs a browser warning. Verified on the current build from the agent panel's *Clear
history* button (the config page the entry used to name no longer exists):

```
Blocked aria-hidden on an element because its descendant retained focus. …
Element with focus: <button.ml-auto rounded p-1 …>
Ancestor with aria-hidden: <div.flex h-dvh overflow-hidden bg-background text-foreground>
```

**Cause** `@radix-ui/react-dialog@1.1.15` calls `aria-hidden@1.2.6`'s `hideOthers` when a modal layer
opens, and does it before focus has moved into the layer. Chrome therefore blocks the attribute — which is
the outcome we want; the page stays readable — and warns. Not specific to one call site: both `confirm({…})`
calls (stopping a generation, clearing the agent history) do it, because the focus is still on the trigger.

**Effect right now** None that a user can see: the dialog is operable and focus lands in it. The warning is
once per open and only in the console.

**Fix** Either upgrade radix once it uses `inert` instead of `aria-hidden` for `hideOthers`, or move focus
into the dialog from the trigger's `onPointerDown`. Not done: both are larger than the symptom, and #33
records the decision to leave it.

---

## 4. Narrower test coverage than it looks: `internal/logx` has no test

`internal/logx` has no `_test.go`: it formats a timestamp, a level and a message, and nothing else in the
package is worth a test. It is covered indirectly (every other test's output goes through it), which is
the reason it has stayed this way.

---

## 5. A few strings stay Chinese in the source, on purpose — and they are data, not copy

Every string of *UI copy* goes through `t()`. What is still written in Chinese in the source is 68 lines
across ten files, and each one is data a model reads, data the gateway's own output is parsed by, or a
comment quoting a string that lives in data:

| Lines | File | What it is |
| --- | --- | --- |
| 45 | `lib/resource-copy-zh.ts` | the resource catalogue's Chinese, keyed by id — data, not a component's copy |
| 10 | `components/canvas/canvas-node-prompt-panel.tsx` | the rewrite instructions sent to the agent (`输出语言：…`, the H3 task types, the caption request) |
| 5 | `lib/canvas/agent-references.ts` | the `【画布引用】` marker the citation block is built from, and the Chinese examples the comment quotes |
| 2 | `components/canvas/canvas-node-moss-layout-dialog.tsx` | the caption prefix and regex the MOSS workflow parses |
| 1 | `services/api/prompts.ts` | the `PromptOptimizeMode` union, as a type |
| 1 | `components/layout/user-status-actions.tsx` | the endonym on the language switcher |
| 1 | `components/canvas/sent-prompt-disclosure.tsx` | a comment quoting the `【文本1】` marker the canvas builds |
| 1 | `lib/canvas/node-title.ts` | a comment quoting the titles old blobs hold (`图片`), which is why `titleKey` exists |
| 1 | `stores/use-config-store.ts` | a comment quoting a channel name a Chinese UI would have saved (`本地 ComfyUI`) |
| 1 | `components/canvas/canvas-agent-panel.tsx` | a comment quoting `图片` as an example of a node's own title |

**Why these are not a violation** #17 asks for user-visible copy to live in the dictionaries. Three rows
are input rather than output: the prompt panel's instructions and `PromptOptimizeMode` are what a model and
the gateway are asked with (#9), and the MOSS prefix and its regex are an agreement about the shape of the
gateway's own output. An endonym is a language written in the language it names, which is what every
language switcher does. Five rows are comments, each quoting a string that lives in data — `图片`,
`【文本1】`, `本地 ComfyUI`, the `【画布引用】` marker — because that is the only way to explain one without
the reader having to guess which Chinese is meant. The tenth looks like a violation and is not:
`resource-copy-zh.ts` is the catalogue's Chinese, and the catalogue is English data (#66, #67); the map is
keyed by resource id exactly as `gateway-labels.ts` holds workflow labels (#20), with
`tests/resource-copy-zh.test.ts` keeping the two in step.

**Not verified** The residual risk is a raw key or a `zh` fallback in a surface nobody clicked through. The
DOM scan covers every route in both locales; dialogs, drawers and context menus are opened by hand and are
not exhaustive.

---

## 6. The Go half has no "nothing calls this" gate, and thirteen exported symbols are in that state

The canvas rejects an export nobody imports (`scripts/check-exports.cjs`, #37, #41), and `tsc` catches an
unused local. The Go half has neither, so a function whose last caller a refactor removed stays behind as a
promise with no promisee — and one of them still carries a doc comment that describes the system as it was.
Measured against the current tree, counting every reference outside comments and outside the declaration
itself, tests included (so "0" means the test suite does not use it either):

| Symbol | Where | What it still says |
| --- | --- | --- |
| `Client.Queue` | `internal/comfy/client.go` | reads ComfyUI's `/queue`; nothing polls it |
| `WithAudioTimeout`, `WithGatewayPort`, `WithMaxImportBytes`, `WithPublicBaseURL` | `internal/config/config.go` | `config.Load` options no caller and no test passes |
| `WriteJSONError` | `internal/httpx/httpx.go` | "for middleware that has no `*Error`" — no middleware uses it |
| `Manager.DerivedDependencies` | `internal/resource/derive.go` | "the single source of truth for a workflow's dependency list"; the status path calls the private `entryDeps` it wraps |
| `Manager.IsAvailable`, `Manager.ModelCandidates` | `internal/setup/setup.go` | the verdict is read through `WorkflowStatus`, and replacements through the resource panel's own path |
| `MainModels.Snapshot` | `internal/store/preferences.go` | "for diagnostics"; nothing asks |
| `NormalizeModelPath` | `internal/workflow/helpers.go` | "exposes … for callers comparing model names"; the callers use the private helper |
| `ReadGraphFile` | `internal/workflow/registry.go` | `Registry.readGraph` is the one that runs |
| `Store.OutputPath` (+ `withinOutput`, `within`) | `internal/task/task.go` | only `task_test.go` calls it — artifacts are served from the canvas's `files/` since #156 |
| `Hub.promptByRequest` | `internal/generate/preview.go` | written on every prompt and reaped with its progress record, never read — a field, not an export |

Thirteen exported functions and methods, two private helpers only `OutputPath` uses, and one map field:
sixteen names in all, and the reason they are worth a table rather than a line is that Go cannot be asked
the question. `staticcheck` reports unused *unexported* code and nothing else, so an exported function is
invisible to every check this repository runs.

**Fix to decide** Delete them, or add the missing gate. Deleting `OutputPath` also takes four assertions in
`task_test.go` with it, and those tests are about reconciliation (the record is repaired at load), not about
path building, so they can be rewritten against `Files()`/`Read`. A gate would be a small check in the
`Makefile` that fails on an exported Go identifier with no reference outside its own file — the Go
counterpart of `check-exports.cjs`, and cheaper than the table above getting longer.

**Not a candidate, deliberately** `GET /api/runs` has no frontend caller and is not dead: `docs/protocol.md`
publishes it as part of the run protocol ("listed in `GET /api/runs`"), and a documented contract is not
obliged to have the one client this repository ships.

---

## Fixed, and where the reason is

Evidence for the SeedVR2 import failure (#113) still describes the general rule — a vendored pack must
import only what it ships — but the pack and the workflow it served are gone as of #123.

- **Old 10-bit HEVC clips played audio only** — `data/outputs` no longer exists at all (#156: a run's
  artifacts are files in the canvas that asked for them), and both shipped video graphs write
  `video/h264-mp4` with `pix_fmt: yuv420p`. The guard that fails the build when a re-export breaks that is
  `internal/workflow/browser_playback_test.go` (`TestShippedVideoWorkflowsAreBrowserPlayable`).
- **"Restart needed" for a missing custom node**, and **the inverted "canvas entry" tag** — labels fixed in
  #48.
- **Corrupt persisted state destroyed what it could not read** — #49. The three things this bullet used to
  name (`preserveUnreadable`, the recovery banner, `tests/persist-migration.test.ts`) went with the browser
  store in #154: a canvas is a file on disk now, so there is no local state to repair, and an unreadable
  document is an error the gateway reports.
- **The repo was not formatted with its own Prettier config** — `npm run format` once, and
  `format:check` is a gate; #50.
- **Thirteen routes with no caller, the one-shot agent path, the heartbeat, the unused locals and
  translation keys** — #107–#109, #114, by hand. `#115`'s three gates are the *frontend's* (`tsc` over
  `tests/`, `check-exports`, `check-i18n`); the Go half still has none, which is #6 above.
- **Chinese prose in the plugin subtree** — the subtree is gone: the plugin mechanism, its SDK and
  its packages were removed in #148, and the one node it carried is now a built-in with its strings in
  the dictionaries like everything else.
- **The agent panel's size was the session's, not the canvas's** — #207: `open`, `position` and `size`
  are fields of `canvas.json`, written through the save queue and restored with the viewport, so a
  reload or another machine opens the panel where the person left it.
