# Known issues

Open problems, verified against the current tree. Each entry says what breaks, why, and what the fix
is, so nobody has to rediscover it. Fixes that only need a command are written out as commands.

Fixed entries are not kept here: they are in [`decisions.md`](decisions.md), which is where the reason
for the fix lives. The last section lists the ones this file used to carry.

---

## 1. H3 video prompts ignore the requested output language

**Symptom** The prompt asks for Chinese (`输出语言：字段正文全部使用中文`) and the generated prompt still
comes back in English.

**State** Reproduced on a local `qwen3.8-27b` endpoint with thinking disabled in the model's `model.conf`:
the instruction is in the request, and it is not followed. Not diagnosed beyond that — either the model
ignores it or the H3 skill does not carry enough weight.

**Next step** Ask through the agent socket (`GET /api/agent/socket/{session}`, `?history=1` for a panel's
conversation) and read the frame log (`agent << SM`, `agent >> UX`): the instruction is in the prompt, so
the difference between the two outcomes is the skill's wording. The fix belongs in
`prompts/skills/h3-prompt-writing/`, which is the agent's to load.

---

## 2. Interpolating a silent clip fails inside VHS

**Symptom** `video-rife` on a clip with no audio track fails with `VHS failed to extract audio`. Clips the
canvas produces always carry audio; an imported or trimmed silent clip does not.

**Fix to decide** Detach the audio input when the source has no audio stream, at the cost of never carrying
audio through the interpolation. `sourceVideoFrames` and the rest of the media plan are declared in
`registry.json` (`video-rife`), so this is a `accepts`/binding question, not a code branch.

---

## 3. Radix hides the page from assistive tech while a focused button sits in it

**Symptom** Opening a confirmation (`kit/confirm`, radix's `AlertDialog`) over a button that currently has
focus logs a browser warning:

```
Blocked aria-hidden on an element because its descendant retained focus.
Element with focus: <button ... border-red-300 ...>        (the danger button that was clicked)
Ancestor with aria-hidden: <div class="flex h-dvh ...">
```

**Cause** Radix sets `aria-hidden` on the rest of the document when a modal layer opens, and does it before
focus has moved into the layer. Chrome therefore blocks the attribute (which is the outcome we want — the
page stays readable) and warns. Reproduced from the config page's delete buttons; not specific to one call
site.

**Effect right now** None that a user can see: the dialog is operable and focus lands in it. The warning is
once per open and only in the console.

**Fix** Either upgrade radix once it uses `inert` instead of `aria-hidden` for `hideOthers`, or move focus
to the dialog's cancel button in `onPointerDown` of the trigger. Not done: both are larger than the symptom.

---

## 4. Narrower test coverage than it looks: `internal/logx` has no test

`internal/logx` has no `_test.go`: it formats a timestamp, a level and a message, and nothing else in the
package is worth a test. It is covered indirectly (every other test's output goes through it), which is
the reason it has stayed this way.

`internal/setup` and `internal/sysinfo` were in this entry with it and no longer belong here — both have
direct tests now (`paths_test.go`, `scan_test.go`, `sysinfo_test.go`).

---

## 5. A few strings stay Chinese in the source, on purpose — and they are data, not copy

Every string of *UI copy* goes through `t()`. What is still written in Chinese in the source is a short
list, and each line is data the gateway or the agent parses rather than text a user reads:

| Lines | File | What it is |
| --- | --- | --- |
| 10 | `components/canvas/canvas-node-prompt-panel.tsx` | the `PromptOptimizeMode` values sent to the agent |
| 5 | `lib/canvas/agent-references.ts` | the `【画布引用】` marker the citation block is built from, and the Chinese examples the comment quotes |
| 2 | `components/canvas/canvas-node.tsx` | mascot slogans, printed beside their own English line |
| 2 | `components/canvas/canvas-node-moss-layout-dialog.tsx` | the caption prefix/regex the MOSS workflow parses |
| 1 | `lib/canvas/node-title.ts` | the old default titles the migration recognises (`图片`, `音频`, …), quoted in the comment that explains it |
| 1 | `services/api/prompts.ts` | the same `PromptOptimizeMode` union, as a type |
| 1 | `components/layout/user-status-actions.tsx` | the endonym on the language switcher |
| 45 | `lib/resource-copy-zh.ts` | the resource panel's **Chinese copy**, kept beside the panel by #67 |

**Why these are not a violation** #17 asks for user-visible copy to live in the dictionaries. The protocol
values are fields the gateway matches or feeds to a workflow (#9); the MOSS regex and prefix are an
agreement about the shape of the gateway's output; the mascot slogans are set in a CJK font stack and
printed next to their own English line, so translating them would show the sentence twice; a language name
is written in the language it names; and the migration titles are strings *stored in old blobs*, which is
the whole reason they are recognised. `resource-copy-zh.ts` is not copy that escaped: #67 decided the
resource panel's Chinese lives beside it as data, and `tests/resource-copy-zh.test.ts` keeps the two
languages in step.

**Not verified** The residual risk is a raw key or a `zh` fallback in a surface nobody clicked through. The
DOM scan covers every route in both locales; dialogs, drawers and context menus are opened by hand and are
not exhaustive.

---

## 6. The agent panel's size is the session's, not the canvas's

**Symptom** Drag the agent panel's corner to a size that suits the canvas, reload, and it opens at the
default share of the window again. Export the canvas, open it on another machine, and the size is not there
either — which is the part that matters: a canvas is worked on away from the machine that made it, and how
much of the screen the panel takes is a property of *that canvas's* work.

**State** Deliberate, and documented as such: `frontend/src/stores/canvas/use-canvas-agent-store.ts` keeps
`size` and `position` in memory, and its doc comment argues that "where a panel sits is the window's
business, not the canvas's … no place in the project blob, in an export, or in the undo history". That
argument holds for `position` and not for `size`, which is the split this entry is about.

**Fix to decide** Persist the size, in the canvas:

- `size` goes into `CanvasDocument` (`frontend/src/services/api/canvases.ts`), which is what `canvas.json`
  holds and what an export's zip carries (#152, #172), so it arrives with the canvas on any machine.
  `viewport` is the precedent: view state that belongs to the document rather than to the window.
- `position` stays out. A pixel position is about the screen the canvas is on; a width and a height are about
  the canvas.
- `null` keeps meaning "the default share" (`Math.min(520, roomWidth - 24)`), and the read path keeps the
  existing clamp (`320 … host - 16`), or a canvas sized on a 2560px screen opens wider than a 1280px window.
- Write on pointer-up, not on every pointer-move, and keep it out of the undo history: resizing a panel is
  not a document edit, the same way moving the view is not.
- Amend that store's doc comment when this lands. It argues the opposite today, and a comment that
  contradicts the code is worse than no comment.

---

---

## Fixed, and where the reason is

Evidence for the SeedVR2 import failure (#113) still describes the general rule — a vendored pack must
import only what it ships — but the pack and the workflow it served are gone as of #123.

- **Old 10-bit HEVC clips played audio only** — the two files this entry named are no longer in
  `data/outputs`, and the three H3 workflows have written `h264` / `yuv420p` since then; the guard is
  `internal/workflow/browser_playback_test.go`.
- **"Restart needed" for a missing custom node**, and **the inverted "canvas entry" tag** — labels fixed in
  #48.
- **Corrupt persisted state destroyed what it could not read** — `preserveUnreadable`, the recovery banner
  and the per-project migration; #49 and `tests/persist-migration.test.ts`.
- **The repo was not formatted with its own Prettier config** — `npm run format` once, and
  `format:check` is a gate; #50.
- **Thirteen routes with no caller, the one-shot agent path, the heartbeat, the unused locals and
  translation keys** — #107–#109, #114. The gates that let them live (#115) now fail on the next one.
- **Chinese prose in the plugin subtree** (#6) — the subtree is gone: the plugin mechanism, its SDK and
  its packages were removed in #148, and the one node it carried is now a built-in with its strings in
  the dictionaries like everything else.
