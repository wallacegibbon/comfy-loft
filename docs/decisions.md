# Design decisions

Why the code looks the way it does. Each entry states the decision, the reason, and what it
costs — so a future change can be measured against the original intent instead of guessed.

Format is deliberately short: decision, why, consequences, where it lives.

**Paths are as the tree was when the entry was written.** Entries record a moment, and the tree has
moved since: the canvas frontend has been `canvas/web/`, then `canvas/` (#149), and is `frontend/`
today (`README.md`, Layout, is always the current tree). A path an entry names for something it
deleted is the path it was deleted from, which is the only one that ever existed.

---

## 1. The gateway is Go, built as a static binary with CGO disabled

**Decision** `gateway` is a single Go binary, `CGO_ENABLED=0`, `-trimpath -ldflags '-s -w'`.

**Why** The gateway is the one component the canvas cannot work without. A static binary
starts in milliseconds, cannot break because a transitive npm package changed, and needs no
runtime installed on the target machine. `make verify-static` fails the build if `ldd` ever
reports a dependency.

**Cost** No cgo libraries. The race detector needs cgo, so `make test-race` re-enables it for
the test binary only; the shipped binary stays static.

**Where** `Makefile`, `docs/server.md` (Why Go).

---

## 2. Zero third-party dependencies

**Decision** `go.mod` has no `require` block. The WebSocket client is hand-written
(`internal/comfy/ws.go`), archive extraction uses `archive/zip` and `archive/tar` +
`compress/gzip`.

**Why** Every dependency is a supply chain and a version constraint. The protocol surface this
gateway needs is small: RFC 6455 frames without extensions, and plain zip/tar.

**Cost** The WebSocket client implements only what ComfyUI sends (text frames, ping/pong,
close). Reconnect logic lives in the caller.

**Where** `go.mod`, `internal/comfy/ws.go`, `internal/resource/jobs.go` (`extractArchive`).

---

## 3. The Go module is the repository root

**Decision** `main.go`, `internal/`, `go.mod`, `Makefile` and the runtime assets (`workflows/`,
`resources.json`, `prompts/`) sit at the top level; the canvas frontend is a sibling subtree in
`frontend/`.

**Why** The repository _is_ a Go service with one vendored frontend. An extra `gateway/`
directory only made sense while a second, Node implementation lived next to it.

**Cost** `go build ./...` would walk `frontend/node_modules`, so the Makefile uses an
explicit package list (`./cmd/... ./internal/...`). Measured difference: `go vet` 0.64 s vs 0.89 s,
plus protection from a stray `.go` file inside an npm package.

**Where** `Makefile` (`PKGS`), `README.md` (Layout).

---

## 4. Workflow graphs stay generic JSON

**Decision** Graph files are `map[string]any` end to end. Typed accessors (`Node.ClassType()`,
`Node.Inputs()`) sit on top; nothing models individual node classes.

**Why** There are nineteen ComfyUI graphs carrying node classes this codebase will never know
about, and users add more. A typed model would have to be extended for every new node.

**Cost** Field access is by string, so typos are runtime errors. Mitigated by confining raw map
access to `internal/workflow`.

**Where** `internal/workflow/graph.go`.

---

## 5. Bindings keep their raw JSON

**Decision** A binding is a thin typed view (`Binding.raw`) over the object in `registry.json`.

**Why** `registry.json` is user-editable. A closed struct would silently drop unknown fields
the next time a workflow uses a newer binding option — a bug that only shows up as a missing
parameter in a generated request.

**Cost** Reading a field goes through accessors, and the type system cannot prove completeness.

**Where** `internal/workflow/bindings.go`.

---

## 6. Request-scoped copies only

**Decision** `ApplyBindings` and `ApplyLoraChain` clone the graph before mutating it; graphs
loaded from disk are treated as immutable.

**Why** The registry is shared across requests. Mutating a loaded graph means two concurrent
generations can see each other's parameters — an intermittent, hard-to-reproduce wrong-image
bug.

**Cost** One graph copy per request (a few hundred KB of JSON), which is irrelevant next to
inference time.

**Where** `internal/workflow/bindings.go`, `internal/generate/lora.go`.

---

## 7. Order-preserving maps for anything the UI renders in sequence

**Decision** `variants`, `variantLabels` and `bindings` use `workflow.OrderedMap`, not Go maps.

**Why** Go randomises map iteration. Those keys drive dropdown order, so a plain map would
reshuffle the canvas image-mode selector on every refresh.

**Cost** A small custom type instead of the builtin.

**Where** `internal/workflow/ordered.go`.

---

## 8. Backend messages are English; localization lives only in the frontend

**Decision** Log lines, error messages and warnings are English. Translation happens in
`canvas/web/src/i18n`. Error `code` values are stable identifiers
(`model_not_found`, `missing_reference_image`, …).

**Why** One backend, two UI languages. Translating backend text would mean shipping a locale to
a process whose only consumer is a dashboard, and would make logs unreadable in bug reports.

**Cost** The frontend has to map codes to copy; unmapped errors surface in English.

**Where** `internal/httpx`, `docs/server.md` (Language policy).

---

## 9. Model-facing Chinese stays Chinese

**Decision** The H3 writing instructions, image/caption system prompts, Chinese-matching
regexes (`图片N`, `正向|负向`) and ComfyUI protocol values (`文生视频(T2VA)` …) are not
translated.

**Why** They are input to a model or to ComfyUI, not text for a human. Translating the prompts
would change generation behaviour; translating the regexes would break parsing; the mode
strings are values the frontend sends and the backend matches.

**Cost** The codebase contains Chinese even though it is English-only by policy. Each such site
carries a comment saying so.

**Where** `internal/prompt/*`, `internal/workflow/infer.go`.

---

## 10. Job statuses and progress are a wire contract with the panel

**Decision** Install jobs speak exactly what the canvas panel expects:

```
job.status  : running | done | error | canceled
item.status : queued | downloading | verifying | copying | extracting | baking | done | error | skipped
job.progress: 0..100, weighted by bytes
```

**Why** The panel was written against these values: it renders byte counters and speed only for
`downloading`, stops polling only on `done`/`error`/`canceled`, and passes `progress` straight
to antd's `percent` prop. Sending `completed` or a 0..1 fraction leaves the bar empty forever —
which is exactly what happened once.

**Cost** The vocabulary is frozen by the frontend, and a single large file must move the bar
(hence byte weighting rather than finished-item counting).

**Where** `internal/resource/jobs.go` (`jobProgress`, item status transitions), `internal/resource/bake.go`.

---

## 11. The gateway installs nothing with pip

**Decision** Runtime Python packages are reported (`runtimeDeps` in `/api/resources/status`) and
the UI shows the exact command; the gateway never runs `pip install`.

**Why** The old implementation wrote into the ComfyUI venv and regularly broke it: wrong wheel
for the CUDA/Python/torch combination, installs that reported success but failed on import, and
torch/numpy overwritten underneath ComfyUI.

**Cost** One manual step for the user, and the panel must tell them precisely what to run.

**Where** `internal/resource/resource.go` (`RuntimeDep`), `docs/runtime-deps.md`.

---

## 12. Only three external binaries, everything else in-process

**Decision** `nvidia-smi` (GPU), `zenity` (file picker), `ffprobe` (video duration). Downloads,
verification, archive extraction and file copies all happen in Go.

**Why** A missing external tool used to be able to fail an install. Anything that can be done
in-process is done in-process; the three that remain wrap information only the OS/driver has.

**Cost** Each of the three must degrade with an actionable message when absent — which they do
(`zenity was not found; type the model's relative path instead …`).

**Where** `internal/sysinfo/sysinfo.go`, `internal/setup/setup.go`, `internal/server/server.go`.

---

## 13. `type: "bake"` resources are never installed

**Decision** A bake resource (a checkpoint merged from two others) is excluded from install
jobs. `/api/resources/status` exposes the command that produces it as `manualCommand`, and the
panel shows that command with a copy button.

**Why** Merging needs torch and produces ~10 GB; neither belongs inside an HTTP install
request. Including it in a job meant every MOSS-pack install finished with a guaranteed failure
and a misleading "run the merge inside ComfyUI" message.

**Cost** One documented manual step, and the command must stay correct as the script's flags
change — pinned by `internal/resource/bake_test.go`.

**Where** `internal/resource/bake.go`, `tools/bake-moss-preset.py`.

---

## 14. The asset root is discovered, not hardcoded

**Decision** `COMFYLOFT_SERVER_ROOT` → working directory → executable directory, accepting the first that
contains `workflows/registry.json` or `resources/index.json`.

**Why** The binary lives in `bin/`, which must not be mistaken for the asset root, and the
gateway is also started from the repository root by `start.sh`. A bare `workflows/` directory is
not enough of a marker — it produced a self-reinforcing wrong guess.

**Cost** Starting from an unrelated directory silently falls back to the working directory; if
that happens, state lands in `./data`.

**Where** `internal/config/config.go` (`resolveRootDir`).

---

## 15. Gates: `make check` must not need a C toolchain

**Decision** `make check` = gofmt check + `go vet` + tests (CGO off). `make check-full` adds
`-race` and therefore needs gcc. `make verify-static` asserts the binary is static.

**Why** The shipped binary must stay cgo-free, but the race detector is the only thing that
catches the concurrency bugs this code has actually had (shared task and job state read while a
worker mutates it).

**Cost** Two gates; contributors without gcc can still run the fast one.

**Where** `Makefile`.

---

## 16. The gateway never starts or stops ComfyUI

**Decision** ComfyUI is external: the gateway connects to `COMFY_URL` and reports when it is
unreachable. `start.sh` does not launch it either: ComfyUI may be on another machine, in a
container, or under a supervisor the user chose, so a start script that assumes it is local
would be wrong more often than right.

**Why** ComfyUI owns the GPU and is usually already running with a user's own configuration.
A gateway that restarts it would race with whatever the user is doing.

**Cost** "ComfyUI is not reachable" is a normal state the UI has to handle, not an error.

**Where** `internal/comfy/client.go`, `start.sh`, `README.md` (process table).

---

## 17. Everything written for a human is English

**Decision** Documentation, code comments, log lines, error messages and commit messages are
English. User-visible copy is not written in the source at all: it lives in the i18n
dictionaries (`canvas/web/src/i18n`) and is translated there. The two exceptions are
the ones already argued for: model-facing Chinese and protocol values (#9), and UI copy as
data (#8).

**Why** One prose language keeps `grep`, diffs, bug reports and commit history readable, and
the frontend is bilingual anyway — a Chinese string in a component is not "a Chinese UI", it
is a string that only ever renders in Chinese and cannot be reviewed by the half of the
audience that reads English. Writing the rule down is the only way to stop the next
contribution from adding one more.

**Cost** Chinese prose that predates the rule has to be translated (what is left, and why each line is
data rather than copy, is #216), and a reviewer has to reject inline copy even when it works in
the current UI language.

**Where** `README.md` (Language), `docs/server.md` (Language policy),
decisions #8, #9 and #216.

---

## 18. `@ant-design/pro-components` is dropped, not worked around

**Decision** The canvas does not depend on `@ant-design/pro-components`. `AppProviders`
wraps the tree in antd's `ConfigProvider` + `App` and nothing else.

**Why** Every published build of that package declares `antd: ^4.24.15 || ^5.11.2` as a peer
while this app runs antd 6, so `npm ci` aborted with ERESOLVE and the only way to install was
`legacy-peer-deps=true` for the whole subtree — a flag that also silences the _next_ real peer
conflict. The single import was `ProConfigProvider`, a wrapper that only re-provides antd's
theme and locale context (plus an SWR provider nothing used); the app has no Pro component, so
there was nothing to keep. Removing it lets installs go back to strict peer resolution, drops
130 packages and ~29 kB of gzipped JS.

**Cost** Anyone who later wants ProTable/ProForm has to add the package back, and antd 6
support becomes a prerequisite for that work.

**Where** `canvas/web/package.json`,
`canvas/web/src/components/layout/app-providers.tsx`. The rendered output is
unchanged — the built page still emits `class="css-1tzwyuk ant-app"` and
`--ant-color-bg-base:#000`, i.e. the same antd hashed theme as before the removal.

---

## 19. `COMFYLOFT_SERVER_HOST` is bound as given; there is no `ALLOW_REMOTE`

**Decision** The gateway listens on whatever `COMFYLOFT_SERVER_HOST` says, loopback or LAN address, with no
second switch. `ALLOW_REMOTE` is gone, and so is the startup refusal it gated. What remains is
a warning when the address is reachable from the network. (The `GATEWAY_TOKEN` this entry still
mentioned went in #110; the warning is now the only thing that says the port is open.)

**Why** A workbench whose gateway is on `192.168.3.232:8190` so a phone can use it _is_ the
local setup — calling that "remote" and making the user flip a flag to reach their own machine
was a gate with no bug behind it. It also failed quietly in the worst way: the canvas started,
the gateway exited, and the UI showed "gateway disconnected". The real risk is not the bind
address but an unauthenticated `/api/*`, and that is what the warning names.

**Cost** One keystroke less between a machine and the network. Anyone who wants the old
behaviour back has `COMFYLOFT_SERVER_HOST=127.0.0.1`, which is still the default. `CORS_ORIGINS` no longer
accepts `*` under any condition — the canvas origin is matched by host, so the wildcard was
only ever an accident waiting to happen.

**Where** `internal/config/config.go`, `internal/httpx/middleware.go` (`sameHostOrigin`),
`main.go`, `.env.example`, `docs/server.md`.

---

## 20. Workflow metadata is English in the registry and translated by id in the canvas

**Decision** `workflows/registry.json` carries English `label`, `description`, `variantLabels`
and `parameters[].label/description` — it is data the gateway serves, so it follows #8. The
canvas translates the strings it displays, in `web/src/lib/gateway-labels.ts`, keyed by the
stable identifier the gateway already sends:

```ts
gatewayModelLabel(modelId, gatewayLabel); // gateway.models.<id>.label
gatewayVariantLabel(mode, gatewayLabel); // gateway.variants.<mode>
gatewayModelDescription(modelId, gatewayLabel);
```

An id the dictionary does not know falls back to the English text, so a hand-written or
newly added workflow still renders instead of showing a raw key.

**Why not bilingual registry strings** A `{ "zh": …, "en": … }` shape would have changed the
`/v1/models` contract, every consumer of `metadata.label`, and the registry schema, for
metadata that only the canvas displays. Ids (`image-moss-sft-8step`, `inpaint`) are already in
the response and cannot change without breaking stored channel configs, which makes them the
natural dictionary key.

**Why the lookup names the language explicitly** The helper exists to answer with the *Chinese* label, so it
asks the Chinese dictionary by name (`getFixedT("zh-CN")`) and only when `resolvedLanguage` is `zh-CN` — a
plain `t()` would answer in whichever language is being read, which is the one thing it must not do.

**Cost** Two places describe one workflow: the registry (English, API consumers) and the
dictionary (Chinese, this UI). A workflow added by hand shows English in both languages until
someone adds the zh entries — visible, not silent.

**Where** `workflows/registry.json`, `canvas/web/src/lib/gateway-labels.ts`,
`web/src/i18n/locales/zh-CN.ts` (`gateway.models`, `gateway.variants`), `use-config-store.ts`
(`modelOptionLabel`, `baseModelOptions`), `resource-center-panel.tsx` (variant list).

**Not translated on purpose** `parameters[].label/description` for the API and plugin consumers
stay English only (nothing in the canvas renders them yet), `bindings.prompt.default` is model
input (#9), and `name` / `source.name` / `lora.filter` are identifiers and patterns.

---

## 21. Model installs are a configured fact, and they are off until stated

**Decision** `INSTALL_INTO_COMFY=1` is required to install models. Without it
`POST /api/resources/install` answers `400 model_install_disabled`, the panel shows a banner and
disables the download buttons, and nothing is inspected to decide any of this. `.env.example` — the
single-machine template the README tells you to copy — ships the line set.

**Why not detection** The two ways to get it wrong are mirror images and both are cheap to hit. A
bind mount or NFS share at a path different from what ComfyUI reports looks exactly like a remote
machine, so a `stat` blocks a working install. Two hosts that both install to `/opt/ComfyUI` look
exactly like one, so the same `stat` allows one that cannot work. A gate that is wrong in either
direction is worse than no gate, and the operator settles it in one line.

**Why fail-closed, and why that was not true before release** The dangerous failure is not an
error: as root, writing into a path that happens to exist here succeeds, gigabytes land on the
wrong disk, and ComfyUI keeps reporting the model as missing with nothing in the log. A default of
"try anyway" would keep that hole open, and the only defence would be an operator who already knew
the answer. While the project had no installed base the trade was different — refusing by default
would have broken deployments that never set the variable — but before release there are none, so
the safe default costs one line in `.env` and nothing else.

**Cost** A first run that skips `.env` gets the panel with installs off; the banner names the
variable, so it is a one-line fix rather than a mystery. Anyone whose mounts are real but
unusual still has to say so, because the process cannot tell them apart from a remote machine —
that is the point, not a limitation to work around.

**Where** `internal/config/config.go` (`boolValue`), `internal/resource/install_policy.go`,
`internal/resource/jobs.go` (`Install`, `installHint`), `internal/resource/status.go`,
`resource-center-panel.tsx`, `web/src/services/api/resources.ts`, `docs/server.md`,
`.env.example`, `README.md`.

---

## 22. ComfyUI is the only backend, and workflow JSON is the product model

**Decision** The gateway speaks ComfyUI and nothing else. There is no backend abstraction, no
per-backend resource directory, no adapter contract and no install script. A ComfyUI API-format
graph _is_ how a model is defined here: `workflows/<type>-<slug>.json` plus an entry in
`workflows/registry.json` describing name, type, prompt binding and parameters.

**Why** The graph is already self-describing — `BuildSchema` renders the parameter card,
`InferBindings` finds the prompt and image slots, `InferType` decides image/video/audio,
`ImageInputCapacity` counts reference images. A hand-written workflow DSL would have to
reproduce all of that. Wrapping graphs as OpenAI models is the whole idea of the project, and
one backend keeps it small enough to hold in your head.

**Why not a backend abstraction, given a second backend is conceivable** The seam would have to
cut through 26 Go files (`/prompt`, `/history`, `/view`, `/object_info`,
`/internal/folder_paths`, `nvidia-smi`, `ModelLoaderSpecs`, the graph format itself), not just
the resource installer. Abstracting only `resources/` would leave a per-backend resource system
inside a ComfyUI-only gateway: two vocabularies, no payoff. The cheap path for a future backend
is to make _it_ speak ComfyUI's protocol — that costs a compatibility layer in the new thing
instead of a permanent indirection in this one.

**Cost** The graph format's sharp edges stay exposed: two encodings (API vs UI, the UI one is
rejected with an explanation), and the heuristics listed above can be wrong (no prompt binding
inferred, a node class renamed upstream). Those are handled where they occur — a registration
warning, a naming rule, a `ModelLoaderSpecs` edit — rather than behind an abstraction that would
only hide them.

**Where** `internal/workflow` (registry, inference), `internal/comfy`, `internal/resource`,
`workflows/*.json`.

---

## 23. antd stays; the two ways it leaks are quarantined

**Decision** The canvas keeps antd 6 as its component library. Two kinds of knowledge about
it are not allowed to spread past one file each:

- _antd's internal DOM._ Every `.ant-*` class name used by application logic now lives in
  `src/lib/canvas-overlay.ts`. The overlay guards match our own `data-canvas-overlay` marker
  and the existing `data-canvas-no-zoom` first; the antd class list is a documented fallback
  array beneath them. When antd goes, that array goes and the canvas is not touched.
- _The palette._ App chrome takes its colours from Tailwind's `stone` scale.
  `src/lib/canvas-theme.ts` keeps its own hex on purpose — it is feature data (the canvas
  palette handed to node renderers and the plugin context), not app chrome.

**Why** Measured before this decision: 60 of 167 frontend files import antd, ~530 JSX
instances and 121 `message.*` calls go through `App.useApp()`, and the antd chunk is 916 kB
(298 kB gzip), the single largest third-party block. The number that made this worth writing
down is not the byte count though, it is the fighting ratio: `globals.css` spends 323 of its
897 lines overriding `.ant-*`, with 155 `!` utility prefixes across 13 components and 23
`[&_…ant-…]` arbitrary variants in 3. A library that 36% of the file tree depends on and a
third of the stylesheet fights is one we can neither swap nor leave alone.

**Why not remove it now** Replacing it is roughly 14–22 engineer-days, and the expensive part
is exactly the part antd has earned: `Form`, `Modal` and `message`, i.e. focus trapping,
nested dialogs, validation ordering and toast key reuse. The seams above turn removal into a
later, cheaper decision rather than an immediate, riskier one. The real blocker was the
`Modal`–canvas coupling: while the guards read `.ant-*`, any migration would have produced
silent drag/zoom regressions instead of compile errors.

**Verified** `CANVAS_CLICK_GUARD` and `CANVAS_WHEEL_GUARD` reproduce the two previous
selectors byte for byte once the new marker is stripped, and `appPalette` matches the old
inline `neutral` object on all 20 colour slots — the quarantine is a refactor, not a
restyle. Note that `#fafafa` in the dark theme is a cold `neutral-50` while its elevated
surface is a warm `stone-900`; that mix predates this decision and is preserved.

**Cost** Whoever finishes the migration must delete the `ANTD_*` constants in
`canvas-overlay.ts`; leaving them behind means the canvas keeps a hidden dependency on a
library that is no longer installed. `design-tokens.ts` and the `:root` / `.dark` block in
`globals.css` cannot import each other, so changing a semantic colour is two edits — both
file headers say so.

**Where** `canvas/web/src/lib/canvas-overlay.ts`, `design-tokens.ts`, `app-theme.ts`,
`canvas-theme.ts`, `styles/globals.css`, `components/canvas/infinite-canvas.tsx`,
`canvas-context-menu.tsx`, `canvas-size-picker.tsx`, `canvas-resource-mention-textarea.tsx`.

---

## 24. Transient messages go through one facade, not antd

**Decision** Showing a transient message is `toast.success / error / warning / info / loading`
from `@/components/kit/toast`. That module owns the implementation — currently sonner, which
has no dependencies and only a React peer — and is mounted once, in `AppProviders`. Call sites
deliberately keep antd's shape: `toast.loading(text)` returns its own dismiss handler instead
of an id, so the three export/import flows that do `const hide = …; hide()` were not rewritten.
Do not "simplify" that away; it is the seam that keeps the library choice out of the callers.

**Why** antd's `message` was reached 121 times from 20 files, 19 of them through
`const { message } = App.useApp()`. That hook was the only reason those files imported `App`
at all. After the move, `hooks/use-copy-text.ts` and `components/layout/client-root-init.tsx`
import nothing from antd, the file count went 60 → 58, and `App.useApp()` now survives only in
the three files that still need `modal.confirm` (`pages/canvas/project.tsx`,
`layout/app-config-modal.tsx`, `layout/config-prompt-sources.tsx`) — which is the next slice.
It also fixed a real inconsistency: `canvas-node-prompt-panel.tsx` used antd's _static_
`message`, which does not read `ConfigProvider` and therefore rendered with antd's default
theme rather than ours.

**Cost** The toast looks slightly different — sonner's pill, not antd's, and it shows at most
three at a time where antd showed unbounded. The copy and the timing did not change:
`duration: 3000` matches antd's default, and `loading()` is still sticky. The bundle barely
moved (antd 916 kB → 912 kB) because `message` was a thin slice of a library that is still
installed — the byte win only arrives when antd goes entirely, so do not read this migration
as a size optimisation.

**Verified** `tsc --noEmit` and `vite build` clean; the 121 call sites are accounted for
one-for-one, no bare `message` identifier is left in application code, and the three files
that keep `modal` still destructure it correctly.

**Where** `canvas/web/src/components/kit/toast.ts`,
`components/layout/app-providers.tsx`, `package.json` (sonner), and the 20 migrated files.

---

## 25. Confirmations are a kit primitive, and antd's static helpers are gone

**Decision** Asking "really?" is `confirm({ title, content, okText, cancelText, danger, onOk })`
from `@/components/kit/confirm`, rendered by a single `<ConfirmHost />` in `AppProviders`. It is
imperative on purpose: all three call sites fire from an event handler deep inside a component,
and threading an `open` boolean through them would cost more than the question is worth. The
dialog is radix's `AlertDialog` — it supplies the focus trap, ESC handling and aria wiring that
made antd's version trustworthy — while every class name is ours. `AppProviders` no longer wraps
the tree in antd's `App`; nothing reaches `App.useApp()` any more (measured: 0 call sites, and
the only remaining `.ant-app` reference in the repo is gone too, so no styles depended on it).

**Why** `App.useApp()` was down to the three files that needed `modal.confirm`
(`pages/canvas/project.tsx`, `layout/app-config-modal.tsx`, `layout/config-prompt-sources.tsx`),
i.e. the last thing keeping those files tied to antd's context. With it gone, the antd chunk fell
from 912.9 kB to 883.5 kB purely by deleting the `App` wrapper, and a future migration no longer
has to reason about a context layer.

**Cost** The `onOk` contract is antd's, not radix's: returning a promise keeps the dialog open
with OK disabled until it settles, and a rejection leaves it open rather than closing silently.
That behaviour had to be reimplemented by hand, so if someone later "cleans up" `handleOk` the
async cases will start closing early. The styling is also ours now — it is meant to look like the
antd dialogs around it, and will need a touch-up if the surrounding design moves.

**Where** `canvas/web/src/components/kit/confirm.tsx`,
`components/layout/app-providers.tsx`, the three call sites above.

---

## 26. Unit tests run on vitest, because bun was never installed

**Decision** `npm test` is `vitest run`. The three suites under `tests/` import from `vitest`
instead of `bun:test`, and `vitest.config.ts` exists so the tests do not drag in the app's build
plugins. `bun.lock`, `pnpm-lock.yaml` and `pnpm-workspace.yaml` are deleted: `Makefile` sets
`NPM ?= npm`, so `package-lock.json` is the only lockfile that was ever authoritative — the
other two were stale duplicates that would have installed different trees.

**Why** `bun test` could not run here at all (`bun: command not found`), so the suite was
vestigial: it had never been executed, and its state was unknown. Running it once made that
concrete — **4 of 15 assertions were failing**, in `tests/model-selection.test.ts`. They assert
the _cloud-mode_ contract (an explicit but unavailable model selection is preserved so readiness
blocks the request), while `resolveModelForCapability` implemented the opposite: a model the
registry no longer knows falls back to its capability default. Since `LOCAL_ONLY` defaulted to
true, those four were wrong on every build this repository ever produced. They were first gated
behind `test.skipIf(LOCAL_ONLY)`; decision #27 then deleted cloud mode outright, so the four
assertions and the gate are gone too. The suite is 11 passing, no skips.

**Cost** The suite covers only pure functions — viewport focus, thumbnail choice, model
selection. There are no component or canvas interaction tests, so the overlay guards and the
kit primitives (toast, confirm) are still verified by hand.

**Where** `canvas/web/package.json`, `vitest.config.ts`, `tests/*.test.ts`.

---

## 27. Cloud mode is deleted, not hidden

**Decision** `LOCAL_ONLY` and everything behind it are gone. There is no `VITE_LOCAL_ONLY`, no
branch to restore the cloud interface, and no dead UI kept "just in case". Deleted: the
`/image`, `/video` and `/prompts` workbenches, the cloud model-channel editor paths, the
audio capability in the canvas, config import/export, the prompt library and prompt-source
scheduler, the model-script editor, and the cloud default config. Routes and the navigation
list now contain only what this build can actually serve.

**Why** The flag defaulted to on and nothing anywhere — not `.env`, not `.env.example`, not
`start.sh`, not `Makefile` — ever set `VITE_LOCAL_ONLY=0`, so no build this repository produced
could reach the cloud interface. It was inherited from the upstream fork, where it _was_ the
main interface, and kept as an escape hatch that only a source-code comment mentioned. A branch
nobody builds is a branch nobody validates: it had already produced four permanently failing
tests (#26), and two of its pages were the largest single consumers of antd. The rule applied
here is the one from #23 — an unsimplified fork is not a smaller dependency, it is a second
product that silently rots.

**How the deletion was bounded** Not by reading: by reachability. A script walked imports from
`main.tsx`, simulating the removed routes as absent, and reported modules nothing could reach.
That found 8 modules (956 lines) already dead _before_ any decision, and after each removal it
was re-run until only `vite-env.d.ts` remained — an ambient-types file, not dead code.
`tsc --noUnusedLocals --noUnusedParameters` then caught the second class of leftovers the
graph cannot see: unused imports and unused locals (45 of them). Three Chinese UI strings that
the local branches already carried moved into the locale files, because inline copy violates
#17 whether or not a flag guards it.

Neither of those tools can see a third class: a JSX expression whose braces were lost, which
compiles and renders the _source_ of the call instead of its result. Two of those shipped into a
build — `t("config.channels.localOnlyDescription")` printed literally in the settings panel —
and only a click-through found them. Any rewrite of this shape needs one pass through the app
afterwards; type checks prove the code is well formed, not that it is right.

**Cost** The upstream fork's interface is gone, so re-adopting cloud providers later means
rewriting those pages rather than flipping a flag. That was an explicit trade: this repository
is maintained on its own and may be rewritten. The cascade also removed `services/config-file`
(settings import/export) and the prompt library, which are user-visible features — they were
unreachable in every build, but someone who only ever ran `VITE_LOCAL_ONLY=0 npm run build` by
hand will notice their absence.

**Result** Frontend 167 modules / 34,112 lines → 145 modules / 29,620 lines. Files importing
antd 60 → 44. antd chunk 916 kB → 739 kB (298 → 240 kB gzip); vendor chunk 1,090 kB → 571 kB
(366 → 192 kB gzip), the latter from dropping the prompt-source and config-file graphs.

**Where** `src/constant/app-mode.ts` (`LOCAL_ONLY` removed), `src/router.tsx`,
`src/constant/navigation-tools.ts`, `src/stores/use-config-store.ts`, and every file that used
to branch on the flag.

---

## 28. Model call scripts are gone; everything is OpenAI-compatible

**Decision** `services/api/model-plugin.ts` is deleted, along with the `script` field on
`ChannelModel`, `resolveModelScript()`, the eight per-capability templates, the LLM authoring
prompt, the full-screen CodeMirror editor, and the `modelPlugin` / `config.scriptEditor` /
`apiErrors.script*` copy. The client no longer evaluates user-authored JavaScript to perform a
model call.

**What it was** An escape hatch for providers whose request shape matched nothing the app knew.
You wrote an async function body; the app injected `prompt`, `images`, `params`, `model`,
`baseUrl`, `apiKey`, `http`, `request`, `poll`, `sleep`, `signal`, `onDelta`, and your code did
the HTTP itself. An empty script meant "use the built-in OpenAI-compatible call", so it was an
override, never a requirement.

**Why it could not fire** Nothing could set a script. The editor's open button was rendered under
`!LOCAL_ONLY`; the local gateway sync maps `name`, `capability`, `label`, `workflowId`,
`baseModel`, `imageInputs`, `variantModes`, `variantLabels` — never `script`. So
`resolveModelScript()` returned `""` on every code path, and all five `if (script)` branches
(image ×3, video, audio) were unreachable. Only a localStorage blob saved by an older cloud build
could have carried one.

**Why not keep it** Three reasons, in order of weight. First, it contradicts the project's core
invariant: the gateway exists to present every ComfyUI workflow as an OpenAI-compatible model, so
the canvas "only changes its base URL" (README). A client-side override is a hole in that
guarantee. Second, unreachable code is untested code — including five branches nobody had run and
an editor nobody could open. Third, it was a `new Function()` evaluation surface shipped in the
bundle for zero reachable benefit.

**Cost** A provider needing a bespoke request shape must now be adapted in the Go gateway. If
client-side scripting is ever wanted again it has to come back deliberately, with an authoring UI
and tests; `git log` keeps the deleted version.

**Result** 991 + 184 lines removed plus the branch bodies; `src` is 145 modules / 29,620 lines →
144 modules / 28,377 lines. Vendor chunk unchanged (571 kB) because the runtime was tree-shaken
out of reachable paths already; the win is comprehensibility, not bytes.

**Where** `services/api/model-plugin.ts`, `services/api/image.ts`, `video.ts`, `audio.ts`,
`stores/use-config-store.ts`, `components/layout/channel-editor-drawer.tsx`,
`i18n/locales/{zh-CN,en-US}.ts`.

---

## 29. Dialogs are a kit primitive too; no antd `Modal` is left

**Decision** All 27 `<Modal>` call sites now render `@/components/kit/dialog`. Its props are the
subset antd's call sites actually used — `open`, `onClose`, `title`, `label`, `footer`, `width`,
`bodyStyle`, `bodyClassName`, `closable`, `maskClosable` — so a call site cannot depend on a
feature that does not exist. `kit/button.tsx` was extracted at the same time, because the confirm
dialog and the two antd-free dialogs needed the same three button looks.

Three behaviours are decided deliberately rather than inherited:

- **Always centred.** 23 of the 27 asked for `centered`; the remainder are content panels where
  centring is not a regression.
- **Closing unmounts the children.** That is antd's `destroyOnHidden`, which 13 sites requested
  explicitly. The others were keeping transient form state alive across opens, which is not worth
  preserving.
- **Footers are explicit.** antd's `okText`/`onOk`/`confirmLoading` are gone; the six sites that
  used them build their own row. More lines, but the loading and disabled states are now visible
  where they are decided instead of inferred from antd props.

**Why this had to carry attributes** This is the part that would have broken silently. The canvas
overlay guards used to match `.ant-modal-root` and `.ant-modal-content`; those class names are
gone, and `lib/canvas-overlay.ts` resolves overlays through `data-canvas-overlay` and
`data-canvas-dialog-content`. The kit dialog emits both, so a dialog opened over the canvas still
swallows clicks and wheel, and the prompt mention menu still measures its boundary. Remove those
attributes and the canvas pans behind its own dialogs — a bug with no compile error anywhere.

**Cost** antd's dialog animated in and out; this one appears instantly. Six call sites had already
opted out of that animation with `transitionName=""`, so for them nothing changed, and the rest
lose a 200 ms transition. There is also no `width` default beyond 520 for panels that omit it.

**Verified** `tsc`, `tsc --noUnusedLocals`, 11 tests and `vite build` clean; in the browser the
resource gate, the asset editor, the system panel, the 980 px settings dialog and the destructive
"clear canvas" dialog all open, close via the X / Escape / their buttons, and the DOM after
closing contains no `ant-modal` at all. The antd chunk went 739 kB → 714 kB (240 → 232 kB gzip).

**Where** `components/kit/dialog.tsx`, `components/kit/button.tsx`,
`components/kit/confirm.tsx`, and the 23 files that used to render `<Modal>`.

---

## 30. Buttons keep antd's prop names, and antd's reset stylesheet is gone

**Decision** `kit/button.tsx` takes `type` / `size` / `icon` / `iconPlacement` / `danger` /
`loading` / `shape` — antd's names — so moving 116 `<Button>` call sites off antd was 30 import
swaps and zero call-site edits. Sizes keep antd's metrics exactly (24 / 32 / 40 px) because these
buttons sit in toolbars measured against those heights. Children render inside
`<span data-slot="text">` and the icon inside `<span data-slot="icon">`, because `globals.css`
collapses the canvas composer's label at narrow widths and needs to select one without the other;
the four `.canvas-composer-icon.ant-btn` rules became `.canvas-composer-icon` plus
`> span:not([data-slot="icon"])`.

**Why keep antd's names** They were never antd's invention: `type`, `size`, `icon` and `danger`
are the words these call sites already think in, and a rename pass would have touched 116 lines to
make them say `variant` instead. The shim is documented at the top of the file so nobody mistakes
it for antd.

**The bug this uncovered** With the kit button in place, the home page's primary button rendered as
an empty white pill. The cause had nothing to do with the button: `antd/dist/reset.css` was
imported from `main.tsx`, so it loaded as an **unlayered stylesheet**, and it contains
`input, button, select… { color: inherit }`. Unlayered CSS outranks _every_ cascade layer, so that
one declaration silently beat every Tailwind text colour on every `<button>` in the app —
including the ones that had been antd's until now, where it made no difference because antd styled
its own internals. `text-white` simply never applied to a button. Tailwind's preflight already
normalises the same elements, so the import is deleted rather than layered; verified afterwards
that antd's Select, Input, Tabs and Switch still render correctly without it.

That failure mode is worth remembering: type checks, unused-symbol checks and the reachability
graph all passed while a primary button was invisible.

**Result** antd component instances 238 → 122; files importing antd 42 → 36. The antd JS chunk did
not shrink (714 kB) because Button is imported internally by the components that remain, so this
step buys removability rather than bytes.

**Where** `components/kit/button.tsx`, `styles/globals.css`, `main.tsx`, and the 30 files whose
antd import lost `Button`.

---

## 31. `Select` is the radix primitive, and `mode="tags"` was never a select

**Decision** `kit/select.tsx` keeps antd's prop shape — `value` / `onChange` / `options` /
`placeholder` / `size` / `loading` / `notFoundContent` — but renders the radix primitive already in
`components/ui/select` (the one `model-picker` uses). The popup portal is marked
`data-canvas-overlay`, which is what lets the canvas stop zooming and deselecting under an open
dropdown without knowing what drew it.

`<Select mode="tags">` at the asset form is a different control and is now `kit/tag-input.tsx`: a
chip list plus a text field, with `,` `，` as separators. Routing it through a listbox bought a
portal, an aria listbox and a hidden search input for a field that has no options to list. It keeps
antd's `value` / `onChange` contract, so `Form.Item` binds to it unchanged — verified by watching
the live preview panel pick up the tags as they are typed.

**Two antd features deliberately not carried over**

- `showSearch` / `optionFilterProp` — the radix listbox has built-in typeahead driven by
  `textValue`. Typing a prefix jumps to the matching option. This is slightly weaker than antd's
  substring filter (it matches from the start), and it is the only behaviour difference from antd
  in this migration. The one call site was a handful of upscale models, so it was not worth a second
  combobox implementation with its own keyboard and aria handling.
- Empty string as a value — radix rejects `value=""`. Both directions travel through a sentinel that
  maps back to `""`, so `value=""` still renders as the placeholder, which is what antd did when no
  option carried `""`.

**The bug the browser caught** The first build rendered **two chevrons**: `kit` drew one so it could
swap it for a spinner while loading, and `SelectTrigger` drew its own. Nothing about that is
type-visible. Fixed with `hideChevron`.

**Dead CSS removed here** The last `.ant-select` users were the three `.canvas-control-select`
workflow rules and `.canvas-compact-control.canvas-control-select`, which had had no matching
element since an earlier pass; plus `.canvas-image-settings-popover .ant-popover-inner`, which had
had none since that panel became a hand-styled portal. `globals.css` now contains no third-party
class name at all.

**Result** files importing antd 10 → 8, and the component kinds left are `Form`, `Drawer`,
`ConfigProvider` and `theme`; antd JS chunk 714 kB → 249 kB (gzip 232 → 87). These are the
first bytes this migration has actually returned, because `Select` was the last component pulled in
from outside the `Button`/`Modal`/`Tooltip` subtree that the remaining components drag along.

**Where** `components/kit/select.tsx`, `components/kit/tag-input.tsx`, `styles/globals.css`, and the
four call sites (`pages/assets/index.tsx`, `components/canvas/canvas-side-panel.tsx`,
`components/canvas/canvas-node-super-resolve-dialog.tsx`, `components/layout/app-config-modal.tsx`).

---

## 32. Drawers are a side of `kit/dialog`

**Decision** `kit/drawer.tsx` reuses the dialog's header / scrolling body / optional footer and
adds `placement` and a width. antd expressed width three ways — `width={640}`, `size={280}` and
`size="large"` — so both `width` and `size` are accepted and resolved to a number (`large` was 736).
`extra` keeps antd's header-right action slot, which the channel editor fills with its save/cancel
pair.

**z-index** 1350/1351: above a dialog (1300) because the channel editor opens _from_ the config
modal, and below a confirmation (1400) because deleting an asset from the detail drawer must still
raise one.

**Where** `components/kit/drawer.tsx` and the three call sites.

---

## 33. antd is gone; here is what that cost and what it returned

**Decision** antd, `@ant-design/icons` and `dayjs` are no longer dependencies. Every component the
app used has a kit equivalent in `components/kit/`, and `Form` has no equivalent at all — its two
real uses hold their values in plain `useState` and its 15 label-only uses became `kit/field`.

**Why reverse #23** #23 said antd stays and its two leaks get quarantined. That was the right call
while the goal was to keep merging upstream. Once the goal became long-term maintainability of a
small local app, quarantine turned out to be a way-station: the seams (#23, #24) and the prop-name
shims (#30) made each component cheap to replace one at a time, and the last four (`Select`,
`Drawer`, `Form`, theme) went the same way. The bundle numbers say the quarantine was doing real
work — the antd chunk stayed at 714 kB from 42 files down to 6, then collapsed 714 → 249 → 219 → 93
→ nothing as `Select`, `Form`, and the providers left.

**What it returned** antd JS chunk 916 kB → 0; vite modules 4126 → 2564; dependencies 32 → 29.
`lib/canvas-overlay.ts` no longer contains a single third-party class name — the contract #23 wrote
("when antd goes, that array goes and the canvas is not touched") is now literally true: the array
went, and the canvas code above it did not change.

**What it cost** Three behaviours are narrower than antd's, and they are worth knowing:

- `Select` typeahead matches a prefix, not a substring (antd's `showSearch` filtered on any
  substring). One call site had it: the upscale model list.
- `Form`'s validation is now written per form, so a _new_ form means writing its own checks rather
  than declaring `rules`. There are two forms left.
- The image toolbar settings dialog renders a preview built from antd tokens; it now uses Tailwind
  classes over `design-tokens`. Nothing reads antd's CSS variables any more, which is why removing
  `ConfigProvider` changed no pixel.

**What the browser caught that the compiler could not** In this pass: a duplicate chevron in
`Select` (the kit drew one and the trigger drew its own), and — after `Form` stopped rendering a
`<form>` element — a browser hint that the API key field was no longer inside a form, i.e. no
password-manager prompt. Both were invisible to `tsc`, `--noUnusedLocals`, the tests and the
reachability graph. The second is the same class of failure as #27's missing JSX brace: deleting a
component deletes the semantics it silently provided.

**Left alone deliberately** radix logs `Blocked aria-hidden on an element because its descendant retained
focus` when a confirmation opens over the button that opened it: `@radix-ui/react-dialog` calls
`aria-hidden`'s `hideOthers` before focus has moved into the layer, Chrome refuses the attribute, and the
page stays readable — which is the outcome we want. Fixing it means patching radix's `hideOthers` or moving
focus in the trigger's `onPointerDown`; both are larger than a console line nobody sees, and neither changes
what the dialog does.

**Where** `package.json`, `components/kit/*`, `components/kit/field.tsx`, `lib/canvas-overlay.ts`,
`lib/design-tokens.ts`, `components/layout/app-providers.tsx`.

---

## 34. Unused translations are pruned by namespace, never by key _(superseded by #38)_

**Decision** A locale namespace is deleted only when its feature was deleted outright _and_ no
template key can reach it. Everything else unreferenced stays.

**Why** After the deletions there are ~150 translation keys no literal `t("…")` refers to. A script
can find them, but it cannot tell a dead string from one reached through a computed key —
`t(\`settingsPanels.common.${labelKey}\`)`, `t(\`canvas.sidePanel.filter.${value}\`)`and`t(\`assets.kinds.${kind}\`)`all resolve keys that look unreferenced. Deleting one of those shows the
user a raw key like`assets.kinds.image`, which is the same class of bug as decision #27's missing
JSX brace: invisible to the compiler and obvious only in the browser.

So the pruning pass took `prompts`, `imageWorkbench`, `videoWorkbench` and the dead half of
`workbench`, and stopped. The verification is a DOM scan for text matching a key shape, run on every
route.

**Where** `src/i18n/locales/{zh-CN,en-US}.ts`.

---

## 35. What the dependency audit removed, and what it kept against its own rule

**Removed** `@uiw/react-codemirror`, `@codemirror/lang-javascript`, `@codemirror/lang-json` (the
model script editor that used them was deleted in #28), `@tanstack/react-query` (only the provider
was rendered; no `useQuery` anywhere, so the client was a cache that always stayed empty),
`class-variance-authority` (no `cva()`), `react-router` (redundant — `react-router-dom` 7 declares
it as a regular dependency), and `streamdown` (a markdown renderer whose components were never
used; only its stylesheet was imported, for a `.agent-streamdown` element that no longer exists,
which also took 147 lines of dead CSS with it).

**Moved to `devDependencies`** `tailwindcss`, `tw-animate-css`, `shadcn` — resolved when the CSS is
built, never at runtime.

**Kept even though each is small and single-use**, because replacing them is a rewrite, not a
deletion, and each one earns its place:

- `copy-to-clipboard` — `navigator.clipboard` is **undefined on a plain-HTTP origin**, which is what
  this app is served from (`http://192.168.3.232:3000`). Its `execCommand` fallback is load-bearing.
- `nanoid` — for the same reason the codebase avoids `crypto.randomUUID`: that API only exists in a
  secure context. `nanoid` works over plain HTTP.
- `three` — the angle dialog's camera-orbit preview.
- `motion` — the canvas side panel's animation.
- `fflate` — the asset package zip. `axios`, `file-saver`, `localforage` — the network, download and
  storage layers.

**Also removed while auditing** two analytics IDs in `constant/runtime-config.ts`. Nothing imported
them, no script was ever assembled, and no docs or `.env` entry mentioned them, so the feature was
never wired to anything.

**The rule applied to the kit's own props** Three props were declared in a component's type, passed
by a call site, and never read by the implementation: `Alert.showIcon`, `Empty.image`,
`Dropdown.trigger`. A prop that lies is worse than a missing one — the call site looks configured.
Five more were implemented but never exercised (`Space.direction`, `Field.htmlFor`,
`TagInput.disabled`, `Tag`'s red and purple) and were deleted so the branches cannot rot.

**The list this audit left alone, and what became of it** ~120 exported symbols appeared to have
no importer. Most are types in `types/canvas-plugin.ts`, which is the **published plugin contract**
mirrored by `plugins/canvas/sdk/src/types.ts` — plugin authors import them, so "unused in this
repo" means the opposite of dead, and they are still there. The rest were resolved in #37, which is
why that entry insists on the reference graph: several of them were not dead, only unexported.

---

## 36. One HTTP layer, replacing axios and three copies of the error reader

**Decision** `services/api/http.ts` owns the transport. `httpJson` / `httpBlob` / `httpVoid` wrap
`fetch`; `readApiErrorMessage` and `apiErrorMessage` own the failure-to-sentence mapping. The four
service files that used axios now call these, and their three copies of
`readApiErrorMessage` / `readAxiosError` / `statusMessage` are gone.

**Why it was not necessary** Nothing used a capability only axios has. The one thing that would
have justified it — `onUploadProgress`, which `fetch` cannot do — appears nowhere. No interceptors
beyond the one below, no `CancelToken` (the app already passes `AbortSignal`), no transform
pipeline. Meanwhile the codebase was already split: 32 axios calls in four files against 17 `fetch`
calls elsewhere, including SSE streaming and blob downloads.

**The part that had to be carried over, not dropped** `image.ts` registered an axios response
interceptor that called `noteGatewayError` for requests to the local gateway. That is what flips the
shared "reconnecting" banner instead of raising one toast per node when the gateway restarts. It now
lives in `http.ts`'s `send()`: any network failure reports its URL, and `noteGatewayError` itself is
selective about which URLs and which errors count. A test pins it. This is the second time in this
migration that the risk was a behaviour hiding in library-specific plumbing rather than in our code
(see #27's missing JSX brace, #33's `<form>`).

**Two behaviours improved** A timeout is now distinguishable from a cancel: `fetch` is aborted with a
`TimeoutError` reason, so the image service keeps its `imageTimeout` wording instead of the axios
path's `ECONNABORTED` special case in one file only. And a non-2xx that a caller expected to be a
blob is still read as text, where axios produced an unreadable `Blob`.

**Verification** 28 tests in `tests/api-http.test.ts` pin every branch of the mapping — cancel,
timeout, API-supplied message, each status, the fallback, HTML error pages, and the gateway report —
because a browser can demonstrate the result but cannot enumerate the branches.

**Result** vendor chunk 556.7 → 514.4 kB (≈16 kB gzip), runtime dependencies 19 → 17.

**Where** `services/api/http.ts`, `services/api/{image,video,audio,skin-unlocks}.ts`,
`tests/api-http.test.ts`.

---

## 37. An export is a promise, and ninety-eight were not keeping one

**Decision** A symbol is exported only when another module imports it. Where nothing outside the
declaring file referred to a symbol that was exported anyway, the keyword was removed and the
symbol left exactly where it was; where _nothing at all_ referred to it, it was deleted. 583
exports under `src/` became 464.

**Why** An export is a contract with a caller who may not exist. It pins a name, a signature and
a shape, and every later reader has to establish whether something out there depends on it before
changing it. Most of these were leftovers rather than contracts: the canvas upscale and
angle-transform routines lost their callers when the gateway took over those workflows, and
`setPackMainModel` lost its when the resource panel stopped offering a main-model picker.

**How the two cases were told apart** With the TypeScript language service, not with grep.
`findReferences` follows barrel re-exports, resolves aliases, and reports whether each reference
comes from the declaring file or from elsewhere — three things a text scan cannot do. `tsc
--noUnusedLocals` then supplied the other half: a symbol used only inside its own file is not dead
yet, but once it stops being exported it may be, and the compiler says so.

**What grep would have got wrong** `fetchImageModels` has no caller by name outside `image.ts`.
Its caller is `fetchChannelModels`, one file down. A name-only scan deletes a live function here.
The reverse error is just as likely: `components/ui/select.tsx` lists every part in a trailing
`export { … }` block, so each part looks referenced — the file appears to use itself. Removing
those entries exposed the truth, and `SelectGroup`, `SelectLabel` and `SelectSeparator` had no
caller inside the file either; they were deleted rather than narrowed, because a component nothing
renders is not an API.

**Cost** Anyone who wants one of these helpers from outside has to add `export` back — a one-word
change made where its intent is obvious. The cost of the alternative is permanent: a reader cannot
distinguish a narrower module from one that happens to have no callers today.

**Where** `canvas/web/src/**`, and the commit that removed the sixteen dead symbols.

---

## 38. Unused translation keys are pruned by key, with reachability decided on the AST

**Decision** A key is deleted when no call site can ask for it. This replaces #34, which pruned
only by namespace because a script could not separate a dead string from one reached through a
computed key.

**Why the earlier reasoning could be finished rather than accepted** #34's warning was right about
the _naive_ script, which is why it stopped. The cases it named are all decidable if the analysis
reads the syntax tree instead of the text: `t(\`settingsPanels.common.${labelKey}\`)` and
`t(\`assets.kinds.${kind}\`)`mark a subtree reachable, and`t(cond ? "a.b" : "a.c")`— the shape
this codebase uses for tooltips — contributes both literals, where a regex sees only the
condition. Keys built by concatenation and by`getFixedT("zh-CN")(…)` are handled the same way.

**The four call sites that stop an analysis dead** `t(item.labelKey)` appears four times. Each
source is a local constant list in the same file, so the eight keys are read out by hand and listed
in the analysis. They are the only place the tool is told the answer instead of deriving it, and
that is the stated risk: a new `t(someVariable)` invalidates the pass.

**Verification, because "nothing looks broken" is not one** The new key set must equal the old set
minus the dead set, key for key, in both dictionaries — a set comparison rather than a diff that a
human skims. It does: zh 1118 → 980, en 1099 → 961. Afterwards the analysis reports zero
unreachable keys, and a DOM scan across every route in both languages returns no rendered key.

**What it found** Two whole namespaces: `config.promptSources.*` (~50 keys for a prompt-library
panel that no longer exists) and `canvas.agentOps.*` (labels for an agent feature that is gone).
Two keys that this migration itself had orphaned — `common.durationMinutes` / `durationSeconds`,
whose only caller was `formatDuration`, deleted two commits earlier — which is the analysis
agreeing with the code rather than with its own assumptions.

**Cost** ~200 lines out of the dictionaries, 18 kB of the index chunk. Deleting the wrong one
shows a raw key to the user, so the two guards above are not optional: the set comparison catches
an over-delete _before_ the build, and the DOM scan catches whatever it cannot see.

**Where** `src/i18n/locales/{zh-CN,en-US}.ts`.

---

## 39. All UI copy lives in the dictionaries — including the panel that kept its own

**Decision** `resource-center-panel.tsx` no longer holds a `copyByLocale` object with `zh` and `en`
side by side. Its 102 strings moved to `resources.panel.*` and are read with
`t("resources.panel", { returnObjects: true })`.

**Why, given the old shape was not wrong** It was correct, bilingual and type-checked, which is
why it survived this long. But it was the only copy in the app that `grep resources.panel`-style
maintenance could not find: someone translating a string had three places to look, and the whole
point of #17 is that there is one. The values were extracted from the component's own object by
script and re-emitted verbatim, so the migration could not retype or re-translate anything — the
check was a value-by-value comparison against the originals, 102 of 102 identical in both
languages.

**What had to be preserved** The type. `type Copy = typeof copyByLocale.zh` made `copy.titlex` a
compile error and, more importantly, checked the two `copy[\`runtimeDep\_${id}\`]`lookups. That is
now`type Copy = typeof import("@/i18n/locales/zh-CN").default.resources.panel`: the dictionary is
the source of truth, and a `Record<string, string>`would have silently allowed a typo through as`undefined` at render time.

**The Chinese that stays, and why each one does** Thirteen lines across six files, all deliberate:

- **Protocol values** `PromptOptimizeMode` (`文生视频(T2VA)` …) and the `referenceNote` hint in
  `canvas-node-prompt-panel.tsx` are form fields sent to the gateway; the backend matches the
  former and feeds the latter to a workflow (#9).
- **Parsed data** the `^(物体|人物|文字)` regex and the `人物：` caption prefix in the MOSS layout
  dialog are an agreement with the gateway about the shape of its output, not copy.
- **Decorative art** the mascot slogans in `canvas-node.tsx` are set in a CJK font stack and
  paired with their own English line (`PROCESS GUARDIAN`, `LIGHT BE WITH YOU`). Translating them
  would print the same sentence twice.
- **Endonyms** `中文` in the language picker and `中` on the switcher name a language in that
  language, which is what every language switcher does.

**Cost** One `as unknown as Copy` cast at the boundary, and a component that now depends on the
dictionary's shape for its types. Both are visible where they are written down.

**Where** `components/layout/resource-center-panel.tsx`, `components/layout/resource-setup-gate.tsx`,
`src/i18n/locales/{zh-CN,en-US}.ts` (`resources.*`).

---

## 40. There is no landing page; `/` is a redirect to a canvas

**Decision** `pages/home` is deleted. `/` renders `CanvasEntry`, which resolves to a canvas
address and replaces the URL with it. The app has exactly one kind of screen — a canvas —
and no page that exists only to be looked at on the way in.

The resolution order is deliberate:

1. the canvas you were **last inside**, from a stored `lastProjectId`;
2. otherwise the most recently modified one;
3. otherwise a new canvas.

**Why not "most recently modified" for step 1** Opening a canvas to read it does not touch
`updatedAt`. Look at canvas A for ten minutes, edit B, close the browser: `updatedAt` says B
but you left A. The remembered id is the only thing that actually answers "where was I".

**Why `replace`, and why it matters more than it looks** Without it the history keeps `/` and
every Back press bounces through the redirect again. This single attribute is the difference
between "the URL is the canvas" and a browser that fights you.

**What it costs** The app has no brand surface left: the toolbar title shows the canvas name,
and `无界工作台` now appears only in the browser tab, appended to the canvas name. That was
the trade the request asked for — the tool is the work, not a front door — but it should be
named rather than discovered.

**Two bugs this surfaced, both pre-existing** The dictionary never had `assets.kinds.audio`,
which the built-in Audio node asks for by name, and it never had `agent.composer.mentions.*`,
which two error paths in `canvas-resource-references.ts` still threw. Both printed raw keys
to the user. The node title was wrong since audio nodes existed; the error messages only fire
when a reference image cannot be read, which is why neither was noticed. They were found by a
check that compares every literal `t("…")` against the flattened dictionary — the inverse of
the dead-key pass in #38, and worth running whenever keys move.

**Follow-up: the list itself became a panel** `pages/canvas/index.tsx` (116 lines) is gone and
`/canvas` no longer renders a page. The list floats over the canvas you are already in, opened
from the switcher or the canvas menu. It is the same body — multi-select for delete, import, and a
card per canvas that exports itself — because that part was always right; only the container
changed. (The batch export it once carried is gone: one archive is one canvas, #172.)

The test that settled it: is this worth a URL? A canvas is — it can be shared, bookmarked, and
reloaded into the same state. A list of canvases cannot: nobody shares "my canvases", refreshing
it means nothing, and Back is worse than Escape. What a route bought was an unmount of the canvas,
a route change, and a full remount to get back to where you already were.

Two details worth keeping. `CanvasDeleteProjectsDialog` renders as a sibling of the manager, not
a child, so the two are independent radix roots rather than a nested focus trap. And `/canvas`
still resolves — to a redirect, so old bookmarks land on a canvas instead of a 404.

**Where** `src/pages/canvas/entry.tsx`, `src/router.tsx`, `stores/canvas/use-canvas-store.ts`
(`lastProjectId`), `components/canvas/canvas-top-bar.tsx` (the switcher this made obvious:
switching used to mean leaving the canvas for the list page), `components/canvas/canvas-manager-dialog.tsx`.

---

## 41. `npm run check` is the third gate, because the compiler cannot see these two bugs

**Decision** Two scripts in `canvas/web/scripts/` run as `npm run check:i18n` and
`npm run check:exports`, together with `tsc --noEmit` under `npm run check`.

**Why they exist** Both catch a class of bug that type-checks, builds, and passes tests while
being visibly broken:

- **A missing translation key.** A key absent from one dictionary renders the other language's
  text through `fallbackLng` — no error, no warning, just a sentence in the wrong language. The
  inverse is worse: deleting a key that is still asked for prints the key itself on screen. This has happened
  three times in this repository — `assets.kinds.audio` (the built-in Audio node's title, wrong
  since audio nodes existed), `agent.composer.mentions.*` (two error paths), and
  `navigation.config` (the settings button's aria-label, deleted as a dead key by the very commit
  that made it dead).
- **An export nothing imports.** An export is a promise to a caller who may not exist, and a
  `tsc` pass cannot tell an unused export from a used one. See #37 for why grep is not enough.

**What makes them checks and not trivia** They are not advice in a document; they exit non-zero.
`check:i18n` compares every literal `t("…")` against the flattened dictionaries in both
directions, compares the two dictionaries to each other, and treats a `t("…", { returnObjects })`
object path as a branch rather than a missing leaf. `check:exports` uses the language service.

**The two exceptions, written down where the script can see them** `chinese()` in
`lib/gateway-labels.ts` asks only the zh dictionary, so `gateway.models.*` and
`gateway.variants.*` are zh-only on purpose — enumerating them in `check-i18n.cjs` stops the
"only in zh-CN" check from failing every run. And four `t(variable)` call sites read their key
from a local constant list; the eight resulting keys are listed by hand in `HAND_RESOLVED`,
which is the one place the tool is told the answer instead of deriving it. The script prints any
`t(variable)` it meets so that list stays honest.

**Renamed while passing through** `canvas.projectPage.*` (37 keys) became `canvas.runtime.*`.
`projectPage` named a page that no longer exists — the list is a panel now — and these keys were
never page furniture: they are stop-generation, export, clipboard and failure messages emitted
_by_ the canvas. `canvas.project.*` keeps the list-management keys, which is what "project"
actually means here.

**Where** `canvas/web/scripts/check-i18n.cjs`, `scripts/check-exports.cjs`,
`package.json`.

## 42. Ten "which node has which dialog open" states become one

**Decision** `project.tsx` held ten independent `useState<string | null>` — `cropNodeId`,
`maskEditNodeId`, `outpaintNodeId`, `mossLayoutNodeId`, `splitNodeId`, `upscaleNodeId`,
`superResolveNodeId`, `videoUpscaleNodeId`, `angleNodeId`, `infoNodeId` — each meaning "this
editor is open on this node". They are now one nullable record:

```ts
type CanvasNodeTool = "info" | "crop" | … | "angle";
const [activeNodeTool, setActiveNodeTool] = useState<{ kind: CanvasNodeTool; nodeId: string } | null>(null);
```

with `openNodeTool(kind, nodeId)` / `closeNodeTool()`, and the ten `xxxNode` render variables
derived from it by a one-line kind check each.

**Why not leave it alone** It was not merely verbose, it was a bug generator. Three code paths
reset "the open editor" and each cleared a different, incomplete subset:

| path                 | cleared                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------ |
| `deleteNodes`        | info, crop, maskEdit, angle — **not** outpaint, mossLayout, split, upscale, superResolve, videoUpscale |
| `clearCanvas`        | the same four                                                                                          |
| the `Escape` handler | info, crop, maskEdit only                                                                              |

So pressing Escape with the split dialog up did nothing. Opening the outpaint dialog and then
deleting the node from the keyboard left `outpaintNodeId` pointing at an id that no longer
existed — invisible only because every render site guards on `node.metadata?.content`, so the
stale id silently rendered nothing and stayed set until the next open. With one state the resets
are one line each and cannot drift apart again.

**The invariant it buys** "At most one node editor is open" was previously a convention nobody
enforced; nothing in the type system prevented `cropNodeId` and `splitNodeId` from both being
set. Now it is the shape of the state. `dialogNodeId` deliberately stayed separate: that one is
the composer panel, which is long-lived and _does_ coexist with a modal (you can have the prompt
panel open while a crop dialog floats above it). Only the modal ten were collapsed.

**Cost** 52 `useState` in the component became 43. The diff is 59 insertions and 64 deletions,
almost all of them mechanical renames the compiler checked.

**Where** `canvas/web/src/pages/canvas/project.tsx`.

## 43. The node editors are a module with a nine-key contract, not a closure

**Decision** Nine editors moved out of `project.tsx` into
`pages/canvas/hooks/use-image-editors.ts` (crop, split, mask, outpaint, MOSS layout, super-resolve,
fast upscale, multi-angle) and `pages/canvas/hooks/use-video-editors.ts` (video upscale, frame
interpolation). `project.tsx` was 3,981 lines; it is now 3,459. Five modules appeared:
the two hooks, `hooks/node-editor-deps.ts` (a type), `lib/canvas/canvas-generated-video.ts` and
`lib/canvas/canvas-node-status.ts`.

**Why these nine and not "generation"** They were the only large, genuinely closed region left.
Every one of them follows the same shape — take the node you were handed, append a child beside it,
wire a connection, select the child, open its composer, and (where it generates) drive exactly one
request. Not one of them _reads_ the graph. That is what made the extraction honest: the whole
surface they need is six setters, two request-registry calls and `closeNodeTool`. Everything else —
`effectiveConfig`, `isAiConfigReady`, `openConfigDialog`, `t` — they can read themselves from the
stores, so it is not in the contract.

`dialogNodeId` and the ten-entry `activeNodeTool` record stayed in the page: the page owns _which_
editor is open, the editor module only owns what happens once you press confirm. Rendering the ten
dialogs stayed in the page too — they are page furniture, positioned against page state.

**Two things fell out of the move**

- `applyGeneratedVideo` and the 420 px video cap were used by both the poller (which stays) and the
  video editors (which left), so they went to `lib/canvas/canvas-generated-video.ts` rather than
  being duplicated or imported page-ward from a hook.
- `NODE_STATUS_*` were four `"idle" | "loading" | "success" | "error"` literals declared in
  `project.tsx` and re-typed by hand in the node components. Now that two more modules needed them
  they moved to `lib/canvas/canvas-node-status.ts`.

**What this is not** It is not a line-count win: 522 lines left the page and 603 arrived elsewhere,
because each hook carries its own imports and the contract type is written down instead of being
implicit. The win is that "what a node editor may touch" is now a 23-line type you can read in one
screen, and that proving an editor correct no longer means standing up a 3,459-line component.

**Where** `canvas/web/src/pages/canvas/hooks/`, `canvas/web/src/lib/canvas/`.

## 44. `handleGenerateNode` was 440 lines and four of them did not talk to each other

**Decision** The four generation modes — image, video, audio, text — moved out of `handleGenerateNode`
into `pages/canvas/hooks/use-generation-runs.ts`, one function each. `handleGenerateNode` is now a
123-line orchestrator: resolve config, hydrate the prompt, build a `GenerationRun`, dispatch on mode,
own the shared `catch` and `finally`.

`project.tsx`: 3,459 → 3,150 lines.

**What the four actually shared** Almost nothing. A 440-line function was: ~45 lines of plugin
`writeBackToSelf` special case, ~40 lines of shared setup, then four branches of 143 / 47 / 29 / 115
lines, then a `catch`/`finally`. The branches agreed only on inputs — which node, the hydrated
prompt, the resolved config, whether to overwrite the source, and the run controller. That is the
whole of `GenerationRun`, and it is why the split is a move and not a rewrite.

**The one thing that is not a pure move** `pendingChildIds`. Each mode records the nodes it created
so the caller's `catch` can stamp them as failed; it has to survive the mode returning early, so it
is a mutable field on the run rather than a return value. Four `pendingChildIds = [...]`
assignments became `run.pendingChildIds = [...]`. Everything else in the four bodies is
byte-identical to what was there before — verified by diffing the moved ranges against
`git show HEAD` with indentation normalised, which leaves only the `}, [deps]);` closer.

**Why not also `handleRetryNode`** It looks like the same function and is not. Retry writes into the
node that already exists instead of spawning a sibling, has no `mode`, and branches on
saved-metadata-vs-hydrated-context instead. Merging the two would have meant a flag for every
difference. It stays where it is, at ~340 lines, and is the next thing worth its own pass.

**Which state stayed in the page** `runningNodeId`, `setExpandedBatchNodeIds` and the error
stamping in `catch` — because they are about the canvas, not about one request. The five setters and
the two registry calls go in as `GenerationRunDeps`, the same shape as `NodeEditorDeps` (#43).

**Where** `canvas/web/src/pages/canvas/hooks/use-generation-runs.ts`.

## 45. Retry joins the generation module, and `project.tsx` drops under 3,000

**Decision** `handleRetryNode` (156 lines) moved to `use-generation-runs.ts` as `retryNode`.
The page now holds no generation logic at all: `handleGenerateNode` dispatches, `handleRetryNode` was
a second entry point, and both live behind `useGenerationRuns`. `project.tsx`: 3,150 → 2,990 lines.

**Why it belongs there even though it shares no code** It looked like a duplicate of `handleGenerateNode`
and is not. Retry has no `mode`, spawns nothing, and writes into the node that already exists — into
the image slot that failed, if one was named. Its four type branches total 88 lines where generation's
total 334. What they share is not code but _ownership_: both resolve a config, both check it is ready,
both drive exactly one request into exactly one node, both stamp the outcome. Keeping one in the page
and one in the module was the wrong seam; the seam is "the page owns the canvas, the module owns
generation", and it is now consistent.

**`GenerationRunDeps` grew by four** `nodesRef`, `connectionsRef`, `setRunningNodeId`, `pollVideoNodeTask`.
The first two are the only place the module reads the graph rather than appending to it —
`findRetrySourceNode` has to walk backwards from the failed node to find what produced it. That is a
real difference from the editors (#43), which never read, and it is why retry needed refs where they
needed nothing.

`effectiveConfig`, `isAiConfigReady` and `openConfigDialog` are read from the stores inside the hook,
as in #43, so they are not in the contract.

**Verified the same way** The moved body diffs against `git show HEAD` at 146 non-blank lines in,
146 out, zero differences.

**The gap** `retryNode` was not exercised in a browser. Retry only appears in the node toolbar and
context menu for a node in `error` status, and there is no way to manufacture one without a failing
API call. What was checked live: the page loads on the new bundle, nodes render, selection and the
context menu work, and the console is empty. The body is a byte-identical move and the contract is
type-checked, but the runtime path itself remains unexercised — worth one click from a human on a
node that has actually failed.

**Where** `canvas/web/src/pages/canvas/hooks/use-generation-runs.ts`.

## 46. Three pieces of housekeeping, and what two of them turned out to be

All three came out of the same audit as #41–#45 and all three changed shape once I read the code.

### `components/layout/` was 80% settings

Ten files lived under a name that described two of them. `app-providers` and `client-root-init`
are the app shell; the rest are the settings feature — the config modal (610 lines), the resource
centre (881), the channel editor, the model picker, the storage-usage panel and the setup gate that
opens the resource centre when nothing is configured.

Six files moved to `components/settings/`. `components/layout/` keeps four: providers, root init,
the reconnect banner and the status actions. The split is by _what the file is_, not by where it
renders — all ten render from the same two places.

### The stores had no rule

`stores/` held `use-panel-store` and `use-canvas-side-panel-store` next to `use-asset-store` and
`use-theme-store`, while `stores/canvas/` held the graph and the plugin registry. Two of those four
are about a canvas and two are about the app, and nothing said which was which.

The rule now holds and is visible from the directory listing: **`stores/` is app-wide** (config,
theme, storage recovery); **`stores/canvas/` is everything about a canvas** (the graph, plugins, the
floating panels, the side panel, the canvas list). Three files moved and two were renamed:

| was                                     | is                                             |
| --------------------------------------- | ---------------------------------------------- |
| `stores/use-panel-store.ts`             | `stores/canvas/use-canvas-panel-store.ts`      |
| `stores/use-canvas-side-panel-store.ts` | `stores/canvas/use-canvas-side-panel-store.ts` |
| `stores/canvas/use-canvas-ui-store.ts`  | `stores/canvas/use-canvas-list-store.ts`       |

**The merge I proposed and did not do** The audit said to fold `useCanvasUiStore` into
`usePanelStore`. Reading them, that is wrong: `useCanvasPanelStore` answers "which floating panel is
open", which is app-level navigation state that outlives any panel; `useCanvasListStore` holds which
canvas rows are ticked and which one is being renamed, which is widget state that belongs to one
open panel. Merging them would have produced a store with two different lifetimes inside it. The
name was the problem — `ui` said nothing — not the split.

### The storage panel reported a number that was quietly wrong

`local-storage-usage.ts` measured one database, hardcoded, named `"infinite-canvas"`. But plugins
write to a second one, `"infinite-canvas-plugins"`, one object store per plugin id. A canvas with
heavy plugins therefore showed less than the browser was actually holding against the quota, and
nothing anywhere said so.

All the database and store names are now in `services/localforage-databases.ts`, which four files
import instead of repeating the strings, and the reader measures both databases.

It also no longer creates what it measures. `indexedDB.open(name)` _creates_ a database that is not
there, so the old reader would have materialised an empty `infinite-canvas` on a fresh profile just
by visiting the settings tab. `indexedDB.databases()` answers "which exist" without touching
anything; the open is only reached for names the browser confirms.

**Two labels were pointing at stores that no longer exist** `agent_chat_messages` and `prompt_cache`
were in `storeLabelKeys` — and their translations in both dictionaries. `check:i18n` could not see
they were dead because the lookup is a template literal, and a template literal registers as a
_prefix_, so everything under `config.localStorage.stores.` counted as reachable. Removed from both
locales along with the labels: 1108 → 1107 keys.

**Verified** `npm run check`, strict `tsc`, 39 tests, build. In the browser the panel renders
`infinite-canvas · v7` with the real per-store breakdown, and `indexedDB.databases()` after visiting
the tab still returns exactly one database — the absent plugin one was reported as absent rather
than created and shown empty.

**Where** `components/settings/`, `stores/canvas/`, `services/localforage-databases.ts`,
`services/local-storage-usage.ts`.

## 47. Content ingress is a module: `File | string` in, node out

**Decision** Eight callbacks that turn something the user handed us into a node moved to
`pages/canvas/hooks/use-content-ingress.ts` (310 lines): the three `create*FileNode`, the clipboard
text node, the system-clipboard paste, the file-picker request, the file-picker handler, and drop.
`project.tsx`: 2,990 → 2,735 lines.

**The line that makes it a module** Not one of them reads the graph. They take a `File` or a string
and append. The only thing they need from the page is where the viewport is looking
(`screenToCanvas`, `getCanvasCenter`, `size`, `containerRef`) plus five setters. That is
`ContentIngressDeps`.

**The picker owns its input** `imageInputRef` and `uploadTargetRef` moved into the hook rather than
being passed in, because the module owns the behaviour that clicks the hidden `<input type="file">`.
The page still renders the element — it destructures `imageInputRef` and attaches it — but it no
longer knows what the ref is for. Passing it in would have been the page owning a piece of the
module's mechanism.

**What stayed behind** `pasteCopiedNodes` (copy/paste of _canvas nodes_, which is graph logic with
connection re-mapping, not content ingress) and `handleAssetInsert` (which inserts from the asset
library and asks the page where the selection is).

**A line was almost lost** The first attempt sliced one line too far and left `handleNodeResize`
with an empty body — a callback that silently does nothing. The compiler caught it only because the
destructured parameters became unused under `--noUnusedParameters`. Every move since then is
checked by reconstructing HEAD minus the moved ranges and diffing it against the result; that diff
is now exactly zero, which is a stronger statement than "tsc passes".

**Verified end to end, not just compiled** The hidden input was driven from the browser with a real
`File` built from a canvas and a `DataTransfer`: a node titled `ingress-test.png` appeared with its
image, selected, composer open, and was deleted afterwards. Console empty.

**Where** `canvas/web/src/pages/canvas/hooks/use-content-ingress.ts`.

## 48. Three small correctness fixes found by a full read of the frontend

The audit that produced #41–#47 stopped after the first four items. This is the pass that finished
it: 168 files, 29,850 lines, read rather than grepped for keywords.

**What the scan said about the codebase overall** Zero `any`, zero `@ts-ignore`, zero empty
`catch`. Seven non-null assertions, five `eslint-disable`, and every one of the five carries a
comment saying why — three of them in `canvas-node-prompt-panel.tsx` exist to keep a text input from
being reset mid-typing. There is no category of "type system bypassed everywhere". The problems are
in the seams between files, which is exactly what a compiler cannot see.

### The side-panel width had two owners

`use-canvas-side-panel-store.ts` declares `WIDTH_KEY = "canvas-side-panel-width"` and reads it at
boot. The _write_ was a bare literal in `canvas-side-panel.tsx`, on pointer-up:

```ts
localStorage.setItem("canvas-side-panel-width", String(nextWidth));
```

Two files, one key, no link between them. Change the constant and the panel silently stops
remembering its width; change the literal and the same. And `setWidth` was the only setter in that
store that did not persist — `openPanel`, `closePanel` and `setNodeViewMode` all do — so the store
was internally inconsistent about what "set" means.

Writing on every pointer-move would hammer localStorage, which is presumably why it was done at
pointer-up in the component. So the store grew `commitWidth()`, which writes the current width, and
the component calls that instead. Same write frequency, one owner, and `setWidth` is again just the
live setter it looks like.

### Two known bugs, both in the resource centre

Known issues #4 and #5 had been sitting there with the fix written down. #4: the workflow status tag
fell through to "Restart needed" for _any_ unavailable workflow, including one blocked by an
uninstalled custom node — a label promising something a restart will not deliver. It is now a
three-way branch, and a workflow carrying `problems` says "Load failed".

#5: the "Canvas entry" tag rendered exactly when `modelVisible === false`, i.e. when the workflow is
hidden from the picker. The audit offered "invert the condition or rename the label"; the label was
renamed to "Hidden from picker", because inverting a condition on a guess about intent changes
behaviour, and this one does not.

Both were one file away from the `components/layout` → `components/settings` move in #46, which is
how they got found again — known issue #4 still pointed at the old path.

### One thing found, documented, not fixed

`use-canvas-store` and `use-asset-store` both `JSON.parse` persisted state with no guard. A corrupt
blob makes the parse throw, zustand swallows it into `onRehydrateStorage`, that listener ignores the
error, and the app comes up with empty defaults over data that is still in IndexedDB. Recorded as
known issue #12 rather than fixed here, because the half that matters — telling the user their saved
state could not be read — is a product decision, and the parse half on its own changes nothing
anybody can see.

**Verified** `npm run check`, strict `tsc`, 39 tests, build. The width fix was checked end to end in
the browser: drag the resizer 280 → 400, reload, the panel comes back at 400. The two tag fixes
were not exercised, because they need the gateway to report a workflow with problems or a hidden
one, and the local gateway reports neither.

**Where** `stores/canvas/use-canvas-side-panel-store.ts`, `components/canvas/canvas-side-panel.tsx`,
`components/settings/resource-center-panel.tsx`, `i18n/locales/`.

## 49. An unreadable store is preserved, refused, and explained

**Decision** Both `persist` storage adapters catch their own parse failure instead of letting it
escape. On failure they copy the raw bytes to `<key>.corrupt-<timestamp>`, record the failure in
`stores/use-storage-recovery-store.ts`, return `null` so hydration proceeds with defaults on
purpose, and from then on refuse every `setItem`. A banner
(`components/layout/storage-recovery-banner.tsx`) says what happened and offers three things.

**Why catching is not enough on its own** Known issue #12 was reproduced before this was written. A
2314-byte `canvas_store` holding one canvas with two nodes was replaced with the string
`{oops truncated` and the page was hard-reloaded. The app came up on a brand-new project id with
"No nodes on this canvas", the console was **empty**, and within seconds the stored blob was 378
bytes — the empty project. The original was gone from the browser. So the failure mode was not
"boots empty", it was "boots empty and then destroys what it could not read".

That is the reason for the write refusal. Returning `null` alone would have left the second half
intact: zustand's `persist` wraps `setState`, `hydrated: true` is a state change, and the canvas
store's dedupe guard is skipped when `queuedPersistState` is `null` — which it is, precisely
because the parse failed.

**The three actions, in the order that protects the user** Export the raw bytes first: it is the
only action that changes nothing and loses nothing, and it turns an opaque failure into a file the
user can keep. Retry second: it re-reads, which genuinely helps the transient case (a write caught
mid-flight, a quota hiccup) and is harmless in the permanent one. "Clear and start over" last and
styled as a link, not a button, because it re-enables writing over the original key — though it
cannot lose anything, since the copy is already on disk.

**Two details that only showed up in the browser**

- The banner was `top-4` and overlapped the canvas title and the top-bar controls. Moved to
  `top-16`, which is where the reconnect banner already sits.
- "Clear and start over" dismissed the banner but wrote nothing, because `setItem` only runs on a
  state change and dismissing is not one. Reloading immediately after showed the banner again, which
  reads as a broken button. The handler now nudges both stores with `setState({})` so the cleared
  state actually replaces the blob.

**Scope** The banner renders in `layouts/user-layout.tsx`, not in the canvas list, because `/`
resolves straight to a canvas — most sessions never open the list, and a message that only appears
there would be seen by almost nobody.

**Verified** The reproduction was repeated against the fix: banner appears, main key still holds
`{oops truncated`, a `.corrupt-2026-10-30T19-28-33-388Z` copy exists, "clear and start over" then
rewrites the main key to a valid 378-byte blob. The origin's data was restored from a backup
afterwards and checked: two nodes, correct title, no banner, console empty.

**Where** `stores/use-storage-recovery-store.ts`, `lib/persist-recovery.ts`,
`components/layout/storage-recovery-banner.tsx`, both persisted stores.

## 50. Every floating panel is 1000×646, or it is not a panel

**Decision** `Dialog` no longer takes `width`. It takes a required `size` from a closed set, and
`size` is not a hint:

```ts
const SIZE_CLASS = {
  panel: "h-[min(760px,88dvh)] w-[1000px]",
  form: "max-h-[90dvh] w-[520px]",
  auto: "max-h-[90dvh] w-auto",
};
```

Thirty call sites were classified. Nineteen are `panel` — the canvas list, the asset library, the
settings modal, the plugin manager, the asset picker, the model picker, the quick-tools settings,
the prompt editor, and all eight image/video editors. Nine are `form` — confirmations, the shortcut
sheet, system status, the cloud-API editor, the card-skin picker, runtime help. Two are `auto`, and
only two: the image preview and the media preview, whose size _is_ the image.

**The problem it fixes** Before this, every dialog's width was a literal between 440 and 1100 and
**not one of the thirty set a height** — height was whatever the content happened to be, capped at
90dvh. So:

- settings (980) → asset library (1100) → canvas list (920) → plugin manager (640): the frame moved
  sideways by 180px between any two of them, and vertically by whatever the content did;
- inside settings, switching between Providers, Prompt API, Preferences, Add workflows and Local
  storage resized the same window five times, because those five tabs have very different content.

A window that resizes to its contents stops reading as a window. The user's sense of "where I am" in
a spatial UI depends on the frame staying put.

**Why not one size for everything** A confirmation is one sentence and a paragraph. Forcing it to
1000×646 would be its own kind of wrong — a giant box that shouts about something small. Keeping
`form` content-sized preserves that, and nothing is lost, because a confirmation is not a place you
_are_, it is a question you answer. `auto` stays for the same reason from the other direction: a
preview's size is information, not layout.

**Why `size` is required and there is no default** A default would have let an unclassified call
site keep its old behaviour silently. Making it required turned the compiler into the checklist:
after the kit changed, `tsc` listed all thirty sites and could not be satisfied until each was
classified.

**Accepted cost** A panel with little content leaves space at the bottom. The video upscale editor
is the clearest case. Measured on a 734px-tall window the panel is 646 tall (`88dvh`); on a 1080p
screen it is 760, and only the tallest editors scroll.

**Measured after the change** Settings across all five tabs: 1000×646, 1000×646, 1000×646, 1000×646,
1000×646. Canvas list: 1000×646. Asset library: 1000×646. Crop editor: 1000×646. Clear-canvas
confirmation: 520×161, unchanged.

**Where** `components/kit/dialog.tsx` and the thirty call sites.

## 51. The editors' canvases fill the panel instead of guessing at the viewport

**Decision** The four editors that sized their image area against the _viewport_ now size it against
the _panel_. The dialog body becomes a flex column (`bodyClassName="flex flex-col"`) and the image
area takes the remaining space (`flex-1 min-h-0`), with a small `min-h` as a floor rather than a
typical value.

| editor    | was                                 | is                                          |
| --------- | ----------------------------------- | ------------------------------------------- |
| crop      | `h-[min(62vh,620px)] min-h-[340px]` | `flex-1 min-h-[260px]`                      |
| mask edit | `h-[min(68vh,720px)] min-h-[360px]` | `min-h-[320px]` (stretched by the grid row) |
| split     | `h-[340px] min-h-[300px]`           | `flex-1 min-h-[240px]`                      |
| node info | `h-[56vh] min-h-[360px]`            | `flex-1 min-h-0`                            |

**Why this was needed at all** Prettier-adjacent: #50 made every panel a fixed height, and these four
had heights expressed in `vh`. On a viewport where `88dvh` is smaller than `62vh` plus chrome — which
is exactly what a 734px-tall window gives — the editor content came out taller than the panel and the
body scrolled. Measured before: the crop dialog needed a scrollbar and its footer was below the fold.
Measured after: `scrollHeight - clientHeight` is 0 in all four, and the crop dialog's Reset / Cancel /
Crop row is visible without scrolling.

The numbers were also the wrong kind of number. `62vh` is a guess about how tall an image wants to be
on somebody else's monitor; `flex-1` is the actual answer, because the panel already knows its height.

**A predating bug found while measuring** In the mask editor the action row needs about 360px for
Reset, Export to canvas and Generate, and sits in a fixed `320px` grid column — so Generate was
clipped by the dialog's `overflow-hidden`. This was true at the old 980px width as well, since the
column was 320 then too; the arithmetic, not the change, is what shows it. The row now wraps
(`flex-wrap`), so the three buttons reflow instead of the last one disappearing.

**Where** `components/canvas/canvas-node-{crop,mask-edit,split}-dialog.tsx`,
`components/canvas/canvas-node-hover-toolbar.tsx`.

## 52. The persisted format has a version, and a migration that can refuse

**Decision** Both persisted stores carry `version: 1`, and both read their blob through a module that
checks the version, migrates an older blob, and then asserts the result has the current shape. A
throw from any of those three steps is the same signal as invalid JSON: copy the blob aside, refuse
to write, show the banner.

**What was wrong without it** zustand's default `merge` is

```js
(persistedState, currentState) => ({ ...currentState, ...persistedState });
```

which is **shallow at the top level**. `projects` is replaced wholesale by whatever was on disk, so
nothing inside a project ever receives a default. A field added to `CanvasProject` comes back
`undefined` on every canvas that predates it. `viewport` is the sharp case: it is `{x, y, k}` and
every coordinate on the canvas passes through `k`, so a missing `k` is not a cosmetic gap, it is
`NaN` in the transform and a blank canvas.

And nothing checked. Both stores left `version` at zustand's default of `0`, so the stored version
and the expected version were always equal and the comparison always took the branch that uses the
state unexamined.

**Why the migration lives in `getItem`, not in zustand's `migrate`** zustand runs its migration
_after_ `getItem` returns. A failure there cannot reach this app's recovery: it logs
`State loaded from storage couldn't be migrated` and discards the state, and the store then persists
defaults over the blob — the data-loss path #49 was written to close. Worse, it would have got
through even with the write refusal, because `getItem` had succeeded. Doing the work inside
`getItem` means there is exactly one failure path, and it is the one with a banner on it.

**The three steps**

1. _Version check._ A blob from a **newer** build throws rather than being guessed at. There is no
   safe interpretation of a format we have never seen.
2. _Migration (`version < 1`)._ Backfills what older blobs lack — `lastProjectId`, and per project
   `chatSessions`, `activeChatId`, `backgroundMode`, `showImageInfo`, `viewport`. The per-project
   pass is the part zustand's shallow merge structurally could not do.
3. _Assertion._ Shallow, but it guarantees the canvas can render: every project has an id, a title,
   array `nodes`, array `connections`, and a viewport with finite `x`, `y` and a positive `k`. This
   is what catches a shape change nobody migrated.

**Tested both ways**

`tests/persist-migration.test.ts` — 14 cases against the real read path: a current blob passes
through, a versionless blob gains `lastProjectId`, a project missing the newer fields is backfilled,
a viewport with no `k` becomes `k: 1`, a zero zoom is treated as unset, a newer version throws,
malformed JSON throws, `nodes` that is not an array throws, an asset with no `data` is dropped.

End to end in the browser: a forged versionless blob whose viewport had only `x` and `y` was written
to IndexedDB and the page reloaded. It came back at `version: 1` with `k: 1`, both nodes intact,
rendering at 100% — no `NaN`, no blank canvas, no banner (it was migratable, not unreadable). The
original blob was restored afterwards and checked.

**Where** `stores/canvas/canvas-persist.ts`, `stores/asset-persist.ts`, both stores,
`tests/persist-migration.test.ts`.

## 53. One run protocol; media type is data, not routing

**Decision** Every generation is a `run`: `POST /api/runs` returns an id, and status, progress,
outputs and cancellation all hang off that id. Image, video and audio are three workflows, not
three families of endpoints. `wait`-style blocking endpoints do not exist. The target is written
down in [`protocol.md`](protocol.md); this entry records why, and what lands first.

**What was wrong without it**

- The API grew as _media × action_: `images/generations`, `images/edits`, `images/upscale`,
  `videos`, `videos/upscale`, `videos/interpolate`, `audio/speech`. Every new capability adds a
  route, a handler and a test, and the handlers drift apart.
- Execution model was chosen by media type, not by how long the work takes. Images and audio
  blocked inside one HTTP request; video got a job. Music generation takes minutes, so it ended up
  on the blocking path — exactly the case where a dropped connection loses the work.
- Handler code contained workflow identity: `entry.ID == "video-h3-t2v"`, `"video-h3-fast"`,
  `"video-h3-frames"`, `"video-h3-ref2va"`, `image-qwen21`, `image-moss-*`. Adding a workflow meant
  editing Go, which contradicts `registry.json` being the workflow data.
- One concept, several spellings: duration is `seconds` for video and `duration` for audio;
  resolution is `size`, `quality`, `vquality` and `resolution_name`; everything else went into a
  `params` field that accepts both an object and a JSON string.
- Uploads were classified by magic field names (`contains "image"` or `"frame"`), so an OpenAI
  `mask` could not be expressed at all, and roles depended on field order.
- Outputs had three retrieval paths: base64 in the body, `/files/{name}`, and
  `/v1/videos/{id}/content`.

**Why the id, and why no `wait`** A blocking variant returns two different success shapes (`200`
with the artifact, `202` with a run), so clients need polling anyway — while the blocking call
brings back the failure the id exists to prevent: the connection dies and the finished work is
unreachable. One shape, one code path, and the work survives reloads and disconnects.

**What lands first** The execution core, because it is shared by every later phase: submission,
queueing, persistence, progress and cancellation move into one helper over the existing
`internal/task` store, and audio joins video on it. Audio then stops being a blocking generation —
its `/v1/audio/speech` adapter submits a run and waits on the run, and the run survives the client.
`/v1/*` stays as a thin adapter so the canvas keeps working and the existing e2e tests keep
guarding the behaviour until their node type migrates.

**Order** (each phase leaves `make check` green): execution core → `accepts`/`inputs`/`outputs` in
`registry.json` plus a generic validator, deleting the per-workflow branches → `/api/runs` and
`/api/uploads` next to the adapters, canvas migrating node type by node type → delete adapters,
`/v1/*` and this table's "today" column.

**Where** `docs/protocol.md`, `internal/server/runs.go`, `internal/task`, `internal/server/routes_*.go`.

## 54. Media rules are registry data, not handler branches

**Decision** What a workflow may accept from a request — how many images, one or none, which media
kinds, that first/last-frame mode needs two images for `both` but one otherwise — is declared per
workflow in `registry.json` (`accepts`, `frameMode`, `mode`, `promptInject`, `promptReorder`,
`sourceVideoFrames`) and resolved by one function, `workflow.PlanMedia`. The handlers no longer
mention a workflow id.

**What was wrong without it** `handleVideoCreate` carried a `switch entry.ID` with four arms
(`video-h3-t2v`, `-fast`, `-frames`, `-ref2va`), then a second `switch` for the same ids to build
the error hint, plus `requiredImageCount` reverse-engineering minima out of bindings.
`handleImageEdits` hardcoded `entry.ID == "image-qwen21"` with three count rules, and
`handleImageGenerations` matched `strings.HasPrefix(entry.ID, "image-moss-")` to decide whether to
inject layout JSON. Adding a workflow meant editing Go, which is the opposite of the reason
`registry.json` exists.

**Where the rules went**

| Was                                     | Is                                                            |
| --------------------------------------- | ------------------------------------------------------------- |
| `switch entry.ID` for media counts      | `accepts.images/videos/audios {min,max}` + `accepts.minTotal` |
| `switch entry.ID` for the error hint    | `accepts.note`, appended to every refusal                     |
| frame-mode defaults and per-mode counts | `frameMode {default, images{first,last,both}}`                |
| fixed execution mode per H3 workflow    | `mode` (`text`, `frames`, `reference`)                        |
| Qwen's per-mode image counts            | `variants.<mode>.accepts`                                     |
| Qwen's reference reordering             | `variants.edit.promptReorder: "qwen-edit"`                    |
| MOSS layout prompt injection            | `promptInject: "moss-layout"`                                 |
| probing the source video length         | `sourceVideoFrames: true`                                     |

**Three behaviour changes, all deliberate**

1. Error codes are uniform: a too-many-media refusal is `unsupported_media` (was
   `unsupported_video_media` for video, and `invalid_inpaint_media` / `invalid_outpaint_media` /
   `too_many_reference_images` for Qwen). The canvas does not map these codes; the message, which
   now names the workflow's own hint, is what it shows.
2. Multi-reference rejects more than six images instead of silently truncating to six. The canvas
   already caps at six, so only a hand-written request can reach it — and a silent truncation is
   exactly the class of bug this refactor is meant to remove.
3. A first/last-frame request with `frameMode: both` and one image now fails on the image minimum
   before any upload, with a message that says two are needed.

**Tested** `internal/workflow/media_test.go` exercises the rule engine directly and then asserts the
same answers against the _shipped_ `registry.json` — the old hardcoded behaviour, expressed as data.
`internal/server/video_media_test.go` proves the route calls the engine (a frames workflow refuses
no image, refuses audio, and counts two images for `both`) without a workflow id in the handler.
Verified against the running gateway for all six H3 workflows and all four Qwen modes; a real
image generation still passes end to end.

**Where** `internal/workflow/media.go`, `internal/workflow/entry.go`, `internal/server/routes_video.go`,
`internal/server/routes_generation.go`, `workflows/registry.json`.

## 55. The run protocol exists on the wire

**Decision** `POST /api/runs` + `/api/uploads` are the gateway's own shape, not a translation of
someone else's: submit returns `202` with a run id, and status, progress, outputs and cancel all
hang off that id. Media is uploaded first (`POST /api/uploads`) and referenced by role. One row per
artifact, so a batch image request returns several outputs from one run. `docs/protocol.md` is the
contract; this entry records what landed and what deliberately did not.

**Why now, and not "just fix audio"** The audio endpoint needed the queue, and the queue needed one
submission path. Building that path twice — once for `/v1/audio/speech`, once for the real protocol —
would have been the only way to get audio working sooner, and the second version would then have to
be kept in step with the first. The cheaper order was: one execution core, then audio as an adapter
on it, then the protocol itself.

**What landed**

| Piece                                                                                              | Where                                  |
| -------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Queue, persistence, progress, cancel, one `submitRun`                                              | `internal/server/runs.go`              |
| `POST/GET /api/uploads`, `POST /api/runs`, `GET /api/runs[/{id}[/outputs/{i}]]`, preview, `DELETE` | `internal/server/routes_runs.go`       |
| Upload store with retention pruning and a cached ComfyUI reference                                 | `internal/upload`                      |
| Multi-artifact runs (`outputs[]`), per-output paths, `started_at`                                  | `internal/task`                        |
| Audio as an adapter over the same path                                                             | `internal/server/routes_generation.go` |

**Two deliberate limits**

1. **No `wait`.** The audio adapter blocks because the canvas asks it to; the protocol itself never
   does. A `wait` parameter would give every client two success shapes (`200` with an artifact,
   `202` with a run) and reintroduce "the connection died, the work is lost".
2. **Media roles are the conventional names** (`source`, `mask`, `first_frame`, `last_frame`,
   `reference`, `image`, `video`, `audio`) rather than a per-workflow declaration. The role list is
   one table in `routes_runs.go`; making it data belongs with typed `inputs`, and inventing it
   before the canvas uses it would be dead weight.

**Tested** `internal/server/runs_e2e_test.go`: a two-output image run (both artifacts fetched), an
upload used as a reference image (the injected `LoadImage` node carries the ComfyUI name), and the
refusals — unknown role, wrong kind, missing upload, unknown workflow. `internal/upload` covers kind
inference, reload, size limit and retention pruning. `internal/task` covers multi-output storage and
`OutputPath` bounds. Verified live against the real ComfyUI: an audio run through `/api/runs`, a
two-image batch, and a cancel that emptied the ComfyUI queue.

**Where** `internal/server/routes_runs.go`, `internal/server/runs.go`, `internal/upload`,
`internal/task`, `docs/protocol.md`.

## 56. A run's inputs are typed and checked at submission

**Decision** `inputs` is a closed, typed surface. `GET /api/workflows/{id}/schema` publishes it, and
`POST /api/runs` validates against it before anything is queued. Unknown keys are rejected with the
accepted list; types, ranges and `required` are enforced; `quality` is an enumerated value because
the gateway owns the preset names; other `select` options stay advisory because they are ComfyUI's
vocabulary, not ours. The list is assembled from the request-level keys plus the workflow's declared
`parameters` plus its non-media binding keys, so no workflow restates it.

**What was wrong without it** `inputs` was a bag. A typo (`setps`) was silently ignored and the run
quietly used the default; a wrong value (a string where a number belonged, a size that is not a size,
`count: 0`) travelled into the graph and failed inside ComfyUI — for a queued run that meant the
caller got a failed run minutes later instead of a `400` immediately. `count` was also clamped
silently by `BuildContext`, so a request for zero images was answered with one.

**Why these boundaries**

- _Unknown keys rejected_: silently ignoring input is never what the caller meant.
- _Media binding names rejected, with `use media.<role>`_: the two input channels must not blur;
  the error names the right one.
- _Ranges enforced, sampler lists advisory_: ranges are our own declarations (and were corrected
  while doing this — seeds now allow 0, audio steps allow 1). Sampler/scheduler lists are a curated
  UI subset of ComfyUI's; enforcing them would reject valid values the canvas never offered.
- _`/v1/_` stays lenient\* until the canvas migrates: an adapter that suddenly rejects values an
  existing client sends is a behaviour change disguised as a refactor.

**A race found on the way** Running the suite with `-race` exposed a pre-existing bug: `persistNow`
marshalled the live task records after releasing the lock, racing the worker's progress updates.
It now snapshots under the lock. `make test-race` is clean over repeated runs.

**Tested** `internal/workflow/inputs_test.go`: the declared surface is accepted, ten rejection cases
carry the right code and message, media keys point at `media.<role>`, the schema marks `prompt`
required and `count` bounded, and every shipped workflow accepts a minimal request and rejects a
typo. `internal/server/runs_e2e_test.go` drives the same through HTTP, plus the schema endpoint.
Verified live against the real registry: unknown key, `count: 0`, `size: "huge"`, `steps: 999`,
`refs` as an input and `quality: "ultra"` all answer `400` with a message that says what to change,
and a valid audio run still completes.

**Where** `internal/workflow/inputs.go`, `internal/workflow/render.go`,
`internal/server/routes_runs.go`, `internal/task/task.go`, `workflows/registry.json`.

## 57. The protocol exchanges workflow runs, not graphs

**Decision** The gateway's unit of exchange is a _run of a registered workflow_: `{workflow, inputs,
media}` in, a run id out. It does not accept a ComfyUI graph from a client, and it does not hand out
node ids. The graph is server-side data (`workflows/*.json` + `bindings`). The job skeleton — submit,
id, poll, fetch, cancel — is ComfyUI's, because that is what the executor actually offers; the
abstraction above it is ours.

**Why** A graph API makes the client responsible for wiring it can only learn by reading the
workflow: which node takes the prompt, which socket takes a mask, what `"37:13"` means today. Every
client then re-implements that knowledge, and the gateway cannot validate anything until ComfyUI
fails minutes later. Naming a workflow moves that knowledge to the one place that already has it —
`registry.json` — and makes submission-time validation possible (`inputs`, `accepts`). It is also
what the canvas needs: a node stores a workflow id, not a graph.

**What follows from it**

- Media is referenced by _role_, not by filename-in-a-socket, because the binding decides the socket.
- Artifacts and run state belong to the gateway (`data/outputs`, `data/tasks.json`), not to ComfyUI's
  in-memory history, so a result outlives a ComfyUI restart.
- Progress is exposed as polling even though ComfyUI pushes it over a WebSocket: the socket stays an
  implementation detail, and a browser that reloads loses nothing.
- Raw graph submission stays refused (`ui_workflow_not_supported`, `invalid_api_workflow`). The
  exposed surface is the capability set, not the executor.

**The comparison to keep** `docs/server.md` → "Relationship to ComfyUI's HTTP API": endpoint
mapping, the eight differences, and the same request written both ways. Read it before changing the
protocol; it is the shortest description of what we are and are not.

**Where** `docs/server.md`, `docs/protocol.md`, `internal/comfy/client.go` (the endpoints we borrow),
`internal/workflow/bindings.go` (the translation), `internal/server/routes_runs.go`.

## 58. The canvas's first node lives on the run protocol

**Decision** Audio nodes submit `POST /api/runs` and keep the returned id on the node
(`metadata.audioRunId`). A reload reattaches to that run instead of re-submitting, the step ring is
driven by the run's own `progress`, and stopping a generation deletes the run (which interrupts
ComfyUI, so the GPU is actually freed). Channels that are not the local gateway keep the
`/v1/audio/speech` contract.

**Why audio first** It is the newest node in the canvas and the least entangled: no batch, no
reference images, one artifact. It is also the node that most needed what the protocol provides — a
song takes minutes, so "the browser stayed open" must not be a requirement. Doing it first proves
the protocol against a real node before the image and video paths (uploads, multiple outputs) are
touched.

**How the node decides which contract to use** Two conditions, both cheap and both already known:
the channel's base URL is the local gateway, and the model id starts with `audio-`. The gateway's
naming rule is `<type>-<slug>`, so an audio workflow is recognisable without another request; every
other channel keeps the speech call. When image and video migrate, the same rule does the work.

**What it bought, concretely**

- A closed tab or a refresh no longer loses a finished or still-running song: `hasResumableAudioRun`
  keeps the node `loading` through the restore pass, and one effect resumes the poll.
- Stop is real: aborting the wait calls `DELETE /api/runs/{id}` (`cancelOnAbort`), where the old
  blocking call only dropped the connection and left ComfyUI rendering.
- Errors are the gateway's: a refused container or a ComfyUI validation failure arrives as a run
  error with its code and message, not as a generic "audio generation failed".
- The step ring works without a preview stream, which audio never had.

**A bug it exposed** `format: "wav"` used to reach ComfyUI and fail there; the run path now validates
the declared container at submission — fixed one commit earlier, because the canvas now sends the
container the user chose rather than one the adapter guessed.

**Tested** `tests/api-runs.test.ts` (root resolution, submit body, polling to terminal, failed runs,
abort-cancels-only-when-asked, relative output URLs) and `tests/canvas-resumable-runs.test.ts`
(which nodes survive a reload). End to end against a real ComfyUI with the exact payload the canvas
sends: a run reached `succeeded` 30/30 and the downloaded mp3 played; `opus` came back as Ogg/Opus.

**Where** `canvas/web/src/services/api/runs.ts`, `services/api/audio.ts`,
`pages/canvas/hooks/use-generation-runs.ts`, `pages/canvas/project.tsx`,
`lib/canvas/canvas-generation-helpers.ts`.

## 59. A video run carries roles, frames and its own post-step

**Decision** Video nodes submit `POST /api/runs` like every other node, and the request is the
workflow's own contract: `mode` picks the media mix, the frames arrive as `first_frame` /
`last_frame`, multi-reference arrives as `reference` + `video` + `audio`, and `frameMode` says which
frames the request supplies. `interpolation` is a run input the gateway executes: the frame-rate pass
runs on the produced video inside the same run. The task id the node stores is a run id, and the
in-flight preview frame is part of the run payload.

**Why the old shape had to go** `/v1/videos` was the most branch-heavy endpoint in the gateway: one
multipart form whose field names (`image[]`, `images`, `first_frame`, `video[]`, `audio[]`) had to be
resolved against the workflow, a `params` JSON string carrying `frameMode` and `interpolation`, and
task polling split across `/{id}`, `/{id}/content`, `/{id}/cancel` and `/api/previews/{promptId}`. A
video took minutes, so the interesting case — the page reloaded mid-render — was the one the shape
handled worst: the id lived on a task nobody could reattach to, and the preview came from an endpoint
keyed by a ComfyUI prompt id the client never saw.

**Why `interpolation` is an input and not a second run** The alternatives were a client-side chain
(submit, download, re-upload, submit again) or a hidden second run inside the gateway. Both leak the
same thing: two ids, two failure modes and an intermediate artifact nobody asked for. The canvas
wants "a 60fps version of this clip", which is one request and one artifact, so the post-step lives
inside the run — the same code `/v1/videos` uses, which is why the two routes cannot drift. It is also
declared: `interpolation` accepts `off|2x|3x` and nothing else, because unlike a sampler name this
set belongs to the gateway.

**Why `frameMode` is an input when the roles could imply it** A single uploaded `last_frame` cannot
be told apart from a single `first_frame` by counting: the default rule (`byCount`) would call it a
first frame and quietly wire the wrong socket. The workflow already declares which frame modes it
accepts and how many images each needs (`frameMode.images`), so the caller states the mode and the
gateway judges it — one owner for the rule, one message when it is violated.

**What the canvas sends now** `prompt`, `mode`, `seconds`, the pixel `size` the settings imply
(`resolution_name` and `ratio` are derived into it, not sent), `frameMode`, `interpolation`, and the
node's own workflow parameters (`seed`, `steps`, `cfg`, `transition_step`, …). Nothing is renamed on
the way in, so a rejected request names the offending key.

**Tested** `internal/server/video_runs_e2e_test.go`: a last-frame request wires `last_frame` and not
`first_frame`; `both` with one image is `missing_reference_image`; an unknown frame mode is
`invalid_frame_mode`; `interpolation: "4x"` is rejected with the accepted set; a `2x` run submits the
generation _and_ the RIFE graph and still stores one artifact; `frameMode` on an image workflow is
`unknown input`. `internal/workflow/inputs_test.go` covers the video-only input surface and
`InterpolationFactor`. `tests/api-video-runs.test.ts` pins the canvas side: one run per generation,
media by role (frames, references, no media for text-to-video), `interpolation` on the same request,
step and preview reporting, failure named as a video task failure, and cancel only on an explicit
user stop.

**Where** `internal/server/postprocess.go`, `internal/server/routes_runs.go`,
`internal/server/routes_video.go`, `internal/workflow/inputs.go`,
`canvas/web/src/services/api/video.ts`, `services/api/runs.ts`, `pages/canvas/project.tsx`,
`docs/protocol.md`.

## 60. An interrupted image batch reattaches to its run

**Decision** An image node keeps the id of the batch run that is producing it (`metadata.imageRunId`,
the same shape audio uses). A reload finds the node `loading` with its placeholder slots still in
place, and one poll fills them from the run instead of asking the gateway for the images a second
time.

**Why it needed more than the audio pattern** Audio has one artifact and one field to write; an image
batch has N placeholders, N uploads to canvas storage and a node that resizes to its first image. So
the fill step moved out of the live request into `fillImageSlot`, and both paths call it: the live
batch keeps its behaviour, and the resume path is the same code reading the same artifacts in the
same order. That is the property worth having — a reloaded batch must be indistinguishable from one
that never stopped, or the two paths will drift.

**What stays unwritten** A single-image retry (the "regenerate this slot" action) does not record a
run id, because the node it repairs usually already has content and would not qualify as resumable
anyway. Retrying is a deliberate, short action; the batch is the one that can quietly outlive a page.

**Tested** `tests/canvas-resumable-runs.test.ts`: a `loading` image node with `imageRunId` survives
the restore pass (and one with content, or of another type, does not). The fill-and-resume path was
exercised against the real gateway during the image migration.

**Where** `canvas/web/src/pages/canvas/hooks/use-generation-runs.ts`,
`lib/canvas/canvas-generation-helpers.ts`, `pages/canvas/project.tsx`, `types/canvas.ts`.

## 61. The last generation adapters, and why one of them is not a run

**Decision** Video upscale and the multi-angle re-render submit runs. Video upscale is the registered
workflow `video-seedvr2-upscale` with the clip in the `video` role; the angle tool is the hidden
workflow `image-qwen21-angle` with its three camera inputs and the source in the `reference` role. One
adapter is left: `/v1/videos/interpolate`.

**Why upscale was free** It was never an endpoint-shaped operation — it already had a graph, bindings
and declared parameters. The adapter was a form that renamed `batchSize` to `batch_size` and posted
the file as `video`. Deleting it removed that translation and nothing else. Two dialog values
(`scale`, `fps`) are not sent any more because the graph derives them itself (the target short edge
and the source frame rate); sending them as inputs would be a `400`, which is the validator doing its
job on a field that never reached the graph.

**Why the angle tool fits the same shape** `image-qwen21-angle` is a hidden workflow like the others:
a prompt, three angle inputs and one reference image. `wideAngle` is a UI toggle with no counterpart
in the graph, so it is not sent — inventing a binding that reaches nothing would be worse than
leaving the knob out, and the gateway rejects inputs a workflow does not declare, which is how that
stayed visible.

**Why interpolate is different** RIFE is not a workflow the registry knows: it is `_internal/video-rife.json`
applied by the engine as a post-step. "Interpolate this clip" therefore has no workflow to name, and
the honest options are (a) register RIFE as a workflow and delete the engine's interpolator, or
(b) drop the tool. Option (a) means the post-step of a generation run and the standalone tool share
one graph but not one mechanism, so the choice is deferred to the deletion phase instead of being made
in a hurry — the adapter stays until then, and `docs/protocol.md` says so.

**Tested** `tests/api-video-runs.test.ts`: an upscale request is one run whose media is the uploaded
clip and whose inputs are only the declared ones (`scale`/`fps` are absent). Against the real gateway
the request was accepted, the graph was built with the clip wired into `LoadVideo`, and ComfyUI's own
`missing_node_type` error came back on the run — the same failure the adapter produced on that
machine, since the SeedVR2 custom node is not installed there.

**Where** `canvas/web/src/services/api/video.ts`, `services/api/image.ts`,
`pages/canvas/hooks/use-video-editors.ts`, `docs/protocol.md`, `docs/server.md`.

## 62. Frame interpolation is a workflow, not a run input

**Decision** `video-rife` is a registered workflow: one clip in the `video` role, `multiplier` (2 or 3) as an input, its output frame rate derived by a binding (`multiply`, 24 × multiplier). The
`interpolation` run input, its post-step (`internal/server/postprocess.go`), the hand-written
interpolator (`internal/generate/interpolate.go`, 163 lines of its own upload/submit/poll/cancel),
the private `workflows/_internal/` directory and the `/v1/videos/interpolate` adapter are all gone.
Choosing "2×" is now two runs: generate, then interpolate over the result. The canvas chains them.

**This reverses part of #59** That entry kept interpolation inside the run so that "one request is one
artifact" stayed true. The reasoning was half right: the produced bytes are already in the gateway's
hand, so interpolating before storage avoids a download-and-re-upload. Everything else it bought was
worse than it looked:

- It needed **three exceptions** to the rule "a run is one workflow": a private graph directory the
  scanner must ignore, a second executor, and an input that changes what a run means.
- It made **failure lossy**. The artifact is only stored when the run ends, so a missing RIFE node or
  a cancel during interpolation threw away the clip the user had already paid GPU time for. That is a
  correctness bug, not a simplification.
- It made the **missing dependency invisible**: no scan, no resource entry, no way for the canvas to
  warn. (Same root cause as the `hidden` bug reported in the same session.)

The intermediate 24fps clip is not "an artifact nobody asked for" — it is the thing the GPU time
bought. Keeping it is worth two ids.

**What stays** A run is still **one workflow, one job**, so `status`, `progress`, `error` and
`outputs` keep describing exactly one thing. What is dropped is the _user action = one run_
equation: the canvas may chain runs to achieve one effect, and it already had that pattern (its
"interpolate" button was always download → upload → second task → child node).

**Two small engine additions it needed**

- `multiply` in `applyTransform`, with a `factor` on the binding: a derived value written into
  another node, the same shape as `fps` on `secondsToFrames`. Generic numeric coercion, not a special
  case for one workflow.
- `RIFE VFI.ckpt_name` in `ModelLoaderSpecs`. That list is the only thing that makes a model file's
  absence visible; omitting the entry would have kept `rife49.pth` invisible, which is the trap its
  own comment warns about.

**Tested** `internal/workflow/bindings_test.go` (`multiply`: 2 → 48, 3 → 72),
`internal/server/video_runs_e2e_test.go` (a `video-rife` run wires the clip into `LoadVideo`, writes
`multiplier` 3 and `frame_rate` 72 into the RIFE/VHS nodes, and stores one output), plus the shipped
registry still validating. `tests/api-video-runs.test.ts` pins the canvas side: an interpolate request
is one run with `{multiplier}` and `media.video`, and a generation run no longer carries an
`interpolation` input.

**Still open** RIFE's node pack and `rife49.pth` are not declared in `resources/index.json`, so a
clean machine can now _report_ the missing node (it is a registered workflow) but cannot install it
from the panel. Declaring them is the follow-up, and it needs the real folder name the node pack
reports.

**Where** `workflows/video-rife.json`, `workflows/registry.json`, `internal/workflow/bindings.go`,
`internal/workflow/loaders.go`, `internal/server/routes_video.go`, `internal/server/routes_runs.go`,
`canvas/web/src/services/api/video.ts`.

## 63. An input is a key that reaches something

**Decision** A binding key becomes an accepted input only when a caller can actually set it: either
the binding is addressed by its own name (`from: "params.<key>"`) or it has no `from` at all. A
binding that derives its value elsewhere (`size.width`, `seconds`, `quality.steps`, `params.steps`
under a different name) is no longer advertised.

**Why** Those keys were accepted and then ignored, because the binding reads its own source. That is
the same failure as a typo that does not error — the shape #56 set out to remove — except it looked
like a feature: the schema listed `width` on a text-to-video workflow, `steps` on z-image (which only
takes it through a quality preset), and `frame_rate` on RIFE (derived from the multiplier). Sending
any of them did nothing, silently.

**What it caught** The schema now shows what a workflow really takes: H3 loses `width`/`height`/
`length`/`task_type`, z-image loses `steps`/`cfg`/`width`/`height`/`batch`, audio loses
`formatQuality`/`stepsOverride` (both were the _binding_ name of a value written under another key),
RIFE keeps only `multiplier`.

**What still wins** A workflow's declared `parameters` are authoritative and are registered before
bindings, so a declared key stays accepted even when a same-named binding reads elsewhere. That
combination is a registry mistake, not a supported case; it is why `steps` (declared for audio) still
works while feeding the `stepsOverride` binding.

**Tested** `internal/workflow/inputs_test.go`: `width` (from `size.width`) and `batch` (from `count`)
are rejected as unknown inputs, while the self-named `seed` is still accepted. Every shipped
workflow's schema was re-read through the live gateway.

**Where** `internal/workflow/inputs.go`, `docs/protocol.md`.

## 64. The model list belongs to the client

**Decision** `registry.json` has no `hidden` flag any more, and neither do `/api/workflows` rows or
the availability scan. The gateway registers workflows and reports two facts about each: what it
accepts, and whether it can run here. Which of them appear in a model dropdown is decided by the
canvas (`lib/canvas/tool-workflows.ts`), because the canvas is the only client.

**What `hidden` was doing** Four unrelated jobs at once: keeping a workflow out of the model list,
excluding it from the availability totals and the "what is missing" list, refusing the user's own
visibility toggle, and overlapping with `category: "upscale"`. Only the first is a real need, and it
is not a fact about the workflow — it is a fact about our UI. The result was the bug this session
started from: the panel read "14/14 available" while two upscalers were missing three node classes.

**What replaced it** The canvas already knew which workflows it invokes from a button; those ids are
now one exported list, used by the buttons, the request builders and the model-list filter. An id
cannot drift between "the button submits this" and "this appears in the dropdown" because it is the
same constant.

**Also deleted with it: three dead workflows.** `video-esrgan_2x` and `image-seedvr2-upscale` had no
caller left (no button, no model, nothing in the canvas referenced them), and
`image-krea2-aesthetics` was retired — its only trace was a migration shim that remapped a saved
selection to `image-krea2-turbo`. The shim is gone too: the generic "pick the first available model"
fallback covers it. The `upscale` pack lost those two workflows and the 7B SeedVR2 DiT resource only
they used, so the panel no longer offers an 8.5GB download for a workflow nobody can invoke.

**Tested** `internal/server/setup_report_test.go`: a workflow whose node class is missing appears in
the setup status totals and in `missing.nodes` (models and tools alike), and a workflow row carries no
`hidden` field. `tests/tool-workflows.test.ts` pins the client-side list. The live gateway's
`/api/setup/status` and `/api/workflows` were re-read after the change.

**Where** `internal/workflow/entry.go`, `internal/workflow/render.go`, `internal/setup/scan.go`,
`internal/server/routes_admin.go`, `internal/resource/status.go`, `workflows/registry.json`,
`resources/index.json`, `canvas/web/src/lib/canvas/tool-workflows.ts`.

## 65. The image upscaler is a run, and a tool workflow takes exactly one item

**Decision** `POST /v1/images/upscale` is deleted. The canvas's 放大 button uploads the source image
and submits a run of `image-esrgan-upscale` (`inputs: {upscale_model, resolution}`, `media: {image:
[id]}`) like every other image action. `GET /api/upscale/workflows` is deleted too: `/api/workflows`
now carries each workflow's loader-enriched `parameters`, so a client reads the whole catalogue in one
request and decides for itself which entries are upscalers. All four tool workflows declare
`accepts` with `min: 1, max: 1` for the media kind they consume.

**Why the route had to go** It was the last image route that existed only for one button. It resolved
a workflow by id, refused anything outside `category: "upscale"`, and parsed a multipart body — three
things `POST /api/runs` already does, with an id that a reload can resume. The category check was the
only thing it added, and that is a UI concern: "is this a button or a model" is a question about the
canvas, not about the workflow.

**Why `/api/upscale/workflows` went with it** It was a Go-side filter (`category == "upscale" &&
type == "image"`) that re-rendered four fields of a workflow row plus its parameters. The parameters
were the only thing `/api/workflows` lacked, and enriching them there costs one map copy per row, so
the second endpoint became a worse copy of the first. The filter moved into the dialog, next to the
button that needs it.

**Why `accepts` matters here** Without it, an upscale with no image is accepted (202) and fails a
minute later inside ComfyUI when the required binding finds nothing — the failure mode #56 exists to
prevent. `min: 1` makes the same mistake a 400 at submission with the workflow's own note. `max: 1`
says what the graph can honour: ESRGAN upscales one image, RIFE one clip, SeedVR2 one clip, the angle
re-render one source.

**Also cleaned** `registry.json` still carried `hidden: true` on those four entries two commits after
the flag was deleted from the struct. Ignored fields that read like behaviour are worse than no
fields.

**Tested** `internal/server/runs_e2e_test.go:TestRunImageUpscaleTakesOneImage` (image reaches the
graph, `upscale_model` reaches its node, no image is a 400),
`tests/api-image-upscale.test.ts` (one upload + one run, nothing on `/v1`, a failed run surfaces its
message). In the browser: the 放大 dialog listed the three ESRGAN models from `/api/workflows`,
submitted a run, and produced a 4096×4096 PNG node.

**Where** `internal/server/routes_generation.go`, `internal/server/routes_admin.go`,
`workflows/registry.json`, `canvas/web/src/services/api/workflows.ts`,
`canvas/web/src/services/api/image.ts`,
`canvas/web/src/components/canvas/canvas-node-super-resolve-dialog.tsx`.

## 66. Everything under `workflows/` is English _(the one path it kept was not the author's, see #117)_

**Decision** The graphs, `registry.json` and their defaults contain no Chinese. Chinese for a shipped
workflow lives in `i18n/locales/zh-CN.ts` under `gateway.models.<id>.label`, keyed by the id the
gateway sends (#8 already said this; the registry just had not caught up).

**What was mixed** Three unrelated kinds of Chinese in the directory:

- _Copy we author_: RIFE's `label`, its `multiplier` label and description, and the angle workflow's
  default prompt. This is the actual violation — data we ship, in one language, shown to both UIs.
  `video-rife` gained a `gateway.models` entry so the Chinese UI still says "RIFE 帧插值", and the
  angle default is now English because the canvas overrides it with `canvas.generation.anglePrompt`
  anyway: the default only reaches a caller that sends no prompt at all.
- _ComfyUI node titles_ (`_meta.title`): cosmetic labels the author typed, never read by the gateway
  and never shown by the canvas — the only titles we write are our own (`Gateway Ref 1`, `Gateway
Load 2`). Translated anyway, because a reader opening a shipped workflow should not have to guess
  what "① 单采 SelfLift（日常版参数）" means, and a half-translated file is worse than either.
- _A real path_: `image-qwen21-outpaint.json` names its LoRA `Qwen-功能2.1/Qwen21-图像扩展…safetensors`,
  and `resources/index.json` installs it at exactly that path. **Left alone** — that string is a
  filename on disk, not copy.

**Cost** A workflow re-imported from an author's file comes back with its Chinese titles; the same
pass has to be applied again. The registry is the part that matters, and it is machine-written.

**Also found** `resources/index.json` was Chinese-only: pack labels and descriptions render verbatim
in the resource panel, with no key indirection. That is #67; it could not be fixed by editing JSON
alone.

**Where** `workflows/*.json`, `workflows/registry.json`, `canvas/web/src/i18n/locales/zh-CN.ts`.

## 67. The resource catalogue is English; its Chinese lives beside the app _(one of the two paths was not upstream's, see #117)_

**Decision** `resources/index.json` carries no Chinese copy — pack `label`/`description`, resource
`label`/`note`/`license` are English. The Chinese sits in
`canvas/web/src/lib/resource-copy-zh.ts`, keyed by pack/resource id, and
`ResourceCenterPanel` looks it up before falling back to the index text. Vendored third-party content
under `resources/payload/**` is untouched: it is the upstream author's text, not ours.

**Why the index had to change** The panel renders those fields verbatim, so the English UI was showing
Chinese — the one place the "English data, Chinese in the dictionary" rule (#8) was still broken in a
way a reader could see. Translating it also makes the index readable to anyone auditing what gets
downloaded.

**Why a map and not the i18n dictionary** Resource ids contain dots: `qwen3.5_9b_int8_convrot`. With
`keySeparator: "."` such a key is read as a nested path and never resolves, so the natural home for
"Chinese keyed by id" (`gateway.models.<id>`, which works because model ids have no dots) does not fit.
A typed `Record<string, …>` next to it is the same idea with the id treated as an opaque string. The
`resolvedLanguage` check is copied from `gateway-labels.ts`, so both tables switch language the same
way.

**What is still Chinese, on purpose** Two `target` paths name files the upstream authors published in
Chinese (`loras/Qwen-功能2.1/…`, `loras/Moss_image/KOOK-MOSS-SFT-观澜.safetensors`). They are disk
paths, not copy; translating them would break the install. A test fails the build if any _other_ field
grows Chinese again.

**Tested** `tests/resource-copy-zh.test.ts`: Chinese for pack/resource/license in `zh-CN`, nothing at
all in `en-US` (so the index text stands), nothing for an unknown id, a dotted id resolving, and the
index itself containing Chinese only in `target`. In the browser: the Add-workflows panel reads in
English with the language set to English and in Chinese with it set to 中文, over the same rows,
including the LoRA whose path stays Chinese.

**Where** `resources/index.json`, `canvas/web/src/lib/resource-copy-zh.ts`,
`canvas/web/src/components/settings/resource-center-panel.tsx`.

## 68. There is no `/v1/models`; a workflow reports the ids it answers to

**Decision** `GET /v1/models` is deleted. `GET /api/workflows` gained a `models` array per row —
`{id, label, baseModel, baseModelLabel, imageInputs}` — built by the same expansion `ResolveModel`
accepts. The canvas syncs from it (`hooks/use-local-gateway-sync.ts` → `lib/gateway-models.ts`) and
decides what the picker offers.

**Why the endpoint had to go** It was the last route whose only job was to present, and it presented
the wrong shape: an OpenAI envelope around a _workflow_ list, with `object: "model"`, `owned_by` and a
`metadata` bag holding what the workflow really is. Everything in it was a fact about a workflow, so it
belongs on the workflow row.

**Why the ids could not just be dropped** The tempting simplification — "a model id is just the
workflow id" — is wrong for two graphs. Z-Image and Krea2 have selectable base models, each combination
has its own spelling (`img-zit-int8`, `img-k2t-int8`), and only `ModelIDFor` knows how to build it and
only `ResolveModel` knows how to read it back. A client that invented the spelling would be guessing at
a gateway rule. So the list moved, it did not disappear: `models` is the gateway reporting the names it
will answer to.

**What stayed in the client** Three decisions, none of which is a fact about a workflow: a workflow
whose `type` the canvas cannot render is not a model; a workflow the canvas drives from a button
(`lib/canvas/tool-workflows.ts`) is not a model; a disabled (`enabled: false`) or unavailable workflow
is not offered. `lib/gateway-capability.ts` went with the endpoint — it existed to guess a capability
from a name or a metadata field, and the workflow's own `type` is the answer.

**Cost** One more request than a list of names would need, and the client has to do the flattening. In
exchange there is one endpoint describing workflows, and the picker is testable without a browser: the
mapping is a pure function (`tests/gateway-models.test.ts`, 11 cases).

**Tested** Go: `TestWorkflowsReportTheirModelIds` (a row carries `models`, `enabled`, `availability`),
`TestWorkflowsReportOneIdPerBaseModel` (two installed base models → three ids, each naming its file),
`TestWorkflowVisibilityToggles` (a hidden workflow stays in the list as `enabled: false`; filtering is
the client's). Canvas: `tests/gateway-models.test.ts`. In the browser: `/v1/models` answers 404, the
channel holds the same 17 models as before with their `workflowId` / `baseModel` / `imageInputs`, the
base-model sub-dropdown still lists `默认底模 / z_image_bf16 / int8`, and a generation run through it
returned three images.

**Where** `internal/server/routes_admin.go`, `internal/server/e2e_test.go`,
`canvas/web/src/services/api/workflows.ts`,
`canvas/web/src/hooks/use-local-gateway-sync.ts`,
`canvas/web/src/lib/gateway-models.ts`, `canvas/web/src/services/api/image.ts`
(`fetchChannelModels`).

## 69. `/v1` is gone

**Decision** The gateway has no `/v1/...` route. `POST /api/runs` is the only way to produce media;
`GET /api/workflows` describes what can run; the prompt services and the two in-flight helpers
(`/api/previews/{id}`, `/api/progress/{id}`) are everything else.

**What was deleted** Nine routes and the code that existed to translate into them:
`POST /v1/images/generations`, `POST /v1/images/edits`, `POST /v1/videos`, `POST /v1/videos/upscale`,
`GET /v1/videos/{id}`, `GET /v1/videos/{id}/content`, `POST /v1/videos/{id}/cancel`,
`POST /v1/audio/speech`, `GET /v1/tasks/{id}`. With them went the request readers nothing else used:
`requireModel`, `parseParams`, `imageFiles`, `matchesImageField`'s multipart role, `uploadFiles`,
`orderedVideoFiles`, `orderedVideoRefs`, `orderedAudioRefs`, `toUploadResults`, `mediaNames`,
`firstMediaName`, `queuedPayload`, `imageResponse`, `runImageWorkflow`, `waitRun`, `runFailure`,
`runResultBuilder` (no caller ever passed one), and three files of adapter tests.

**What replaced each of them** Nothing: every caller was already moved. The canvas's image, video,
audio, upscale, interpolate and angle actions all submit runs, and the audio "blocking call" contract
was the last thing that needed an adapter — the run id answers it.

**The bug the deletion flushed out** All three media modules decided "is this the gateway?" by the
model's _name_: `<type>_WORKFLOW` regexes (`image-`, `video-`, `audio-`). A base-model variant is
`img-zit-int8`, which matches none of them, so selecting the int8 base model would have sent the
request to `/v1/images/generations` — a route that no longer exists. The channel is the only thing that
decides which contract a request speaks, so the three predicates are now `isLocalGatewayUrl(baseUrl)`.

**What the canvas still had, and lost** The `/v1`-shaped request builders
(`/images/generations`, `/v1/videos/{id}`, `/audio/speech`) once stayed on the theory that another
channel might speak OpenAI. #71 removed the second channel, so those builders had no caller and went
with them: the gateway's `/api/runs` is the only path any node takes.

**Cost** The gateway can no longer serve a client that speaks OpenAI. That was the goal: it never spoke
it honestly — one route was `/v1/images/upscale`, another took a `params` JSON string, and every media
rule was a branch keyed to a workflow id.

**Tested** `make check` and `make test-race`; the two audio adapter tests became
`audio_runs_e2e_test.go` (caption + lyrics as ordinary inputs, ComfyUI's own error code on failure);
`video_fixture_test.go` kept only the shared fixture and multipart helper. In the browser: a fresh
page load syncs its models, generates an image, and lists the workflows with no request to `/v1`.

**Where** `internal/server/routes_generation.go`, `internal/server/routes_video.go` (deleted),
`internal/server/runs.go`, `internal/server/server.go`, `internal/server/helpers.go`,
`canvas/web/src/services/api/{image,video,audio}.ts`, `docs/protocol.md`, `docs/server.md`,
`README.md`.

## 70. Saved names are keys, not translations

**Decision** A name the app generates is stored as a translation key, and rendered in the reader's
language: `CanvasNodeData.titleKey` (+ `titleParams`) and `ModelChannel.nameKey`. `title` / `name` stay
on the record as the snapshot — what a filename, an export, or a user-typed name looks like. Editing a
title (or a channel name) clears the key: from then on the node says exactly what the user wrote.

**What it fixed** Everything the app wrote down was written in the language that happened to be active.
A canvas created in Chinese showed "图片", "音频" and "AI 超分" as node titles in the English UI, and the
channel was called "本地 ComfyUI" there too. #66 and #67 fixed the _shipped_ text; this was the other
half — generated text that outlives its session.

**Why not store only the key** Two of the three uses of a title are not UI: `${node.title}.png` names a
reference image, and the canvas export writes it into a file. Those need a string now, in whatever
language. So the key drives display and the snapshot drives data, and a node without a key keeps working
as before — a user-typed title, or one from a canvas written by an older build.

**The migration** `CANVAS_PERSIST_VERSION` 2 adds `titleKey` to a stored node whose `title` matches one
of the app's own defaults **in either language**; the same idea runs over the channel list on load (no
version bump: the config store already rebuilds channels every time it reads). The matching list lives in
`lib/canvas/node-title.ts` and has to be extended when a new default title is added; the test fails when
a stored default goes unrecognised.

**What is deliberately still a snapshot** Titles that _compose_ several translations — the multi-angle
label (`前方 · 俯视 10° · 正面视角`), the split title's source name — store the composed string. They are
descriptions of a particular moment, and rebuilding them would need the parameters, not just a key. The
`Copy` suffix and asset titles (which are prompts) are the same kind of thing.

**Tested** `tests/node-title.test.ts` (key wins, params pass through, a typed title is untouched, a dotted
id, whole-title matching, `channelName` both ways) and a case in `tests/persist-migration.test.ts` (a
stored "音频" becomes `canvas.nodeTypes.audio`, a typed title and an explicit key are untouched). In the
browser: the existing canvas, created in Chinese, shows "Audio" and "Local ComfyUI" in English, and
"音频" / "本地 ComfyUI" again after switching back — with nothing edited in between.

**Where** `canvas/web/src/lib/canvas/node-title.ts`,
`canvas/web/src/constant/canvas.ts`,
`canvas/web/src/stores/canvas/canvas-persist.ts`,
`canvas/web/src/stores/use-config-store.ts`,
`canvas/web/src/components/canvas/canvas-node.tsx`,
`canvas/web/src/pages/canvas/hooks/use-image-editors.ts`,
`canvas/web/src/pages/canvas/project.tsx`.

## 71. There is one channel, and it is the gateway the page came from

**Decision** The canvas has exactly one model channel. Its address is the gateway that served the page
(`constant/app-mode.ts`), its model list is whatever `GET /api/workflows` reports, and the channel editor
keeps only two things: a name and a per-model capability override. "Add a channel", "choose a provider"
and the address field are gone.

**Why** A channel was a cloud provider: an address, an API key, a model list typed in by hand. This build
talks to one gateway and to nothing else, so the list could only ever hold one entry whose fields were all
either fixed or derivable — and a second entry would be a way to point the canvas at something that is not
this gateway, which is the one thing the local-only rule forbids. The capability override survives because
it is the only field with information the gateway does not have: a workflow whose `type` is not what the
user wants it to be.

**Cost** Pointing the canvas at another gateway is a `dist/config.js` / `START.sh` job
(`LOCAL_COMFYLOFT_SERVER_URL`), not a settings-screen job. A saved config from a build with channels is repaired
on read: the first channel that points at this gateway wins, the rest are dropped, and a backup of the
original blob is left in `localStorage` under `…:pre-local-only-backup`.

**Where** `canvas/web/src/constant/app-mode.ts`,
`canvas/web/src/stores/use-config-store.ts` (`merge`),
`canvas/web/src/components/settings/channel-editor-drawer.tsx`,
`canvas/web/src/components/layout/client-root-init.tsx`.

**Tested** `npm run check`, `npx vitest run` (the config-store merge cases), and in the browser: a cleared
config syncs the gateway's workflow list, the editor shows one channel, and its address field does not
exist.

## 72. The gateway address has no `/v1`

**Decision** `LOCAL_GATEWAY_BASE_URL` is the gateway's **root** (`http://host:8190`), and
`start.sh`/`config.js` inject it that way. A trailing `/v1` is still accepted on input and stripped
in exactly one place (`gatewayRoot`), so an older `config.js` or a stored channel keeps working.

**Why it was still there** The base URL was written when the gateway spoke OpenAI's paths, and
deleting the routes did not touch it: the value was carried around with `/v1` on the end and each
caller stripped it again before using it — `gatewayProtocolRoot`, `local-session`, `resources`,
`canvas-system-status`, two plugin-host fetches, plus the config store's own normalization. Six strips
for a suffix nothing needed.

**What replaced them** One function, `gatewayRoot(url)` in `constant/app-mode.ts`, applied where the
address enters the app (the injected value and a persisted channel). The call sites now use the value
directly, which is what makes "there is no `/v1`" true rather than maintained by convention.

**Kept deliberately, then removed** `buildApiUrl` appended `/v1` for the prompt-API endpoint. It was
the last caller of the canvas's chat path, which had no gateway endpoint behind it; decision 73 gave
that path a real endpoint (`POST /api/prompts/chat`) and `buildApiUrl` went with the client it served.
The model server's own `/v1/chat/completions` is now reached only by the gateway, from the base URL
the settings hold.

**Cost** A hand-written channel entry that points at a path like `https://host/openai/v1` loses the
suffix. Nothing in this build talks to such an endpoint: the gateway and the prompt API are configured
separately.

**Tested** `make check`, `npm run check`, `npx vitest run` (117). In the browser, with a cleared config:
17 models sync from `http://127.0.0.1:8190`, the stored channel address has no `/v1`, and a recorded
network capture shows every gateway request on `/api/...` with no `/v1` path anywhere.

**Where** `canvas/web/src/constant/app-mode.ts`, `start.sh`,
`canvas/web/src/services/api/{runs,resources}.ts`,
`canvas/web/src/components/canvas/canvas-system-status.tsx`,
`canvas/web/src/pages/canvas/hooks/use-plugin-host.tsx`,
`canvas/web/src/stores/use-config-store.ts`. (The `lib/local-session.ts` this list used to
name went in #109, and `POST /api/prompts/chat` — the endpoint #73 gave the prompt path — went in #76
when prompts became the agent's socket.)

## 73. Text is a prompt route, not a model

**Decision** `POST /api/prompts/chat` answers one prompt with one text: `prompt` (required), `system`
and images (optional), plus the endpoint's `promptBaseUrl` / `promptApiKey` / `promptModel`. The gateway
adds no wording of its own and answers once — no streaming.

**Why the canvas needed it** The text node and the plugin API's `generateText` called OpenAI's
_Responses_ API (`POST /v1/responses`) straight at the channel address. The gateway has never served
that path — it went with the rest of `/v1` — so in this build every text generation was a 404. The
canvas was carrying a whole Responses client (SSE parsing, tool calls, `input_text` / `input_image`
conversion) with nothing on the other end.

**Why not OpenAI compatibility** Serving `/v1/responses` or `/v1/chat/completions` would have meant the
gateway re-implementing another protocol for one feature. The host that actually answers is the
configured model server; the gateway's only job there is to be the party that sends the request.
`/api/prompts/chat` is that job and nothing else: it reads the prompt, hands it to the same `chat()`
the other three prompt routes use, and returns `{text, model, elapsedMs}`.

**The one thing it decides** An empty `system` is omitted rather than sent as an empty turn: a model
that receives a blank system role may answer it instead of the prompt. `Optimize`, `OptimizeImage` and
`Caption` all pass a system message, so nothing else changed.

**What the canvas lost** The streaming consumer, the tool-call types and `buildApiUrl`. A text node
shows "generating" and then the answer, which is what a non-streaming route can report, and a plugin's
`onDelta` fires once with the whole answer. Text nodes still ask for several variants (`textCount`):
the canvas sends N requests, so the gateway's contract stays one in, one out.

**What replaced the model guard** Text used to be gated on a channel model (`isAiConfigReady`), and no
workflow has a text capability, so a text node could never start — the click opened the settings and
nothing else. The gate is now `promptEndpointReady(config)` (the endpoint's base URL, key and model),
which sends the user to the prompt-API tab, and the config node's empty "pick a model" shows the
endpoint's model instead: the only model that answers.

**Tested** `make check`, `make test-race`, `npm run check` (lint, types, i18n, exports), `npx vitest
run` (124). New: `internal/server/prompt_chat_e2e_test.go` (the configured endpoint and the one user
turn, system plus image parts, unconfigured settings, the endpoint's own error, an empty prompt),
three `Optimizer.Complete` cases, `tests/api-prompts.test.ts` (7) for the form the canvas builds. In
the browser, against a real model (`qwen3.8-27b` on `172.16.9.7:9999`, configured through the settings
UI): a text node holding "写一句关于海边灯塔的诗，不超过二十个字" produced "灯塔守夜，潮声吻着星光"; the
gateway log shows `POST /api/prompts/chat 200` and one `POST /v1/chat/completions` to the model server,
and the browser's own capture shows no `/v1` path on the gateway.

**Where** `internal/prompt/optimizer.go` (`ChatRequest`, `Complete`, `chatMessages`),
`internal/server/routes_generation.go` (`handlePromptChat`, `promptCloud`, `promptImageURLs`),
`canvas/web/src/services/api/prompts.ts` (the four prompt routes, moved out of `image.ts`),
`canvas/web/src/services/api/image.ts`,
`canvas/web/src/pages/canvas/hooks/{use-generation-runs,use-plugin-host}.tsx`,
`canvas/web/src/pages/canvas/project.tsx`,
`canvas/web/src/stores/use-config-store.ts`,
`canvas/web/src/components/canvas/{canvas-config-node-panel,canvas-node-prompt-panel}.tsx`.

## 74. The prompt endpoint is called what it is, and text has no model

**Decision** Three leftovers from the cloud era, removed together:

1. `cloud` → `prompt` everywhere it meant "the configured chat endpoint": the Go type is
   `prompt.Endpoint`, the request fields are `promptBaseUrl` / `promptApiKey` / `promptModel` /
   `promptEndpointId`, the config keys are `promptBaseUrl` / `promptApiKey` / `promptModel` /
   `promptEndpoints` / `promptEndpointId`, the settings tab is `prompt-api`, and the error codes are
   `prompt_not_configured` / `prompt_invalid_url` / `prompt_api_failed` / `prompt_api_timeout`.
2. `ImageCaptionEngine` (`"qwen35" | "florence" | "cloud"`) is gone. Only `"cloud"` was ever
   produced — the canvas hardcoded it and the gateway always answered it — so the union documented
   two engines that do not exist. `captionEngine` / `captionEngineUsed` went with it, and so did the
   `provider: "cloud"` / `engine: "cloud"` fields the gateway echoed back: one producer needs no label.
3. Text mode has no model picker. It offered "text models" (a capability no workflow has, so the list
   was always empty) plus a `caption:cloud` entry that was really a mode switch. Both are replaced by
   the prompt endpoint's model in a read-only chip, and by a separate **反推** button beside the send
   button.

**Why now** The rename was deferred while `/v1` was being deleted, and the caption union was blocked
by the same thing: with `docs/known-issues.md`'s text node still 404ing there was no working path to
name. Decision 73 created it, so the names had to follow — "cloud" described a provider that this
build does not have, and a picker with an empty list is not a choice.

**What the split means for the four routes** The endpoint travels per request, but there is exactly
one of it in the settings, so the canvas services read it instead of taking it as an argument: the
three call sites that each rebuilt `{ baseUrl, apiKey, model }` from config now pass nothing. Images
are attached only where they are read — `optimize-image` and `optimize` never sent them anywhere, and
`optimize-image` is text-only by design, so its client stopped uploading files it knew would be
ignored.

**Migration** A saved config that still says `promptCloud*` is read once by
`withLegacyPromptFields()` and written back in the current spelling only. It is four keys and a
rename; silently dropping a working endpoint would be a worse bug than the name ever was.

**Cost** A hand-written client posting `cloudBaseUrl` gets a `prompt_not_configured` 400 instead of
silently working. Nothing outside this repository calls these routes.

**Tested** `make check`, `make test-race`, `npm run check` (lint, types, i18n, exports), `npx vitest
run` (128; new `tests/config-migration.test.ts` covers the rename, "current spelling wins" and "no
prompt fields at all"). In the browser with the pre-rename config still in localStorage: the config
node and the text panel show `qwen3.8-27b` (migrated, not re-entered), the settings tab lists the
endpoint as "使用中", a text generation answered `孤灯向海，夜浪无声` via `POST /api/prompts/chat`, and the
caption route returned a prompt with no `engine` field.

**Where** `internal/prompt/optimizer.go`, `internal/server/routes_generation.go`,
`canvas/web/src/lib/config-migration.ts`,
`canvas/web/src/stores/use-config-store.ts`,
`canvas/web/src/services/api/prompts.ts`,
`canvas/web/src/components/canvas/canvas-prompt-endpoint-chip.tsx`,
`canvas/web/src/components/canvas/canvas-node-prompt-panel.tsx`,
`canvas/web/src/components/canvas/canvas-config-node-panel.tsx`,
`canvas/web/src/components/settings/app-config-modal.tsx`,
`canvas/web/src/types/canvas.ts`.

## 75. Prompts are served by AlayaCore, and one instance belongs to one person

**Status** decided, not implemented. Today the four `/api/prompts/*` recipes and their in-process
chat client are still what runs; this entry records the target so the code that replaces them does
not have to re-litigate it.

**Decision** The gateway stops calling a chat-completion endpoint and starts **spawning the agent**:
one request → one `alayacore --rawio` process → one event stream → process released. Nothing else
lives longer than that; the canvas's panels do not keep an agent alive. The prompt
surface collapses to a single route (`POST /api/prompts/chat`), and `internal/prompt` (the chat
client, the four recipes, the H3 skill assembly, the sanitisers, the speaker tags) goes away. No dual
backend and no fallback: a second path would be two configuration stories and two code paths for one
feature.

**Why this is not over-engineering here** This repository is part of the AlayaCore ecosystem, so the
binary is a prerequisite the way ComfyUI already is: nothing to install, nothing to version by hand.
What it buys: the canvas no longer has to be told a base URL, key and model (they are in the agent's
`model.conf`, which the user already has); the gateway's guessing at "which thinking parameter does
this endpoint want" is replaced by the agent's per-model `reasoning_0/1/2`; and four routes, four
response shapes and four error vocabularies become one. What it costs: process-level failures (spawn,
crash, hang, stderr-only errors), a protocol dependency with a `message_version`, and more tokens per
request (the agent's own system prompt, and one extra step if a skill has to be read). Spawning is not
itself expensive — a rawio session reaches `SM session ready` in ~30 ms on this machine, so releasing
the process after each request is cheaper than keeping one warm.

**Tenancy is the security model** The gateway is **single-tenant**: one instance serves one person and
uses **one** AlayaCore config directory — `os.UserConfigDir()/comfyloft-server/alayacore` by default
(`~/.config/...` on Linux, the right place on macOS and Windows), overridable with
`AGENT_CONFIG_PATH`. The gateway does not create or validate it: the agent creates what it needs on
first spawn, and a fresh directory comes with AlayaCore's own Ollama default, which exists to be
_seen_ — see "The model is visible and selectable" below. There is no per-request identity, so there
is nothing to map a second user onto — and therefore no per-user credential to leak: a caller of
`:8190` spends that instance's own keys, exactly as it already spends that instance's GPU on
`POST /api/runs`.

**If the gateway ever serves more than one user**, each user must have their own AlayaCore config
directory, and that requires real identity (a login/session the gateway can resolve a request to) —
not a shared secret. `GATEWAY_TOKEN` would not be that answer: it is injected into the page, so
anyone who can open the canvas can read it. Until then, one directory, and the rule that makes it
safe: **the config path, the skill container and the tool list are gateway settings and never fields
of a request.** They are the user's to change — there is no separate operator in a one-person install
— but they are changed in the gateway's own settings, not per call: a request that could name its own
`--config-path` would turn "every user has their own directory" into "the caller picks whose directory
to read", and a request that could name its own tool list would let the caller undo the one switch
that decides whether the agent can run commands.

**Security posture, stated plainly** No token is required to enable the agent, because there is no
token at all (#110). `COMFYLOFT_SERVER_HOST` defaults to loopback and binding anything else emits a startup
warning. The one built-in tool the spawn enables is `read_file`, and it is not a field of a request:
the H3 rewrite loads its `SKILL.md` with it, which is what changes the risk class of an exposed port
from "uses your quota" to "reads your files".

**Cancel belongs to the agent** Its `CI cancel` command winds a task down on its own terms — it is
the process that knows what a half-finished step means — so the gateway does not layer its own
timeout on top, and it does not invent a reaper either. A request that ends early sends `cancel` and
stops reading; the process exits when it says it has.

**Nothing binds to a window** The process lives for one operation and no longer: spawn when the
request arrives, release on `done`/`error`/cancel. It is not tied to a panel's lifetime, so there is
no idle agent to reap, no TTL, no "the panel is still open but the process was reclaimed" state to
hide, and no per-node processes for the config nodes that are always on screen. A spawn costs ~30 ms,
which is why re-opening one for every ✨ press is the cheap end of the trade.

**One route, one stream** A prompt and a command are the same kind of thing to AlayaCore — frames on
its stdin — so they are one route (`POST /api/agent/chat`) and one stream: what the request carries is
written to the agent (a `command` + `args` for a setting change, a `prompt` and images for a question,
either or both), and what the agent says comes back. Two routes would have been two ways to say one
thing.

**The model and the level are the user's, and the gateway only shows them** Everywhere the canvas
uses the agent there is a model `<select>` and a reasoning-level control. The gateway does not track,
remember, re-send or validate either of them. It displays what the agent says — `SM model` and `SM
reasoning_level`, forwarded as they arrive — and when the user changes one, the canvas sends the
agent's own command (`model_set`, `reasoning_level_set`) and the agent's answer comes back on the same
stream. Whether a
setting survives a session is AlayaCore's business: it persists the model in `runtime.conf` and does
what it likes with the level, and the canvas shows whatever it reports next.

**The list arrives with the answer, not before it** `SM model_list` and `SM model` are part of the
startup broadcast of every spawn, ahead of the model call. The gateway forwards them as one `models`
event with **every `api_key` stripped**, and the canvas renders the select from the last such event.
There is no listing route, no probe and no gateway-side cache: an empty picker before the first
request in a page is the honest state, and one request fills it.

**The event surface is a whitelist** `delta` (Ax text), `reasoning`, `step` (SM `task`), `done`,
`error` (+ an optional one-line `tool` state). Everything else the agent emits stays on the gateway:
`SM model_list` carries every `api_key` from `model.conf` verbatim, and `mcp`/`theme`/`video_config`/
`CO` have no meaning for a canvas node. The gateway is an adapter, not a pipe.

**Borrowed, not invented** `internal/wire` (frame codec, tests) and `internal/core` (spawn, stderr
tail, kill order, binary discovery) come from the Go backend of the AlayaFace project, which is the
same adapter for a different client. `message_version` is validated at startup, because the codec now
exists in three repos and drift between them is a real failure mode.

**Still open** Where the H3 wording lives: (a) an Agent Skill loaded with `read_file` (one extra model
step, and the agent gains read access), or (b) `--system` assembled by the gateway and passed at spawn
(single step, no file access). The decision waits on a measured comparison of the two outputs.

**Also noted for later** The canvas will eventually grow a settings page for the agent's models. It
must write through the agent's command plane (`CI model_sync` with the model array, `CI model_set` to
switch) rather than parsing `model.conf` from Go: the file format (`protocol_type`, `reasoning_0/1/2`,
…) belongs to AlayaCore, and going through the agent is what keeps it there.

## 76. The prompt recipes are deleted; the agent route is the only one

**Decision** The four `/api/prompts/*` routes, `internal/prompt`'s chat client and its recipes (the H3
skill assembly, the two sanitisers, speaker tags, frame alignment), the prompt-endpoint settings in the
canvas and the model/key/base-URL fields they carried are gone. What replaced them is `#75`'s one route:
`POST /api/agent/chat`, a prompt and/or one of AlayaCore's commands in, its frames out.

**Why** They had had no caller since the canvas moved to the agent, and their whole job — writing the
wording, choosing the model, cleaning the answer — is the agent's now. Keeping them was keeping a second
backend, a second configuration story (a base URL and a key in the browser) and 900 lines that could
drift from the skill they duplicated.

**What went with them, and where it went instead** The H3 wording was already a shipped Agent Skill
(`prompts/skills/h3-prompt-writing/`), so it stays exactly where it was and the agent loads it with
`read_file` — the one tool the spawn enables. The canvas now says "rewrite this into a MiniMax H3
prompt, task type …, duration …" and nothing else. `promptOptimizeLanguage` survived: the instruction
still has to say which language to answer in.

**Logging, because the transcript is the API** Every agent operation writes a line a reader who knows
AlayaCore can follow: the request (`command`, `args`, the prompt's head, how many images), the spawn
(pid, binary, config dir, skills container, tools), **every frame in both directions** (`agent >> UX`,
`agent << SM`, … with the value truncated at 400 runes), the release (exit, stderr's last line, how long
it lived), and a closing count per event type. `api_key` values are redacted: `SM model_list` carries
every key from `model.conf`, and a transcript is worth having without them.

**Tested** `make check` (14 packages), `npx vitest run` (121), `npm run check`. Against the real agent:
a prompt streamed `models`/`reasoning`/`delta`/`done` with the frame log, a command-only request changed
the reasoning level and logged its `CI`/`CO` pair, and the browser generated text, switched models and
optimised an image prompt through the one route.

## 77. Regenerating an image answers in that node; a variant is a node you make

**Decision** `nodeRegenerateBehavior` is gone. Pressing generate on a node that already holds a result
replaces that result, always. Nothing is created beside it, and the old image is not quietly fed back in
as a reference. The "原图" leading reference (`canvas.references.source`, `leadingNode`) went with it,
and so did `Radio` in `components/kit/choice.tsx`, which had no caller left.

**Why** The setting offered two answers to one button: _overwrite_ meant "re-roll this one", _new node_
meant "keep this, and make another one conditioned on it" — it created the sibling **and** inserted the
old image into the request as a reference. So the same press meant two different things depending on a
preferences toggle, and the meaning leaked into the result: with the default, pressing generate twice
gave you two images, the second one not a re-roll but an edit of the first.

**Both real intents already have explicit routes.** A variant conditioned on an image is a new node with
that image picked in 参考内容 (`requestEdit`); a variant of a _prompt_ is a config node pressed twice,
since the config node keeps the prompt and never reuses a result node. Neither needed the toggle — the
automatic path was the manual path, performed silently on the user's behalf.

**Where a reference actually comes from** An image node's references are **connections**
(`buildNodeMentionReferences(node, nodes, connections)`); picking one in 参考内容 is that connection
being made (`project.tsx`, the picker appends `{fromNodeId, toNodeId}`). The `@` mention is a different
thing and lives elsewhere: the config node's 组装提示词 composer writes `@[node:…]` into the text, and
double-clicking a text node gives a textarea with an `@` menu. An image node's prompt box is a plain
textarea — there is no `@` there, and saying otherwise would send people looking for a menu that is not
in that panel.

**Cost, stated plainly** Pressing generate on a finished image destroys it. To keep it, 复制 the node
first, or make the new node before generating. This is the trade the decision buys: the button does one
thing, and the thing it does is visible in the node you pressed.

**Tested** `npm run check` (i18n 1049/1031, no dead keys, exports clean), `npx vitest run` (124). In the
browser against `:8191`: an image node with content and no references showed only the add button in
参考内容 (the "原图" chip is gone), pressing 生成 kept the node count at 26 and replaced that node's image
through `image-z-image-turbo` — a plain generation, no edit workflow, so no source image was sent — and
the preferences page no longer lists the option.

**The sediment, and where it went** A persisted blob keeps whatever it was written with, and the store's
merge spread it over the defaults — so every field deleted from `AiConfig` (`promptEndpoints`,
`reasoningEffort`, `nodeRegenerateBehavior`, and the `promptCloud*` / `channelMode` / `apiFormat` /
`videoInterpolation` names before them) stayed in state and was written out again on the next change.
`use-config-store.ts` now drops those names at the merge, from one list, with the reason attached.
Nothing reads them and the values need no migration: the setting they describe is gone.

## 78. A mask belongs to the node that shows it

**Decision** The mask annotation node carries the mask the workflow consumes: `metadata.mask` holds
the storage key of the file that goes out as `media.mask` — binary for the inpaint workflows, the
drawn-over picture for the ones that accept that. Its own picture stays the mask painted over the
source, because that is what a person needs to see. Inpaint runs take the mask from whichever connected
node carries one; `submit()` opens the mask editor only when no connected node does, so wiring a source
and a mask node by hand works exactly like a run the editor made.

**Why not the result node's saved references** `buildImageGenerationMetadata` already records the
references a run used, so an inpaint could re-run from `metadata.references`. That was the first attempt
and it is wrong in two ways. It is a string, not a thing the canvas shows: `collectImageStorageKeys`
only counts objects with a `storageKey`, so the binary mask was treated as garbage and deleted, and the
run then fell back to the connected picture — a blue-tinted photograph in the `media.mask` slot, which
inpaints nothing and reports nothing. And it makes the connections a second, silently overridden
answer, so re-wiring a different mask would be ignored.

**What the binding buys** The file is part of a node, so a storage cleanup keeps it; the request is
whatever is connected, so #77 still holds and a mask can be swapped by re-wiring; and pressing generate
on an input of a run repeats the run because that is what the graph says, not because a hidden string
was found.

**The cost** Mask nodes made before this have no binding, and their binary mask is gone — deleted by
the cleanup that caused the bug. Pressing generate with one connected now opens the editor instead of
sending a picture where a mask belongs: one honest re-mark, and that node is fixed for good.

**Tested** `image-qwen21` on `:8191`, three runs over the same source. The editor's run uploaded mask
`7b985050…` (31,835 B). Re-running on the build that resolved saved references sent the tint instead
(`81e7d561…`, 1.48 MB) — the bug, reproduced. With the mask bound to the node, re-running pressed
generate, opened no editor, kept the node count at 30, and uploaded `7b985050…` again, byte-identical.

## 79. A reference makes it one answer per press; only text-to-image draws

**Decision** An image run with references generates exactly one image, whatever 画布生图张数 says. Only
a run with nothing to condition on uses that setting. The settings chip stops showing a count it will
not use when the node has references.

**Why** A reference is the user being specific — this picture, this mask, this region. Asking for three
answers to a specific question turns the node into a batch that looks exactly like a text-to-image batch
while meaning something else, and the three are stacked in a node nobody asked to be a batch. Without a
reference there is no提问 to be specific about: that is the draw, and repeating it inside one run is
what the count is for. Dissatisfied with an edit? Press again — the node it overwrites is the one being
looked at (docs/decisions.md #77).

**What this fixes** The mask editor has always forced `count: "1"`, so the same inpaint made 1 image
through the editor and 3 through a hand-wired node. Now both are 1, and the rule is one sentence instead
of two paths.

**Tested** `image-qwen21` inpaint with two references on `:8191`: the run fetched only `outputs/0`, one
artifact, with the bound mask (`7b985050…`). The count could not be observed on the other side of the
rule in this environment — a Z-Image text-to-image run with 画布生图张数 = 3 also fetched only
`outputs/0`, so the workflows here return a single artifact per run regardless of `count`. The
no-reference path is the same expression it was before this change.

## 80. An agent's life belongs to the client that opened it

**Decision** A connected agent is one process per client-chosen name, held until that client disconnects.
Nothing expires. Opening it again under the same name is idempotent: the same name returns the same
process, which is how a reloaded page finds the conversation it left. The conversation route requires a
name and writes into that process without ever spending it; `POST /api/agent/once` has no name at all and
releases its process when the answer ends (see #81 for why that split is structural, and #82 for the
transport that carries it).

**Why** A conversation is the point of this process: an agent that forgot what it had done while the
user was thinking would be worse than no agent. An idle timer cannot know the difference between "the
user gave up" and "the user is reading a video that takes six minutes", and it took the history away in
both cases. So the only thing that ends an agent is the user closing it.

**The cost, stated plainly** A tab that is closed by the browser rather than the user leaves its process
behind, and a gateway that is killed takes the map with it. Both are accepted: the first is the price of
a history that survives a reload, and the second is why the canvas has to say "已断开" rather than
pretend the agent is still there. The disconnect route is the one way out, and it is the client's job to
call it.

**The key is the client's, not the gateway's** The name is whatever the client files the process under;
the canvas passes its own id. The gateway does not know what a canvas is — it files processes under
strings, which is the same dumbness it keeps everywhere else. A string that changes means a new agent,
and that is the whole of the semantics.

**One turn at a time** Two streams reading one stdout would each take half the frames and split an
answer between them, so a session serialises its turns. This replaced a `Take`/`Touch`/`idleSession`
state machine — a session was previously consumed by its one question, and "does this request spend the
connection" was a branch in the route. Both are gone; a question now spends nothing because there is
nothing to spend.

**What a turn ends on** `SM task in_progress: false`, measured against a real tool round: AlayaCore runs
built-in tools itself, so `AF` (the call, in two frames — name then arguments) and `UF` (the result) both
arrive inside one task, and the task ends once. The gateway relays all three as `tool_call` and
`tool_result` events and answers none of them. That measurement is also why there is no reader goroutine
fanning out to subscribers: the agent only speaks when spoken to, so the read loop stays in the request.

**A cancelled turn is not a dead agent** A client that goes away mid-answer sends `CI cancel` and the
frames that arrive while it winds down are read and dropped, so the next turn does not inherit them. Only
a process that ends before its turn does returns `ErrGone`, and that releases the session.

**Tested** On `:8191` with a real AlayaCore: `connect` twice with one name returned one pid; two
questions on that session both answered ("收到", then "还在") from the same process; the tool round
(prompt → `AF`/`AF`/`UF` → answer) streamed as `tool_call`/`tool_result`/`delta` with one `done`.
The e2e tests state the idempotency, the second turn and the tool relay against a fake agent.

## 81. A one-shot question has no name, so it cannot reach a canvas's agent

**Decision** The words the canvas asks for without continuing — a text node's body, a rewritten prompt, a
caption — go to `POST /api/agent/once`, which names no session and reads none. It spawns
`alayacore --rawio`, asks, and releases. The canvas's own agent is reached only through
the conversation's own route, which requires a name (#82).

**Why** One function used to do both, and it read the session out of the store, so every one-shot
question was sent to whichever agent the canvas happened to hold — and the gateway spent it when the
answer ended. That was harmless while a connection was one question by design (#80 replaced that), and
it would have become "pressing the sparkle next to a prompt empties the history of the agent you are
working with" the moment the process started living. The rewrite buttons and the canvas agent are
different kinds of thing; the route is where that difference lives rather than a convention the caller
has to remember.

**The shape of the guarantee** `/api/agent/once` never reads a `session` field, so a buggy caller cannot
hand it one either — the field is not on the route. The client mirrors it: `requestAgentOnce` passes a
literal `null` where `requestAgentChat` passes the store's session, and both go through one helper that
takes the session as an argument, so the only place that can look one up is the caller that should.

**Not a weakened agent** The one-shot keeps the tools and the skills container: it is the H3 prompt
rewrite, which works by reading a `SKILL.md`, so `--builtin-tools=read_file` stays on both routes. The
difference between the two kinds of agent is lifetime, not capability.

**Tested** `:8191`: a prompt on `/chat` spends nothing and the session answers again; a prompt on `/chat`
for a name that was never connected is `409 session_not_connected`; a prompt on `/once` handed a live
session id answers, leaves that session connected, and the session still answers afterwards. From the
browser, clicking 优化提示词 logged `POST /api/agent/once 200` with 20 deltas, and the process exited by
itself (`lived=14886ms`) — a one-shot agent does not outlive its answer.

## 82. The conversation is a socket; a shortcut stays a POST

**Decision** The agent is one WebSocket per session, at `GET /api/agent/socket/{session}`, both directions
as messages: prompts, settings commands, `cancel`, `close` up; the agent's own frames down.
`POST /api/agent/connect`, `/api/agent/chat` and `DELETE /api/agent/session/{id}` are gone. So is
`GET /api/agent/once`: a second route for a shorter lifetime was a second mechanism for the same thing,
and the lifetime is the client's to decide (see #83).

**Why this and not SSE** Three shapes of SSE were proposed and each one added a concept instead of
removing one: a stream per turn needed "when does a turn end" and "which request owns the stream"; a
stream per turn with injection needed a lock; one downstream plus N upstream POSTs needed status codes
for "queued" and a separate lifetime for the downstream. The third would have worked (it is the
WebSocket topology expressed in HTTP), but the sequence itself was the argument: a transport that needs
a new shape for every requirement is the wrong transport. The agent is a bidirectional stream; so is a
socket. See #80 for the lifetime this carries, and #81 for why the one-shot must not share it.

**No dependency** `go.mod` still has no `require`. `internal/ws` is ~250 lines: the handshake accepted
instead of asked for, masked frames read, unmasked written, fragmentation reassembled, ping answered.
`internal/comfy` already spoke the same framing as a client, and the tests drive the new server with
that client — an independent implementation rather than the server's own reflection.

**One transport** The one-shot was a POST returning `text/event-stream`, which is the natural shape for
one request and one stream — but it meant two streaming mechanisms for one feature: two client readers,
two framing formats, and a question ("why are these different?") whose only answer was "one of them is a
single answer". Moving it cost one route and the SSE machinery it had needed (`startEventStream`, the
multipart body, the file-to-data-URL helpers that existed only to fill that body — images now travel as
the data URLs the canvas already holds). #83 finished the job by deleting the route itself, because a
session's lifetime is the client's to decide, not the route's to declare.

**What it cost** `curl -N` no longer watches anything; `websocat` does. Two things had to be fixed
to make the upgrade possible at all, and both were silent bugs: `statusRecorder` in `internal/httpx`
wrapped the response writer without forwarding `Hijack`, so every upgrade failed with a 400, and without
forwarding `Flush` — which meant the SSE that `/api/agent/once` still uses had _never_ actually flushed:
every event sat in the response buffer until the handler returned. The first event of a one-shot answer
now arrives at 0.03s instead of at the end.

**Origin** A handshake is a `GET` that becomes a write channel the moment it is accepted, so `Guard`
now treats an upgrade as a write and applies the cross-site check it applies to POSTs. Without that, the
one route that speaks to a canvas's agent would have been open to any page the user had loaded.

**One watcher, one reader** The pump that reads the agent's stdout belongs to the session, not to a
socket: it starts with the process and runs until the process ends. A socket attaches as the watcher and
detaches when it goes away; the pump keeps reading and dropping. This is not decoration — a read blocked
in a syscall cannot be cancelled, so a reader that lived and died with a socket would be stuck holding
half a frame when the user reloaded the page, and the next socket would corrupt the stream.

**Tested** Against a real AlayaCore on `:8191`, in a browser: the panel opened the socket
(`socket open … spawned=true`); a prompt answered "收到" and a follow-up "刚才让你回复什么" answered from
history; `@` on a node sent `【画布引用】` with that node's id and prompt, and the agent answered "茶壶";
the model select sent `model_set` and the display became `qwen3.8-flash`; `结束对话` logged
`released … reason=closed by the client`; a page reload reattached with `spawned=false` and the agent
still remembered "新开". Dragging the panel moved it and left the canvas viewport untouched; a wheel over
it did not zoom. The Go tests cover the same ground without a model: idempotent open, one watcher per
name, second turn on one socket, tool relay, `close` releasing, a dropped socket keeping the agent, a
killed process reporting itself, and the one-shot never reaching a conversation.

## 83. One session per surface, and the model is the session's

**Decision** Every agent use is a session: one process, one socket, one name chosen by the client — the
canvas panel's is `canvas`, a node panel's is `node:<id>`. A session is created by pressing connect in
that panel, announces its own model list, is told which model it is on, and answers on it. Nothing about
a session is stored in the application: `agentSession` and the `agent` blob are gone from the config
store, and there is no per-node model field either. The canvas panel's session lives until it is closed;
a node panel's is released **the moment its answer ends** — not when the panel closes — and asking again
means pressing connect again, which is what makes one panel one turn. `GET /api/agent/once` is deleted
with the last of the nameless one-question processes.

**Why** The application had been keeping a mirror of state the agent already owns — which models exist,
which one is in effect, how hard it is thinking — in a single global slot. One slot for many processes
can only be wrong: the first node to connect made every other node think it was connected, and choosing
a model for one node changed the model everywhere. Every bug in this area was the same bug: two owners
for one fact. A session's own process is the owner, and the client only ever reads back what it says.

**Why this is the simple shape, not the big one** The processes are small and there can be as many as
there are panels open. Refusing to start one per panel is what produced the shared slot in the first
place; the alternative — one agent shared by every node — is not cheaper, it is a different and wrong
product. A node holds no process between answers — the release is part of the answer, so nothing at all is
running for a node nobody is asking. The canvas's own agent is the one thing that outlives its socket,
because the user asked for that.

**What it fixes** Pressing connect on a second node now shows connect, because that node has asked
nothing of anyone yet; the model select in each panel shows _that session's_ model; and text generation
asks the session of the node whose button was pressed, not a new node's name.

**Tested** In a browser against a real AlayaCore: two config nodes in text mode, the first connected
(`socket open session=node:config-1793445940295-nk65u spawned=true`, model list shown, button became
send) while the second still read 未连接 / 连接; pressing send on the first logged
`socket in session=node:config-…`, the answer landed in a new text node, and the gateway logged
`released session=node:config-… reason=close` with the button back to 连接 and no `alayacore` process
left running. The client tests hold the
other half: a session's model does not leak into another's, and asking for words opens no second socket.

## 84. A session's tools are its own, and the workspace is how a call says so

**Decision** A session's agent is spawned with `--config-path` pointing at a directory of its own,
`<DATA_DIR>/agent/<sanitised-session>-<hash8>`, holding a copy of the operator's `model.conf` and
`runtime.conf` plus an `mcp.conf` that points its tool calls at `http://<COMFYLOFT_SERVER_HOST>:<COMFYLOFT_SERVER_PORT>/mcp/<workspace>`
(see #87 for why it is that address and not loopback).
The workspace name is derived from the session name, so `POST /mcp/{workspace}` finds the session that is
asking by scanning the sessions that exist rather than through a registry beside them. The directory is
removed with the process, and every leftover is removed at startup. The endpoint speaks `initialize`,
`tools/list` and `tools/call` (notifications are `202`) and, for now, offers one tool, `ping`. A call is
then **not answered by the gateway**: it is published down the session's socket as a `tool` event, and the
canvas — the only thing that knows what a node is — replies with `{"toolResult":…}` on the same socket,
which becomes the tool's answer to the agent. Tool names are unprefixed: AlayaCore namespaces them under
the server, so `ping` is the model's `canvas_ping` and arrives back here as `ping`.

**Why MCP at all** Anything the agent does that AlayaCore cannot do itself — make a node, wire an edge,
start a generation — has to reach the gateway, which is the process that holds the socket to the canvas.
AlayaCore's only way to learn a tool exists is `mcp.conf` in its config directory, so the gateway serves
that tool itself instead of inventing a second channel.

**Why the identity is a directory** An MCP call carries nothing but its arguments. The alternative ways
to know who is asking are both wrong: guessing the session with a turn in flight breaks the moment two
panels ask at once, and adding a session field to every tool's arguments makes the model carry something
that is not its business. A path segment written by the gateway, into a file the gateway chose, cannot be
got wrong by the client — and it is a name that says what it is.

**Why a config directory per session, rather than one shared** `model_set` is persisted by AlayaCore into
`runtime.conf`, so a shared directory would turn "the model this session runs on" into the default for
every later session — the same kind of second owner that #83 removed from the client. The copy also means
the agent writes nowhere near the operator's configuration.

**Tested** Against a real AlayaCore on `:8191`, with a WebSocket client standing in for the page: on
connect it read its own `mcp.conf` and logged `MCP servers initialized: 1 servers, 1 tools loaded`; the
agent called `canvas_ping`, the gateway published
`{"type":"tool","callId":"tool-1","name":"ping","arguments":{}}` on the session's socket, the client
answered `{"toolResult":{"callId":"tool-1","text":"pong from the page"}}`, the POST that had been holding
the agent's turn returned it, and the agent's answer was "pong from the page". Closing the conversation
removed `data/agent/probe-mcp-7ed10748` with it. The name the model sees was measured, not assumed — the
first version offered `canvas_ping` and the model was shown `canvas_canvas_ping`. `mcp_test.go` holds the
rest: the handshake and tool list, a call run by the canvas and answered with what it said, a tool the
canvas called a failure, a session nobody is watching, a name the gateway never advertised, a notification
accepted with no body, and a session's directory built for it and removed with it.

## 85. A tool runs in the page, once, for whichever agent asked

**Decision** The canvas answers the gateway's `tool` events itself: one hook mounted where the nodes are
(`useCanvasAgentTools`), subscribed to **every** session's events (`onAnyAgentEvent`) rather than to the
canvas panel's name, and replying `{"toolResult":{…}}` on the session the call arrived on. The vocabulary
starts read-only — `ping` (how much is on the canvas) and `list_nodes` (every node with the id a later tool
can act on, and every connection), the second written as one line per node.

**Why every session and not just the panel's** The canvas is one, and a node's agent asking to see it is
the same question as the panel's asking. Subscribing per name would have to be done for sessions that do
not exist yet — a node's session exists only after its connect is pressed — and would then need a rule
saying which agents have hands. One subscription for the page, answering on the name it was given, has no
such rule: whatever agent asks, the page is what runs it.

**Why read-only to begin with** Reading is the only thing that cannot be wrong in a way the user has to
undo, and it proves the whole pipe — agent decides, gateway routes, page answers, agent reads — with real
canvas state. Anything that changes the canvas comes after, through the same functions the buttons call,
so a tool can never be a second way to do something.

**Tested** In a browser against a real AlayaCore on `:8191`, on a canvas with 38 nodes and 29 connections:
opening 画布助手 connected the session, a prompt asking for `canvas_list_nodes` made the agent call it,
the gateway logged `tool answered session=canvas callId=tool-1 isError=false` in 3ms, and AlayaCore logged
`<< UF {"output":[{"type":"text","text":"38 nodes, 29 connections\n- text-1793432616807-5rz7o (text)
\"文本\" at (689, 247)\n…"}]}`; the panel's answer named both counts and the shapes it had read. A second
turn and a page reload repeated it (`callId=tool-2`). The node titles that disagree with their prompts are
the canvas's own data — a title is a snapshot taken when the node was made.

## 86. A tool makes a node exactly the way the button does

**Decision** `create_node` calls the same function the canvas's own 文本 / 图片 / 视频 buttons call, with the
same consequences: the node lands in the middle of the view (a tool that states a position gets its
top-left corner there, which is the coordinate `list_nodes` reports), it is selected, and for the types
whose button opens a panel the panel opens. A `prompt` becomes a text node's `content` and every other
node's `prompt` — the field that node's own panel edits. The answer names the new node's id and position.

**Why** The agent must look like a hand the user cannot see, not like a second, quieter way to change the
canvas: whatever appears has to appear where he is looking, selected, with the panel he would have got by
pressing the button. Anything else — building the node in a corner, skipping the selection, writing
metadata the panel would not have written — makes the canvas a different surface depending on who asked,
and the user would have to learn which one he is looking at.

**What it refuses** Groups (structure, not content) and plugin nodes (the user's own extensions): a tool
that could make anything the registry knows would be a tool that makes things nobody asked for. The
refusal names what it can make.

**Tested** In a browser against a real AlayaCore on `:8191`: "用 canvas_create_node 在画布中央新建一个文本节点，
内容是「第二只手写的字」" → `<< AF {"name":"canvas_create_node"}`, then
`{"input":{"prompt":"第二只手写的字","type":"text"}}`, `tool answered … isError=false`, and
`<< UF "created text-1793522100580-liw89 (text) at (1541, 438)"`. The node appeared in the middle of the
viewport with the text already in it, selected, with the selection toolbar over it — visible in a
screenshot taken right after — and the panel showed one step, `调用 canvas_create_node`, and the id.

## 87. The tool URL is the address the gateway actually listens on

**Decision** `mcp.conf` names the workspace at the gateway's **bind** address — `COMFYLOFT_SERVER_HOST:COMFYLOFT_SERVER_PORT`,
not `127.0.0.1:<port>` — with a wildcard bind (`0.0.0.0`, `::`) replaced by loopback, since a wildcard has
no address of its own to dial and loopback is what it reaches.

**Why** The agent runs on the same machine as the gateway, but "same machine" is not "loopback": a gateway
bound to `192.168.3.232:8190` does not answer on `127.0.0.1:8190` at all. Handed that URL, AlayaCore's MCP
client simply cannot connect — it reports `0 servers` in its own output, the agent has no tools, and the
only place the failure is visible is the agent's own log. This was found the way it should have been found
earlier: on a real setup whose gateway binds a LAN address, while every test of ours ran on `127.0.0.1`,
where the wrong URL happens to be right.

**Tested** `TestMCPURLIsAnAddressTheAgentCanDial` pins the four shapes (loopback, LAN, wildcard, IPv6) and
the generated file. A gateway bound to `192.168.3.232:8192` wrote
`url: http://192.168.3.232:8192/mcp/probe-lan-8a8315a4` and its agent logged
`MCP servers initialized: 1 servers, 3 tools loaded`; with the old `127.0.0.1` URL the same setup cannot
connect at all (`curl http://127.0.0.1:8192/` → connection refused).

## 88. A tool answers with content, and the gateway only carries it

**Decision** A tool's result is a **content array in the protocol's own shape** — `text`, `image` and `audio`
(each with `data` and `mimeType`), `resource` (`mimeType` + `blob`, which is how a film travels because the
protocol has no video block of its own), `resource_link`. The page produces the blocks, the session carries
them as raw JSON, and the gateway puts them in `tools/call` unchanged: it does not resize, transcode,
truncate, cap, or turn one kind of block into another. `read_node(nodeId)` is the tool that uses this: it
answers with the node's own words and media, not with a description of them.

**Why raw, and why nothing is inspected** The blocks are self-describing — a block says what it is, and
`mimeType` says what the bytes are — so every layer between the canvas and the model would be guessing if it
looked inside. AlayaCore already knows what to do with each kind (`internal/mcp/tool_adapter.go` maps them to
image/audio/video parts, `internal/llm/providers/openai.go` promotes a tool result's media into a follow-up
user message because an OpenAI `tool` message holds only a string, and `media_fit.go` shrinks what is too
large to send). A gateway that "helpfully" downscaled a picture, sent only a video's first frame or rewrote a
sound as prose would be deciding how much of the canvas the agent is allowed to see — and would break as soon
as a later protocol revision added a block type, which a raw carrier simply forwards.

**What it costs, and why that is the user's call** A 1024² picture is ~1.3 MB of base64 on the socket and in
the conversation; a film is more. That is what looking at the real thing costs, and it is charged to whoever
asked for it (the agent, once per read), not paid preventively by every call.

**Tested** In a browser against a real AlayaCore and a vision model, on a canvas holding two nodes whose
prompt was "a red ceramic teapot on a wooden table, soft window light": `canvas_list_nodes`, then two
`canvas_read_node` calls in one turn; each result was `[{"type":"text","text":"a red ceramic teapot…"},
{"type":"image","uri":"data:image/png;base64,…"}]` (1.27 and 1.30 M runes) and the agent answered that the
first pot has water droplets on the lid and body, the second does not, spout left and ring handle right, wood
grain with wear marks, diffuse window light from the left — details that are in the pixels and nowhere in the
canvas's text. `TestMCPCarriesTheBlocksThePageProduced` holds the carrier property: text, image and resource
blocks come out of `tools/call` byte-for-byte as the page sent them.

## 89. Generating is the button, not a second way to run

**Decision** `generate(nodeId)` calls the same `handleGenerateNode` the node's own panel calls, with the mode
that panel would use — a content node generates what it is, a config node generates the kind its composer is
set to — and the words the node already holds. It is not awaited: it answers at once that the button was
pressed, and the node shows its own progress and holds the result. A group has nothing to generate and is
refused.

**Why not awaited** A picture takes minutes and a film longer. The tool's job is to start the work, not to be
the progress bar for it: an agent holding a tool call open for five minutes blocks its own turn, and the place
the user is watching is the node.

**Why it is allowed at all** The agent may ask before pressing — that is a decision about the conversation —
but if the user says do it, doing it cannot be something only a human hand can reach. A canvas the agent can
build but not run is a canvas where every resulting step is still the user's.

**Tested** In a browser against a real AlayaCore: "用 canvas_create_node 建一个图片节点，prompt 是「a brass
compass on a marble table」，然后立刻用 canvas_generate 对它按下生成" →
`<< AF {"name":"canvas_create_node"}` → `created image-1793524968642-jq17f (image) at (1541, 438)` →
`<< AF {"name":"canvas_generate"}` with `{"nodeId":"image-1793524968642-jq17f"}` → `tool answered … isError=false`
with `pressed generate on image-1793524968642-jq17f (image)`, and the gateway straight after logged
`POST /api/runs 202` and the run in the queue (`image-z-image-turbo running`). The node count went 39 → 40 and
the new node sits on the canvas with its prompt.

## 90. The transcript follows the newest message only while the reader is at the bottom; `@` points at a node

**Decision** The agent panel keeps itself at the newest message only while the reader is at the bottom. A
wheel up stops the follow at once; being at the bottom again resumes it, and the position is re-read on every
message rather than kept as a flag that can drift from where the reader actually is. Typing `@` no longer
opens a list of node names: it puts the canvas into the same "click a node" state a reference's `+` uses, and
the node the user clicks becomes the citation, its title replacing the `@` in the draft.

**Why** An answer that streams while the user scrolls up is an answer they cannot read: the follow turns a
gesture into a tug of war. The list of names was a second, worse copy of the canvas — the nodes are already on
screen, with their pictures and their layout, and picking one is pointing at it. Both are the same rule as
everything else here: the surface shows what is there, and the user aims at the thing itself.

**Tested** In a browser, on a real answer long enough to overflow (1279px of transcript in a 290px box):
while it streamed the panel stayed at the bottom (`gap 0`); after a wheel up and a scroll to the top, two more
messages grew it to 1360px with `scrollTop` still 0 and `gap 1070` — the reader was not dragged down; after
scrolling back to the end, the next message put it at 1145 of 1435 with `gap 0` again. `@` in the composer
showed "点击一个节点来引用 · ESC 取消", clicking the teapot node put `@a brass compass on a marble table` in the
draft, and the prompt the gateway logged carried `【画布引用】- image-1793524968642-jq17f (image) …`.

## 91. Changing a prompt and running it again are the manual path, so the agent gets both

**Decision** `set_prompt(nodeId, prompt)` writes the prompt where the node's own prompt panel writes it: a node
that already holds a result keeps the words in `composerContent` (typing must not throw the result away), a
node that holds none keeps them in `prompt`. The question "does this node hold a result" is one function,
`holdsResult`, asked by both the panel and the tool. Generating afterwards is `generate` on that same node,
which replaces the result in place (#77) — nothing is created beside it. A variant remains what it is manually:
a new node fed through the reference bar, i.e. `create_node` plus a connection.

**Why** Before this the agent's only way to answer "draw this differently" was `create_node` + `generate`, so
every request produced a sibling — the shape #77 deliberately removed from the manual button because it made
one press mean two things. An agent that offers only the removed route is a second, worse product: the user's
hand and the agent's hand would do different things to the same canvas. Both intents are legitimate and both
have explicit routes; which one is meant is the user's sentence, not the tool's choice.

**Tested** In a browser against a real AlayaCore: "把 image-1793524968642-jq17f 这个节点的提示词改成「a rusty
copper kettle on a dark stone shelf, candle light」，然后在同一个节点上重新生成，不要新建节点" →
`canvas_set_prompt` → `canvas_generate` → `POST /api/runs 202` → the run succeeded in that node (3 images, the
count the canvas is set to), the node's prompt box showed the new words, its picture became the copper kettle
by candlelight, and the canvas still had **40 nodes** — the same 40 as before. The agent then called
`read_node` and reported "已直接在原节点上触发生成（没有新建节点）".

## 92. A connection is a drag, so the agent gets the same call

**Decision** `connect(fromNodeId, toNodeId)` adds one connection through the same function a drag adds it with
(`addConnection`, which `connectNodes` now also calls): the canvas's own `normalizeConnection` decides the
direction and whether the pair may be connected at all, and an existing connection is never added twice. The
tool starts from the source handle, because a tool states its two nodes in order; a drag states a gesture, so
it says which handle it came from. What a connection means is unchanged: it is how one node's content becomes
another's input — the picture connected into a config node is what makes the next generation a variant of it.

**Why** The variant route (#77) is a connection, and without it the agent could only ever make things from
nothing: it could not build the "keep this, make another one conditioned on it" gesture the canvas offers. Two
implementations of "may these connect" would eventually disagree, so the drag and the tool share one.

**Tested** In a browser against a real AlayaCore: "新建一个图片配置节点，把铜壶那张图
image-1793524968642-jq17f 连到它上面，然后在配置节点上生成一张以它为参考的变体" → `create_node` →
`created config-1793527710406-y2raf (config) at (1927, 438)`, `connect` →
`connected image-1793524968642-jq17f -> config-1793527710406-y2raf`, `generate` on the config node → the
config node's panel showed 参考图 1 张 with the kettle in it, the run went out and succeeded with one artifact,
and the canvas went from 40 nodes / 29 connections to 42 / 31 — a new image node holding the variant.

## 93. A pick is a way of typing, so it gives the caret back

**Decision** Choosing a node with `@` puts the focus back in the composer with the caret just after the label it
inserted; cancelling (escape, or the banner) leaves the `@` as typed and puts the caret back after it. The node's
own mousedown no longer moves the focus while a pick is in progress: picking is typing somewhere else, and the
caret belongs to the box that asked.

**Why** Without it the click ends the sentence: the caret stayed wherever the click left it, the next thing
typed went nowhere, and the user had to click into the box and find the end of the line again. The pick exists
to save typing, not to interrupt it.

**Tested** In a browser: typing "看看 @" then clicking the kettle node left `看看 @a rusty copper kettle on a
dark  ` in the box, `document.activeElement` a TEXTAREA, and `selectionStart` 37 — the end of what was
inserted. Escaping a pick left `看看 @ 再看 @` untouched with the caret at 9, still in the box.

## 94. The agent panel is the user's window: it opens from the corner it sits in, and it resizes

**Decision** The button that opens the agent panel is a round button in the canvas's bottom-right corner — where
the panel itself opens — not one of the small icons in the top bar. The panel can be resized by dragging either
of its corners: the bottom-right one, and the top-left one, which also moves the panel so that the opposite
corner stays where it was (a panel in its default corner is pinned by its right and bottom edges, so pulling the
top-left there needs no move at all). Both are clamped to 320×280 at the least and to the canvas (minus a 16px
margin) at the most. The
size is not persisted, for the same reason the position is not (#83's list of things that are not the canvas's):
a window's shape belongs to the window. The open button is shown only while the panel is closed, because when it
is open it covers that corner and carries its own close button.

**Why** The panel is the one surface that is not the canvas: it is a card you move, read in and put away, so it
should behave like one — and a card that can only be the size it was born at cannot hold a long answer or a
transcript you want to scan. The opening button belongs to the panel, so it lives where the panel appears; in the
top bar it was a small icon among other small icons, next to the sidebar's own collapse control, and it read as
part of the canvas's chrome rather than as "the assistant is over there".

**Tested** In a browser: the button rendered at (1653, 670) in a 1717×734 canvas — bottom-right — and clicking it
opened the panel; closing the panel showed the button again in the same corner. Dragging the new corner grip
took the panel from 380×480 to 536×446, and a drag towards the top-left clamped it at 320×360 (the minimum
width), with the size in the panel's own inline style rather than the class list.

## 95. A popup over the canvas has to say so twice: the marker, and the height

**Decision** A dropdown opened from inside the canvas carries `data-canvas-no-zoom` (so the canvas does not read
the click on an option as a click on its background), stops pointer events, **and** sets a z-index above the
canvas's own chrome — `z-[1500]` for the agent panel's two selects, whose card sits at `z-95`. That is the same
recipe `model-picker` uses (`z-[1200]`), and the marker-only version was not enough.

**Why** The first fix was the marker alone, and it was incomplete in a way only a person could see: radix renders
the popup in a portal at the document root with the component's own `z-50`, so the dropdown opened _underneath_
the panel that owns the trigger. Nothing threw, the accessibility tree listed the options, and a synthetic click
aimed at the element still changed the model — so it looked fixed. A real mouse click lands on whatever is on
top, which was the panel. A floating layer over the canvas is therefore two things, not one: told apart from the
canvas, and above it.

**Tested** In a browser, with `elementFromPoint` at the centre of an option: before, the option measured
`z-50` against a card at `z-95`; after, `z-1500` and the option is the topmost element at its own centre. Clicking
它 changed the panel to `Test / qwen3.8-27b` and the gateway logged `command="model_set"`; the level select
showed 不思考/普通思考/深度思考, and picking 不思考 logged `command="reasoning_level_set"`.

## 96. `@` needs no space in front of it

**Decision** Any `@` that lands at the caret in the composer asks for a node pick. The earlier rule — only after
whitespace, so that `foo@bar` would not trigger — is gone.

**Why** The rule was Latin typography imposed on a Chinese box: Chinese does not put a space between words, so
the natural way to cite a node is `看看@那个茶壶`, which did nothing at all, and the "fix" the rule asked of the
user was to type a space that then travelled into the prompt. The case it was protecting against — an address
being typed in an agent's message — is rare here and costs one escape: a cancelled pick leaves the `@` exactly as
typed. A gesture that refuses to start on the input it was made for is worse than one that starts too eagerly.

**Tested** In a browser: the draft `看看@` (no space before the `@`) showed "点击一个节点来引用 · ESC 取消";
clicking the kettle node replaced it with `看看@a rusty copper kettle on a dark  `, focus back in the textarea at
the end of what was inserted.

## 97. The system menu was four questions in one trench coat

**Decision** The hamburger at the top-left is gone. 我的资产 and 我的画布 became round buttons beside the
side-panel toggle, where the two "where is my stuff" questions are one click away instead of two. 导出当前画布
became a button in the bottom dock, right after 上传资产. 删除当前画布 joined the canvas menu behind the title,
next to 新建画布 and 我的画布. Everything the menu held now has a second home: 新建/重命名/切换 were already in
the title menu, 撤销/重做 were already in the dock.

**Why** One menu was answering four unrelated questions — where am I, where are my things, what is this canvas
doing, can I undo that — with the same three dividers. A menu is a place to put what has nowhere else to go;
once 导入 sat in the dock and 导出 sat only in a menu, the menu was a hiding place, not a home. Deleting it
costs nothing that is not already within one click of where it belongs, and removes a concept (a menu that
owns no subject) rather than adding one.

**Tested** In a browser (1717×734): the top-left renders 收起面板 / 我的资产 / 我的画布 as three buttons in one
row; the dock lists … 上传资产 / 导出当前画布 …, and `导出当前画布` was present in the accessibility tree next to
`上传资产`. The title menu reads 无限画布 1 (42 个节点) / 重命名 / 新建画布 / 我的画布 / **删除当前画布** (red).
A grep for `打开画布菜单` in the accessibility tree returns nothing: no hamburger is left.

## 98. The side panel is a board over the canvas, not a column beside it

**Decision** `CanvasSidePanel` is no longer a flex sibling that the canvas is laid out next to. It lives
inside the canvas `<section>` as `absolute left-0 top-16 bottom-0`, slides out with `translateX(-width)` and
`opacity: 0`, and turns `pointer-events` off while it is away. It is shut by default (`canvas-side-panel-open`
must say `1`), and the same top-left button opens and closes it. With the reflow gone, the store lost
`panelMounted`/`panelClosing` and the component lost the two-frame "render at 0, then flip" hack that existed
only because a CSS transition cannot run on first paint. Chrome that used to be pushed aside by the column now
steps over the board: `useSidePanelInset(gap)` — 20 for the zoom dock, 24 for the minimap, 300 for the bottom
dock.

**Why** The panel was reflowing the canvas: opening it moved every node on screen, so a person looking for a
node in the list lost the view they were looking at. A list of what is on the canvas is a way of _looking_, and
looking should not move the thing you are looking at. The floating board keeps the function and drops the
consequence.

**Amended by #195** It no longer slides out sideways: it opens and closes by height, growing down from the
column's top edge. Everything else here stands — it is still a board over the canvas, still shut by default,
still the same top-left button.

The bottom dock's `left: 300` was **not** room for the side panel, which is what this change first assumed: it
is the width the zoom dock and minimap occupy in the bottom-left corner. Changing it to 16 made the dock
overlap the zoom dock as soon as the board was wide, which the browser showed immediately. It is
`useSidePanelInset(300)` now: still 300 from the canvas's left edge when the board is shut, 300 further right
when it is open — the same pixels as before, without the canvas ever moving.

**Tested** In a browser (1717×734, 42 nodes). The board sits at (0, 64), 280×670, bottom flush with the canvas.
Its first node's screen rect read `left=-53` with the board open, after closing it, after a resize to 360, and
after a reload — the canvas did not move once. Closing it put the aside at `left=-361` with
`pointer-events: none`; the zoom dock moved 380 → 20, and the bottom dock 660 → 300, both without touching the
canvas. `elementFromPoint(120, 300)` returned a button inside the aside, and `(900, 600)` returned the canvas,
so the board takes the pointer it covers. A clean storage (all three keys removed, reload) opened with the board
shut and width 280 and wrote nothing until it was toggled; after opening it, a reload kept it open.

## 99. The memory readout is ComfyUI's, or it is nothing

**Decision** `/api/system/stats` no longer samples the gateway's own host. It asks ComfyUI's
`/system_stats` what its machine has — `ram_total`/`ram_free` and, per device, `vram_total`/`vram_free` —
and reports that as `gpu` and `ram`, with `available: true`. When ComfyUI cannot be asked, or answers
without a device, `available` is false and the panel renders nothing at all. `internal/sysinfo` lost its
`nvidia-smi` shell-out and its `/proc/meminfo` reader and is now only the shape plus the translation.
`/api/system/free-memory` measures the freed memory from ComfyUI's own figures for the same reason.

**Why** The gateway and ComfyUI are usually _not_ the same machine — here the gateway runs on a 14 GB box
with no NVIDIA GPU at all, while ComfyUI is a 5080 with 16 GB of VRAM and 94 GB of RAM on another host.
The panel was printing the gateway host's numbers under the heading "VRAM" and "memory", so it read
`显存 --` and `内存 6/14G` while the machine doing the work had 15.6 GB of VRAM. A number about the wrong
machine is worse than a blank: it invites you to wait for memory that is not the memory that ran out.
ComfyUI already knows the answer about itself, so the fix needs no new protocol and no IP comparison
between gateway and ComfyUI — the question is simply asked in the right place.

The `utilization` and `temperature` fields are gone: ComfyUI does not report them, and they were the only
numbers the local sampler had that ComfyUI lacks. The panel shows a device's name and its memory, which
is what it can be told.

**Tested** Against the real pair (`gateway :8191` → `comfy 192.168.3.233:8188`), the endpoint returned
`available: true`, `gpu[0] = cuda:0 NVIDIA GeForce RTX 5080, 821 / 15933 MB`, `ram = 22.1 / 93.6 GB` —
figures that cannot have come from the gateway host (14 GB, no GPU). In a browser, the bar read
`显存 0.5/15.6G · 内存 20.0/93.6G`, and its dialog listed the 5080 by name with no load or temperature
line. Pointed at a gateway whose ComfyUI is unreachable (`:8192` → `:8198`), the same bar showed only the
account buttons: no readout, no zeros. `POST /api/system/free-memory` there returned
`503 comfy_unreachable`. Go: `TestSystemStatsReportComfysMachine`,
`TestSystemStatsAreAbsentWhenComfyReportsNoDevices`, `TestSystemStatsAreAbsentWhenComfyIsGone`, and the
`sysinfo.FromComfy` unit tests (units, `nil` for no device, index fallback).

## 100. The conversation is a file, and the process is only what works on it

**Decision** Every agent session is spawned with `alayacore --session <file>`, one file per session name,
in `DATA_DIR/agent/sessions/`. The process now lives exactly as long as its socket instead of outliving it,
and the conversation comes back the way AlayaCore offers it: a new process replays the file before it says
`session ready`, and the gateway relays that as one `history` event. The panel draws `history` by
**replacing** its messages, not appending. The canvas panel's session name became `canvas:<canvasId>` —
it was the bare `"canvas"` for every canvas, one conversation shared by all of them.

**Why** The panel kept its transcript in `useState`, so a reload showed an empty panel while the agent, in
a process that had survived the reload, still remembered everything: a blank screen answering from
invisible context. That was the worst of both worlds — worse than either side forgetting.

The fix is not in the page. AlayaCore already keeps a conversation when told where to put it, and already
replays it on start (a 733-byte file for one turn, `context_tokens: 222` restored before `ready`). What was
missing was the two things that let it happen: a file to write to, and a process short-lived enough to
have to read it. Keeping the process alive across reloads was the very thing that prevented the replay.

Two frames made this safe to wire, and both were checked against the real binary: replayed content arrives
as **complete** `UX`/`AX` frames carrying text, while a live turn ends its messages with `AX` frames that
carry **no** text at all — so "text present" is the whole difference between history and a full stop, and
nothing is drawn twice. `UX` echoes exist in both cases, which is why history is defined by _when_ it
arrives (before `ready`), not by its tag.

The name had to change with the file. One name for every canvas meant one file for every canvas: what was
said on one canvas would be replayed on the next.

**Tested** In a browser against a real AlayaCore (`gateway :8191` → `Test / qwen3.8-27b`): asked the panel
to remember a code word, got `好的`; the session file `canvas-UyrJZS8t68LWjeruICYOR-bb5c104f.session`
appeared (744 bytes) and the live process's command line carried
`--session /tmp/gw8191/data/agent/sessions/canvas-UyrJZS8t68LWjeruICYOR-bb5c104f.session`. Reloaded the
page, reopened the panel: both messages were there. Asked "刚才让你记的暗号是什么?" and the answer was
`紫罗兰` — the context, not just the text, had come back in a new process. Closing and reopening the panel
inside the same page showed the same four messages and no duplicates, so a replay replaces. The gateway log
for the whole sequence: `released session=… reason=socket closed`, then `spawn … spawned=true`.

Go: `TestSocketGoingAwayReplaysTheConversation` (fake agent that keeps its own session file: prompt, drop
the socket, reconnect, and the new process replays the question and the answer); `TestMCPToolSaysWhenNoCanvasIsWatching`
now reports the session's disappearance; the workspace tests read the new `agent/workspaces/` path.
`make check`, `make test-race`, `npm run check`, `vitest 125` green.

## 101. A replayed citation shows the words, not the block

**Decision** The block the canvas puts in front of a cited prompt — `【画布引用】` and one line per node —
now has a home of its own, `lib/canvas/agent-references.ts`, and that module can take it off again
(`withoutReferences`). The panel uses the first half when sending and the second half when it draws a
user message replayed from the agent's session file.

**Why** What is sent and what was typed are different strings, and until now only the sent one could
survive a reload. So a message that read `@补全背景 描述一下这张图片的背景。` came back as:

```
[Canvas references]
- lPiENyy6iXVTwtTVDzd7M (image) 补全背景: 补全背景

@补全背景 描述一下这张图片的背景。
```

The block is plumbing for the agent — `@补全背景` means nothing to it without the node's id — and it is
not something anybody typed. The stripper recognises the marker in **either language**, because a
conversation written in Chinese can be read back by an English UI, and it only cuts where the block
actually ends (marker, then a blank line): a prompt that merely starts with those characters keeps every
word.

**Tested** Unit tests pair the two directions against each other: what `referenceBlock` builds,
`withoutReferences` removes, in both languages and across a language switch; a marker without its blank
line is left alone; a prompt without a block is returned unchanged. In a browser: the session file was
edited to carry exactly the block from the report, the page was reloaded, and the panel drew
`@补全背景 描述一下这张图片的背景。`.

## 102. `editCanvasRatio` was UI state wearing a workflow input's clothes

**Decision** The image settings popover no longer writes `editCanvasRatio`. Which ratio pill is lit is read
back from `editCanvasSize` — the workflow's own input — through the same table that wrote it
(`canvasRatioOf`). A format 2 → 3 migration deletes the key from nodes that already carry it.

**Why** Every edit run from a node whose params held that key failed with

```
unknown input "editCanvasRatio"; workflow image-qwen21 accepts: background, cfg, count, …
editCanvasSize, layout, …
```

The key was never a workflow input: it was "which pill did I click" parked next to the real inputs and
shipped with them. The gateway is right to refuse it — an input it does not know is either a typo or a
version skew, and guessing which would be worse than saying so. The fix belongs on the side that invented
the key.

Deriving it beats keeping it somewhere else: the pill _is_ the size, so a second field can only drift from
the first. Old canvases are repaired on load rather than left to fail, which is what the migration is for.

**Tested** `tests/persist-migration.test.ts`: a version-2 blob whose node params hold
`{editCanvasRatio, editCanvasSize, resolution, seed}` reads back as
`{editCanvasSize, resolution, seed}`, and a node with nothing stored is untouched.

## 103. Deleting a canvas forgets its conversation

**Decision** `DELETE /api/agent/session/{session}` releases the process if one is running, removes the
session file and the session's workspace, and answers `{ok, removed}`. The canvas calls it for each canvas
it deletes — from the canvas menu and from the multi-select dialog — with the name it already owns
(`canvas:<canvasId>`), fire and forget.

**Why** A conversation now outlives the page, which is the point, but a canvas does not outlive the canvas.
Without this, every deleted canvas left a file in `DATA_DIR/agent/sessions/` that nothing would ever read
again — the user's words, kept forever, for a canvas that no longer exists. Only the canvas knows when a
conversation is over: the gateway sees names, not canvases.

Closing the panel is deliberately _not_ this. A closed panel is a conversation waiting to be reopened; a
deleted canvas is a conversation with nobody left to have it.

**Tested** `TestDeletingASessionForgetsTheConversation`: prompt, wait for the turn, confirm the file exists,
`DELETE`, confirm it is gone and that the next connection replays nothing. In a browser: a scratch canvas
was opened with its panel (workspace created), given a session file, then deleted through the canvas menu
and its confirmation — the gateway logged
`DELETE /api/agent/session/canvas%3APrivX2hRZQHWmyUJmmsP6 200`, and both the file and the workspace were
gone while the other canvas's conversation was untouched.

## 104. The transcript is the agent's, and only a conversation keeps a file

**Decision** Two things that were the same mistake:

1. The panel no longer writes a message when the user presses send. A user message is drawn from the agent's
   own echo (`UX`, which it sends live as well as on replay), and the assistant's message starts at the
   first delta instead of being created empty beforehand. The panel holds no message the agent did not
   report.
2. A session file is created only when the client asks for one: `GET /api/agent/socket/{name}?history=1`.
   The canvas panel asks; a node's panel does not, so a one-shot question leaves nothing on disk.

**Why** (1) The submit handler drew the typed text itself, and the replay drew the agent's copy — two copies
of the same message, which is why they could disagree (the typed `@补全背景 …` versus the stored
`[Canvas references] …` block). Stripping the block on replay patched the symptom and left both copies in
place. One owner removes the class: what is on screen is what the agent says was said, live and replayed,
and the citation block is stripped in one place because there is only one place.

(2) A node's agent is asked one question at a time — reverse-prompt, text generation — and writes the
answer into the node. Giving it a session file left one file per node in the data directory with nothing to
ever read or delete it, and it would carry an earlier question into the next answer. Whether a name is a
conversation is a property of the surface, and the surface is the client, so the client says so in the
socket URL. The gateway keeps filing processes under opaque names.

_(The second half is superseded by #280: the node panels are gone, and the name decides.)_


**Tested** Gateway: `TestSocketRelaysTheUsersWordsOnce` (a prompt produces exactly one `user` event, with the
words as sent) and `TestOneShotSessionKeepsNoFile` (a socket without the flag prompts and answers, and
`sessionFile("node:n1")` does not exist). In a browser against a real AlayaCore: after a reload the replayed
conversation still drew, and a new turn showed the typed sentence once — with the answer appearing under it
as it streamed — while nothing was added by the submit handler.

## 105. Sending is never blocked, and the queue is visible

**Decision** The panel no longer refuses to send while a turn is in flight, and it shows how many messages are
waiting in the agent's queue above the input: `2 条消息已排队,会在当前步骤之后一起插入`. The gateway relays
AlayaCore's `SM steering` frames as `{type:"steering", phase:"queued"|"delivered"}`; the panel adds one per
`queued` and **zeroes** on `delivered`. The "End conversation" button in the header is gone, and with it
`canvas.agent.end`.

**Why** AlayaCore has its own queue. A message sent into a running task is inserted between the agent's steps
— that is in the gateway's own reading loop, which explicitly may not assume one prompt equals one answer —
so a send button that goes dead for the length of a three-hundred-word answer is the panel inventing a
limitation the agent does not have.

But queueing invisibly is its own problem: the message is accepted and then nothing happens for a while, which
looks exactly like a message that was lost. AlayaCore already announces both ends of the queue
(`phase: queued` when it takes the message, `phase: delivered` when it works it in), so the panel says so,
where the message was sent from.

The number is counted from the `queued` frames, and the frame that clears it is the one that arrives once.
AlayaCore inserts a whole batch at the same time and says `delivered` **once** for it — measured with three
messages sent into one running task: `queued`, `queued`, `queued`, `delivered`. Decrementing on delivery (the
first version) therefore left a queue on screen that no longer existed, which is the one thing worse than not
showing it at all: the message looks stuck. The panel zeroes instead.

The End conversation button promised something that stopped being true when conversations moved into session
files: it closed the socket and released the process, and the next open replayed the conversation anyway. A
button that claims to end a conversation and does not is worse than no button — closing the panel is the only
"leave" the panel has, and deleting the canvas is the only end.

**Tested** Gateway: `TestSocketRelaysTheSteeringQueue` (the two phases arrive in order). In a browser against a
real AlayaCore: a 300-word request was sent, the send button stayed enabled while it streamed, a second
message was accepted mid-answer — the line above the input read `1 条消息已排队,会在当前步骤之后插入` and then
disappeared when delivered — and both messages and both answers ended up in the transcript in order. The
gateway log shows the pair:
`<< SM {"type":"steering","data":{"phase":"queued"…` then `…"phase":"delivered"}`. The header now lists only
`关闭` and `发送`.

## 106. A mention in a message is a link to its node

**Decision** `@title` inside a message in the agent panel is drawn in the accent colour and clicked like a row
in the side panel: the canvas moves to that node and selects it. Which node a mention means comes from the
message itself — `referenceEntries` reads the ids back out of the citation block the canvas wrote — and, for a
message that cited nothing (an answer that names a node), from the canvas's current titles.

**Why** The visible text of a cited message says `@补全背景`; only the block says which node that is, and the
block is stripped before display. Reading it first and keeping the pairs on the message is what makes the
mention a reference rather than a word that looks like one. The action is `focusNode`, the same one the side
panel's rows call, so "jump to that node" means one thing in the canvas.

A title containing the block's own separator (`: `) loses its tail when read back — the id is never lost, so
the link still points at the right node; only the token that gets coloured is shorter. That is the cost of
keeping a format that reads well for the agent, and it was not worth a second markup.

**Tested** `tests/agent-references.test.ts` round-trips the block: what `referenceBlock` writes,
`referenceEntries` reads, including the colon case. In a browser: cited an audio node with the panel's `@`
picker, sent the message, and the mention drew in the accent colour inside otherwise plain text; pressing
"reset view" moved the canvas to `translate(858.5px, 367px)`, and clicking the mention put it back at
`translate(-827.5px, -173px)` — the same transform a side-panel click produces — with the node selected.

---

## 107. A route nobody calls is not an API

**Decision** Twelve routes are gone: `GET /api/tasks`, `GET /api/tasks/{id}`, `GET /api/setup/status`,
`POST /api/setup/model-alias`, `POST /api/resources/packs/{id}/main-model`, `POST /api/requests/{id}/cancel`,
`GET /api/session/status`, `GET /api/previews/{promptId}`, `GET /api/progress/{requestId}`,
`GET /api/workflows/{id}`, `DELETE /api/workflows/{id}` and `GET /api/uploads`.

**Why** Every one of them was reachable and none of them had a caller: the canvas, the plugins, `start.sh`
and the tests never asked for them, so they were a surface maintained for a client that does not exist —
the exact thing [`protocol.md`](protocol.md) argues against ("every compatibility branch we do not need is
code we would maintain forever"). They are also where the tree kept its dead weight: `task.PublicTask`,
`upload.List`, `registry.Remove` + `writeRegistry`'s sibling, `resource.SetMainModel`,
`generate.Hub.GetByRequest`, `Server.requests` with `withCancel`/`cancelRequest`, and the session
`activeTasks` count were used by these handlers and by nothing else. `POST /api/requests/{id}/cancel` was
not merely unused: nothing ever registered a cancel function, so it could only answer `cancelled: false`.

What each one duplicated, and what answers the same question now:

| Removed | The client already does this |
| --- | --- |
| `GET /api/tasks[/{id}]` | `GET /api/runs` — one projection of a run, on the route the canvas uses |
| `GET /api/previews/{promptId}`, `GET /api/progress/{requestId}` | the run's own `preview` and `progress` fields |
| `GET /api/setup/status` | `GET /api/resources/status`, which embeds the scan's result |
| `POST /api/setup/model-alias` | `POST /api/resources/replacement` (the same alias write, from the panel) |
| `POST /api/resources/packs/{id}/main-model` | nothing — the panel stopped offering the picker (decisions #37) |
| `GET`/`DELETE /api/workflows/{id}` | `GET /api/workflows` and `POST /api/workflows/{id}/visibility` |
| `GET /api/uploads` | upload ids travel in the run that references them |
| `GET /api/session/status` | nothing — the tracker behind it had no other reader, so it went too (#109) |

**Cost** The main-model override store (`internal/store/preferences.go`) still loads and is still read by
the registry and the resource status, but after this its write path has no production caller — the panel
cannot set an override, so "already using a chosen model" can only come from a file edited by hand. Either
the feature comes back with a picker or the store goes; that is a product decision, not this one (the same
one #37 left open). The session tracker this route reported went with it — see #109.

**Tested** `make check` and `make test-race`. Each deleted path answers `404 not_found` from the mux's
catch-all rather than a handler's error, while `/health`, `/api/workflows`, `/api/workflows/{id}/schema`,
`/api/runs`, `/api/resources/status`, `/api/loras` and the `/api/agent/socket/...` upgrade answered as
before (the upgrade relaying a real agent's `models` and `history` frames). In a browser against that
build, the canvas loaded its 42 nodes and the complete request log was `/api/workflows`,
`/api/resources/status`, `/api/skin-unlocks`, `/api/system/stats` and `/api/session/{open,heartbeat}` —
every one `200`, and not a single `404`: the client really did not call any of the twelve. (Those three
session posts were the last thing #109 removed; the same page now makes no request to them at all.)
`TestSetupReportsToolWorkflowProblems` kept its scan assertions and lost the HTTP half that pointed at the
deleted route; `TestTaskNotFoundShape` went with the route it tested.

---

## 108. The conversation is the socket, so the one-shot run has no caller

**Decision** `agent.Run`, `readTurn`, `withAgent` and `finish` are gone, with the three tests that drove
them. Reading an agent now has exactly one shape: a session (`Sessions.Connect`) whose pump feeds the
socket's watcher.

**Why** `Run` spawned a process, wrote one request, read until the turn ended and released — the shape of
`POST /api/agent/chat`, which was deleted in #74/#82 when prompts became the socket's. After that the only
caller was `run_test.go`: golangci's `unused` stayed quiet because the test counted as a caller, and the
suite looked green on a route that no longer exists. `turnStep` is what both paths actually shared, and it
stayed — `Session.pump` is now its only caller, which is the honest count.

**Cost** The tests could not simply be deleted with the code: `turnStep` and `writeRequest` are live (the
pump and `Session.Send`), and they were only ever exercised through `Run`. They were ported instead:
`internal/agent/session_test.go` opens a real session against the same fake agent and asserts the same
three things through it — the answer arrives as deltas with `done` as a bare marker, the agent's `api_key`
and `base_url` never reach an event, and a command's `CO` (ok or rejected) is relayed without a `UE` being
flushed. One test is new: a detached watcher makes the pump drop events rather than fail.

**How verified** `make check` and `make test-race`. The ported tests run the live path
(`Connect` → `Watch` → `Send` → events), so a regression in the translation fails the suite exactly where
it would fail in a browser.

---

## 109. A presence signal nobody reads is a timer, so it is gone

**Decision** The canvas-tab tracker is deleted whole: `internal/store/sessions.go` (the map, the stale
window, the idle clock), `Server.sessions`, `POST /api/session/{open,heartbeat,close}`,
`sessionPayload`, the `SESSION_STALE_SEC` environment variable, `web/src/lib/local-session.ts`, and the
`startLocalSession()` call in `main.tsx`. Nothing posts a heartbeat any more.

**Why** Every five seconds, per tab, the canvas posted to the gateway, which wrote a timestamp into a map,
pruned entries older than 120 s, and answered with a snapshot of that map. Nothing read it. The two
readers it was built for do not exist here: the upstream fork's desktop launcher (which stopped the Node
backend when the last page closed — the comment in `local-session.ts` says so in as many words) was never
part of this repository, and the VRAM idea recorded in `store/sessions.go` ("'idle' from 'nobody is
looking', which governs whether it is safe to free VRAM") was never wired into `POST /api/system/free-memory`
— that button asks ComfyUI, not the tracker. #107 removed the one route that exposed the map, which
turned the heartbeat into pure noise traffic; this removes the noise.

**Why a heartbeat at all, for the record** Presence cannot be sent reliably: a tab that is killed, a
laptop that sleeps and a dropped network all fail to POST "I am leaving". A last-seen timestamp with a TTL
is the honest way to infer it, and 120 s against a 5 s beat is a sane margin. The mechanism was fine; the
consumer was missing. If VRAM release ever wants this fact, the run queue already has it — "nothing is
queued and nothing is running" is a question the gateway can answer about itself, without a browser.

**Cost** With this, nothing in the gateway knows whether a browser is open. Nothing did before either —
the count was reported to a route nobody called — so the only thing that changes is 17,280 requests a day
per tab that no longer happen, and a config knob that no longer exists. A deployment that set
`SESSION_STALE_SEC` can delete the line; the variable is simply ignored now.

**Checked together, as the change asks** Code: the `store` package keeps its other three stores and its
package comment moved to `preferences.go`, corrected (it used to name "canvas sessions" as one of the
things the package holds). Tests: the two `TestSessions*` cases went with the type; `config_test.go` no
longer isolates `SESSION_STALE_SEC`. Frontend: `main.tsx` lost both the import and the call, and
`check:exports` reports 182 modules instead of 183 with no unused export. Docs: `gateway.md` and
`protocol.md` never listed the three routes (`/api/session/*` was mentioned once in protocol.md's
"unchanged" line, already dropped in #107); `README.md`'s endpoint table never had them. Comments that
described the trackers — the `local-session.ts` header, `store/sessions.go`'s two paragraphs, and the
inline "Register the canvas session…" — went with their files.

**Tested** `make check`, `make test-race`, `npm run check`, `npx vitest run` (132 cases), and the rebuilt
bundle in a browser: the canvas loads, and the network log contains no `/api/session/*` request at all
(where the previous build posted `/api/session/open` and a heartbeat every five seconds).

---

## 110. There is no token, because the client that would send it cannot keep one

**Decision** `GATEWAY_TOKEN`, the `X-Gateway-Token` branch in `Guard`, and the variable's row in
`gateway.md`/`README.md` are gone. The startup warning stays, and says what it knows: a bind that is not
loopback means anyone who can reach the port can run workflows, read their artifacts and drive a canvas's
agent.

**Why** The token protected `/api/*` and nothing else, which is not where the risk is: `/mcp/{workspace}`
was never inside that prefix, and that is the route that makes the canvas *do* things. It was also
unsendable by the only client — the canvas speaks `Authorization: Bearer local` and has nowhere to read
`X-Gateway-Token` from — so setting the variable turned every request into a 401 and the UI into a wall of
"missing a valid gateway token". A protection that breaks the product when enabled and omits the dangerous
route when it works is worse than an honest absence, especially with #19 and #75 leaning on it.

What actually protects the gateway is unchanged and is one rule: a **browser** may write only from an
allowed origin, which is what stops a random page from driving the gateway through the user's session.
Nothing protects it from a non-browser client that can reach the port, and `gateway.md` now says so in a
section of its own — including what such a client gets (`POST /api/runs`, the artifacts under
`data/outputs`, and `/api/agent/socket/{name}`, which spawns AlayaCore with `read_file` enabled). The one
dangerous write with its own lock is `POST /api/resources/install` (`INSTALL_INTO_COMFY`), fail-closed.

**Cost** An operator who wants to expose the port to an untrusted network has no built-in answer. The
documented one is an SSH tunnel or a reverse proxy that terminates authentication; a token in the page
would not have been that answer either. `GATEWAY_TOKEN` in an existing `.env` is now ignored.

**Tested** `make check`, `make test-race`; the two `httpx` tests that existed for the token went with it
(one of them still asserted `/v1/*`, a surface deleted in #69). Against the rebuilt binary on `:8192`,
`/api/workflows` answers `200` with and without the header even with `GATEWAY_TOKEN` set in its
environment, while a cross-site `POST /api/resources/refresh` still gets `403` from the origin guard.

## 111. A session's name becomes a file name, so the readable part is capped

**Decision** `agentWorkspaceKey` cuts its readable prefix at 40 bytes and appends an 8-hex and a `-`:
49 bytes at most, whatever the client typed.

**Why** The key is both a directory under `DATA_DIR/agent/workspaces/` and the path segment of the MCP URL,
so it has to survive a file name and a URL. The cap was already written — `if safe.Len() >= 40 { break }`
— but the `break` sat inside the `switch` that chose between "copy the rune" and "write a dash", so it
left the switch and the loop kept appending: a long name produced a key as long as the name. Staticcheck's
SA4011 named it; the fix is to test the length before writing.

**Cost** A canvas id longer than 40 characters is recognisable only by its first 40 and its hash, which is
what the hash is for. Nothing reads the prefix back.

**Tested** `internal/server/agent_workspace_test.go`: a 500-character name yields a key of at most 49 bytes
with an 8-hex suffix, deterministically; two names that agree for their first 499 characters still differ;
and a name carrying `/`, `:`, `*`, `?` and CJK becomes dashes without starting with a dot.

---

## 112. A spawn is not worth the whole gateway's lock

**Decision** `Sessions.Connect` looks the name up, spawns **outside** the mutex, and files the result under
the lock with a second check. Losing that race releases the process it started and answers with the
session that exists. The session's own startup state gained an `RWMutex` (`snapshot`), because a second
connection now reads it while the pump writes it.

**Why** `Connect` held the sessions lock across the spawn **and** across `readStartup`, which waits for the
agent's `session ready` — i.e. until the model list is loaded, which on a real AlayaCore is seconds. The
same mutex is what `List()` takes, and `List()` is on every MCP tool call's path (`sessionForWorkspace`),
so one canvas opening its panel froze tool calls for every other panel and blocked every other connect.
The old comment claimed the cost was "a handful of milliseconds"; the `TestListDoesNotWaitForASpawn` test
that now guards it holds a fake agent at `ready` for a second, and `List` must still return inside 200 ms.

**Cost** Two connects for one name can each spawn a process; one is released immediately. That is a wasted
spawn on a race that needs two sockets to open in the same milliseconds, against a global stall on a
routine one — and the observable contract ("one session per name") is unchanged, which
`TestConcurrentConnectsFileOneSession` states.

**The race this exposed** The startup broadcast was documented as needing no lock ("only the pump changes
it"), but `Connect` read it for a *second* caller while that pump was writing. `-race` never saw it because
no test connected twice; `TestConnectWhileATurnStreamsReadsTheState` does, and the guard is now a lock
rather than a comment.

---

## 113. A vendored pack is checked against its own imports

**Decision** `internal/resource/payload_imports_test.go` walks every pack under
`resources/payload/custom_nodes`, resolves every relative import (`from ..pkg.mod import …`) against the
files that are actually shipped, and fails `make check` when one names something absent. Host modules
(`ComfyUI`, `folder_paths`, `comfy`, `nodes`, …) are excluded, and a bare `from . import name` is skipped —
there is no module path in it to resolve.

**Why** The SeedVR2 pack was vendored without `src/data/`, so `src/core/generation_utils.py` raised
`ModuleNotFoundError` before registering a node, and `video-seedvr2-upscale` could never load. The
symptom appears far from the cause — ComfyUI says `IMPORT FAILED` in its own log, the gateway reports a
missing node class, the panel shows a workflow that cannot run — and the first written diagnosis blamed
the *installed* copy, which reinstalling from this repository cannot fix. Nothing in the suite looked at
the payload's internal consistency, so the tree could ship a pack that Python could not import.

**Cost** A pack that imports a module another custom node provides at runtime would be reported. None does
today (601 imports resolved when this was written), and the exclusion list is where such a case would go —
one line, with the reason.

**The mistake this made, and the second check** Restoring the files needed a syntax check, and the only
one available without torch is `python3 -m py_compile` — which left four `__pycache__/*.pyc` files behind,
and those were committed with the sources they came from. `TestVendoredPacksContainNoBytecode` now fails on
any `__pycache__` or `.pyc` under `resources/payload`, and `.gitignore` covers both. A vendored pack is
source; bytecode is machine-specific and stale the moment the source moves.

**Tested** With `src/data/` present the check passes and reports 601 imports; moving the directory aside
makes it fail with exactly the two imports `generation_utils.py` needs. Planting a `__pycache__` directory
makes the bytecode check fail by name. The restored files are the upstream
2.5.24 tree (`area_resize`, `divisible_crop`, `na_resize`, `side_resize`), byte-identical to it, and
`python3 -m py_compile` accepts them — importing them for real needs torch, so the compile check is as far
as this repository can go without ComfyUI's interpreter.

---

## 114. The chat the panel stopped keeping, and the code that still carried it

**Decision** Out of the canvas frontend: `chatSessions` / `activeChatId` (persisted in every project,
carried through the undo history, restored on every open), the four `CanvasAssistant*` types, the
`hydrateAssistantImages` pass, thirteen dead translation keys, the `step-progress` bus
(`bindStepProgress` / `unbindStepProgress` / `publishStepProgress`), and the thirty-one unused locals and
cloud-era leftovers that `tsc --noUnusedLocals` lists (mostly `services/api/video.ts`: `ApiVideoResponse`,
`ApiEnvelope`, `VideoGenerationTaskState`, `aiHeaders`, `videoResultFromUrl`, `assertVideoBlob`,
`normalizeVideoResolution`, `delay`).

**Why** $4 held a conversation the panel drew itself. When the panel became a socket over the agent's own
session file (#104) that model lost its writer: nothing ever pushed a message, so the two fields only
travelled — written on every edit, read on every open, cloned into every undo step. The types, the
hydration pass and the store plumbing existed to move them. The rest is the same shape of leftover: the
step ring is driven by a run's own progress now (`waitForRun`'s `onSteps`, and `updateVideoSteps`), so
`publishStepProgress` had no caller and every `bindStepProgress` registered a handler nothing invoked; and
`video.ts` still carried the request/response shapes of the cloud API that #69 deleted, kept alive only by
each other.

**Cost** A stored blob is now format 4: `backfillProject` drops the two keys on read (the migration is a
destructuring, like the `editCanvasRatio` one in #102), so an older canvas opens without them. An undo
entry and a project are now `nodes + connections + backgroundMode + showImageInfo` — less to copy per edit.
`stepProgress` itself stays: the ring is real, its source is the run.

**Tested** `npm run check` (i18n 1031/1013 keys, no dead key; 181 modules, no invalid export; prettier;
`tsc --noUnusedLocals --noUnusedParameters` clean) and `npx vitest run` (133 cases, including a new one
that feeds a format-3 blob with a chat session and asserts both keys are gone while nodes and viewport
survive). In a browser against `:8191`: the same canvas opened with its 42 nodes and no console error,
which is the migration running on a real stored blob; the built bundle contains `chatSessions` exactly
once — inside the migration that deletes it.

---

## 115. The three gates that could not see, and what they see now

**Decision** The frontend's checks grew three teeth:

1. **`tsc` covers `tests/`** (`tsconfig.json`'s `include`), with `noUnusedLocals` and `noUnusedParameters`
   on for `src` as well. Dead locals are now a compile error, and a test that drifts from the types it
   exercises fails `npm run check`.
2. **`check-exports.cjs` counts a test as a reader of nothing.** A reference from `tests/` no longer makes
   an export "used": exports used only by tests are a failure, and the three that legitimately are
   (`modelsOf`, `ApiError`, `readApiErrorMessage`) are listed in `TEST_ONLY` with a reason each. This is
   the same blind spot that kept `agent.Run` alive in Go (#108) — a test importing a function is evidence
   that the function is *tested*, not that anything calls it.
3. **`check-i18n.cjs` no longer lets one template exempt a namespace.** It reads the literal candidates out
   of a template's expressions (`${mode === "image" ? "editImage" : mode}` yields `image`, `editImage`,
   `text`, `editText`) and marks only those; a segment that comes from data has to be declared in
   `DYNAMIC_PREFIXES`, either with the values it can take or with a reason why they cannot be enumerated.
   An undeclared dynamic prefix fails the check, which is what keeps the next blind spot from opening
   silently.

**Why** Each of the three was expensive in the same way: the suite was green while the tree carried code
and copy that nothing reached. Thirteen i18n keys lived under `canvas.promptPanel` because one template
argument marked the whole namespace as used; thirty-one unused locals (mostly `video.ts`'s cloud-era
shapes) were invisible because nothing asked; and the dead-export rule was satisfied by tests.

**Cost** `DYNAMIC_PREFIXES` is a list a human maintains — twelve entries today, each with the reason it
cannot be resolved. When one is added, the reason is the review. Tests are now type-checked, so a fixture
that uses a field a type no longer has fails the build instead of passing silently (ten such drifts were
found the moment the include changed).

**Tested in both directions** Adding an orphan key under `canvas.promptPanel` fails the check (1 dead key);
adding a template with an undeclared prefix fails it ("没有声明的动态 key 拼接: canvas.someNewNamespace");
turning `include` on surfaced ten real type errors in the test files, all fixed. `npm run check` and
`npx vitest run` (133 cases) are green, and the payload-import gate from #113 covers the fourth blind spot
(vendored packs).

---

## 116. Startup repairs what a kill left behind, and every knob is documented

**Decision** Three gaps found by walking the tree against its own documents:

1. `COMFY_FRONTEND_DIR` is gone. It was read, trimmed, made absolute — and never used by anything.
2. `PUBLIC_BASE_URL` is now actually read from the environment. `gateway.md` had documented it since the
   port, but only `WithPublicBaseURL` (a test option) could set it, so the documented knob did nothing.
3. Every variable the code reads is in `gateway.md`'s table: `COMFY_RETRY_ATTEMPTS`,
   `COMFY_RETRY_DELAY_MS`, `CLEANUP_INTERVAL_MS`, `MAX_IMAGE_COUNT` and `MAX_WORKFLOW_BYTES` were read by
   the gateway and documented nowhere — findable only by reading `config.go`.

**Startup hygiene, in the same pass** Two kinds of file accumulated in `DATA_DIR` with nothing to remove
them:

- **Directories from the layout before #100** (`DATA_DIR/agent/canvas-7aa15835/`): one config copy per
  session, named by the session alone. `clearAgentWorkspaces` only cleared the current `workspaces/`
  subtree, so these sat there forever. It now removes every directory under `agent/` except `workspaces`
  and `sessions` — conversations are still never touched.
- **`util.WriteFileAtomic` leftovers** (`tasks.json.1793441001953777902.tmp`): a kill between the write
  and the rename leaves one behind, and this tree had five. `util.SweepTempFiles(dir)` removes files
  matching `<name>.<nanoseconds>.tmp` directly in `DATA_DIR` and `OUTPUT_DIR` at startup — only files, only
  that shape, so a broad `*.tmp` delete never happens in a directory of user data.

**Why startup, not a janitor** Both facts are only true when nothing is running: no session exists yet, and
no atomic write is in flight. Doing it in `server.New` costs two `ReadDir`s and cannot race.

**Cost** A `.tmp` file an operator deliberately put in `DATA_DIR` with that exact name would be removed. It
would also be indistinguishable from the leftovers, which is why the pattern is that narrow.

**Tested** `internal/util/util_test.go` (the sweep takes the two leftovers, leaves `tasks.json`,
`notes.tmp`, `output.png`, a `.bak` and a *directory* that matches the pattern);
`internal/server/agent_workspace_test.go` (the legacy directory and `workspaces/` go, `sessions/` and
`tasks.json` stay). End to end on `:8191`: a planted `setup-status.json.<nanos>.tmp` and
`agent/canvas-legacy01/` were gone after the restart, `data/agent/` held only `sessions/`, and `/health`
answered.

## 117. One of the two Chinese paths was not the author's after all _(the other path is gone too, see #119)_

**Decision** `image-qwen21-outpaint.json` loads its LoRA as `qwen-image-2.1-outpaint-v2.safetensors`, and
`resources/index.json` installs it at `loras/qwen-image-2.1-outpaint-v2.safetensors`. The
`loras/Qwen-功能2.1/Qwen21-图像扩展…` path is gone, directory and all.

**Why #66 and #67 were wrong about it** Both kept that path on the stated grounds that it is "a filename
on disk, not copy" and "a file the upstream authors published in Chinese". The first half is true — the
graph resolves `lora_name` literally, and whatever it says has to exist. The second half is false, and the
index said so itself: all three sources it lists (ausboss on ModelScope and AIFastHub, bozoyan on
ModelScope) publish `qwen-image-2.1-outpaint-v2.safetensors`, ASCII. The Chinese folder and the `Qwen21-图像
扩展` prefix were the local filing habit of the machine the graph was drawn on, and the installer faithfully
reproduced the rename. `KOOK-MOSS-SFT-观澜.safetensors` is the one that really is upstream's name — its
ModelScope dataset URL is percent-encoded 观澜 — and it stays.

**What the old path was costing** A `/` separator frozen into the graph, while `folder_paths.recursive_search`
builds names with `os.path.relpath`. On Windows that same directory lists as `Qwen-功能2.1\Qwen21-…`, so the
string the graph carries would not resolve there. Nothing else read the path: the index, the graph and one
parser fixture were its only mentions.

**Why now and not later** No user has installed this yet, and the file on disk was already byte-identical
under both names (sha256 `3611a5cc…`, the hash the index declares). Later this would be a rename on every
machine or a 152 MiB re-download.

**Tested** `make check` (gofmt, `go vet`, `go test . ./internal/...`) passes. The LoRA still reaches the
workflow's dropdown: `internal/generate/lora.go` compiles the filter with `(?i)`, so
`Qwen21|qwen_image_2.1|Qwen-Image-2.1` matches the new name through its last alternative.
`tests/resource-copy-zh.test.ts` passes and now has one Chinese `target` to police instead of two — it
caught the first draft of the new index `note`, which had quoted the old folder name.

**Where** `workflows/image-qwen21-outpaint.json`, `resources/index.json`, #66, #67.

## 118. The H3 pack stops being the one we cannot check

**Decision** Every resource in the `h3` pack now carries a `sha256`, and
`h3_lightx2v_8step_lora` installs as `minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors` — the
name its two sources publish, without the `768p` a local hand had inserted.

**Why the pack had none** Thirteen entries — the H3 text encoder, both VAEs, two LoRAs, and the whole VDN
stage — were declared with a `size` and no hash. The files were already on the reference machine before
the catalogue described them, so the entry recorded what was observed, not what would be downloaded:
`downloadFile` skips verification when `expectedSha` is empty, and a note was the only thing asserting
that the renamed LoRA was the same artifact. That is the one shape a catalogue must not have — an install
that reports success without ever comparing bytes.

**How the hashes were obtained without downloading 40 GB** Both hosts publish the digest of the stored
object, so a `HEAD` is enough:

- **Hugging Face (and `hf-mirror`)** — `x-linked-etag` on the `resolve/main/...` response *is* the
  sha256 of the LFS object, and `x-linked-size` its length.
- **ModelScope** — `GET /api/v1/models/<repo>/repo/files?Revision=master&Recursive=true` returns
  `Sha256` and `Size` per file, LFS or not.

All thirteen were then checked against the files already on disk: **13/13 match**, including the two
`adapters/*/adapter_spec.json` files the index had been writing as `adapter_config.json`, which is now
proof rather than a claim in a note. A full sweep of the catalogue — every resource that declares a hash
and is installed — reports 43 files, 180.9 GiB, zero mismatches.

**Why the rename went with it** The old `target` carried a `768p` its own `sources` do not, so the
installer renamed on every download and the note had to explain why. `x-linked-size: 1956193000` matching
the local file's size, and the hash matching byte for byte, is what the rename was asserting; with the
target equal to the published name the assertion is no longer needed. `video-h3-ref2va-drama.json` and
the Chinese note in `resource-copy-zh.ts` carried the old spelling and were updated with it.

**Cost** The hashes pin the catalog to the current revision of `Comfy-Org/MiniMax-H3`, `OpenVDN/vdn-minimax-h3`
and `akatz-ai/MiniMax-H3-Character-Swap-LoRA`. If any of them replaces a file in place, the install fails
its checksum instead of silently installing something else — the intended failure, but it means the index
has to be updated when upstream moves. And a hash can only be added this way for a host that publishes
one; a source that offers neither header still needs the bytes downloaded once.

**Where** `resources/index.json`, `workflows/video-h3-ref2va-drama.json`,
`canvas/web/src/lib/resource-copy-zh.ts`.

## 119. Guanlan leaves: an optional download nobody needs

**Decision** `moss_guanlan_lora` is gone from `resources/index.json` — the resource, its entry in the
moss pack's `resources` and `optionalResources`, and its line in the Chinese copy table. The 145 MB file
is deleted from `models/loras/Moss_image/`. The catalogue went from 59 resources to 58.

**What it was** A style/aesthetic LoRA for MOSS-Image SFT, which the index could only describe as
`license: Unknown (community LoRA)`. The weights say the rest: ai-toolkit 1.18.9, internal name
`MOSS-SFT-2027`, `ss_base_model_version: moss_image`, 5000 steps over 70 epochs, version 1.0, and no
trigger word or dataset metadata at all. Nothing in the repository knows what it does to an image.

**Why it went** Three things together, none fatal alone:

- **No workflow names it.** Nothing in `workflows/` references the file; the only reason it was visible
  was the `Moss_image|MOSS|moss` filter putting it in the LoRA dropdown of the three MOSS graphs. A
  dropdown entry is not a dependency.
- **No license.** `Unknown (community LoRA)` is a license we cannot ship against, and unlike the other
  third-party weights it was not even a mirror of something we could point at.
- **The note was wrong.** It said the ModelScope collection is private and signing in may be required.
  The file answers `302 → cdn-lfs 200` with a full `content-length`, no credential — so the entry was
  also the reason a user could not tell what they were agreeing to.

**What this is not** Not a statement that community LoRAs are unwelcome: `moss_image_sft_8steps_lora`
stays, because a shipped graph loads it and it has a hash. The rule the pack now follows is the one the
`upscale` pack already used: a resource exists because a workflow needs it, not because a download was
convenient to list.

**Tested** `make check` and the canvas suite (133 tests) both pass; `resource-copy-zh.test.ts` is the gate
that would have caught a zh dictionary key left pointing at a resource that no longer exists.

**Where** `resources/index.json`, `canvas/web/src/lib/resource-copy-zh.ts`.

## 120. taeh3 stops being a binary of unknown origin

**Decision** `h3_tiny_vae` is downloaded, not bundled: `resources/payload/vae_approx/` is gone and the
index entry carries two sources plus the correct license. The three H3 graphs still say
`tiny_vae: taeh3.safetensors` — the upstream file has exactly that name, so nothing in `workflows/` moved.

**What was wrong with it** It was the only model in the catalogue with `sources: []`, which is why it was
staged under `resources/payload/` in the first place — a 9.8 MB safetensors in git that nothing in the
repository could describe beyond "preview VAE". Its `license` was declared as *MiniMax H3 Community
License*, which is not what it is.

**What it actually is** Byte-identical to `Kijai/MiniMax-H3-TAE → vae_approx/taeh3.safetensors`
(`x-linked-etag` `f0f60fa0…`, `x-linked-size` 9791388), Apache-2.0, and Kijai is the author of the KJNodes
node that consumes it. A re-publisher, `t8star/Taeh3-Comfy`, records the same hash in a `provenance.json`
with `"modifications": "filename only; tensors unchanged"` and carries the upstream revision
(`a213ac8b…`). The file had a paper trail all along; we simply had not written it down.

**Why the file cannot just be dropped instead** Because a missing `vae_approx` entry does not degrade, it
fails twice:

- `internal/setup/scan.go` validates every loader input against ComfyUI's option list and turns any miss
  into a `Problem`, which makes `available` false — the canvas then filters the workflow out of the model
  list (`web/src/lib/gateway-models.ts`), so the H3 graphs vanish from the picker entirely.
- If one is submitted anyway, ComfyUI rejects the prompt: `tiny_vae` is a combo whose options are
  enumerated from disk at validation time (`nodes/preview_override_node.py`), so the hard-coded filename
  fails `value_not_in_list` in `execution.py` before any node runs.

The graceful path exists — `load_tiny_vae_decoder` returns `None` with a warning when the file is absent,
and the node falls back to the default previewer — but validation never lets execution reach it. So the
only way to take the binary out of the repository without breaking three workflows was to give it a URL.

**Why "now it needs the network" is not a cost** The `h3` pack already pulls roughly 60 GB on install.
9.8 MB against that is noise, and it buys a verified hash the bundled path never had.

**Tested** `make check`, `tsc --noEmit`, and the canvas suite (133 tests) pass; the payload path unit test
is unaffected because `payloadPath` itself did not change. `resources/payload/` now contains node packs
only.

**Where** `resources/index.json`, `canvas/web/src/lib/resource-copy-zh.ts`,
`resources/payload/vae_approx/`.

## 121. Every vendored pack says which commit it is, and which files we changed

**Decision** Each of the eleven node entries carries `upstream` (the repository) and — for the ten that are
vendored — `pinnedCommit`. Three of them also carry `localPatches`, a list of files that are not what
upstream published. `Resource` gained the three fields so the facts survive the index→cache rewrite and
reach `/api/resources/status` instead of sitting in the JSON unread.

**Why it was missing** The catalogue described where to download a pack from, but the packs are not
downloaded: they are copied from `resources/payload`. So the index described the wrong thing about half of
its own node entries, and "which version are we frozen on" had no answer anywhere — the repositories publish
no tags (`lquesada` and `kijai` return empty tag lists), and nothing recorded a commit.

**How the pins were found, without downloading the packs again** A blobless clone per repository
(`--filter=blob:none --no-checkout`) keeps trees and commits and skips file contents. `git ls-tree -r
<commit>` then yields the complete blob manifest of a commit, which is comparable to `git hash-object` over
the vendored directory — no blob fetched, no API quota spent. Candidate commits were limited to those
before 2026-10-30, the date the packs were committed here, because a copy cannot come from the future.

| pack | pinned | upstream commit date |
|---|---|---|
| `comfyui-kjnodes` | `d7641533d663` | 2026-10-10 |
| `ComfyUI-VideoHelperSuite` | `4d907bee61e9` | 2026-09-01 |
| `ComfyUI-Inpaint-CropAndStitch` | `e2727a26c0a0` | 2026-10-18 |
| `ComfyUI-qwenmultiangle` | `bf8d032a36f1` | 2026-09-12 |
| `ComfyUI-VDN-H3` | `7271c648d7c2` | 2026-09-07 |
| `ComfyUI-YCNodes-MiniMax-H3` | `efbe83f69ffa` | 2026-09-15 |
| `comfyui-SelfLift` | `835c3cf79194` | 2026-09-19 |
| `ComfyUI-SolAttn_triton` | `dfc2e31a41af` | 2026-08-22 |
| `minimax-h3-audio-t8` | `5bb623978d0e` | 2026-08-26 |
| `ComfyUI-SeedVR2_VideoUpscaler` | `4490bd1f482e` | 2025-12-24 |

**What the comparison turned up** Two things that were not known before this pass:

1. **Three files differ only by line endings.** `ComfyUI-Inpaint-CropAndStitch/__init__.py` and two files in
   `ComfyUI-YCNodes-MiniMax-H3` are CRLF upstream and LF here, because `.gitattributes` says `* text=auto`
   and normalises on commit. The content is upstream's; only the blob differs.
2. **Four files are ours, not upstream's, and no commit ever published them.** `ComfyUI-SolAttn_triton`
   changes two node defaults (`sink_conditioning` → `exact_kv`, `dense_blocks` → `0-5`) and resolves
   `_forward` on the class at call time "so sampling-scoped patches such as TE-Speed's MiniMaxH3 runtime
   forward remain in the chain"; `ComfyUI-SeedVR2_VideoUpscaler` swaps `allow_tf32` for the newer
   `fp32_precision` API; `minimax-h3-audio-t8` passes three extra arguments to `final_layer`
   (`sigma_v`, `sample_sigmas`, the two shifts). #113 recorded that the SeedVR2 files *restored* were
   byte-identical to upstream, which is still true — but the tree as a whole was never pristine, and
   nothing said so.

**Why it changes the download question** "Replace the vendored packs with downloads" was being argued from
principle, because nobody could measure the difference. It is now measurable: switching to upstream would
drop those four fixes. That does not make vendoring right — it makes the trade-off explicit, which is what
`localPatches` is for.

**Cost** A pin is only useful while upstream keeps the commit. If a repository is deleted or force-pushed
past it, the SHA stops resolving. `frame_interpolation_node` had no pin when this was written — it is
downloaded rather than vendored, so there was no frozen copy to read a commit off — and has since been
pinned to `26545cc2dd95`, the commit `main` pointed at. All nine node URLs name a commit; see #126.

**Tested** `make check`, `tsc --noEmit` and the canvas suite (133 tests) pass; `gofmt` clean after the struct
change.

**Where** `resources/index.json`, `internal/resource/resource.go`.

## 122. Two of the four local patches are gone

**Decision** `minimax-h3-audio-t8` is re-vendored at **v1.79.2** (`93cefbf5d15f`), and
`ComfyUI-SolAttn_triton/__init__.py` is restored to the bytes upstream publishes at the commit we already
pin. Four locally modified files became two.

**The audio-t8 one was upstream's fix, written better** Our copy of `multikeyframe_advanced.py` passed
three extra arguments to `final_layer` because the H3 core changed its signature. v1.75.0 solved the same
problem with `call_h3_final_layer`, which inspects the model's signature and passes the schedule
parameters only when the layer accepts them — so it survives both cores instead of ours, which only
survives the new one. Re-vendoring removes the patch and the reasoning that went with it.

**Why v1.79.2 and not v1.104.0** v1.104.0 is 6,566 files and, at the tag itself, not self-consistent:
its root `__init__.py` imports modules that live in `h3_t8/`, and `h3_t8/nodes.py` imports
`sol_attn_minimax_v2`, which lives at the root. `TestVendoredPacksImportOnlyWhatTheyShip` rejects that
tree, correctly — a pack we ship must be one Python can import. v1.79.2 is the earliest tag after the
`h3_t8/` reorganisation, resolves all 3,167 relative imports across the packs, and is 25 releases newer
than the v1.47.0 it replaces. It costs 416 files where we had 179, and 6.8 MB where we had 6.5.

**What was checked before shipping it** The four node classes our graphs actually use
(`MiniMaxH3AVDecodeT8`, `MiniMaxH3AudioConditioningT8`, `MiniMaxH3SigmaShift`, `ModelAttentionBackend`)
still exist, and all 62 inputs those graphs pass to them still exist by name. Without that, "it imports" is
not the same as "it works".

**The SolAttn defaults cost nothing to give back** Upstream's 2026-08-05 commit "update defaults" changed
three values; our copy kept two and reverted `sink_conditioning` to `exact_kv`, plus set `dense_blocks`
to `0-5`. The only graph that uses the node, `video-h3-ref2va-drama.json`, passes `"off"` and `""`
explicitly, so the defaults never reached a render. Restored.

**What is still patched, and why it has to be**
`ComfyUI-SolAttn_triton/_morton_h3.py` resolves `_forward` on the class at call time so TE-Speed's runtime
patch stays in the chain — upstream still captures the pointer at patch time. And
`ComfyUI-SeedVR2_VideoUpscaler/src/common/distributed/basic.py` uses `fp32_precision` where upstream still
sets `allow_tf32`; that repository has not been touched since 2025-12-24, so there is no upstream fix to
wait for.

**Tested** `make check` (3,167 relative imports resolved, no bytecode), `tsc --noEmit`, and 133 canvas tests.
Not tested: a real render — ComfyUI is not running on this machine, and no gate here can replace that. The
input-name check above is the closest thing available without it.

**Where** `resources/payload/custom_nodes/minimax-h3-audio-t8`, `.../ComfyUI-SolAttn_triton/__init__.py`,
`resources/index.json`.

## 123. SeedVR2 leaves: the video upscaler nobody maintains, for a job we do not have

**Decision** `video-seedvr2-upscale` is gone — the registry entry, the graph, its three resources, the
vendored pack, the runtime-dependency entry, the two loader specs, the `SEEDVR2` model-dir alias, and the
canvas action that drove it (toolbar button, dialog, API call, hook, i18n, Chinese copy, tests). The
catalogue is 55 resources and 17 workflows; `resources/payload` is node packs only.

**Why it went** Three facts, in the order they mattered:

1. **The job is not one we have.** `video-seedvr2-upscale` took any clip and returned a bigger one. Nobody
   asked for that; the H3 workflows already produce their own video at the resolution they need.
2. **Upstream is dormant.** `numz/ComfyUI-SeedVR2_VideoUpscaler` is the official port — its README says so
   — but the last push was 2025-12-24, with 140 open issues and 24 open pull requests. Recent reports are
   unanswered, including one from 2026-09-18 that matters for a ComfyUI we keep updating: the pack's
   compatibility shims register phantom `flash_attn` / `bitsandbytes` modules. It is not archived, so
   nothing warns a user; it simply rots.
3. **Nothing better exists for that job.** A code search inside `comfyanonymous/ComfyUI` for `seedvr2`
   returns zero hits across code, issues, PRs and commits — core never absorbed it — and no fork picked it
   up (the search returns wrappers and integrations, not successors).

**What was checked before deleting, because "find a better one" was the tempting answer**
Two actively maintained packs do H3 video upscaling: `LBH-123-AI/Comfyui_Minimax_h3_latent_Upscaler`
(805★, MIT, last push 2026-09) and `bbaudio-2025/Comfyui-MMH3-UltimateUpscale` (248★, MIT, 2026-10). Both
are **latent-in, latent-out**: their main nodes declare `model`, `conditioning`, `negative?`, `latent` and
return `latent`. They enhance a clip *inside* the generation graph; they cannot take an exported mp4. So
they are not replacements for a file→file workflow — they are a better second pass, and #121's numbers
already show we benefit from LBH's work: `SelfLiftH3Sampler` loads
`minimax_h3_latent_upscaler_3d_fp16.safetensors`, which is LBH's model.

That distinction is the whole decision: **"replace the upscaler" and "keep the upscale button" are
different questions.** The first has a good answer we already use. The second has none, and does not need
one.

**Cost** A user holding an arbitrary clip and wanting it bigger has no path any more. If that becomes a
requirement, the honest way back is a fork of the Apache-2.0 upstream with the torch shim fixed — not
re-vendoring a dormant pack and hoping.

**Tested** `make check` (imports and bytecode gates included), `tsc --noEmit`, and the canvas suite:
132 tests, one fewer than before because the deleted `createVideoUpscaleTask` case went with the function.

**Where** `workflows/registry.json`, `resources/index.json`, `resources/payload/custom_nodes/`,
`internal/resource/status.go`, `internal/workflow/loaders.go`, `internal/setup/paths.go`,
`canvas/web/src/{lib/canvas,components/canvas,pages/canvas,services/api,i18n}`.
## 124. The no-VDN path leaves, and takes the last unlicensed pack with it

**Decision** The three `-novdn` workflows, their graph, the LightX2V 8-step LoRA, the SolAttn pack, the
two unreferenced 4-step LoRAs, and the UI switch that chose between the two backends are gone. The
catalogue is 14 workflows and 53 resources; `resources/payload` holds 8 packs, all of them reachable
upstream and none of them patched.

**Why** Four reasons that arrived in this order:

1. **The capability was duplicated.** `-novdn` and the VDN trio are the same model with the same three
   input modes; only the acceleration recipe differs (a 1.8 GB distillation LoRA plus sparse attention,
   versus a 5.1 GB distilled stage model plus chunked attention). Both run 8 steps + one refinement.
2. **Nobody had ever used it.** The gateway's 16 recorded runs are `image-qwen21` ×8,
   `video-h3-frames` ×6 and `video-h3-ref2va` ×2 — the last two are the VDN graphs. No `-novdn` run
   exists, and no run carries a LoRA at all.
3. **It was SolAttn's only reason to exist**, and SolAttn was the last pack with no real license story —
   the repo does publish one (Apache-2.0), which our copy never carried, so the index said "No LICENSE
   declared". More importantly, ComfyUI core already ships the same thing:
   `comfy_extras/nodes_sparse_attention.py` implements *Sol-Attn adaptive threshold*, SLA-style top-k and
   FastVideo's VSA behind one `BlockSparseAttention` node, with patches specifically for MiniMax-H3. A
   third-party pack that reimplements core, on a path nobody runs, is not worth its dependency.
4. **Two of the four LoRAs were dead weight.** `minimax_h3_fl2v_turbo_4step_v1.0_768p` and
   `minimax_h3_ref2v_turbo_4step_v0.1` are referenced by no graph — they only appeared in a LoRA dropdown
   whose filter matches any `minimax_h3*` file. 3.6 GB for an entry nobody can use correctly without the
   chain they were trained for.

**What was kept, and why** `h3_character_swap_lora` stays: 0.14 GB, referenced by the character-swap
graph, and the only "replace the person in this clip" capability we have. The VDN trio and character swap
are exactly the workflows that have actually run.

**Cost** There is no fallback if the VDN stage weights disappear. They come from a single source
(`OpenVDN/vdn-minimax-h3`), and #118 is what makes that survivable: the sha256 of every stage file is in
the catalogue and the copies are on disk. The UI also loses its "no VDN" toggle —
`video-model-mode.ts` went from five exports to three and no longer rewrites a workflow id.

**Tested** `make check` (imports, bytecode, the media-role tests now naming only the VDN ids), `tsc
--noEmit`, 132 canvas tests, and an integrity pass: 14 registry entries all point at graphs that exist,
every pack reference resolves, and the 8 payload directories are exactly the 8 vendored node resources.

**Where** `workflows/registry.json`, `workflows/video-h3-ref2va-drama.json` (deleted),
`resources/index.json`, `resources/payload/custom_nodes/ComfyUI-SolAttn_triton` (deleted),
`canvas/web/src/lib/canvas/video-model-mode.ts`, the two node panels, `video-settings-panel.tsx`,
`i18n/locales/*`, `lib/resource-copy-zh.ts`, `internal/workflow/media_test.go`.

## 125. Krea2 leaves: the second text-to-image family nobody opened

**Decision** The `krea2` pack is gone — four resources, the `image-krea2-turbo` workflow and its graph, the
Chinese copy, and 29.92 GiB of weights. The catalogue is 13 workflows, 49 resources and 8 packs.

**Why** It occupied the same slot as Z-Image Turbo and had never been used. Both are 8-step, CFG-1
distillation models of the same size class with a text-to-image graph; the difference is which images they
were trained on. The evidence is one-sided:

| | Z-Image Turbo | Krea2 Turbo |
|---|---|---|
| disk | 25.04 GiB (bf16 + int8) | 29.92 GiB (fp8 + int8) |
| outputs in `output/` | **1030** | **0** |

Sampling five Z-Image artefacts plus the newest one, every embedded graph names
`z_image_turbo_bf16.safetensors` at 8 steps and CFG 1 — so the int8 variant has never run either, though
it is the low-VRAM fallback and stays.

**What "another aesthetic" costs** 29.92 GiB resident for a second look, when the pack can be installed
from the resource panel in a few minutes and removed again. Three of the four files only existed for this
workflow: `qwen3vl_4b_fp8_scaled` (4.88 GiB, a vision-language encoder used nowhere else),
`qwen_image_vae`, and the int8 base model that no graph declared a dependency on.

**What is left for images** Z-Image Turbo (fast drafts, the one actually used), Qwen Image 2.1 (edit,
inpaint, outpaint, multi-angle) and MOSS-Image (the three-recipe photoreal family). Those three do
different jobs; Krea2 was the only removable duplicate.

**Tested** `make check`, `tsc --noEmit`, 132 canvas tests, and the integrity pass: 13 registry entries all
point at graphs that exist, every pack reference resolves, 8 payload directories for 8 vendored node
resources. `internal/generate`'s "a LoRA outside the family is rejected" fixture was renamed from
`krea2/anime.safetensors` to `other-family/anime.safetensors` — it needs a foreign name, not that one.

**Where** `resources/index.json`, `workflows/registry.json`, `workflows/image-krea2-turbo.json` (deleted),
`canvas/web/src/lib/resource-copy-zh.ts`, `README.md`, `internal/generate/generate_test.go`.
## 126. The node packs are no longer bundled

**Decision** `resources/payload` is gone. All nine node resources install by downloading the
`archive/<pinnedCommit>.zip` their entry names, the catalogue's `size` now describes that download rather
than a directory in this repository, and the "the pre-extracted folder is copied with the pack" wording is
gone from the index and from the Chinese table.

**Why** Two reasons, and one of them was us:

1. **The vendored copies were not what upstream ships.** They were hand-trimmed — `ComfyUI-Inpaint-CropAndStitch`
   kept 7 of 50 files, `minimax-h3-audio-t8` kept 416 of 1,570 — so "the tree we tested" and "the tree a
   user gets" were never the same tree, for no reason anybody asked for. Once the packs are downloaded that
   difference disappears on its own.
2. **The imports gate existed to catch our own vendoring mistakes.** `TestVendoredPacksImportOnlyWhatTheyShip`
   was written because the SeedVR2 pack lost `src/data/` on the way into git (#113). Downloading upstream's
   own tree removes that failure mode, so a second gate that verifies downloaded trees would be protecting
   against a risk we just deleted — upstream's archive is the tree its author runs.

**The bug this exposed, which had to be fixed first** `extractZip` keeps the wrapper directory every GitHub
archive contains, while install state is read from `custom_nodes/<target name>`. Only
`ComfyUI-Frame-Interpolation` had ever taken the download path, and it landed as
`ComfyUI-Frame-Interpolation-main` — so the panel could never see it as installed and every click on
Install would download it again, silently. Shipping nine packs down that path would have made the bug the
normal case.

`extractNodeArchive` now unpacks to a staging directory and copies the wrapper's *contents* onto the target
name, and the download path skips when the target already exists (the bundled path always did). The new
`TestExtractNodeArchiveDropsTheWrapperDirectory` pins both halves: the files arrive, the wrapper does not.

**Cost** Installing a node pack now needs the network and depends on GitHub being reachable — models already
did, and node packs have no mirror. What lands is upstream's full tree: Inpaint brings its 20 test images,
audio-t8 its 1,570 files. That is 43 MB across nine packs, against 11 MB of hand-trimmed copies, and the
extra weight is the price of not shipping a tree we edited by accident.

**The first attempt broke a size, and the audit caught it** Rewriting nine `size` fields line by line
walked past `frame_interpolation_node`, which had no `size` field at all, and wrote its archive size onto
the next entry — `esrgan_x2plus`, whose 67 MB download became 16.8 MB. The check that found it compares
every declared `size` against the file on disk for installed resources, and every changed `size` against
the previous revision; both are now part of how this file gets edited. `esrgan_x2plus` is back to
67,061,725 and `frame_interpolation_node` finally has the size it never had.

**Tested** `make check`, `tsc --noEmit`, 132 canvas tests, and the integrity pass (13 registry entries, 49
resources, no dangling references, every workflow's graph present). The install path itself is best proven
by the panel: the packs were deleted from the reference machine's `custom_nodes` so the next Install click
exercises the new code.

**Where** `internal/resource/jobs.go`, `internal/resource/install_extract_test.go` (new),
`resources/index.json`, `canvas/web/src/lib/resource-copy-zh.ts`, `resources/payload/` (deleted).

## 128. `resources/index.json` becomes `catalogue.json` _(the name given in it was wrong, see #129)_

**Decision** The resource index moved from `resources/index.json` to `catalogue.json` at the repository
root, and `resources/` is gone. Its name says what it is — the catalogue of everything that has to exist on
a machine — instead of "index", which described its position rather than its job. The project already calls
it "the resource catalogue" in #67, so the file now matches the word.

**Why the directory had to go with it** `resources/` held two things: the index and `payload/`. The payload
half was deleted in #126 when every node pack started downloading, so the directory was a wrapper around one
file. A directory that exists to hold one file is a place to look for things that are not there.

**What had to move with the file** Three things depended on the old path, and only one was a path:

- `Manager.indexPath`, obviously.
- `config.hasMarker`, which decides whether a directory really is the gateway's asset root. It probes for
  `workflows/registry.json` and `resources/index.json`; a wrong answer there would leave the gateway without
  workflows, so `catalogue.json` is now the second marker.
- `payloadPath`, whose convention was `resources/payload/<target>`. Since nothing is staged there any more
  and the directory is gone, the rule is now `payload/<target>`. The mechanism and its comments stay; only
  the location changed, and the comment says plainly that nothing is staged there today.

**Tested** `gofmt`, `go vet`, `go test ./internal/...`, `tsc --noEmit`, 132 canvas tests — the canvas test
that reads the index (`resource-copy-zh.test.ts`, which enforces "the index is English except in `target`")
follows the file to its new path. A tree-wide grep for `resources/index.json` and `resources/payload` now
returns only #121–#127, which describe history.

**Where** `catalogue.json` (moved), `internal/resource/{resource,jobs,helpers,status}.go`,
`internal/config/config.go`, `internal/config/config_test.go`, `internal/resource/*_test.go`,
`canvas/web/{src,tests}`, `README.md`, `docs/server.md`, `docs/known-issues.md`.

## 129. The file is `resources.json`, not `catalogue.json`

**Decision** Renamed. #128 moved the index out of `resources/` and called it `catalogue.json`; the name was
wrong and this corrects it before anything could depend on it.

**Why "catalogue" was a bad name** It came from prose — #67 calls the thing *the resource catalogue* — and a
word that reads well in a sentence does not automatically read well as a filename. "Catalogue" suggests a
browsable collection of products; this file is a list of things that must exist on a machine before a
workflow can run, with the URL, the hash and the destination for each. It also reads as the British
spelling of a word software rarely uses at all.

**Why `resources.json`** It is the word the rest of the project already uses for exactly this: the panel is
the resource centre, the route is `/api/resources`, the Go type is `Resource`, and the payload field on a
workflow row is called `resources`. Beside `workflows/` at the root it also states the split in one line —
`workflows/` is what can run, `resources.json` is what has to be there for it to run.

**Cost** One commit, twenty-one replacements, and three places that are not strings: the index path,
`config.hasMarker` (which identifies the asset root), and the canvas test that reads the file to enforce
"English everywhere except `target`". No install or layout behaviour changed.

**Tested** `gofmt`, `go vet`, `go test ./internal/...`, `tsc --noEmit`, 132 canvas tests. A tree-wide grep for
`catalogue` now returns only #67, #121, #127 and #128, which are history.

**Where** `resources.json` (moved), `internal/resource/`, `internal/config/`, `canvas/web/`,
`README.md`, `docs/server.md`, `docs/known-issues.md`.

## 130. A pack's dependencies are derived from its graphs, not written down three times

**Decision** `resources.json` no longer says which files a pack needs. A pack is now an id, a label, a
description, a list of workflow ids, and a list of *alternates*; everything else is read off the
workflows' graphs. `schema` is 2, and the fields `resources`, `optionalResources` and
`workflowDependencies` are gone.

**Why the hand-written lists had to go** They were three descriptions of one fact, and all three had
drifted from the graphs:

- **Six packs declared every resource optional.** `resources == optionalResources`, so
  `required = resources − optionalResources` was empty: the panel showed "已齐全" for MOSS, H3, Z-Image
  and upscale packs *even with every weight deleted*, and because `total` was 0 the row had no checkbox,
  so the pack could not be installed from the panel at all. A pack that says it is complete and cannot
  be installed is worse than one that says nothing.
- **Eight of the nine node packs had no entry point.** Only `frame_interpolation_node` appeared in any
  pack. `qwenmultiangle`, `inpaint_cropandstitch`, `kjnodes` and all five H3 packs were installable only
  by hand, while their workflows were offered in the canvas — this was true in the initial import too
  (`925ce37`), so it was never a regression, just a hole nobody's list closed.
- **The tables missed real dependencies.** No pack listed `kjnodes` for the H3 workflows that run
  `ModelPreviewOverrideKJ`, and `video-h3-*` omitted all five packs its graphs need. Conversely the
  Outpaint LoRA was listed for `image-qwen21` (whose default graph is *edit*) only because someone
  remembered the variant.

**What "derived" means** A graph names files through loader inputs and names nodes through `class_type`.
The catalogue knows which resource owns a target (`loras/Moss_image/…` is matched as a whole target, not
as a file name, because two LoRAs can share a name in different folders) and which classes a pack
provides. Two shapes needed care: `ApplyVDNH3Advanced.vdn_checkpoint` names a *directory*
(`stage-dmd-step-250`) and is matched as a prefix, and a loader class can be owned by a node pack
(`SelfLiftH3Sampler`, `ApplyVDNH3Advanced`, `LoraLoaderBypassModelOnly`), so the class lookup runs for
loader nodes too. Variants are unioned: outpaint's LoRA is a dependency of the workflow even though the
default mode never loads it.

**What the pack row now says** Required is the intersection over the pack's workflows — a file every one
of them loads; optional is everything else the pack can install, which includes alternates no graph names
(the second precision of a base model, the other two RealESRGAN checkpoints). H3 therefore requires 20
items (including its five node packs) and offers one optional LoRA; MOSS requires three and offers four.
A pack with no workflows — `core` — requires nothing, which is what makes it informational.

**Two data corrections fell out of the audit**

- `provides` is not "every class this pack registers", it is "every class our graphs need from this pack".
  `h3_audio_t8_node` claimed `MiniMaxH3SigmaShift`, `ModelAttentionBackend` and
  `LoraLoaderBypassModelOnly` — all three ship with ComfyUI (`comfy_extras/nodes_minimax_h3.py`,
  `nodes_model_advanced.py`, `nodes_lora_debug.py`), so the pack was being blamed for the host's own
  nodes and looked broken on any ComfyUI whose version moved them. `kjnodes` claimed only
  `DrawMaskOnImage` and now also claims the three classes our H3 and inpaint graphs actually load from it
  (`ModelPreviewOverrideKJ`, `MiniMaxChunkFeedForward`, `MiniMaxH3MemoryEfficientSageAttentionPatch`);
  `h3_vhs_node` gained `VHS_LoadVideo`, and is now `vhs_node` because RIFE uses it as well.
- `resources/payload` imports test (`payload_imports_test.go`) is deleted with the payload it checked.

**Tested** `gofmt`, `go vet`, `go test ./internal/...`, `tsc --noEmit`, 132 canvas tests. New tests:
`derive_test.go` pins the three matching rules (whole-target, directory prefix, loader class owned by a
pack) plus unresolved reporting and variant union; `catalogue_test.go` reads the real `resources.json` and
`workflows/registry.json` and fails if a pack names a workflow the registry lacks, if a graph loads a file
no resource owns, if a runnable pack requires nothing, if a catalogued resource is in no pack and no graph,
if a pack claims a core class, or if a node pack is not pinned to a full commit. Verified against the live
catalogue: no graph resolves to an unresolved name, and the four packs that used to show a false green now
count 3, 3, 3 and 20 required items.

**Where** `resources.json`, `internal/resource/{derive.go (new),derive_test.go (new),
catalogue_test.go (new),resource.go,status.go,helpers.go,jobs.go,bake_test.go,resource_test.go}`,
`canvas/web/src/{services/api/resources.ts,components/settings/resource-center-panel.tsx,
lib/resource-copy-zh.ts}`, `internal/resource/payload_imports_test.go` (deleted).

## 131. `core` stops being a pack

**Decision** The `core` pack is gone from `resources.json`. The panel now lists seven packs, all of them
things that download.

**Why** It was a row whose only content was the sentence "此包没有需要下载的资源" — a bundle declared to
contain nothing, in a drawer whose job is to list what to download. Since #130 a pack's contents are read
off its workflows, so `core` could never have said anything else: it has no workflows and no resources, and
no future edit would make it informative. The fact it was trying to state — the binary, the canvas bundle
and the base graphs ship with the installer — belongs in the README, where it now says it in one line.

**What went with it** The `noResources` branch in `packState` (unreachable once no pack can be empty), the
`noResources` string in both locales, the `core` row of the Chinese copy table, and the pack-fixture id in
the index validation test. Nothing consults `core` by id — the "is everything ready" summary counts packs,
and it now counts seven.

**Tested** `gofmt`, `go vet`, `go test ./internal/...`, `tsc --noEmit`, 132 canvas tests. The panel's
remaining states are `planned`, `ready` and `missing N`; a pack offering only alternates and no workflows
still renders as a green row with an install checkbox.

**Where** `resources.json`, `internal/resource/status.go`,
`canvas/web/src/{components/settings/resource-center-panel.tsx,
i18n/locales/{en-US,zh-CN}.ts,lib/resource-copy-zh.ts}`, `canvas/web/tests/resource-copy-zh.test.ts`,
`README.md`.

## 132. A node pack that is on disk but not loaded is not "missing"

**Decision** A node item now carries `needsRestart` when its directory exists but ComfyUI does not report the
classes it declares. The panel shows it as `待重启` instead of `缺`, explains why in one line, and offers no
download for it. `needsRestart` counts are also on the pack row and the per-workflow rows, and those items are
excluded from `missingSize` and from every install list.

**Why** ComfyUI imports `custom_nodes/` once, at startup. Install a pack while it is running and the directory is
correct, the classes are absent, and the panel said `缺 6` — so the user downloaded again and read
`directory already exists, skipping`. Both statements were true and together they were useless: the panel could
not tell "not installed" apart from "installed, not loaded yet", which are one restart and zero downloads apart.

**What it looks like** The directory check runs after the class check fails, so a healthy pack still reports
`matchedBy: classes`; only the broken-looking case consults the filesystem. The hint names the missing classes,
because the same symptom has a second cause — a python dependency that failed to import — and after a restart
that list is the difference between "restart again" and "install the dependency".

**Limits** The gateway cannot restart ComfyUI: this build of `--enable-manager` has no reboot route (`POST
/manager/reboot` → 405, `GET` → 404), so the panel tells the user to restart and refresh rather than pretending
to do it. A half-extracted pack would also read as `待重启`; restarting is the honest first answer to that too.

**Tested** Against the live ComfyUI on this machine, with seven packs installed while it was running: `interp`
→ `missing 2, needsRestart 2, missingSize 0`, `h3` → `missing 6, needsRestart 6`, and every other pack `missing 0`.
`gofmt`, `go vet`, `go test ./internal/...`, `tsc --noEmit`, 132 canvas tests.

**Where** `internal/resource/{resource.go,status.go}`,
`canvas/web/src/{services/api/resources.ts,components/settings/resource-center-panel.tsx,
i18n/locales/{en-US,zh-CN}.ts}`.

## 133. The tick means "and also download this", so it says so

**Decision** The optional section is called `可选版本` / "Optional versions", its checkbox carries a tooltip that
states what ticking it does, a pack's own checkbox is disabled when the pack has nothing left to download, and
"install selected" no longer re-sends packs that are only waiting for a ComfyUI restart.

**Why** The section holds exactly the `alternates` of #130 — resources no workflow names — because everything a
workflow does need is already listed inside that workflow's row. So a tick and a dot side by side in one pack
looked like two strengths of the same statement, when they are two different sentences: the dot means "this
workflow loads it, so installing the workflow gets it", the tick means "nothing needs it, tick it if you want
it". The user asked what the difference was; a control whose meaning is not on screen is a control that will be
misread.

**Also fixed while there** A pack whose remaining gaps were all `needsRestart` still had an enabled checkbox,
and ticking it built an install list that the server then rejected as empty. That checkbox is now disabled by
the same rule that hides the pack's install button, and its tooltip explains that the files are already on disk.

**Tested** `tsc --noEmit`, 132 canvas tests, and the pack rows against the live status payload: five packs
disabled (nothing left to download), `h3` and `interp` disabled for the restart reason, everything else as before.

**Where** `canvas/web/src/{components/settings/resource-center-panel.tsx,i18n/locales/{en-US,zh-CN}.ts}`.

## 134. A blocked mode does not hide the workflow

**Decision** Availability is decided by the graph a workflow *opens with*. A variant's own gaps are collected
into `availability.modeProblems` instead of `problems`, shown against that mode, and never take the workflow off
the model list. The canvas marks such a mode as `（缺节点）` and refuses to switch to it.

**Why** `image-qwen21` has four modes sharing one entry: edit, t2i, inpaint, outpaint. Inpaint wants
Inpaint-CropAndStitch; the pack was not installed, so the scan — which unioned every variant's problems and
called the entry unavailable — dropped Qwen Image from the image-model picker entirely, while edit and
text-to-image were runnable. The same shape hid nothing else, which is why it survived: only one workflow in the
registry has variants.

The panel showed the same pack as green at the same time, because its required/optional split (see #130) counts
inpaint's node pack as optional. Two screens disagreeing about one pack is the bug; the fix is to make the
workflow's own graph the unit of availability, and to let a mode carry its own verdict.

**What is unchanged** A single-graph workflow with a missing node is still unavailable (`image-qwen21-angle` needs
`QwenMultiangleCameraNode` and stays out of the picker), and the missing node is still counted in the scan's
`missing.nodes` — the totals do not quietly lose it.

**Tested** `TestScanKeepsAWorkflowWhoseVariantModeIsBlocked` builds a registry entry whose `inpaint` variant loads
an unknown node and asserts the entry stays available, that `modeProblems["inpaint"]` is reported, and that the
node still appears in `missing.nodes`. Against the live gateway: `image-qwen21` → `available: true,
modeProblems: {inpaint: 2}`, every other workflow unchanged. `gofmt`, `go vet`, `go test ./internal/...`,
`tsc --noEmit`, 132 canvas tests.

**Where** `internal/setup/{scan.go,setup.go,scan_test.go}`, `internal/resource/{resource.go,status.go}`,
`canvas/web/src/{services/api/{resources,workflows}.ts,lib/gateway-models.ts,stores/use-config-store.ts,
components/image-settings-panel.tsx,components/canvas/canvas-image-settings-popover.tsx,
components/settings/resource-center-panel.tsx,i18n/locales/{en-US,zh-CN}.ts}`.

## 135. "Install this pack" installs the pack

**Decision** A pack's *required* set is now everything at least one of its workflows loads — including a
bake's inputs, which are described in `resources.json` rather than in a graph. `optional` is only what no graph
names at all: a second precision, another upscale checkpoint. The pack's install button sends the required set
plus whatever alternates were ticked, and "#130's intersection rule" is retired.

**Why** The intersection said "required = what every workflow shares", which made the per-mode dependencies
optional — Qwen's inpaint node pack, its multi-angle node pack, its outpaint LoRA, MOSS's per-workflow base
models. Two consequences, both reported by the user before the second one was understood:

- the pack header read "已就绪" while inpaint could not run, because `missing` counted only the intersection;
- "安装此包" shipped required-plus-ticked-alternates and therefore never installed those files. Nothing in the
  UI could add them: they have no checkbox (they are not alternates) and their only other route is the
  per-workflow "安装此工作流" button on the row that needs them. The user installed the Qwen pack, saw it turn
  green, and found inpaint blocked — correctly angry that a pack the panel had described as missing was not
  installed by the button that says it installs it.

**What a pack reads as now** `qwen21` 7 required / 0 optional, `h3` 21 / 0, `moss` 7 / 0, `music` 3 required
and 4 alternates (other precisions and text encoders, 44 GiB — the reason alternates are not installed by
default), `upscale` 1 / 2, `zimage` 3 / 1.

**Also** The bake case needed one more rule: `packResourceSplit` and the installer now close the derived set
over each resource's `requires`, because a bake artifact's inputs (`moss_image_base_bf16`) are as necessary as
anything a loader names and are written down outside the graph. `moss_image_base_bf16` was listed as an
alternate by #130 and no longer is.

**Tested** Live payload from a spare port: `qwen21 requiredIds = [inpaint_cropandstitch, kjnodes,
qwen21_outpaint_lora, qwen3vl_8b_int8_convrot, qwen_image_2.1_turbo_int8_convrot, qwen_image_2.1_vae_bf16,
qwenmultiangle]`, `optionalIds = []`, and every pack reporting `present == total`. `gofmt`, `go vet`,
`go test ./internal/...`, `tsc --noEmit`, 132 canvas tests.

**Where** `internal/resource/{status.go,derive.go}`, `resources.json`,
`canvas/web/src/components/settings/resource-center-panel.tsx`.

## 136. The brush ring was behind the dialog it lives in

**Decision** The mask editor's brush ring moved from `z-[1100]` to `z-[1500]`, and the canvas only hides the
native cursor while that ring is actually rendered — otherwise it shows `cursor-crosshair`. A new test keeps both
rules: every portalled overlay declared by a component that renders a dialog or drawer must outrank the dialog,
and `cursor-none` may only appear in the same expression as the ring it stands in for.

**Why** The ring *is* the cursor: the canvas sets `cursor-none` and paints a circle through a portal at the
pointer's position. At 1100 it sat below the dialog (1300/1301) and was therefore invisible, so the user painted
with no cursor at all — blind drawing, reported as "看不到光标". The number was correct when the dialog was antd's
Modal (z-index 1000) and was never revisited when the app moved to Radix and the overlay stack was renumbered.
Nothing failed loudly: a buried ring throws no error, and the only symptom is the one thing the feature cannot do
without.

**Why the second rule** A ring that fails to render must degrade to something usable. Hiding the real cursor is a
promise that a substitute is on screen; keeping that promise conditional means a future regression costs a
crosshair instead of the feature.

**Tested** `tests/overlay-z-index.test.ts` reads the sources: it takes the highest z-index in
`kit/dialog.tsx` + `kit/drawer.tsx` as the floor and fails for any `fixed z-[n]` portal in a file that renders a
`<Dialog`/`<Drawer`. Reverting the ring to 1100 fails with the file and line named, restoring it passes. The
canvas's own portals (context menu at 80, @-mention list at 120) are out of scope on purpose — the canvas is
behind the dialog, so those can never be opened from inside one. `tsc --noEmit`, 134 canvas tests.

**Where** `canvas/web/src/components/canvas/canvas-node-mask-edit-dialog.tsx`,
`canvas/web/tests/overlay-z-index.test.ts` (new).

## 137. `infinite-canvas/` becomes `canvas/`

**Decision** The frontend subtree is now `canvas/`. The upstream project is still credited in the README's
Credits section and its licence is still kept verbatim at `canvas/LICENSE`; only the directory name changed.

**Why** A directory named after the project it was copied from makes a claim about its contents. This one has
been reworked far past that claim: the dialogs are Radix instead of antd, the request layer calls a Go gateway
that did not exist upstream, the editors (mask, outpaint, layout, angle) and their controls are ours, and the
registry/resource model underneath them was written here. Someone reading the tree would take `infinite-canvas/`
for a vendored copy that can be updated by re-copying, which is exactly the mistake this session kept paying for
in other forms — the file that says one thing while the code does another. The name now says what the directory
is: the canvas.

**Credit stays where credit is read** The README names both upstream repositories, states that the frontend
started as a copy of that UI and that the Go gateway is a port of the Node gateway, and keeps the MIT text at
`canvas/LICENSE` unchanged. Renaming a directory is not a claim of authorship.

**What moved** `WEB_DIR` and the three build comments in the `Makefile`, three paths in `start.sh` (vite binary,
`dist/index.html`, the preview `cd`), four `.gitignore` rules, the README layout tree and Credits paragraph, and
the "Where" lines in `docs/decisions.md` (#1–#136), which are how a reader follows a decision to its code —
leaving them pointing at a path that no longer exists would have made the whole log unfollowable. The URLs in
Credits were checked by hand afterwards, because a mechanical `infinite-canvas/` → `canvas/` is one character
away from rewriting an upstream link.

**Not renamed on purpose** `canvas/plugins/infinite-canvas/` keeps its name: that is the upstream plugin's *id*,
declared inside its own `plugin.json` and in the marketplace entry, and it is data rather than a path we own.
`canvas/web/package.json` still says `"name": "infinite-canvas"` for the same reason — it is the npm project's
identity inside the subtree, not this repository's name for it.

**Tested** `make web` builds into the new path, `make check`/`tsc`/134 tests pass, and a tree-wide grep for
`infinite-canvas/` now returns nothing outside `canvas/plugins/infinite-canvas/` itself.

**Where** `canvas/` (moved, 290 tracked files), `Makefile`, `start.sh`, `.gitignore`, `README.md`,
`docs/{decisions,gateway,known-issues}.md`.

## 138. The project is Comfy Loft

**Decision** The project is called **Comfy Loft**. The gateway code keeps its module name `comfyloft-server`
(that is the binary, not the product), and the repository slug is being renamed by the owner separately.

**Why "Comfy" stays and the second word changed** "Comfy" is the searchable half: this is an abstraction layer
over ComfyUI, and users look for that word. What it may not do is claim to be a ComfyUI *component* — `bench` and
`dock` were the two candidates that failed that test, and both failures were measured rather than guessed:

- `ComfyBench` is already two projects, one of them literally a benchmark paper ("ComfyBench: Benchmarking
  LLM-based Agents…"). In a technical name, `bench` reads as *benchmark* and nothing else, which is a claim this
  project is not making.
- `ComfyDock` is an existing product (`comfygit-ai`) that manages ComfyUI environments — adjacent enough that the
  collision would be a real one, not a coinsidence of string.
- `comfyloft` returned **zero** repositories on GitHub.

A loft is the working space the thing is: one open room where images, video and audio are made — the
"multimedia workbench" idea without a generic word in the name.

**What the name says in the README** `# Comfy Loft`, then one line: images, video and audio made on your own
machine, no cloud API, no vendor account, no per-image bill. The upstream credit is untouched and still names
both repositories and keeps the MIT text at `canvas/LICENSE`; renaming is not a claim of authorship (#137).

**Stale documentation fixed in the same pass** — the three statements this project was carrying that were no
longer true:

- `main.go` described the gateway as "OpenAI-compatible". There is no `/v1` route left; the README has said so
  for a while ("the gateway serves no `/v1/...` at all — that belongs to the model provider AlayaCore talks to"),
  and the package comment disagreed with it.
- `docs/server.md` listed the runtime assets as `workflows/`, `resources/`, `prompts/`. `resources/` became
  `resources.json` at the root in #128–#129.
- The README said "generate images and videos"; the music pack has been shipping audio since #124.

**Left alone, on purpose** `canvas/` still carries upstream's strings: the plugin ids and directory
(`plugins/infinite-canvas/`, `@infinite-canvas/plugin-sdk`), the plugin skills documentation, and the
default *board* title (`无限画布 {{count}}` / "Infinite Canvas {{count}}") and export file name. Those are
upstream contract and document names, not this project's name; the browser tab already says `无界工作台`
(`canvas/web/index.html`), which is the one place the product introduces itself. Changing any of them is a
separate decision with its own consequences, not a rename.

**Tested** `gofmt`, `go vet`, `go test ./internal/...`, `tsc --noEmit`, 134 canvas tests. A grep for
`Infinite Canvas`/`ComfyUI Local` now finds nothing outside `canvas/` (upstream strings) and this log.

**Where** `README.md`, `docs/server.md`, `main.go`.

## 139. The old product names leave the canvas shell too

**Decision** The browser tab says `Comfy Loft` in both languages, the canvas manager is titled `Canvas` /
`画布`, a new canvas is `Canvas {{count}}` / `画布 {{count}}`, the export default is `Canvas` / `画布`, and the
storage page's database labels name Comfy Loft. Three upstream names are gone from user-visible text:
`无界工作台` (the shell's `<title>` and `meta.title`), `Boundless Workbench` (its English counterpart), and
`Infinite Canvas` (the English board title, export name and storage labels).

**Why they were still there** They were never removed. `git log -S "无界工作台" -- canvas/web/index.html` returns
exactly one commit — #137, the directory rename — and that is a path change, not a content change. The string
has been in the tree since the initial import; it surfaced in #138's review, where it was listed as "user-visible,
your call" instead of being changed. That was the wrong call: a name that is on screen is not a decision to defer
when the decision to rename has already been made.

**What the tab actually reads from** Two places, and both had to change: `canvas/web/index.html`'s static
`<title>` (what a cold load shows) and `meta.title` in the i18n dictionaries, which `app-providers.tsx` and
`project.tsx` write into `document.title` at runtime. Changing only the HTML would have been overwritten a frame
later; that is worth remembering the next time a "title" looks like markup.

**Board titles became words, not a brand** "Infinite Canvas 3" was the upstream product name used as a document
name. `Canvas 3` / `画布 3` says the same thing without pretending each board is the product.

**Still upstream, deliberately** `canvas/plugins/**`: the plugin id `infinite-canvas`, the SDK package
`@infinite-canvas/plugin-sdk`, every plugin's `package.json`/`README`/`build.mjs`, the Codex/ZCode plugin manifests
and `canvas/plugins/infinite-canvas/skills/**`. Those are an interface — the host loads plugins by id and the
packages resolve by name — so renaming them means renaming the SDK, every import of it and every marketplace
declaration in one move. That is a project of its own, not a string edit.

**Tested** `npx tsc --noEmit`, `npm run check:i18n` (1018 zh keys, 1004 en, no dead or missing keys), 134 canvas
tests, `go test ./internal/...`, and a rebuilt bundle whose `<title>` is `Comfy Loft`. A grep for the three old
names now returns nothing outside `canvas/plugins/**`.

**Where** `canvas/web/{index.html,src/i18n/locales/{zh-CN,en-US}.ts}`.

## 140. The plugin SDK and its packages stop being named after upstream

**Decision** The web app's package is `comfy-loft`, the plugin SDK is `@comfy-loft/plugin-sdk`, and the plugin
packages, READMEs, `tsconfig` `jsxImportSource`, `build.mjs` entry points and SDK comments follow it: 48 files
across `canvas/plugins/canvas/**`, plus `canvas/web/{package.json,package-lock.json}`. The CHANGELOG and SECURITY
files the upstream project shipped are deleted — they describe a release history that stops before this work and a
security policy whose reporting address is someone else's.

**What was renamed and why it is safe** The SDK name is a *build-time* identity: `build.mjs` bundles the SDK into
each plugin, so the host never resolves the package name at runtime. Nothing in `canvas/web/src` imports it, and
the two prebuilt host plugins in `canvas/web/public/plugins/` contain no reference to it. The registry's build
comment also still pointed at `infinite-canvas/web/public/plugins/`, a path that has not existed since #137.

**Three identities were left alone, and they are the interesting part**

- **Persisted data.** `infinite-canvas:canvas_store`, `:asset_store`, `:ai_config_store`, `:plugin_store`,
  `:theme_store`, `:locale`, and the localforage databases `infinite-canvas` and `infinite-canvas-plugins` are keys
  in the user's browser, not labels. Renaming them silently orphans every canvas, asset, setting and theme on every
  machine that has used this app. Doing it properly means reading the old key, writing the new one, and keeping the
  old one readable for a while — a migration, not a rename.
- **Export files.** `app: "infinite-canvas"` in `canvas-export.ts`, `types/canvas-export.ts`,
  `asset-transfer.ts` and `project.tsx` is the marker that says "this JSON is a canvas export". Change it and every
  file exported so far stops importing. Its own migration, if it is ever worth it.
- **The agent plugin.** `canvas/plugins/infinite-canvas/**` is a third party's work: the manifest names
  `basketikun` as author, links `canvas.best` and its `.mcp.json` spawns `@basketikun/canvas-agent`. Renaming the
  wrapper while it still calls their package would present their tool as ours, which is the opposite of what #137
  was about.

**Tested** `tsc --noEmit`, `npm run check:i18n`, 134 canvas tests, `go test ./internal/...`, `make web` (bundle
title `Comfy Loft`), and JSON validity of every touched lockfile. The `Symbol.for("infinite-canvas.jsx.fragment")`
in `sdk/src/jsx-runtime.ts` stays as well: it is an interop symbol inside prebuilt bundles, and renaming it would
risk plugins built before this commit for no visible gain.

**Where** `canvas/plugins/canvas/**` (48 files), `canvas/web/{package.json,package-lock.json}`,
`canvas/{CHANGELOG.md,SECURITY.md}` (deleted).

## 141. The credits section names the origin and the licence, and stops there

**Decision** `README.md` opens with a short Credits block and nothing more: this is a fork of
`1314521gjy/ComfyUI-Local-Infinite-Canvas`, itself a modified copy of `basketikun/infinite-canvas`; both are MIT,
their copyright notices and licence texts are kept verbatim at `canvas/LICENSE`, and this project is MIT too; then
one sentence saying both halves have been rewritten since, so nothing is compatible upstream. No tables, no counts,
no inventory of what was added or removed.

**Why** That section exists for the licence obligations: say where the code came from, keep their notices, state
ours. Everything else in the earlier draft was a status report — accurate when written, wrong within a month, and
not what a reader wants above the fold. The single compatibility sentence stays because it is also licence-adjacent:
it tells a reader that upstream work may not be merged here.

**The measurement I had to withdraw** An earlier version of this entry carried a table comparing `canvas/web/src`
and `internal/` against this repository's **own first commit** — 22 of 182 files byte-identical in the canvas, 12 of
102 in the gateway, +13,138/−15,007 and +11,077/−5,984 lines. The canvas half measures the right thing: that tree
was imported from the fork. The gateway half does not. By the time of that first commit the gateway was already Go,
so those numbers describe our own service evolving, not the distance to the project we forked — upstream shipped
`comfyloft-server/` in JavaScript. There is no line-for-line comparison to make, and the honest version is the
sentence the README now carries.

**What the licence file needed** Checking the claim "their copyright notices are kept verbatim" showed it was
false: `canvas/LICENSE` carried only `Copyright (c) 2026 basketikun`. The fork the canvas came from has its own
`Copyright (c) 2026 1314521gjy`, so both lines are now in that file, with the MIT body unchanged. A README that
claims a licence file says something it does not is worse than one that says nothing.

**Tested** `git diff` on `canvas/LICENSE` (one line added), README reads in ten lines, and the language rule still
holds — a Chinese check over the file returns the one pre-existing protocol example.

**Where** `README.md`, `canvas/LICENSE`, `docs/decisions.md`.

## 142. The third-party agent plugin goes, and the browser keys stay

**Decision** `canvas/plugins/infinite-canvas/` is deleted. The browser storage keys and the export marker keep the
old name. `docs/known-issues.md` loses two entries: the `ComfyUI-MiniMaxH3-TimelineDirector` note (that node is
somebody else's install, not this project's business) and the history-size note (the purge it described is done).

**Why the plugin goes** It is a manifest for **Codex and ZCode**, not for this application: `.codex-plugin/` and
`.zcode-plugin/` declare a marketplace entry, and `.mcp.json` runs `npx -y @basketikun/canvas-agent@latest mcp` —
someone else's npm package as the MCP server. Nothing in this repository loads it: the canvas reads
`/plugins/index.json`, which is built from `canvas/web/public/plugins/`, and a grep for `canvas-agent`,
`marketplace.json` and `plugins/infinite-canvas` across the tree returns only the plugin itself and this log.

**What replaced it** This project has its own agent, and it does not need a plugin to reach the canvas. AlayaCore is
spawned per request (`internal/agent`), and the gateway is its **MCP server**: `POST /mcp/{workspace}` answers
`tools/list` and `tools/call`, routes each call down the browser socket, and advertises one workspace per session
(#… "the agent's hands"). Keeping the upstream plugin would mean shipping a second, unmaintained vocabulary that
calls a package we do not build — the canvas would have two agents with two ideas about how to touch it.

**Why the browser keys stay, again** `infinite-canvas:canvas_store`, `:asset_store`, `:ai_config_store`,
`:plugin_store`, `:theme_store`, `:locale`, the localforage databases `infinite-canvas` / `infinite-canvas-plugins`,
and `app: "infinite-canvas"` inside export files are **addresses, not labels**: they are where the browser and the
importers find data that already exists. Renaming them without a migration means the app opens empty — every
canvas, asset, setting, theme and language reset — and every previously exported file refuses to import. Nothing
the user sees is affected by leaving them, which is why they were left (#140).

**What a rename would cost, if it is ever wanted** A startup shim: read the old key, write the new one, keep
reading the old one as a fallback for a release. IndexedDB is the hard half — the records have to be copied
database to database, and a half-finished copy is a half-empty app. The export marker needs the importer to accept
both values forever, because exported files outlive the app.

**Tested** `go test ./internal/...`, `tsc --noEmit`, 134 canvas tests, `git status` clean. The plugin's 63 files
leave no dangling reference: `canvas/plugins/` still builds its five official plugins, and the Chinese-prose entry
in `known-issues.md` was re-measured (55 files, 411 lines).

**Where** `canvas/plugins/infinite-canvas/` (deleted), `docs/known-issues.md`, `docs/decisions.md`, `README.md`.

## 143. The browser keys and the export marker are renamed too

**Decision** The persisted identities now carry this project's name: `comfy-loft:canvas_store`,
`:asset_store`, `:ai_config_store`, `:plugin_store`, `:theme_store`, `:locale`; the localforage databases
`comfy-loft` and `comfy-loft-plugins`; the export marker `app: "comfy-loft"` in canvas and asset exports; and the
SDK's JSX fragment sentinel became `Symbol.for("comfy-loft.jsx.fragment")`.

**Why now, after #140 and #142 said no** Those entries were right about the trade-off and wrong about the
constraint: they priced a migration nobody asked for. There is no data to migrate. The owner's words: it is
development stage, nothing here cannot be lost. A ten-second empty app beats a compatibility shim that has to be
kept, explained and eventually retired — and the shim was the only reason the old name was still in the code.

**What the old code would have needed** Nothing exotic, which is exactly why it was tempting: read the old
localStorage key, write the new one, keep the old one readable for a release. The IndexedDB half is the part that
does not fit in a shim — the records have to be copied database by database, and a half-finished copy is a
half-empty app. Both are skipped: the new databases start empty.

**Export files** The importer never validated `app` — `JSON.parse(...) as CanvasExportFile` and a cast — so files
written before this commit still import; they simply carry a marker that no longer describes the writer. That is
the one place the old name survives, in files already on disk, which is where it belongs: they are history, not
code.

**Left alone** `components/canvas/infinite-canvas.tsx` and its `InfiniteCanvas` export keep their names. That is a
description of the widget — a canvas that scrolls forever — not the product's name, and renaming it would churn
every import in the canvas for no gain a reader could see.

**Tested** `tsc --noEmit`, 134 canvas tests, `make web`, and the built bundle contains `comfy-loft:canvas_store`
and no `infinite-canvas:` key. A fresh browser therefore starts with an empty app, which is the intent.

**Where** `canvas/web/src/{stores/{use-asset-store,use-config-store,use-theme-store,use-storage-recovery-store}.ts,
stores/canvas/{use-canvas-store,use-plugin-store}.ts,i18n/index.ts,services/localforage-databases.ts,
types/canvas-export.ts,lib/canvas/canvas-export.ts,components/assets/asset-transfer.ts}`,
`canvas/plugins/canvas/sdk/src/jsx-runtime.ts`.

## 144. The asset library is deleted, not hidden

**Decision** `use-asset-store`, `asset-persist`, `components/assets/`, the Assets tab in the side
panel, the "Add to My Assets" node action and the asset package format are gone, and `/assets` is
nothing but an address that lands back on a canvas. A canvas's nodes are the only place a file lives:
what is on a canvas is what exists.

**Why** The library was the cloud-era organ of a product that no longer exists. Upstream could not
read the user's disk, so it had to keep a pool of its own inside the browser; this fork deleted the
cloud (README, #71, #76) and kept the pool. On a local machine the pool is the filesystem, and it is
better at every part of the job: it can be searched, backed up, synced, opened by other programs and
seen without this app running. The app's copy was worse than that — IndexedDB, no
`navigator.storage.persist()`, cleared by "clear site data" and collected by the canvas GC — so
keeping user originals there was a net risk, not a service.

**Nothing was lost from the loop** Content already enters a canvas without the library: files
dropped on the canvas, pasted from the clipboard, or chosen from the picker all become nodes
(`use-content-ingress.ts`), and that path accepted images, video and audio before this change. The
library's own "Add" button did the same job with an extra step, and its create form only ever
supported text and images.

**What else went with it** Four kit components whose only callers were the asset UI — `Empty`,
`Pagination`, `TagInput`, `CheckableTag` — and the `.prompt-filter-tag` styles. The `assets.*`
translation namespace went whole; the node-type titles it was also carrying (`assets.kinds.*`) moved
to `canvas.nodeTypes.*`, which already existed and already had all four kinds. `common.addToAssets`,
`common.addedToAssets`, the side panel's asset keys and the six `canvas.runtime` strings that only
said "there is nothing here to save" went with their call sites.

**The one thing the library did that a canvas does not** Cross-canvas reuse: copy/paste of nodes is
page state, so it does not survive switching canvases, and the export zip carries whole projects, not
a chosen set. Both are accepted losses — re-dragging from the disk is one gesture, and the filesystem
is a better selection UI than a dialog would be.

**Data already on disk** `comfy-loft:asset_store` and the records in it are left where they are; no
migration reads them. Blobs that only a library record referred to are now unreachable, so the next
sweep (`lib/canvas/canvas-file-cleanup.ts`) collects them. That is the intent of a deletion, and this
project is at the stage where #143 already said an empty app beats a compatibility shim.

**Where the sweep lives now** With the asset store gone, `sweepUnusedCanvasFiles` in
`lib/canvas/canvas-file-cleanup.ts` is the single entry point for blob collection, called by node
deletion (with the undo snapshot as an extra root) and by project deletion.

**Tested** `npm run check:i18n`, `check:exports` and `tsc --noEmit` (the three gates a deletion can
break), 129 canvas tests, `make web`,
and in a browser: no Assets button in the top bar, no second side-panel tab, no "Add to My Assets" in
a node's toolbar, `/assets` lands back on a canvas instead of opening anything (the address is a
tombstone, the same courtesy `/config` gets), and a file dropped on the canvas still becomes a node.

**Where** `canvas/web/src/{stores/use-asset-store.ts,stores/asset-persist.ts,components/assets/**,components/kit/{tag-input,tag,nav,display}.tsx,components/canvas/canvas-side-panel.tsx,components/canvas/canvas-node-hover-toolbar.tsx,components/canvas/canvas-top-bar.tsx,pages/canvas/project.tsx,pages/panel-entries.tsx,router.tsx,types/canvas.ts,i18n/locales/*,styles/globals.css,tests/persist-migration.test.ts}`.

## 145. The deleted library gets one exit, and then it is gone

**Decision** `lib/canvas/legacy-asset-store.ts` reads the `comfy-loft:asset_store` record back,
`components/layout/legacy-assets-banner.tsx` offers it once as a zip, and discarding the offer deletes
the record. While the record exists its `storageKey`s are one more root for the blob sweep, so nothing
it names is collected before the user has been asked. Nothing is imported back into the app.

**Why not just delete it with #144** Because the code was the only thing that knew those files
existed. A record in `comfy-loft:asset_store` can point at a blob that no canvas, no undo snapshot and
no generation log mentions — a picture saved to the library and nowhere else — and the first sweep
after the removal would have collected it. That is a feature removal quietly deleting user data, which
is not the same thing as removing a feature.

**Why a dead end rather than a migration** Converting library records into canvases would resurrect
the very shape #144 removed: a project per saved picture, or one junk canvas per library. The package
is the old format (`assets.json` verbatim + `files/` + a `README.txt` that says what it is), which
means this path writes a format nothing reads. That is the point: the exit has to be worth deleting
once it is unused, and a format nobody parses is easier to delete than an importer.

**The common case is silence** Most machines that ever opened the app have
`{"state":{"assets":[]},"version":1}` sitting there. `readLegacyLibrary` reports that as `empty`, the
banner deletes it without a word. Only a record with something in it, or a blob that will not parse,
is worth asking a person about — an unreadable blob is not empty, because its bytes are still theirs.

**Verified end to end in a browser** A seeded library of one image record and one text record: the
banner says 2, exporting downloads a zip holding the record's bytes verbatim, a 79-byte
`files/1-Legacy-hero.png` and no file for the text record; a sweep with the record still present leaves
the image alive; discarding removes the record and the next sweep collects the image.

**When to delete this** After the release in which nobody can still hold an old library. It is
`lib/canvas/legacy-asset-store.ts`, the banner, its `canvas.legacyAssets.*` strings, the
`legacy` root in `sweepUnusedCanvasFiles`, and `tests/legacy-asset-store.test.ts`.

**Where** `canvas/web/src/{lib/canvas/legacy-asset-store.ts,lib/canvas/canvas-file-cleanup.ts,components/layout/legacy-assets-banner.tsx,layouts/user-layout.tsx,i18n/locales/*}`,`canvas/web/{tests/legacy-asset-store.test.ts,scripts/check-exports.cjs}`.

## 146. The project's machine identity is `comfyloft`

**Decision** Every identifier a machine reads is one word: the Go module is `comfyloft`, the web package
is `comfyloft`, the plugin SDK is `@comfyloft/plugin-sdk`, the browser keys are `comfyloft:*`, the
databases are `comfyloft` and `comfyloft-plugins`, the export marker is `app: "comfyloft"` and the JSX
sentinel is `Symbol.for("comfyloft.jsx.fragment")`. What humans read is unchanged: **Comfy Loft**.

**Why one word, after #138 chose the hyphen** A hyphen is harmless in a filename and harmful everywhere
a machine wants the name as a token. Environment variables cannot contain one, so the hyphenated form
forces `COMFY_LOFT_CANVAS` — three words, one of them wrong — where `COMFYLOFT_CANVAS` is just the name.
The same shape repeats for binary names, domains and anything typed from memory or spoken aloud. #138
had already measured the one-word handle when it picked the name: `comfyloft` returned zero repositories
on GitHub. It kept the hyphen only because the product name was written that way, which is a display
question, not an identifier one.

**Why now and not later** Cost of the change is entirely in the contracts (`@comfy-loft/plugin-sdk`, the
browser keys, the export marker) and it is at its lowest point today: seven official plugins in this
repository, no third-party plugin, and #143's standing judgement that this stage has no data worth a
compatibility shim. After a third-party plugin imports the old scope, the same change becomes a breaking
release.

**What stayed, on purpose**

- **The display name `Comfy Loft`** — README heading, window title, plugin descriptions. Two words read
  better than one, and this is the only place the product speaks as a name.
- **The gateway binary `comfyloft-server`** and the config directory `~/.config/comfyloft-server/alayacore`
  (#138: "that is the binary, not the product"). The binary is named for what it faces; the config
  directory holds the operator's hand-written `model.conf` with a real API key in it, and moving it would
  make an agent silently lose its models.
- **`comfy-loft:asset_store`** — the one-time exit for the deleted asset library (#144, #145) reads that
  exact key because that is what the old build wrote. Renaming it would have broken the only path that
  rescues that data.

**What it costs** The old `comfy-loft:*` localStorage entries and the `comfy-loft` / `comfy-loft-plugins`
databases are orphaned, not deleted — the next load starts empty, which is #143's accepted trade. Nothing
in the app reads them again. Zips exported by an older build still import: the importer never validated
`app`, which #143 recorded as the one place the old name survives. If that orphaned data ever has to be
rescued, the pattern already exists in `legacy-asset-store.ts`.

**Tested** `make check`, `npm run check` (i18n, exports, prettier, `tsc`), 143 canvas tests, `make build`,
`make web`, and one official plugin (`sticky-note`) installed against `@comfyloft/plugin-sdk` and built
with esbuild. In a browser: the app boots to an empty canvas, writes `comfyloft:canvas_store` and
`comfyloft:plugin_store` into a database named `comfyloft`, stores `comfyloft:theme_store` and
`comfyloft:ai_config_store` in localStorage, leaves the old `comfy-loft` databases and keys untouched, and
logs no console errors.

**Where** `go.mod`, 61 Go files' import paths, `canvas/plugins/canvas/{sdk,html,markdown,panorama,registry,sticky-note,svg,template}/**`,
`canvas/web/{package.json,package-lock.json,src/{i18n/index.ts,lib/canvas/canvas-export.ts,services/localforage-databases.ts,stores/**,types/canvas-export.ts}}`,
`docs/server.md`.

## 147. The MCP edge is a bridge process, not a URL

**Decision** AlayaCore reaches the canvas tools through `bin/comfyloft-mcp`, a second small binary that
speaks JSON-RPC on stdin/stdout and forwards each call to the gateway on a **loopback-only** listener.
The session is not in any address: the gateway spawns AlayaCore with `COMFYLOFT_MCP` and
`COMFYLOFT_SESSION` in its environment, AlayaCore hands that environment to the bridge it starts, and the
bridge puts the session in `X-Comfyloft-Session`. `mcp.conf` is one static file for every session, and the
agent's configuration lives in one directory per host, `~/.config/comfyloft-server/<host>/alayacore/`.

**Why the names are one word** `COMFYLOFT_*` and `X-Comfyloft-*`, not `COMFY_LOFT_*`: an environment
variable cannot contain a hyphen, so the hyphenated spelling would force three words with one of them
wrong — which is #146's whole argument, and these are the first identifiers written since it was made.

**Why the URL had to carry identity, and why it no longer does** MCP carries no identity of its own and
the bridge is configured with one URL per server, so with an HTTP-only endpoint the URL was the only place
left: `/mcp/<sanitised-session>-<sha1[:4]>`. That derivation was a chain of its own — sanitising is lossy,
so two sessions could collide, so a hash was appended, so the URL carried the session id while being
unreadable and unguessable-but-not-secret. AlayaCore supports stdio servers, which deletes the chain at the
root: the identity is a file descriptor's parent's environment, not a string in a path.

**What the loopback listener is for** The old route sat on the main mux, which is served on whatever
`COMFYLOFT_SERVER_HOST` names — and a tool that creates nodes and starts generations was reachable from the network
with no token. The bridge endpoint is now a second listener bound to `127.0.0.1` on an ephemeral port, known
only to the processes it was written into. Requiring a custom header also means a browser cannot reach it
cross-site without a CORS preflight this server never answers.

**Two binaries, and the rule that went with them** `make build` produces `comfyloft-server` and
`comfyloft-mcp`. The old "one self-contained binary" rule is retired: it was never true of the *release*
(the canvas bundle, `workflows/`, `resources.json` and the external AlayaCore were always beside it), and
with two binaries a mixed install is possible — so the bridge sends `X-Comfyloft-Bridge` and the gateway
refuses a version it does not speak, naming which half to rebuild. What must stay true is what the rule was
actually protecting: both are static, cgo-free, and need no runtime.

**One config directory, per host** `mcp.conf` names the address the agent dials, so a machine reachable at
two addresses needs two answers, and `<host>` is that address (a wildcard bind means loopback, as it always
did for the URL). Inside it, nothing is per session: `model.conf` is the operator's, `mcp.conf` is written by
the gateway on every start — the `command` is an absolute path that moves with the release directory, and a
stale one fails as `handshake: EOF`, which names the symptom and not the cause. Per-session config copies are
gone; the `runtime.conf` that AlayaCore writes is now shared, and concurrent writes are AlayaCore's own
problem to solve.

**What did not move** The conversation. It is the user's words and it belongs beside the canvas it belongs
to, which is where #144's directory layout will put it; until then it stays in `data/agent/sessions/`.
`clearLegacyAgentState` still sweeps the old per-session directories under `data/agent/`, and keeps
`sessions`.

**Costs, named** The shim is a second artifact to build, ship and verify-static. The wire contract between
the two binaries has to stay dumb (one `POST /mcp`, two headers, JSON-RPC verbatim) so a new bridge against
a not-yet-restarted gateway is survivable. And MCP servers are started *lazily*, on the first turn: a bridge
that cannot start fails that turn rather than the boot, so its diagnostics go to stderr and its errors have to
name the side — unknown session, unknown tool, unreachable gateway, version mismatch are four different
stories.

**Tested** `make check`, `make build`, `make verify-static` (both binaries static), `go test ./...` including
new tests that the bridge relays whole lines and answers its own failures (`internal/mcpstdio`), that one
static `mcp.conf` serves two sessions with the session arriving in the environment, that the endpoint is
loopback-only, and that a bridge from another build is refused with both versions named. End to end in a
browser, with the real AlayaCore and a real model: `MCP servers initialized: 1 servers, 7 tools loaded`,
then a tool call answered — the model's reply described the empty canvas it had just been told about.

**Where** `cmd/{comfyloft-server,comfyloft-mcp}/main.go`, `internal/mcpstdio/**`,
`internal/server/{mcp_server.go,routes_mcp.go,agent_config.go,server.go,routes_agent.go}`,
`internal/agent/{spawn.go,sessions.go}`, `internal/config/config.go`, `Makefile`, `start.sh`,
`README.md`, `docs/server.md`.

## 148. There is no plugin mechanism; a node type is a built-in

**Decision** The plugin system is gone — loader, runtime, store, manager dialog, the SDK and its eight
packages, the `public/plugins` directory, the per-plugin IndexedDB database, the event bus the runtime
handed out, and the "节点插件" button. The one node that was actually reachable, the LoRA card, is now a
built-in node (`CanvasNodeType.Lora`) rendered by `components/canvas/nodes/lora-node.tsx`. The
`CanvasPluginDefinition` shape survives as `types/canvas-node.ts`, because it was always the description
of a node and the registry is what built-ins use.

**Why** The mechanism bought two things: a third-party author could add a node without this repository,
and a node could be replaced without rebuilding the app. Neither was ever used. The evidence is the whole
history: no canvas this machine ever saved contained a node type outside the built-in enum; the tracked
plugin manifest never listed anything but the two hand-written `.js` cards; and the eight SDK packages
had only ever been touched by rename commits. What it cost was real — a `fetch` + `eval` loader, a
persisted store, a manager dialog with install/uninstall/update, a version contract, a manifest written by
a build script into a tracked file, an IndexedDB database per plugin, a curated `runtime` object standing
in for the imports a plugin could have had, and no type checking or `check-i18n` coverage inside anything
that was evaluated.

**What "add a feature" means now** A new kind of card is a built-in node, and the cost is the honest one:
one file with its components, one entry in `BUILTIN_DEFINITIONS`, one `CanvasNodeType` member with its
`NODE_SPECS` row, its strings in both dictionaries, and a branch in `renderNodePanel` if it has a panel.
Adding one is a rebuild — for a project that runs from source, that is `make build`.

**The two cards, resolved separately** The LoRA card was converted because it was the only UI that could
choose a LoRA at all: the native side consumes a `lora` resource (`canvas-node-generation.ts` →
`params.loras` → `internal/generate/lora.go`), and nothing else produced one. The ComfyUI-parameters card
was deleted outright: its own source had retired it from the create menu ("与自由卡片重复…保留运行时以兼容
已有节点"), and there were no such nodes to be compatible with.

**What a canvas written by an older build looks like** A node type this build does not have renders as
"Unknown node" (`MissingNodeContent`) instead of a plugin-missing message. That is the honest fallback now:
there is nothing to install that would bring the type back.

**Left on disk, unread** `comfyloft-plugins` (the old IndexedDB database) and any `comfy-loft:plugin_store`
key are not deleted and not read; the storage panel stops reporting the plugin database, because nothing
writes to it (#147 chose the same for the pre-rename keys).

**Tested** `npm run check` (i18n, exports, prettier, `tsc`), 143 canvas tests, `make check`, `make build`,
`make web`, and in a browser: the 节点插件 button is gone, the dock's LoRA button creates the node, its
panel lists the LoRAs the gateway reports (`GET /api/loras`, with the model-pack-internal file filtered
out), picking one updates the card and the node's `params.loras`, and the console stays clean.

**Where** deleted: `canvas/plugins/**`, `canvas/web/public/plugins/**`,
`canvas/web/src/{lib/canvas/{plugin-loader.ts,plugin-runtime.ts,plugin-node-context.ts,canvas-event-bus.ts},stores/canvas/use-plugin-store.ts,components/canvas/canvas-plugin-manager-modal.tsx,pages/canvas/hooks/use-plugin-host.tsx,types/canvas-plugin.ts}`.
Added: `canvas/web/src/{components/canvas/nodes/lora-node.tsx,types/canvas-node.ts,services/api/loras.ts}`.
Touched: `node-registry.ts`, `builtin-nodes.tsx`, `canvas-node.tsx`, `project.tsx`, `canvas-toolbar.tsx`,
`canvas-create-menus.tsx`, `canvas-top-bar.tsx`, `user-status-actions.tsx`,
`services/{localforage-databases,local-storage-usage}.ts`, `vite.config.ts`, `vite-env.d.ts`,
`constant/canvas.ts`, `types/canvas.ts`, `services/api/video.ts`, `i18n/locales/*`,
`internal/server/routes_mcp.go`, `scripts/check-exports.cjs`, `docs/known-issues.md`, `README.md`,
`.gitignore`.

## 149. The canvas frontend is `canvas/`, not `canvas/web/`

**Decision** Every file under `canvas/web/` moved up one level and `canvas/web/` is gone. `canvas/` is the
frontend: `src/`, `public/`, `scripts/`, `tests/`, its `package.json` and its build output in
`canvas/dist/`. `canvas/LICENSE` — the upstream MIT text the credits point at — stays where it was, beside
the app it covers.

**Why** `web/` was upstream's layout, and it made sense there: the subtree held `web/` (the app) next to
`plugins/` (the SDK and the official plugins). The plugin mechanism is gone (#148), so `canvas/` had exactly
one child left, and a directory that contains a single directory is a level of indirection that no reader
needs. Nothing about the boundary changed — `canvas/` is still the self-contained npm project, still
separate from the Go module at the root — only the path got shorter.

**What moved with it** `make web` now builds into `canvas/dist/`, `start.sh` finds `vite` and the bundle one
directory higher, `vite.config.ts` reaches the repository root with `..` instead of `../..`, and the
one test that reads `resources.json` through `import.meta.url` counted one `..` too many until the move.

**Not changed on purpose** `canvas/vercel.json` and `canvas/components.json` are upstream leftovers that
still describe a deployment nobody runs and a stylesheet path that does not exist. They are as dead after
this move as before it; removing them is a separate decision about the credits, not about the layout.

**Tested** `make web-deps` (a fresh `npm ci` in the new location), `npm run check`, 143 canvas tests,
`make web`, `make check`, and `./start.sh` serving the bundle: the canvas loads from
`http://127.0.0.1:3000/`, `config.js` is injected at the new path, the public assets resolve, and the
console is clean.

**Where** `canvas/**` (moved), `Makefile`, `start.sh`, `.gitignore`, `canvas/vite.config.ts`,
`canvas/tests/resource-copy-zh.test.ts`, `README.md`, `docs/server.md`.

## 150. The two upstream leftovers go too

**Decision** `canvas/vercel.json` and `canvas/components.json` are deleted. #149 left them alone because
removing them is a decision about the credits rather than the layout; this is that decision.

**Why they were dead** `vercel.json` described deploying the bundle to Vercel with `bun install` — this is a
local workbench whose canvas is served by `start.sh` and whose gateway is a static binary. `components.json`
was a shadcn CLI config pointing at `src/app/globals.css`, a path that has not existed since the kit
components replaced antd; the real stylesheet is `src/styles/globals.css`, which the app imports directly.

**What stays** The `shadcn` package itself, and it is not a leftover: `src/styles/globals.css` imports
`shadcn/tailwind.css`. Deleting the config does not make the dependency unused — the check that found the
two files dead also found this one alive, which is the reason it was checked at all.

**Tested** `npm run check` (i18n, exports, prettier, `tsc`), 143 canvas tests, `make web`.

**Where** `canvas/vercel.json`, `canvas/components.json` (deleted).

## 151. There are no users yet, so the compatibility layers go

**Decision** The one-time exits and the old-data adopters are deleted, not kept one release longer.
This is #145's "when to delete this" arriving early, plus the two places in the gateway that did the
same job for files instead of browser storage.

**Why** A compatibility layer costs nothing to *keep* and everything to *maintain*: it is a second
input format, a second failure mode and a second set of tests, all of them describing data that only
exists because someone was already using the app. Nobody is. There is no installed base, no stored
library, no `model.conf` from an earlier layout. What would have been "one release, then delete" is
just delete.

**Deleted** `canvas/src/lib/canvas/legacy-asset-store.ts`, `components/layout/legacy-assets-banner.tsx`,
`tests/legacy-asset-store.test.ts`, the `canvas.legacyAssets.*` strings in both dictionaries, the
`legacy` root in `sweepUnusedCanvasFiles`, the two `TEST_ONLY` waivers those modules needed —
exactly the list #145 wrote for itself. In the gateway: `adoptLegacyAgentConfig` (the copy of a
`model.conf` written before the per-host split), `clearLegacyAgentState` (the sweep of older
per-session directories under `data/agent/`), `config.LegacyAgentConfigDir`, and the two calls in
`server.New`. Startup now does one thing to the agent's config: it writes the static `mcp.conf` (#147).

**Deliberately not deleted** `internal/task`'s `File`/`URL`/`MimeType`/`Bytes` mirror of the first
output and `internal/store`'s version-1 pack map are not old data on disk — they are part of the shape
the canvas reads *today*. Removing either means changing routes and frontend together, which belongs
to #152 and later, not to a sweep. `canvas-persist.ts`'s format migrations stay for the same reason
they are useless: the file itself is replaced wholesale when the canvas becomes a directory.

**Tested** `make check`, `go build ./...`, `npm run check` (i18n, exports, prettier, `tsc`), and the
canvas suite — 129 tests, down from 143, every one of the 14 removed being a test of the code removed
above.

**Where** `canvas/src/{lib/canvas/{legacy-asset-store.ts,canvas-file-cleanup.ts},components/layout/legacy-assets-banner.tsx,layouts/user-layout.tsx,i18n/locales/*}`,
`canvas/{tests/legacy-asset-store.test.ts,scripts/check-exports.cjs}`,
`internal/{server/{agent_config.go,server.go},config/config.go}`.

## 152. A canvas is a directory, and the gateway owns it

**Decision** The workspace gets a root of its own — `CANVAS_ROOT`, default `<root>/canvases` — and one
directory per canvas:

```
<CANVAS_ROOT>/<id>/canvas.meta.json   id, title, createdAt, updatedAt, rev
<CANVAS_ROOT>/<id>/canvas.json        the document
<CANVAS_ROOT>/<id>/files/             the media
```

Five endpoints serve it: `GET/POST /api/canvases`, `GET/PUT/DELETE /api/canvases/{id}`. The id is
sixteen hex characters generated by the store, and it is the directory name.

**Why a directory and not a row** Because the thing has two kinds of content with different lifetimes:
a small document written on every keystroke, and large media written once. A file per document gets
the atomic rename for free; a table would need transactions to do the same. It also makes "back up
your work" a sentence with no exceptions — copy the directory, or zip it, and the canvas is whole.

**Why its own root, not under `data/`** `data/` is the gateway's bookkeeping: tasks, uploads, locks,
preference files. It is disposable and rewritten on start. The canvases are the user's work, and a
variable that moves the bookkeeping must not move the work with it. Hence `CANVAS_ROOT` beside
`DATA_DIR` in the config rather than `DATA_DIR/canvases`; a test pins that moving one does not move
the other.

**The gateway does not read `canvas.json`** It checks two things — that the bytes are a JSON object,
and that they are under 16 MiB, the size at which the author has inlined media that belongs in
`files/`. Everything else is stored verbatim. A gateway that understood nodes would need a release
every time a node type was added, which is the coupling #148 spent an entry removing.

**Writes are renamed into place and versioned** Every write goes through a temporary file in the
destination directory and is renamed over the target, so a reader never sees half a document and a
failed write leaves no debris (tested). Every write also bumps `rev`, and `PUT` takes `If-Match`; a
stale one is refused with `409` and the current summary in `details.current`. This is what lets the
browser stop being the truth: it becomes a cache with a save queue, and a save that races another one
loses visibly instead of overwriting silently.

**Deliberately absent** No trash directory: a delete is a delete, and undo belongs to the editor that
still has the nodes in memory (#151 reasoned the same way about the exits). No file listing yet — the
`files/` directory exists and is created with the canvas, but runs and uploads still write into
`data/outputs`; pointing them here is #153, and it is where `/api/canvases/{id}/files/{name}` arrives.
No agent session inside the canvas directory yet, same reason.

**Tested** `internal/canvas` (15 tests: the layout a create writes, ordering, rev conflict including
"the refused write did not land", ids that are not ours refused before a path is built, non-object and
oversized documents, delete twice, no temporary files left behind, a meta that belongs to another
directory, an unreadable meta skipped by `List` but reported by `Read`), six route tests over HTTP, the
whole `make check`, and `docs/server.md` now documents the layout, the five endpoints and the rev.

**Where** `internal/canvas/{canvas.go,canvas_test.go}` (new), `internal/server/{routes_canvas.go,canvas_e2e_test.go}`
(new), `internal/server/{server.go,routes_admin.go,e2e_test.go}`, `internal/config/{config.go,config_test.go}`,
`docs/server.md`, `README.md`, `.env.example`, `.gitignore`.

## 153. There is no API key, because there is nothing to authenticate to

**Decision** `apiKey` is gone: the field on `AiConfig` and on `ModelChannel`, the two `"local"` defaults,
the four call sites that hard-wrote it, the three gates that refused a run without it, and the
`Authorization: Bearer …` header that four requests sent. The gateway's CORS no longer lists
`Authorization` as an allowed header, because nothing sends one.

**Where it came from** #71 deleted the cloud-provider concept — one channel, and it is the gateway the
page came from — and removed the address field from the channel editor. The key survived that entry for
one reason: the request layer still built an `Authorization` header, so the config had to hold
*something* to put in it. That something was the literal string `"local"`, in every default, in the
channel editor's save path, and in the model-sync hook.

**Why it was never a secret, and never checked** `git grep Authorization internal/` answers with one
line: the CORS allow-list. No handler reads the header, no middleware validates it, and the gateway
serves a `Bearer local` exactly like no header at all. Meanwhile three code paths asked the user to
configure a key that had no input field: `app-config-modal.tsx`'s "is this channel ready",
`assertAudioConfig` and `assertVideoConfig`. The first was reachable only on a config whose
`apiKey.trim()` was empty — which the defaults made impossible, so the check was dead weight that
still carried two translation strings.

**What is left of #71's repair path** `use-config-store`'s `merge` used to snapshot the whole persisted
blob to `localStorage` under `…:pre-local-only-backup` and then keep only the channel that pointed at
this gateway. That existed for saved configs written by the provider-era build, which cannot exist
(#151). It is deleted; `merge` now merges over the defaults and normalizes the channels, nothing else.

**Why this mattered for the next step** The plan for #152's frontend half was to move preferences to
disk. Carrying `apiKey` through that move would have put a fake secret in `settings.json` and added a
"never echo it back" rule to an endpoint that holds nothing worth hiding. Deleting it first makes the
settings endpoint a plain settings endpoint.

**Tested** `npm run check` (i18n 918/904 keys, 171 modules, prettier, `tsc`), 129 canvas tests, `make check`,
`make web`. `model-selection.test.ts` lost the case that rotated a key — its real subject was that a
saved task keeps the model it was made with, and that still has a test.

**In the browser** The canvas loads, and the settings dialog's 网关 tab reports
`本地 ComfyUI · 本地网关 · 11 个模型 · http://127.0.0.1:8190`: the model list arrives from a
header-less `GET /api/workflows`, which is the path this entry changed most. An image node is created and
the console stays empty. No generation was re-run for this entry: the removed header was ignored by the
gateway, and the run and upload request shapes are covered by `tests/api-runs.test.ts`.

**Where** `canvas/src/stores/use-config-store.ts`, `services/api/{runs,workflows,image,audio,video}.ts`,
`hooks/use-local-gateway-sync.ts`, `components/settings/{app-config-modal,channel-editor-drawer}.tsx`,
`components/layout/client-root-init.tsx`, `i18n/locales/*`, `tests/model-selection.test.ts`,
`internal/httpx/middleware.go`.

## 154. The canvas store is a cache, and one queue writes it

**Decision** `use-canvas-store` no longer stores a document anywhere. It holds two things: `canvases`
— the list the gateway reports, metadata only — and `projects`, the documents this session has opened.
Every write goes through `lib/canvas/save-queue.ts`:

- **coalesced** — a 400 ms debounce, so dragging a node is one save rather than sixty, and the save
  carries the state at flush time rather than the state that queued it;
- **serialized per canvas** — a save that starts while another is in flight marks the canvas dirty and
  runs when the first finishes, because two saves racing would hand the gateway a stale `If-Match`;
- **versioned** — `If-Match: <rev>`, so a save made against a version that has moved on is refused
  instead of overwriting whatever arrived in between;
- **honest about failure** — a network error is retried on a backoff and keeps the canvas dirty; a 409
  adopts the new rev, retries, and tells the user their edits replaced someone else's; a 404 stops,
  drops the canvas from the list and says so, because retrying a deleted canvas is an infinite loop
  (found in the browser, not in a test: an old tab sat there answering 404 every few seconds).

**Deleted with it** `stores/canvas/canvas-persist.ts` (the format versions and every `backfill*`
migration between 0 and 3), `lib/persist-recovery.ts`, `components/layout/storage-recovery-banner.tsx`,
`stores/use-storage-recovery-store.ts`, `lib/localforage-storage.ts`, `canvas-file-cleanup.ts`,
`cleanupUnusedImages` / `cleanupUnusedMedia`, the two `*_generation_logs` object stores nothing had
written to for several releases, and `defaultTitleKeyFor` with the list of default title keys:
recognising a stored title as a translated default was migration work, and the migration is gone.

**Why the media sweep could not stay** It walked every project to decide which `storageKey`s were
alive, and the store no longer holds every project — only the ones you opened. A sweep that sees one
canvas would delete the media of the rest, which is the one failure this design cannot tolerate. It
comes back when the gateway owns `files/` (#155): a string scan of `canvas.json` for `files/<name>`
finds the references without understanding a single node.

**What the UI lost, and why that is correct** The canvas card and the switcher showed a node count.
A count lives inside the document, and the list deliberately carries no document — so the count is
gone rather than fetched per card. `deletedProjects` (id + deletedAt tombstones) is gone too: a delete
is a delete (#152). `hydrated` became `ready`, which is what it now means: the first list has arrived.

**One browser preference left, for one entry** "Which canvas was I in" is device state, not workspace
state, and `lib/canvas/last-canvas.ts` keeps it in `localStorage` under `comfyloft:last_canvas`. It
moves to `/api/settings` in #155 with the theme, the language and the panel widths.

**A CORS bug this found** `If-Match` was not in the gateway's `Access-Control-Allow-Headers`, so every
save failed its preflight and surfaced as `TypeError: Failed to fetch` — the sweep in #153 had removed
`Authorization` from that list and nothing had taken its place. The header is allowed now, for the
reason the comment beside it gives.

**Tested** `npm run check` (i18n 917/903, 168 modules, prettier, `tsc`), 127 canvas tests including
13 for the queue (coalescing, flush-time snapshot, no overlapping saves, conflict retry and give-up,
transient-failure backoff, a new edit overtaking a retry, `flushAll`, `forget`, and a deleted canvas
reported once and never retried), `make check`, `make verify-static`, `make web`.

**In the browser, against a real gateway and the real ComfyUI** `/` created a canvas and a directory
appeared under `CANVAS_ROOT`; adding a text node produced `PUT 200` and the node was in `canvas.json`;
a reload brought the node back from disk; the canvas list showed what the gateway has; renaming in the
list wrote the title into `canvas.meta.json` and advanced the `rev`; deleting removed the directory and
shrank the list; the console stayed empty. The stale-id path was exercised by accident and behaved:
a tab left on a canvas that no longer existed got `404`, went to `/`, and created a new one.

**Where** `canvas/src/{services/api/canvases.ts,lib/canvas/{save-queue.ts,last-canvas.ts},stores/canvas/use-canvas-store.ts}`
(new/rewritten), `pages/canvas/{entry.tsx,project.tsx}`, `components/{canvas/{canvas-manager-dialog,canvas-project-card,canvas-top-bar,canvas-delete-projects-dialog}.tsx,layout/{user-layout,client-root-init}.tsx}`,
`services/{file-storage,image-storage}.ts`, `lib/canvas/node-title.ts`, `i18n/locales/*`,
`tests/{canvas-save-queue,node-title}.test.ts`, `scripts/check-exports.cjs`, `internal/httpx/middleware.go`.

## 155. Preferences live with the workspace, and the browser stores nothing

**Decision** The last thing the canvas kept in the browser — its preferences — moves to
`data/settings.json`, served as one document:

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `GET` | `/api/settings` | The whole document. `{}` until something is saved. |
| `PUT` | `/api/settings` | Replace it. `{settings: {...}}`. |

The gateway checks two things — that the bytes are a JSON object under 1 MiB — and never reads a key.
The shape belongs to the canvas, the same division #152 drew for a canvas document. There are no
per-key endpoints: a partial update would need a merge, and a merge is where preferences quietly lose
keys.

Every `localStorage` key and the last IndexedDB database are gone:

| Was | Now |
| --- | --- |
| `comfyloft:theme_store` (zustand `persist`) | `settings.theme`, published by one subscription |
| `comfyloft:ai_config_store` (+ its `…:pre-local-only-backup` blob) | `settings.config` |
| `comfyloft:locale` | `settings.locale` |
| `canvas-side-panel-{width,open,node-view}` | the same names inside `settings` |
| `comfyloft:last_canvas` | `settings.lastCanvas` |
| `resource-setup-skipped`, the image quick-tools key | the same names inside `settings` |

**Why** #154 made the canvas a directory and left the preferences behind, which produced the oddest
state this app had: the same workspace, on the phone in the next room, opened English and light with the
right canvases in it. Preferences are the workspace's, not the browser's.

**Why a first-paint file, and why the gateway writes it** A document that only arrives over HTTP cannot
be applied before the first frame, so every dark workspace opened white for a moment and every English
one opened in Chinese. The bundle is static, so the one thing a page can read synchronously is a script
tag: `start.sh` used to write `dist/config.js` with the gateway address, and the gateway now writes it —
on every start and after every settings save — with the address *and* the settings document. That also
fixed something nobody had noticed: `canvas/index.html` had an inline script reading
`localStorage["infinite-canvas:theme_store"]`, a key nothing has written since #143 renamed them, so the
first paint had been guessing for several releases. The script is deleted; `AppProviders` applies the
theme in a `useLayoutEffect`, before the paint rather than after it.

**Superseded in part by #220** The script is no longer a file the gateway writes into the bundle: it is a
route (`GET /config.js`) computed from `data/settings.json`, and `RUNTIME_CONFIG_PATH` only writes a copy for
a canvas a static host publishes.

**Why there is no request at startup** The document is already in `config.js`, so `load()` is the
fallback for an operator who serves no first-paint file, and the store **refuses to save until it has a
document from one of the two**. Without that guard, a gateway run without `RUNTIME_CONFIG_PATH` would
replace the workspace's preferences with this build's defaults on the first keystroke.

**Cost, named** Two people sharing one gateway share the theme, the language and "the canvas I was in".
For a local workbench whose whole premise is one workspace, that is the intended reading; a per-device
scent would need a second storage mechanism, and this entry's point is that there is only one.

**Deleted** `services/local-storage-usage.ts`, `components/settings/config-local-storage.tsx`, the
settings dialog's `本地存储` tab and its `ConfigTabKey`, the kit's `Alert` (that panel was its only
caller), and `RETIRED_CONFIG_KEYS` with `withoutRetiredKeys` — a filter that existed to drop keys out of
persisted blobs that no longer exist (#151).

**Tested** `internal/settings` (8 tests: empty-until-saved, byte round-trip, replace-not-merge, only an
object, the size cap, an unreadable file reported rather than treated as empty, no temporary files, the
directory created), four route tests including the first-paint file's content and its rewrite on save,
`npm run check` (895/881 keys, 168 modules, prettier, `tsc`), 127 canvas tests, `make check`,
`make verify-static`, `make web`.

**In the browser, with `localStorage` cleared** The theme and the language came back light and English on
reload from `config.js` alone, with `Object.keys(localStorage)` empty before and after; switching the
theme and the language wrote `settings.json` (`theme`, `locale`, `lastCanvas`, `config`) and rewrote
`config.js`; the console stayed empty.

**Where** `internal/settings/{settings.go,settings_test.go}` (new),
`internal/server/{routes_settings.go,runtime_config.go,settings_e2e_test.go}` (new),
`internal/{server/{server.go,routes_admin.go,e2e_test.go},config/config.go}`,
`canvas/src/{services/api/settings.ts,stores/use-settings-store.ts}` (new),
`canvas/src/{stores/{use-config-store.ts,use-theme-store.ts,canvas/use-canvas-side-panel-store.ts},lib/canvas/last-canvas.ts,i18n/index.ts,constant/runtime-config.ts,components/{layout/{app-providers,client-root-init,user-status-actions}.tsx,settings/{app-config-modal,resource-setup-gate}.tsx,canvas/canvas-node-hover-toolbar.tsx,kit/feedback.tsx}}`,
`canvas/index.html`, `canvas/src/i18n/locales/*`, `start.sh`, `docs/server.md`.

## 156. Media belongs to the canvas, and the gateway stops keeping scratch space

**Decision** A run and an upload are canvas-scoped, and their bytes live in the canvas directory:

```
POST /api/canvases/{id}/runs          submit into that canvas
POST /api/canvases/{id}/uploads       one media file into that canvas
GET  /api/canvases/{id}/files/{name}  any file of that canvas, upload or artifact
```

`data/outputs`, `data/uploads` and `uploads.json` are gone. `config.OutputDir` is gone. A node names its
media as `files/<name>` — the same string in the document, in the export zip and in the URL — and the
browser resolves it against the canvas it is showing.

**Why** #152 made the canvas a directory and #155 gave it its preferences; the media was the last thing
still living somewhere else, and it lived in *two* other places at once: artifacts in the gateway's
scratch directory, uploads in `data/uploads` plus an index, and the browser's own copy of whatever a
node displayed. Three copies of one picture, with the canvas naming none of them. Now the canvas names
all of them, and `cp -r canvases/` is a complete backup — which it was not before, since the images a
canvas showed lived in `data/outputs` and in one browser profile.

**The collector returns, and this is why it can** #154 had to delete the media sweep: it walked every
canvas in the store, and the store only holds the ones you opened, so running it would have deleted the
media of the rest. The files now sit next to the document, so the sweep asks each canvas directly: the
document is scanned for `files/<name>` strings (a reference is a string; understanding nodes was never
required), the canvas's run history adds its artifacts and upload inputs, and anything else older than
**24 hours** is deleted. The grace window covers the gap between a run writing a file and the client
putting it in a node; a task record expiring does not delete anything, because the canvas, not the run,
owns the file.

**ComfyUI's input directory stops growing** The gateway used to push every upload under a name with a
fresh random suffix, so each process restart that touched a reference image left another copy in
ComfyUI's `input/`, and nothing on either side ever collected them. The push name is now derived from
the canvas and the upload (`upload.ComfyNameFor`), and the request already carried `overwrite=true`, so
a re-push replaces one file instead of adding one. The in-memory push cache is an optimization again
rather than the only thing preventing duplicates.

**What the frontend lost** `localforage` (uninstalled), `services/localforage-databases.ts`, the
IndexedDB media and preview stores, the client-side thumbnail generator (`createImageThumbnail`), and
the blob-URL bookkeeping in `file-storage.ts` / `image-storage.ts`. Those two modules keep their names
and their exported functions — `resolveImageUrl` still answers "what goes in an `img src`" — but the
answer is now a URL on the gateway. A node's `metadata.content` holds the reference, not the URL, and
the store strips resolved URLs on the way to disk so a document can never carry this host's address.

**Tested** `internal/canvas` (reference scan, sweep with grace and references, path validation),
`internal/upload` (save/get/kind/oversize/unknown canvas/derived ComfyUI name), the task store (outputs
into a canvas, pruning that no longer deletes media), the e2e suites (uploads and runs through
`/api/canvases/{id}/…`, artifacts fetched back over HTTP, cross-canvas reads refused, unknown canvas
refused), `npm run check`, 127 canvas tests, `make check`, `make verify-static`, `make web`.

**In the browser and against the real gateway** An upload landed in `<canvas>/files/up-*.png` and came
back byte-identical with `Cache-Control: private, max-age=31536000, immutable`; a real generation through
ComfyUI (`image-moss-sft-int8-8step`) wrote its 919 KB artifact into the same directory and reported
`/api/canvases/<id>/files/task_*.png`; a file of another canvas is a 404; the canvas page loaded with an
empty console.

**Where** `internal/canvas/{files.go,files_test.go}` (new), `internal/upload/{upload.go,upload_test.go}`,
`internal/task/task.go`, `internal/server/{routes_runs.go,routes_canvas.go,routes_generation.go,runs.go,server.go,e2e_test.go,canvas_e2e_test.go,*_runs_e2e_test.go}`,
`internal/config/config.go`, `canvas/src/services/{canvas-files.ts (new),file-storage.ts,image-storage.ts}`,
`canvas/src/stores/canvas/use-canvas-store.ts`, `canvas/src/lib/canvas/{canvas-export.ts,canvas-node-factory.ts,image-thumbnail.ts}`,
`canvas/src/components/canvas/canvas-manager-dialog.tsx`, `canvas/src/pages/canvas/project.tsx`,
`canvas/src/i18n/locales/*`, `canvas/package.json`, `docs/server.md`.

## 157. The gateway's liveness is learnt from the traffic, not probed

**Decision** The heartbeat is gone. `services/api/gateway-status.ts` no longer has a timer, a
`GET /health` probe, or a reload: a gateway request that fails at the network layer marks the gateway
down, **any** response from it marks it up, and the banner follows. `/health` stays as an endpoint —
what it answers (ComfyUI's reachability, workflow counts) is a question for an operator with `curl`.

**What the old loop did** After the first failure it probed `/health` every 2s, and when the probe
answered it cleared the banner and reloaded the page 600ms later. It cost nothing while healthy (the
probe only ran while down), so this is not a performance entry; it is an entry about a mechanism that
had stopped being the only way to know either thing.

**Why the probe was unnecessary** Recovery was already in the traffic: the model list is fetched every
8 seconds and the system chip every 5, and the first of those to succeed is the same news, a few seconds
later and for free. The probe's only real contribution was making the banner disappear up to ~6 seconds
sooner.

**Why the reload was worse than useless** Its stated reason was that model lists, resource status and
in-flight requests had gone stale while disconnected. The polls now refresh all of that on their own
(#153 made the model list self-syncing), so what the reload still did was throw away what the tab held:
the undo stack, the selection, the node being dragged. A page that reloads itself because the backend
came back is a page that interrupts the person using it.

**The new rule, in one line** Reachability is derived from requests we make anyway: `noteGatewayError`
on a network failure, `noteGatewayResponse` on any answer — including a 4xx, because a 400 from the
gateway is a gateway that is answering. The synchronous hook that used to call `markGatewayUp()` after
its own fetch no longer has to, because its fetch goes through the HTTP layer like everything else.

**Tested** `npm run check`, 127 canvas tests (the API tests mock the status module, which gained the
`noteGatewayResponse` export they now stub), `make web`. In the browser: the gateway was killed under an
open canvas — the banner appeared with its new wording within one poll — and brought back: the banner
cleared on the next poll, `window.__noReload` survived (no reload), and the new build logged **zero**
`GET /health` requests across the whole cycle.

**Where** `canvas/src/services/api/{gateway-status.ts,http.ts}`, `canvas/src/hooks/use-local-gateway-sync.ts`,
`canvas/src/i18n/locales/*`, `canvas/tests/api-*.test.ts` (the stubs).

## 158. A tab that is out of date says so instead of winning

**Decision** A save that names a version older than the one on disk is **refused and handed to the
person**, never retried over it. And a tab checks whether it is still current when it comes back into
focus, so the mistake is caught at the moment it is made rather than at the next save.

**The scenario** One person, one workspace, no collaboration — and two tabs of the same canvas, because
a link was opened twice or the session was restored. Both hold a copy. A save replaces the whole
document (#152), so the second tab to save erased the first one's work, and the only trace was a toast
that said "changed elsewhere, saving this version" *after* the damage.

**Why the retry was the bug** The queue's conflict path adopted the new `rev` and retried, on the
reasoning that the content on screen was still unsaved and losing it would be worse. That reasoning is
right about *not discarding* the edit and wrong about the retry: with whole-document saves, a retry is
an overwrite. `rev` stops two saves from interleaving; it cannot stop one document replacing another,
because the gateway is not allowed to know what a node is.

**What the tab checks, and when** On `focus` and on `visibilitychange` → visible, the canvas page asks
for its own entry (`GET /api/canvases/{id}`, metadata only) and compares `rev` with the one it last saw.
Switching to a tab is exactly the moment the person is about to continue working in a stale buffer, so
it is the moment worth one request. No `BroadcastChannel`, no cross-tab protocol: the gateway already
holds the answer, and the check works across browsers and machines too.

**What the dialog offers** "Keep this" saves over the other copy — the one save in the app that names no
version, and only after the person was shown what it replaces. "Use the disk copy" reloads the page: the
nodes, the undo stack and the selection are all derived from the document read at load, and a reload is
how all three are made to agree with the file. That is the one reload in this app that somebody asked for
(#157 removed the automatic one).

**Not built, on purpose** No editing lock, no read-only second tab, no takeover, no polling leader. Those
solve *co-existing* tabs, which this workspace does not have; the requirement is a failsafe for a
mistake, and a failsafe that asks one question is smaller than one that forbids a layout.

**Tested** The queue's conflict tests now assert the opposite of before: one attempt, no retry, no save
on the other copy's version, and a later edit does not silently start overwriting again. `npm run check`,
127 canvas tests, `make check`, `make web`.

**In the browser** Two tabs on one canvas; a save from the first (`PUT` with its rev); focus moved to the
second — the dialog appeared by itself, naming when the disk copy was written — and "keep this" advanced
the `rev` with a forced save and closed the dialog with a toast. Nothing was overwritten before the
answer.

**Where** `canvas/src/lib/canvas/save-queue.ts`, `canvas/src/stores/canvas/use-canvas-store.ts`,
`canvas/src/components/canvas/canvas-conflict-dialog.tsx` (new), `canvas/src/pages/canvas/project.tsx`,
`canvas/src/i18n/locales/*`, `canvas/tests/canvas-save-queue.test.ts`.

## 159. The frontend is `frontend/`, and the build target says so

**Decision** `canvas/` is now `frontend/`, and the npm targets are `make frontend`, `frontend-deps`,
`frontend-check`, `frontend-clean` (they were `web`, `web-deps`, `web-check`, `web-clean`).

**Why** Two directories one letter apart, and the letter pointed the wrong way: `canvas/` was the app
and `canvases/` is the work. Every reader had to work out which was which — in the `Makefile`, in
`start.sh`, in the `.gitignore`, in this file. The frontend is not a canvas; the workspace is a set of
them.

`canvas/` was upstream's layout, kept through #149 because it was where the app lived. With `web/`
gone (#148) and the app no longer named after what it edits, the name was the last thing tying the
markup directory to the domain. `cmd/`, `internal/`, `frontend/` reads as one repository.

**What it cost** A `git mv` and seven references: the `Makefile` (its `WEB_DIR`/`WEB_STAMP` variables
became `FRONTEND_*`), `start.sh` (three paths and two hints), `.gitignore` (three build-output lines),
`README.md` (the tree and four paths), `docs/server.md` (one), and the two places that tell a reader
what to run next (`internal/server/runtime_config.go`'s comment and `frontend/public/config.js`).

**Not renamed** The `CANVAS_ROOT` variable, the `canvases/<id>/` layout and "back up your canvases" —
those name the workspace, which is what a canvas is. `make frontend` still says "build the canvas
bundle" in its help text, because that is what it builds.

**Tested** `make frontend` (a fresh build into `frontend/dist`), `make frontend-check`, `npm run check`,
127 canvas tests, `make check`, `make verify-static`, and `./start.sh`: the page, `config.js` and the API
all answer, and the canvas loads in the browser with nothing in the console.

## 160. The newest connection reads the agent, and an empty turn is a failure

**Decision** `Session.Watch` hands the session to the newest connection and tells the one it replaced
(`closed`), instead of refusing the newcomer. And a prompt turn that ends without a single word is an
error, not an empty answer.

**The report** A text node's agent wrote nothing at all, and the log showed `state closed`.

**What was actually happening** The agent was fine: the same prompt over the same socket streams
reasoning, then deltas, then `done`. The failure was in who is allowed to read a session. `Watch`
accepted one sink and refused every later one with "这个画布在另一个连接里已经打开了" — so a second tab
on the same canvas (and there were seven open while this was investigated) got an `error` instead of the
model list, the ask rejected, and `askOnceAgentSession`'s `finally` closed a session it had never been
able to use. That close is the `state closed` in the log, which is *normal* for a node's one-shot ask:
connect, ask once, close.

**Why the refusal was wrong** The rule exists so deltas are never split between two readers, and that
part stays: exactly one sink receives them. But refusing the *newest* connection protects a socket
nobody is looking at, and the tab it strands is the one in front of the person. Now the new connection
takes over, and the old one hears `closed` — which is also true, so it can reconnect and say so.

A handover cannot be undone by a late close: `Watch` returns a stop function, and only the watcher that
still owns the session may clear it (a generation counter, since a func value cannot be compared).

**Why an empty turn had to become visible** When a turn ended with nothing — which is what a closed
session looks like from the other side — the node was written with the empty string and marked
successful, so the canvas showed a blank text node and no reason. `requestPromptChat` now throws
instead, and the node's own error path (a toast and `NODE_STATUS_ERROR`) says what happened.

**Tested** The gateway's old `TestSocketIsOnePerCanvas` (which asserted the refusal) is replaced by
`TestTheNewestSocketTakesTheSessionOver`: the second connection gets the model list, receives the
answer, and the first one is told `closed`. `requestPromptChat` gained a test for the empty turn. Then
`make check`, 128 canvas tests, `npm run check`, `make frontend`.

**In the browser and over the socket** With the real agent: a second socket on one session name is
accepted, the first is told `closed`, and the second received 942 text events and `done` for the same
prompt that had produced nothing.

**Where** `internal/agent/sessions.go`, `internal/server/routes_agent.go`,
`internal/server/agent_e2e_test.go`, `internal/agent/session_test.go`,
`frontend/src/services/api/prompts.ts`, `frontend/src/i18n/locales/*`,
`frontend/tests/api-prompts.test.ts`.

## 161. A run goes into the canvas, and one function is the only place that says where

**Decision** Every URL the canvas submits a run or an upload to is built by one function,
`canvasApiUrl()` in `frontend/src/services/api/runs.ts`, which cannot be called without an open canvas.
And the tests that pin those URLs now name the canvas, instead of pinning a path that nothing external
checked.

**The report** The generate button answered `Not found: POST /api/runs`.

**What was actually happening** #156 deleted `POST /api/runs` and `POST /api/uploads` and gave every run a
canvas. The gateway was right; the browser was calling a route that no longer existed, because
`createRun` and `uploadMedia` still posted to the old two paths and nothing on either side compared its
address with the other's router.

**Why both test suites were green** They answer different questions and neither one is "do these two
agree?". The gateway tests post to the routes the gateway serves, so they track the router by
construction. The canvas tests stub `fetch`, so they agree with whatever the client sends, and a perfectly
exact assertion of the wrong string is still green: `api-runs.test.ts` did assert its URLs in full, which
pins the client but cannot know the gateway. The other two routed their stubs by suffix
(`url.endsWith("/api/runs")`, `endsWith("/api/uploads")`), so even a client-side change of the path's
prefix would have slipped past them. Only a real browser click crossed the seam, and that is where it
broke.

**The fix** `canvasApiUrl()` reads the canvas being edited and refuses to build a URL without one — the
`apiErrors.noCanvas` message, not a request built from an empty id. Both calls go through it, so the
canvas-scoping is stated once. A run that does not belong to a canvas is not a thing the protocol has
(#156), so the helper is also where that rule is enforced on the client side.

**Two smaller misses from the same sweep**

- `frontend/src/lib/canvas/canvas-export.ts` built the zip path with an **escaped** interpolation:
  `` `projects/\${project.id}/files/\${name}` ``. The archive therefore had one literal directory named
  `${project.id}` holding every file of every canvas — export "worked", and an import could not put a name
  back where a document's reference expects it. Fixed to a real template literal.
- The three tests that answer a run now open a canvas first (`setActiveCanvas`) and name the canvas in
  every URL they assert or stub; `api-runs.test.ts` still asserts them in full.

**Still weak, and left alone** Suffix matching survives in the video and upscale stubs, because the calls
they exercise are the ones whose shape did not change. Worse, `api-image-upscale.test.ts` keeps a stub
branch for `url.includes("/outputs/0")` — a route that no longer exists — so its artifact download falls
through to the run-status fallback. The test passes because it asserts the data-URL prefix, not the bytes:
it would not notice a download that returned the run's JSON. Nothing in this sweep touched it; it is
recorded here rather than left to be rediscovered.

**The guard that was written and thrown away** A `routes_contract_test.go` scanned the frontend sources for
`/api/...` strings and checked each against the gateway's route table. It was deleted: with
`httpRequest(url, { method: "POST" })` it can read the path but not reliably the method, and it did not
catch the bug it was written for. What would work is the client consuming a machine-readable route list —
a route table the gateway publishes, or a module generated at build time — because then the two sides read
the same data instead of one guessing about the other. That is not built.

**Tested** `make check`, `make verify-static`, `npm run check`, the canvas suite, `make frontend`, and the
two routes over `curl` (a `202` from `POST /api/canvases/{id}/runs`, a `200` from the artifact's file URL).
Not clicked in a browser yet: the generate path from the node itself.

**Where** `frontend/src/services/api/runs.ts`, `frontend/src/lib/canvas/canvas-export.ts`,
`frontend/tests/api-runs.test.ts`, `frontend/tests/api-video-runs.test.ts`,
`frontend/tests/api-image-upscale.test.ts`.

## 162. A stub that matches a URL's suffix cannot fail

**Decision** The canvas tests that answer a run route their stubs by the **whole** URL and answer `404` to
anything else, and the assertions name the whole URL too. `api-image-upscale.test.ts` is the case that made
this worth doing: it kept a stub branch for `/outputs/0` — a route #156 deleted — so its artifact download fell
through to the run-status fallback and the test read a run's JSON as if it were a PNG.

**Why** #161 recorded that weakness and left it. A stub matched by suffix (`url.endsWith("/runs")`) accepts a
request sent to the wrong place: it is written from the client's point of view, so it agrees with the client
whatever the client does, and the case passes on an address no gateway serves. A `404` for anything unlisted
turns that into a failure in the one place that is cheap to fix.

**What changed** `api-image-upscale.test.ts` and `api-video-runs.test.ts` gained a `ROOT`, a named upload id
(an upload's id is its file name, per #156, not `upl_1`), and a stub that routes the four addresses the action
actually uses: the canvas's uploads, the canvas's runs, the run's status, and the artifact as a file of that
canvas. The first case asserts the whole list of calls, in order. The interpolate case stopped overriding
`fetch` for one call and now declares its own upload response, so its media id is a video's name rather than a
lie about an image.

**Cost** A new call added to an action makes an existing case fail until the stub knows that address. That is
the point, but it is friction, and it is why the stub lives next to the cases rather than in a shared helper.

**Tested** `npx vitest run` (17 files, 136 tests), `npm run check`, `make check`. The upscale case now fails if
the artifact is fetched from anywhere but `GET /api/canvases/{id}/files/{name}`.

**Where** `frontend/tests/api-image-upscale.test.ts`, `frontend/tests/api-video-runs.test.ts`.

## 163. A citation is an id, and two nodes may share a name

**Decision** A citation in the agent panel is a node id plus the label the message shows. When the label is a
name another citation in the same draft already uses, it gets an ordinal (`图片`, `图片 2`), and the block the
prompt carries records both: `- <id> (<kind>) <label>: <prompt>`. A mention in the transcript is read back as
pairs and the click follows the id; the canvas's current titles are only a fallback for a sentence that cited
nothing.

**The report** Two `@` mentions that read the same, pointing at two different nodes, both jumped to the first
one.

**What was actually happening** `withMentions` collected `message.mentions` and then every node on the canvas,
and deduped **by title**, keeping the first. With two citations of `图片` the second was dropped before the
text was even scanned, so both occurrences matched the one survivor and focused its node. The dedupe was not
the only problem, it was the visible one: the code treated a name as an identity, and names are not unique
here. A node's title is the translation of its type by default (`canvas.nodeTypes.image`), so a canvas with
five images has five nodes called `图片` — the case the panel was built for is the case that broke.

**Why it read as working** #106 tested the block with two nodes that had different titles. Everything about
the mapping was correct except the part nothing exercised: that the token is not the identity.

**The fix** Three small pieces, in the module that already owned the format:

- `citationLabel(base, taken)` hands out the name, or the name with the first free ordinal, so the token a
  message shows is unique inside that message.
- `mentionSegments(text, citations, nodes)` cuts a message into plain runs and links, taking each link's id
  from the message's citations in order. A transcript written before labels were unique — two identical
  tokens, two ids — is read one citation per occurrence, which is the most two identical words can support.
- The panel keeps `{id, label}` for each citation, writes the label into the draft, and describes the node to
  the agent with the same label. It also cites `nodeTitle(node, t)` rather than the stored `title` snapshot, so
  a canvas created in Chinese and read in English cites the words on the screen.

**What it buys beyond the click** The agent reads `图片 2` with an id beside it, so a tool call can name the
second image instead of "the image" — the same ambiguity was in the prompt, not only in the link.

**Cost** The block's third field is the token, not always the node's name; a node whose title contains the
block's own `: ` still loses its tail when read back (#106's cost, unchanged). And the draft now reads
`@图片 2` where the user might have expected their node's name — true, and unavoidable while two nodes answer
to that name.

**Tested** `tests/agent-references.test.ts`: `citationLabel` numbering, two citations that read the same
resolving to two ids, a legacy transcript with identical tokens, a citation beating a node of the same name,
the longest label winning (`图片 10` before `图片 1`), and an `@` that names nothing staying text. Gates:
`npx vitest run` (137), `npm run check`, `make check`, `make frontend`.

**In the browser** A canvas with two text nodes, both called `文本`. `@` → pick the first → draft reads
`@文本`; `@` → pick the second → the draft reads `@文本 @文本 2`, and the block sent with it has two lines with
two different ids. The answer came back with two links — `@文本` and `@文本 2` — and clicking the first
selected `text-aaaa-1`, clicking the second selected `text-bbbb-2`. The agent also read them apart by itself:
it made two `canvas_read_node` calls and wrote its answer as a table of `text-aaaa-1 (文本)` against
`text-bbbb-2 (文本 2)`, which is the label doing its second job.

**Where** `frontend/src/lib/canvas/agent-references.ts`,
`frontend/src/components/canvas/canvas-agent-panel.tsx`, `frontend/tests/agent-references.test.ts`.

## 164. A replaced socket reconnects, and it does not release the agent

**Decision** Only the connection that is still reading a session may release it, and a browser told `closed`
reopens on its next send instead of writing into a socket another tab now owns.

**What broke** #160 lets the newest connection read a session and tells the one it replaced. Two things around
that handover were wrong, and both ended in a conversation that looked alive and was not.

On the gateway, the replaced connection's handler ended with `session.Cancel()` and
`sessions.Close(...)` — unconditionally. So when the tab that lost the session was closed (the ordinary end of
a socket nobody is reading), it released the process the *newer* tab was using. That tab's next question went
into a pipe that was gone.

In the browser, `closed` only changed the label in the header. The socket and its session entry stayed, so the
next send went to a socket whose events now belong to another tab: no answer, no error, no end of turn, and a
panel stuck on "thinking" for ever. `openAgentSession` had the same shape from the other side — a live entry
whose socket was closing was handed back as if it were connected, because its `opening` promise had already
resolved.

**The fix** `Session.Watch` returns whether the connection detaching was still the reader, and only then does
the handler cancel and release; the call is idempotent, so the early returns and the `defer` cannot release
twice. The client treats `closed` as the end of *this socket*: it drops the entry, closes the socket, and the
next send opens a new connection — which takes the session back. `openAgentSession` refuses to return an entry
whose socket is not open or opening. Submitting a message now checks whether it was written and says so when
it was not.

**Cost** A replaced tab that sends again steals the session back from the tab it lost it to, so two tabs can
alternate rather than one being permanently second class. That is the price of "the newest connection reads
the session" being the only rule; the alternative was a refusal, which #160 already rejected.

**Tested** `TestTheReplacedSocketDoesNotTakeTheAgentWithIt` (Go, e2e): two sockets, the first closed, the
second still answered by the same process — it fails without the fix with EOF on the second socket.
`TestTheNewestSocketTakesTheSessionOver` still passes. Frontend gates: `npx vitest run` (138), `npm run check`.

**In the browser** Two tabs on one canvas, both open the panel. Tab B becomes the reader (the gateway logs
`spawned=false`, so it is the same process) and tab A shows "未连接" with its transcript intact. Sending from
tab A reconnects and answers "我还在。"; the gateway logs a third `socket open` with `spawned=false` and no
`released` line, which is the fix: closing the replaced socket no longer ends the conversation.

**Where** `internal/agent/sessions.go`, `internal/server/routes_agent.go`, `frontend/src/services/api/agent.ts`,
`frontend/src/components/canvas/canvas-agent-panel.tsx`, `internal/server/agent_e2e_test.go`.

## 165. A save that ran out of retries waits for the next edit

**Decision** A save whose retry schedule is spent stops; the next edit is what starts a new one.

**What broke** The save queue's "try again" path armed the debounce from the failure handler, and the
settle step re-armed it whenever the canvas was still dirty. With the retry schedule spent, nothing cleared
the flag, so a document the gateway kept refusing was re-sent every 400 ms for as long as the tab lived. The
new test counted 153 attempts where the schedule allows three, and `onError` fired with each one.

**The fix** An entry remembers that its retry schedule is spent. `settle` does not re-arm a spent entry; a new
edit (which is new information) calls `schedule`, which clears the flag and starts a fresh schedule.

**Cost** A permanent failure now needs a user action to be retried at all. That is what the comment always
said and the code did not do; the alternative is a loop that fills the console and gains nothing.

**Tested** `canvas-save-queue.test.ts`: "stops once the retry schedule runs out, and a new edit starts it
again" — 3 attempts, 3 errors, still dirty, and a fourth attempt after a new edit.

**Where** `frontend/src/lib/canvas/save-queue.ts`, `frontend/tests/canvas-save-queue.test.ts`.

## 166. Preferences are written one at a time

**Decision** One settings document on the wire at a time, in the order it was edited.

**What broke** The settings document is replaced whole, and `save()` set its `pending` flag and awaited the
request. A change arriving while that request was in flight started a second one, and two whole documents in
flight can land out of order — the older one winning. It needs a slow gateway and a quick edit to happen, and
then preferences look like they did not change.

**The fix** One write on the wire at a time. A change that arrives during a write is written by the next
request, in order; a failure is retried by the next change rather than from the write's own end.

**Cost** A save queued behind a slow request waits for it. The debounce is what kept this rare, and the
alternative is a lost edit rather than a late one.

**Where** `frontend/src/stores/use-settings-store.ts`.

## 167. The upload ceiling is the one that was configured

**Decision** The multipart parser reads `MAX_UPLOAD_BYTES` from the configuration; it has no ceiling of its own.

**What broke** `MAX_UPLOAD_BYTES` is documented as the per-file limit, but the multipart parser capped every
file at 50 MiB of its own: the knob could be lowered and not raised, and a deployment that raised it got
"uploaded file is too large" from the parser before the upload store saw the request.

**The fix** The ceiling travels from the configuration into `ParseMultipart` (through `httpx.Ctx`), and zero
still means the package default for callers that have no configuration.

**Cost** One more field on `Ctx`, and the parser no longer has an opinion of its own — which is the point.

**Tested** `TestParseMultipartHonoursAConfiguredCeiling`: a limit below the file size refuses it, a limit above
accepts it.

**Where** `internal/httpx/form.go`, `internal/httpx/httpx.go`, `internal/server/server.go`.

## 168. Shutdown stops the task cleaner instead of waiting for its next tick

**Decision** Shutdown signals the cleaner and then waits for it: `stop` and `done` are two channels.

**What broke** The cleaner took one channel and closed it itself on the way out, and the shutdown path waited
on that same channel. There was nothing that could tell it to stop, so with `TASK_RETENTION_DAYS` set a
Ctrl-C blocked until the next cleanup tick — an hour by default. Measured on the built binary: six seconds
after SIGTERM it was still running.

**The fix** Two channels: `stop` is closed by the shutdown path, `done` is closed by the loop.

**Cost** One more argument to a ten-line function.

**Tested/measured** The fixed binary exits immediately on SIGTERM with `TASK_RETENTION_DAYS=1`; the previous
build was still running six seconds later.

**Where** `cmd/comfyloft-server/main.go`.

## 169. A file that could not be added says so, and media too big to hand over is not sent

**Decision** An add that fails reports it, and a tool result larger than one socket message is refused in
favour of its size.

**What broke** Two silent failures around media. Dropping, pasting or picking a file ran the upload with no
failure path: a gateway that was down left the rejection in the console and nothing on the canvas. And
`read_node` inlined a node's media as base64 with no bound — the gateway closes a socket that sends a message
over 8 MiB, so reading back a large clip ended the whole agent conversation.

**The fix** Every ingress path reports a failure with a toast (one new key, both languages). `read_node` refuses
to inline more than 5 MiB of base64 and answers with the file's size instead — the file stays on the canvas,
which is where the user can open it.

**Cost** A 6 MB picture cannot be handed to the agent at all. The alternative is a socket that dies, which
loses the whole conversation rather than one read.

**Where** `frontend/src/pages/canvas/hooks/use-content-ingress.ts`,
`frontend/src/pages/canvas/hooks/use-canvas-agent-tools.ts`, `frontend/src/i18n/locales/*.ts`.

## 170. The default language is English

**Decision** A workspace that has never chosen a language opens in `en-US`, and `en-US` is also the
dictionary fallback: a key the Chinese dictionary is missing renders its English sentence rather than the
other way round. A workspace that has chosen a language keeps it — the preference is `locale` in
`data/settings.json` (#155), read before the first paint.

**Why** The project's written language is English (README, "Language"), so the product's own default should
not be the one language its documentation is not in. It also puts the `fallbackLng` on the side with the
larger dictionary: an untranslated string is then an English sentence in a Chinese screen, which is the
failure the check script reports (§#41), rather than Chinese text in an English one.

**What did not change** The Chinese labels for workflow metadata (`gateway.models`, `gateway.variants`) —
`chinese()` asks the `zh-CN` dictionary by name (#20), so it does not depend on which language is being read.
The Chinese copy the resource panel keeps beside itself (#67), the model-facing Chinese in
`internal/prompt` (#9), and the protocol values such as `文生视频(T2VA)` are untouched: they are data, not
UI copy.

**Cost** An operator who wanted Chinese by default now says so once per workspace, and the first screen of a
fresh install is English. Existing workspaces are unaffected — their `locale` was written the first time
anyone switched the language, and the read is what runs first.

**Tested** `npm run check` (i18n keys still agree: 905 / 891), `npx vitest run` (146 — no test depended on the
Chinese default; the ones that need a language name it), `npx tsc --noEmit`. In the browser: a gateway on a
temporary data directory (so the workspace really has no `locale`) served the bundle on a fresh tab —
`document.documentElement.lang` is `en-US`, the first canvas is created as "Canvas 1", and the toolbar reads
"Canvas elements" / "No nodes on this canvas" with the switcher offering `中`. A workspace that has chosen a
language keeps it, because `bootLocale()` reads the saved document first.

**Where** `frontend/src/i18n/index.ts`, `frontend/index.html`, `frontend/scripts/check-i18n.cjs`,
`docs/decisions.md` #20 and #41 (their wording no longer rests on the fallback being Chinese).

## 171. A file's name is the document's, so an import keeps it

**Decision** Restoring an exported canvas writes every file under the name the document already uses
(`files/<name>`), through one route that takes the name from the URL — `PUT /api/canvases/{id}/files/{name}` —
and the document is then stored exactly as it came out of the zip. Nothing is renamed and nothing is rewritten.

**What was wrong** Import went through the upload route. That route names files itself (`up-<8 hex>.<ext>`,
unique inside a canvas, chosen by the gateway so a client cannot collide with, or walk out of, a directory),
so every imported file came back under a different name, and the document had to be repaired afterwards by
replacing `files/<old>` with `files/<new>` — over the whole JSON, as text. Two costs came with that: the
document briefly named files that did not exist, and the rename was a string substitution over a document the
gateway is not supposed to understand.

**Why it was wrong, more precisely** An export already is the canvas directory: `projects/<id>/files/<name>`,
named by the document. The only thing an import has to change is the canvas id, because directory names are
ids and the exported one still exists. A file name is not an id — it is the reference the document holds — so
preserving it is the whole job. The "gateway picks file names" rule belongs to *new* bytes (an upload, a run's
artifact), where no name exists yet.

**What else had to agree** The export carried the in-memory project, whose `metadata.content` is the absolute
URL an `<img>` needs, so a zip contained `http://127.0.0.1:8190/api/canvases/…` — the exact thing #152 forbids
in a document, and the reason an imported canvas displayed the *exporting* workspace's URLs until the next save
stripped them. The document is now built in one place (`lib/canvas/canvas-document.ts`) by both the save queue
and the export, and a zip carries no id, no rev and no URL.

**Cost** The gateway now accepts bytes at a name a client chose, guarded by the same name validation the read
route uses. A name that is taken is refused (`409`) rather than overwritten: a file's URL is its own ETag
(`immutable`), so overwriting one would leave every cache that has seen it showing the old bytes. Import is
unaffected — it always writes into a canvas it just created — but a "restore over an existing canvas" is not
something this route can do, and is not something the canvas offers.

**Tested** Go: `TestWriteFileKeepsTheNameAndRefusesATakenOne` (store) and
`TestAFileCanBeWrittenUnderANameTheDocumentUses` (route: write, read back the same bytes, second write 409,
escaping name 400, unknown canvas 404). Frontend: `tests/canvas-document.test.ts` — media named by reference,
nodes without metadata untouched, and only the five document fields in the result. Gates: `make check`,
`go test -race`, `npm run check`, `npx vitest run` (149).

**In the browser** Exported a canvas holding an image, deleted it, imported the zip: the canvas came back with
the same node, the file in `files/` kept the name the document names (`files/import-test.png`, no `up-` copy),
the bytes were identical, and `canvas.json` on disk contains no `http` at all. (The archive itself has since
become one canvas per zip — `manifest.json`, `canvas.json`, `files/` — see #172.)

**Superseded in part by #172** The route this entry introduced (`PUT /api/canvases/{id}/files/{name}`) is gone:
the gateway unpacks the archive itself now, so no client ever writes a file at a chosen name. What stays is the
finding — a file's name is the document's, and an import must not rewrite it.

**Where** `internal/canvas/files.go`, `internal/canvas/canvas.go`, `internal/server/routes_canvas.go`,
`frontend/src/services/canvas-files.ts`, `frontend/src/lib/canvas/canvas-document.ts`,
`frontend/src/lib/canvas/canvas-export.ts`, `frontend/src/components/canvas/canvas-manager-dialog.tsx`,
`frontend/src/stores/canvas/use-canvas-store.ts`.

## 172. One canvas, one zip, and the gateway unpacks it

**Decision** An export is one canvas: a zip holding `canvas.json` (the document), `manifest.json` (format and
title) and `files/<name>` (its media). An import is that zip POSTed to `/api/canvases/import`, and the gateway
creates a canvas, unpacks the archive into it and answers with the canvas. No id, no rev and no URL travel in
the archive, and the files keep the names the document uses.

**Why one canvas per archive** The previous format packed *several* canvases into one zip
(`projects.json` + `projects/<id>/files/…`), because the canvas list had a "export selected" button. That is a
batch format for a product whose unit is a canvas: it made the import dialog ask the gateway for N canvases, it
made "what does this file on disk belong to" answerable only by reading a JSON index, and it is why the word
"projects" leaked into a workspace that has only canvases. A zip that is exactly one canvas directory is also
the thing a person can unzip by hand and read.

**Why the gateway unpacks it** The client used to unzip (`fflate`) and PUT each file, and before that it wrote
the bytes back into IndexedDB — import has always been "put these bytes where the document says they are". Once
the media moved into the canvas directory (#156) the only write route named files itself, so the client had to
collect the new names and rewrite the document (#171). With the archive in one request the operation is what it
always was: unpack into the canvas. The client keeps no archive parser, and three consequences come with that:

- **The title comes from the manifest.** It is not part of the document (the gateway owns titles), so the
  archive has to say it somewhere.
- **The id is new.** The zip carries none; the exported canvas usually still exists in the same workspace, and
  a canvas id is a directory name.
- **Limits have to exist**, because this is user input: the body and the unpacked bytes are bounded by
  `MAX_IMPORT_BYTES` (8 GiB by default — a canvas archive carries every clip it shows), an archive holds at
  most 20 000 entries, and a `..` segment in an entry name is refused *before* cleaning — `files/../x.png`
  cleans to `x.png`, which no longer looks like a traversal.

**Cost** A failed import can leave nothing behind but also cannot be resumed: it is one request, so it is
either the canvas or an error (the canvas is deleted if a file fails to write). Old archives — the multi-canvas
format — are refused with a message saying to export them again, rather than carried forever. And unpacking
user archives is the one place this gateway parses a container it did not produce: `archive/zip` only, with the
rules above, no symlinks and no modes taken from the archive.

**Tested** Go: `TestImportingAnArchiveRestoresTheCanvasAsItWasExported` (document, title, file bytes and name),
`TestAnArchiveThatIsNotOneCanvasIsRefused` (old format, no document, `..` entry, not a zip — and no canvas left
behind), `TestAnImportPastTheLimitIsRefusedAndLeavesNothing` (413 with a 32-byte ceiling). Frontend:
`tests/canvas-document.test.ts` still pins the document that goes into `canvas.json`. Gates: `make check`,
`go test -race`, `npm run check`, `npx vitest run` (149).

**In the browser** Exported a canvas holding an image: the zip holds `manifest.json`, `canvas.json`,
`files/import-test.png`. Deleted the canvas, imported the zip: one request, the canvas came back with the same
node and title, the file kept its name and its bytes, and `canvas.json` on disk contains no `http`.

**Where** `internal/server/canvas_import.go`, `internal/server/routes_canvas.go`, `internal/canvas/files.go`,
`internal/canvas/canvas.go`, `internal/config/config.go`, `frontend/src/lib/canvas/canvas-export.ts`,
`frontend/src/services/api/canvases.ts`, `frontend/src/stores/canvas/use-canvas-store.ts`,
`frontend/src/components/canvas/canvas-manager-dialog.tsx`, `frontend/src/types/canvas-export.ts`,
`frontend/src/lib/canvas/canvas-document.ts`.

## 173. A generated file is the file the run wrote

**Decision** When a run finishes, the node references the artifacts where the run put them: `files/<name>`
inside the canvas, which is exactly the name `canvas.json` stores. Nothing is downloaded and nothing is
uploaded; the only thing read back is the media's own shape (a picture's size, a clip's duration), and a
browser reads that from the URL.

**What it replaced** Every generation ended with a round trip that made a second copy: the gateway wrote
`files/task_<id>.png`, the browser fetched it, turned it into a data URL, and posted it to
`/api/canvases/{id}/uploads` — which named it `up-<8 hex>.png` — and the node referenced *that*. Two files per
artifact (measured: three 1.0 MB images, three `task_*` and three `up-*` with identical sizes, document
pointing at the last three), one wasted transfer per artifact, and a document whose names depended on a second
write succeeding.

**Why it was there** `uploadImage` / `uploadMediaFile` is the canvas's one primitive for "put these bytes in
the canvas and give me a reference", written when the browser owned the media (IndexedDB) and every picture
had to be stored by the page. Generation was built on it before #156 moved media into the canvas directory;
after #156 the run was already writing the file, so the upload had become a copy of a copy. It stayed because
it worked — the same reason the import did (#172).

**What it changes for the user** One file per artifact instead of two, and a generation that finishes when its
last file is written rather than after a second upload. The names in the document are the run's
(`task_<id>[-n].<ext>`), so a canvas and its runs agree on what a file is called. The collector is unaffected:
a run record and the document are both roots, and once the document names the file it is the document that
keeps it alive.

**What it does not touch** Bytes the browser itself produces still go through the upload route, because they
have no name yet: a dropped or pasted file, a crop, a split piece, a painted mask, a captured video frame.
Reference media for a run is uploaded the same way — it is the user's file, not a run's output.

**Cost** A node's `content` is the run's own name, so an artifact keeps the run's spelling (`task_<uuid>.png`)
rather than a short one. Nothing renames files, which is the point.

**Tested** `tests/api-runs.test.ts` (a run's outputs become the document's names and the gateway's URLs),
`tests/api-image-upscale.test.ts` (an upscale run's artifact is referenced, not fetched — the call list stops
at the run's status), `tests/api-video-runs.test.ts` (a clip's reference carries its size and duration, and the
artifact is never fetched). Gates: `npm run check`, `npx vitest run` (147).

**In the browser** Generated three 1024×1024 images from the canvas: `canvases/<id>/files/` held exactly three
`task_*.png` files and no `up-*`; the document referenced `files/task_*.png` in order with real dimensions and
byte counts; the images rendered; a reload rendered them again from the same names. The canvas was deleted
afterwards.

**And the shims went with it** Two branches existed only for documents written while the browser owned the
media: `resolveMetadataReferences` resolved `image:` keys, and `hydrateCanvasImages` uploaded a node's inline
`data:` picture on load, so that opening an old canvas rewrote it. Nothing this build writes has either shape
(the workspace was checked), so both are gone: an inline picture is shown as it is and left alone, which is
honest for a document no build can produce any more. `canvas-export.ts` lost the same dead fallback.

**Where** `frontend/src/lib/canvas/generated-media.ts` (new), `frontend/src/services/api/{runs,image,video,audio}.ts`,
`frontend/src/pages/canvas/hooks/{use-generation-runs,use-image-editors,use-video-editors}.ts`,
`frontend/src/pages/canvas/project.tsx`, `frontend/src/services/{image-storage,file-storage}.ts`,
`frontend/src/lib/canvas/canvas-generation-helpers.ts`.

## 174. A reference is named, not copied

**Decision** A run's media map takes the file a reference already is. A node's picture, a mask, an upscale
source, a reference clip — if it is a canvas file, its name goes into the request (`media: {image:
["task_<id>.png"]}`) and the run reads it from the same canvas. An upload happens only when the reference has
no file yet: a paste, a crop, a split piece, a data URL.

**What it replaced** Every reference was converted to a data URL and posted to `/uploads` before the run, so a
generation with one reference stored a second copy of it under an `up-<8 hex>` name — and again on the next
generation from the same node, once per run. The same bytes, once per attempt.

**Why it was there** The upload route is the canvas's "give these bytes a name" primitive, and it was the only
way media entered a run when the browser held the pictures. Since #156 a run's media is looked up *by name in
the canvas it belongs to* (`uploads.Get(canvasID, id)` reads `files/<name>`), so a name that already exists is
all a run needs. Nothing in the request changes shape: the id was already a file name.

**Cost** A reference whose file was collected (or deleted by hand) now fails as `upload_not_found` naming the
file, instead of silently being re-uploaded from whatever the page still had in memory. That is the honest
answer either way — the node was showing a picture whose file is gone — and the message names the file that is
missing.

**Tested** `tests/api-image-upscale.test.ts`: a source with a `storageKey` produces exactly two calls (submit,
poll) and `media: {image: ["up-abcdef12.png"]}`, while a source with none still uploads first. Gates:
`npm run check`, `npx vitest run` (148).

**In the browser** Generated one picture, then upscaled it from the image toolbar: the canvas grew by one file
(the upscale's own output) and no `up-*` copy of the source appeared — the run's record shows
`media: {image: ["task_afa1632b-….png"]}`, the file the node was already showing.

**Where** `frontend/src/services/canvas-files.ts` (`mediaIdOf`), `frontend/src/services/api/image.ts`,
`frontend/src/services/api/video.ts`.

## 175. A cancellation is a value, not a sentence

**Decision** Every service rethrows a request the caller cancelled *as itself* (`throwIfCanceled`) before it
wraps an error into a sentence for the user, and the canvas decides "the person pressed stop" by the error's
name (`AbortError`). The agent's socket refuses an aborted turn the same way, instead of rejecting with a
translated sentence.

**What was wrong** `isGenerationCanceled` compared `error.message` against `i18n.t("common.requestCanceled")`
while the wrapping services produced `apiText("requestCanceled")` — a different dictionary key that happens to
hold the same words today. Change either string and stopping a generation would be reported as a failure and
paint the node red. The agent path was already wrong in a second way: an aborted turn rejected with the generic
"request failed" message, so a text node cancelled mid-answer showed an error and kept it.

**Cost** Two message constants (`apiErrors.requestCanceled`, `common.requestCanceled`) still exist, for display;
neither is load-bearing for control flow now.

**Tested** `tests/api-runs.test.ts`, `tests/api-video-runs.test.ts` and the generation hooks' own cases all
assert on `name === "AbortError"` paths; `npm run check` and `npx vitest run` (150).

**Where** `frontend/src/services/api/http.ts` (`throwIfCanceled`), `frontend/src/services/api/{image,video,audio,runs,agent}.ts`,
`frontend/src/lib/canvas/canvas-generation-helpers.ts`.

## 176. A dialog with no safe default cannot be dismissed

**Decision** The conflict dialog has no close button, its backdrop does nothing, and Escape does nothing. The
two buttons — load the disk copy, or keep this one — are the only ways out. `kit/dialog` grew
`escapeClosable` for it; the other dialogs are unchanged.

**What was wrong** `onClose` was wired to "use the disk copy", which is `window.location.reload()`. So a stray
Escape, or a click outside, silently answered "throw my changes away and reload" — the one answer that loses
work, chosen by accident. The close button sat in the header offering the same thing.

**Cost** A person who does not want to choose must reload the browser tab by hand (which is the same answer, but
deliberate), or pick one. That is the point: this dialog only exists because a decision is required.

**Tested** In the browser: two tabs on one canvas, both edited, the second save answered 409 → the dialog
appeared with only its two buttons; Escape left it on screen; "keep this one" saved this tab's document (rev
moved, the other tab's node replaced) and closed it.

**Where** `frontend/src/components/kit/dialog.tsx`, `frontend/src/components/canvas/canvas-conflict-dialog.tsx`.

## 177. The last save before a page leaves is sent with keepalive, when it fits

**Decision** The flush that runs on `pagehide` (`flushAll` for canvases, `flush()` for settings) asks the
transport to keep the request alive across the navigation. `http.ts` honours that only for a body under 60 kB —
Chrome's budget for in-flight keepalive bodies is 64 KiB and it *rejects* a request over it, so a bigger
document is sent as an ordinary request instead of a request that cannot exist.

**Why** A debounced save started as the page unloads is the one write that can be lost: the request is issued
and the document goes away under it. Keepalive is what tells the browser to deliver it anyway. The size line is
the part that has to be honest — a canvas document is usually a few kilobytes, and a document that inlined
media (16 MiB is the store's ceiling) can never travel this way.

**Cost** Two code paths to reason about (kept and not kept), and a threshold that a browser could change. The
alternative was pretending: `keepalive: true` on a 2 MB body fails the fetch, which is worse than a normal
request that usually still arrives.

**Tested** `tests/canvas-save-queue.test.ts`: `flushAll` marks its saves `keepalive`, a debounced save does not.

**Where** `frontend/src/services/api/http.ts`, `frontend/src/services/api/{canvases,settings}.ts`,
`frontend/src/lib/canvas/save-queue.ts`, `frontend/src/stores/{canvas/use-canvas-store,use-settings-store}.ts`.

## 178. A canvas's conversation is a file in the canvas

**Decision** The agent's conversation for a canvas is `<CANVAS_ROOT>/<id>/session.alaya`, handed to AlayaCore
as `--session`. The gateway reads exactly one thing out of a session name — the `canvas:` prefix and the id
after it (`frontend/src/services/api/agent.ts` is the other side of that contract) — and puts the file there.
A name that is not a canvas keeps no file: a node panel's question is one question, and its answer belongs to
the node. Nothing is migrated: no release has users, so there is no arrangement worth carrying.

**Why** A conversation is part of the canvas. Inside the directory it is deleted with the canvas, copied with
it, and found where somebody looking at the canvas would look. Before this it was `data/agent/sessions/
<session>-<hash>.session`, named after a session rather than a canvas: the UI had to remember to call
`DELETE /api/agent/session/...` before deleting a canvas, and every other way of deleting one (the API, a
script, a hand) left a file that nothing could attribute, on a disk nobody sweeps. Two such files were already
sitting in this workspace, for canvases deleted weeks ago. A file whose owner is a directory needs no second
lifetime rule.

**Cost** The conversation is not in an export. That is deliberate — a zip is the document and the media its
nodes point at — but it does mean a canvas that travels arrives without what was said about it. And the
gateway now knows the `canvas:` prefix exists, which the session registry otherwise does not: the alternative
was a second copy of the id in the socket URL, free to disagree with the name.

**Tested** `internal/canvas`: `TestSessionPathIsInsideTheCanvas` (the path is inside the canvas, asking for it
creates nothing, a missing canvas has none, deleting the canvas deletes the file). `internal/server`:
`TestSessionFileIsTheCanvasesOwn`, `TestDeletingACanvasTakesItsConversationWithIt` (a real socket, a real
conversation, one `DELETE /api/canvases/{id}`), `TestOneShotSessionKeepsNoFile`. By hand: the conversation of
the one canvas in this workspace was moved into `canvases/349b70cf4764/session.alaya` and the agent replayed
it on the next connection.

**Where** `internal/canvas/canvas.go` (`AgentSessionName`, `SessionPath`, `ValidID`),
`internal/server/agent_conversations.go`, `internal/server/{agent_config,routes_agent}.go`,
`frontend/src/services/api/agent.ts`, `docs/server.md`.

## 179. An image is stored, or it fails — never kept as an address

**Decision** `uploadImage` has one path: a `File`/`Blob` is stored as a canvas file, and a string is downloaded
first and then stored. The branch that returned `{url: input, bytes: 0}` when a remote URL could not be
downloaded but could be displayed is gone, and so is `IMAGE_REMOTE_LOAD_TIMEOUT_MS`.

**Why** That branch wrote an absolute `http://…` into the document, which is exactly what #152 removed and what
#174 replaced with a name the canvas serves. It was also unreachable in practice — every caller hands over a
`File`, a paste, a crop or a data URL — so it was a second way to produce a reference, kept alive by nothing but
the possibility of it. What it claimed to support cannot work: a URL this build cannot download is a node that
draws nothing after a reload, and a picture only the current browser can show is the blob era coming back.

**Cost** A URL behind an address this machine cannot reach fails loudly at the point of the node that wanted it.
That is the honest answer, and it is the same answer #174 gives for a canvas file that is no longer there.

**Tested** `tests/image-storage.test.ts`: a URL whose download fails rejects, with an `Image` stub that *would*
load, so the old branch would have resolved — the test fails against the previous code (`promise resolved instead
of rejecting`) and passes now.

**Where** `frontend/src/services/image-storage.ts`, `frontend/tests/image-storage.test.ts`.

## 180. One run is one picture, and a node holds one result

**Decision** Generating several candidates at once is gone, on both sides. A run produces one artifact
(`Runner.RunImage` returns the first image file, like `RunVideo`/`RunAudio` do for theirs), the gateway no
longer accepts `count`/`n` as inputs (`semanticInputs`, the typed `InputSpec`, `InputLimits.MaxCount`,
`MAX_IMAGE_COUNT`, the `BuildContext.Count` plumbing, and the four `count → batch_size` bindings in
`registry.json`), and a node holds one picture: `metadata.images[]`/`primaryImageId`/`count` are gone from
the document, so the node's own `content`/`storageKey`/`naturalWidth`/`naturalHeight`/`bytes`/`mimeType`
*are* the picture. All the UI that existed to manage a group went with it: the expand/collapse badges on the
card and in the side panel, the group thumbnails, set-primary, duplicate, download-per-image, per-image
retry and delete, the count control in the image settings popover and in preferences, and the words for
them in both locales.

**Why** A node was two things at once — an artifact and a set of artifacts — and every surface that pointed
at a node had to ask which one it meant: the agent's `read_node` could only reach the selected picture, a
reference taken from the node depended on `primaryImageId`, and "you can see it but you cannot say which"
is not a state a canvas should have. The feature also bought nothing in exchange: three images in one run
is one batch through the same GPU, so it costs three times the time of one and returns nothing sooner.
Candidates are a canvas question anyway — a text node and three image nodes fed from it is the same
comparison, with each picture a node somebody can point at (#181's other half).

**Cost** Comparing candidates is now several nodes rather than one click, and the text-node batch UI
(`texts[]`, "N texts") survives as the last of the pattern — it is unreachable from the UI (text generation
writes one text) and is the next thing to collapse into `content`. An old document that holds `images[]`
renders its `content`, which is the picture that was primary; the other files become unreferenced and the
startup collector sweeps them after its grace window.

**Tested** `make check` (the removal reaches `inputs_test.go`, `bindings_test.go`, `config_test.go`,
`runs_e2e_test.go`: `TestRunImageProducesOnePicture` asserts one output named `<run>.png`), `CGO_ENABLED=1
go test -race`, `npm run check` (i18n 893/879 keys — 11 dead keys removed), `npx vitest run` (151). In the
browser: a fresh canvas, an image node generated once, no group badge, no count control anywhere.

**Where** `internal/workflow/{inputs,bindings}.go`, `internal/generate/runner.go`, `internal/config/config.go`,
`workflows/registry.json`, `internal/server/routes_runs.go`, `frontend/src/lib/canvas/{canvas-node-factory,
canvas-generation-helpers,generated-media,canvas-document}.ts`, `frontend/src/pages/canvas/{project.tsx,
hooks/use-generation-runs.ts}`, `frontend/src/components/canvas/{canvas-node,canvas-side-panel,
canvas-image-settings-popover,canvas-node-hover-toolbar}.tsx`, `frontend/src/components/image-settings-panel.tsx`,
`frontend/src/stores/use-config-store.ts`, both locales.

## 181. The start script rebuilds a bundle older than its sources

**Decision** `./start.sh` compares `frontend/dist/index.html` with `frontend/src`, `frontend/public`,
`index.html`, `vite.config.ts`, `package.json` and `package-lock.json`, and runs `make frontend` when the
bundle is missing or older. It does this before the gateway starts, so the gateway's write of
`dist/config.js` still lands in the file the browser reads first.

**Why** The rule was "the bundle is build output, so remember to run `make frontend`", and forgetting it is
invisible: the page loads, the old code runs, and a fix looks like it did nothing. That is not a rule worth
remembering — it is a rule that punishes remembering nothing. The build is two seconds when it happens at all.

**Cost** Starting without changing anything still touches the filesystem to check, and a source tree whose
mtime moved without its content changing rebuilds a bundle that did not need it. Both are cheaper than a
stale page.

**Tested** A copy of the workspace with a bundle older than its sources: `./start.sh` printed "building the
canvas bundle (missing, or older than its sources)", built, and served; a second start printed nothing and
served the same bundle.

**Where** `start.sh`, `README.md`.

## 182. The agent can delete a node, and point at one

**Decision** Two more MCP tools, both run by the page with the functions the user's own controls call:
`delete_node` is the Delete key (the node, and every connection that touched it), `focus_node` is a click
on a row of the side panel (the node is selected, and the view animates to it). Focus selects; there is no
select-without-moving.

**Why** The agent could build and never clean up. A wrong turn left nodes the user had to find and remove
by hand, and `create_node` puts a node in the middle of the view, so a canvas the agent filled up is a
canvas the user can no longer see. Naming a node in words — "the third image" — is exactly what the ids
`list_nodes` reports exist to avoid.

**Cost** `focus_node` moves the viewport the user is working in; the description says so, and it is the
only way an agent can point at something. Deleting takes an id, so a wrong id removes the wrong node — it
is one history step, the same Ctrl+Z as a deletion by hand, and like the Delete key it does not cancel a
generation already running in that node.

**Tested** `make check`, `go test -race`, `make verify-static`, `npm run check`, `npx vitest run`.
`TestMCPHandshakeIsEnoughToDiscoverTheTools` pins the nine names in order. In the browser (a `/tmp/verify`
copy on 8191/3001, the canvas agent connected, the real `comfyloft-mcp` bridge fed one call at a time into
`tools/call`): `create_node` twice, `connect`, `focus_node` — the view moved from the reset position
`translate(1131.6px, 738.8px)` to `translate(1261.6px, 718.8px)` and the node carried the selected class —
then `delete_node` on an unknown id (an `isError` answer naming it), `delete_node` on the image node
("deleted … and 1 connection that touched it"), `list_nodes` agreeing (1 node, 0 connections), the saved
`canvas.json` agreeing, and Undo bringing the node back / Redo removing it again.

**Where** `internal/server/routes_mcp.go`, `internal/server/mcp_test.go`,
`frontend/src/pages/canvas/hooks/use-canvas-agent-tools.ts`, `frontend/src/pages/canvas/project.tsx`.

## 183. The agent is told to connect rather than copy

**Decision** Every spawn carries one `--system` line of the gateway's own (`canvasInstructions` in
`agent_instructions.go`, passed as `SpawnOptions.System`): the canvas is nodes and connections; before
making a node, use what is already there and connect it, because two copies are two things to keep in
step; and the viewport is the user's, so `focus_node` points at something instead of narrating. The two
descriptions that carry the same choice — `create_node` and `connect` — say it in one clause each.

**Why** A copy is a fork. Two text nodes with the same words drift apart the moment either is edited, and
two pictures with the same prompt are two generations to pay for and two results to tell apart, while a
connection keeps one source of truth — the canvas's own idea of reuse, which the user's gestures already
express. The agent had no reason to prefer it: it had a tool to make nodes and a tool to wire them, and no
sentence about which one applies. A tool description cannot say it (it explains one tool, not the choice
between two), and a skill is activated by reading it, which is precisely what has not happened at the
agent's first canvas move.

**Cost** A paragraph in every session's context, including a node panel's one-question agent that never
touches the canvas, and it is a default and not a guarantee: a model may still copy. The text is the
gateway's own and an operator cannot remove it (they can still add to it through `model.conf`), which is
the price of a rule the canvas tools do not work well without.

**Tested** `make check`, `go test -race`, `make verify-static`, `npm run check`, `npx vitest run`.
`TestArgsCarryTheSystemPrompt` pins the flag mapping, `TestAgentSpawnCarriesTheCanvasRule` pins that every
spawn carries the text. In the browser, with the real agent on the test instance: the startup frame
reported `MCP servers initialized: 1 servers, 9 tools loaded`, the process started and reached ready with
the flag in place, and asking "when you need what a node holds somewhere else on this canvas, do you
connect it or copy it, and why?" answered "I connect it rather than copy it, because a connection keeps a
single source of truth on the canvas — the source node's content flows directly to where it's needed, so
there's nothing to keep in step and no ambiguity about which version you meant".

**Where** `internal/server/agent_instructions.go`, `internal/server/routes_agent.go`,
`internal/server/routes_mcp.go`, `internal/agent/spawn.go`, `internal/agent/args_test.go`,
`internal/server/mcp_test.go`, `docs/server.md`.

## 184. The agent can move a node

**Decision** `move_node(nodeId, position)` puts one node's top-left corner where the tool says — the same
space `list_nodes` and `create_node` speak — and changes nothing else about the node. It is the page's
own end-of-drag outcome: a node whose centre now sits inside a group becomes a member of it, and one moved
out of a group stops being one.

**Why** The previous tool could make nodes where the view was looking and point at one, and nothing could
tidy the result: a row of nodes the agent made sits on top of the canvas the user was working in, and the
only way to separate them was to drag each one by hand.

**Cost** No collision test and no snapping: the corner stated is the corner the node gets, so a tool can
place two nodes on top of each other, and the drag's own "snap into the group" is not repeated. The user
can undo it — a move is a history entry like any other edit.

**Tested** `make check`, `go test -race`, `make verify-static`, `npm run check`, `npx vitest run`.
`TestMCPHandshakeIsEnoughToDiscoverTheTools` pins the ten names in order. In the browser (a `/tmp/verify`
copy on 8191/3001, its own `AGENT_CONFIG_PATH`, the real bridge fed one `tools/call` at a time): the
startup frame reported `10 tools loaded`; `move_node` moved an image node to `(640, -260)` — `list_nodes`
and the DOM transform (`translate(640px, -260px)`) and the saved `canvas.json` all agreed — a call with no
`position` answered `move_node needs a position: {x, y} in canvas coordinates` as an error, an unknown id
answered with the node lookup's own message, moving the node onto an empty group node set
`metadata.groupId` to it, and moving it back out cleared it.

## 185. The prompt box holds the user's words; the request is composed when it is sent

**Decision** Connecting a text node to an image (or video, or audio) node no longer copies its words into
that node's prompt box. The box holds only what the user typed. The connected text reaches the model where
it is an input: at send time, appended to the box as a labelled block (`【Text 1】\n…`, #78's labelling).
Nothing composed is stored back into a node — an in-place run keeps `prompt` as the user's words and
records the request in `sentPrompt`, which the panel shows on demand ("Sent 29 chars · show"). Generate is
enabled when there is anything to send: words in the box, or a text node connected to it.

**Why** Three mechanisms were adding the same sentence: the panel copied a connected text into the box, the
request appended every connected text, and an in-place run wrote the composed prompt back into the node —
which the panel then showed, and which the next run appended to again (the block grew by one per press). A
copy in the box is also the wrong idea about the line on the canvas: if the words appear in the box, the
connection is decoration, and editing them there forks them away from the text node the user is keeping.
The box is the node's own content, the connection is an input, and the disclosure is the honest place to
say that the two differ.

**Cost** An image node with an empty box made by a text node sends `【Text 1】…` to a model that did not need
the label — the label exists because there can be several texts, and dropping it for the single case would
be a second rule. The box is no longer a place to edit a copy of the connected text: editing happens in the
text node, which is the point. A document written before this keeps whatever a run used to write into its
`prompt`; nothing migrates it, so the box has to be cleared once by hand — the node's own title is left
alone in that case rather than being renamed after a request nobody typed.

**Tested** `npm run check` (i18n 897/883), `npx vitest run` (156, including five new cases in
`tests/canvas-generation-context.test.ts`: appended once after the box's words, whole request when the box
is empty, still appended when the box repeats the words, one block per text in connection order, nothing
when no text is connected), `make check`, `go test -race`. In the browser (a `/tmp/verify` copy on
8191/3001 with its own `AGENT_CONFIG_PATH`): `create_node` text + image, `connect` — the image node's box
stayed empty (`prompt` absent in `canvas.json`), References showed 1, Generate was enabled, and pressing it
submitted exactly `【Text 1】\na red ceramic teapot` (read back from the run's own request) and produced a
picture; the saved node then held `prompt: ""`, `sentPrompt: "【Text 1】\na red ceramic teapot"`, `title:
"Image"` (not renamed), and the panel offered "Sent 29 chars · show".

**Where** `frontend/src/components/canvas/canvas-node-prompt-panel.tsx`,
`frontend/src/pages/canvas/hooks/use-generation-runs.ts`,
`frontend/src/components/canvas/canvas-node-generation.ts` (unchanged by this: it already appended),
`frontend/tests/canvas-generation-context.test.ts`.

## 186. The agent's history can be thrown away

**Decision** The agent panel's header carries one more button (`canvas.agent.clearHistory`): it asks first,
then hands the session to `DELETE /api/agent/session/{session}` — the route that releases the agent and
deletes its session file — and reopens the socket. The next connection spawns a new AlayaCore, which finds
no session file and starts a new one; the transcript is drawn from the agent's own replayed history, so an
empty history is an empty panel.

**Why** A conversation is a working surface with a limit: a long one costs tokens on every turn and carries
mistakes into the next answer, and the only way to start over was to delete the canvas. The gateway already
had the half that matters — release the process, then remove the file, in that order, so nothing is left
writing what was just deleted (#183's route) — and the panel already redraws itself from `history`.

**Cost** Clearing mid-answer stops the turn (the release cancels it), which is what the confirmation is
for. The conversation is gone for good: no archive, no undo. A canvas that is never cleared keeps growing,
and one that is cleared leaves nothing behind to explain the nodes it made — the nodes are still there, and
that is the half that survives.

**Tested** `npm run check` (i18n 897/883: four new keys, none dead), `npx vitest run` (156), `make check`.
In the browser (a `/tmp/verify` copy, its own `AGENT_CONFIG_PATH`, the real agent): one exchange
(`X`→`ok`) left `canvas.json` and a 715-byte `session.alaya` next to it; pressing the button, confirming,
answered `DELETE /api/agent/session/canvas%3A…` 200, released the old process (`pid=374053`) and spawned a
new one (`pid=374193`), the file was gone, and the panel showed its empty state with no messages while the
canvas kept its two nodes and its picture. The next message wrote a fresh file whose first entry was that
new message, and the answer did not mention the earlier turn.

## 187. Clearing the history waits for an idle agent, and the gateway is what decides

**Decision** Clearing is refused while a turn is in flight, at both ends. The panel disables the button
(with a label that says why, `canvas.agent.clearHistoryBusy`), and the gateway refuses the request itself:
`Session.Busy` is set when a prompt is written and cleared where the turn ends, so
`DELETE /api/agent/session/{session}` answers `409 agent_busy` and changes nothing — no release, no
removal. The client asks *before* it closes its socket, so a refusal leaves the conversation exactly as it
was and the panel keeps working; only a delete that happened closes the socket and reopens a session.

**Why** Mid-turn, the words being written are the next entry of the file the button deletes — and the file
may not even exist yet, because the agent writes it as the turn ends: a delete now would remove nothing and
the turn would put the conversation back a second later. Releasing the session also cancels the turn,
which is a different act from forgetting a conversation and not one anybody asked for by pressing "clear
history". A client-side guard alone is not enough: the panel's idea of "busy" is its own state, and a
second tab, a reload, or a stale page would each have their own; the process's turn is the fact.

**Cost** A long answer has to finish (or be stopped) before the history can go. A refused delete is a
message in the transcript rather than a silent no-op, and the canvas-deletion path still closes its socket
either way (the directory is going away, so the process must not outlive it).

**Tested** `make check`, `go test -race`, `npm run check` (i18n 898/884), `npx vitest run` (156).
`TestDeletingABusySessionIsRefused`: a prompt the fake agent answers slowly, `DELETE` 300 ms in answers
`409 agent_busy`, the session file and the process are both untouched, and the same request after `done`
answers 200 and removes the file. In the browser (a `/tmp/verify` copy, the real agent): idle the header
read `Clear history`; one message in, it read `The agent is working — stop it or wait for it to finish` and
was `[disabled]` at +2 s and at +27 s while the answer streamed, and a direct `DELETE` against the gateway
at that moment answered `409 {"code":"agent_busy","message":"the agent is in the middle of a turn: stop it,
or wait for it to finish"}`; after `done` the button read `Clear history` again, and pressing it —
confirm, then `DELETE … 200`, release, new pid — left the file gone and the panel on its empty state.

**Where** `internal/agent/sessions.go` (`Session.Busy`, `Sessions.Busy`, `Send`, `pump`),
`internal/server/routes_agent.go`, `internal/server/agent_e2e_test.go`,
`frontend/src/services/api/agent.ts`, `frontend/src/components/canvas/canvas-agent-panel.tsx`, both
locales.

## 188. The bottom dock is gone; its commands live in the canvas menu

**Decision** The icon dock across the bottom of the canvas is deleted (`canvas-toolbar.tsx`), and its
commands became sections of the menu that opens on the canvas's name: **New** (text, image, video, group,
LoRA, upload files), **Edit** (undo, redo, center focus, delete selected), **View** (select/move tool, grid:
dots/lines/blank, image info) and, after a divider, export current canvas and clear canvas. Items that
toggle show a tick; items with a real keyboard shortcut show it. The viewport's own controls — zoom,
minimap, reset view — stay in the bottom-left dock: they are a dial, not a menu.

**Why** The dock was sixteen glyphs with no words, each one needing a tooltip to be readable, and the
thing pressed once a session (export, clear) took exactly the room of the thing pressed constantly (a new
node). It also sat in the middle of the canvas's bottom edge, which is where a node's own panel opens. A
menu is where a command that needs a name can have one, and the canvas menu already held the commands that
belong to the canvas as a whole (rename, new, delete).

**Cost** Every one of these is now two clicks instead of one, and nothing is discoverable by looking at the
canvas: a first-time user has to open the menu to find out what can be made. The commands still answer
their keyboard shortcuts (undo, redo, delete, clear's confirmation), which is what the menu shows beside
them.

**Sediment removed with it** `bottomInset` in `focusViewportForNode` and the test that measured it (the
dock was the only thing that fed it — the inset said "do not centre a panel under the dock"; with no dock
the whole height is usable), the `[data-canvas-bottom-toolbar]` lookup in `measureFocusFrame`,
`canvas-toolbar.tsx`'s `ToolbarButton`/`DockTip`/`toolLabel`/`getTipX`/`CanvasThemeButton` and its
appearance popover, the `CanvasColorTheme` export (nothing outside `canvas-theme.ts` names it any more), and
seven i18n keys the popover owned (`canvas.toolbar.appearance`, `audio`, `config`, `themeMode`, `light`,
`dark`, `gridStyle`). `Dropdown` gained a section heading and a shortcut column for this, which is the only
kit change.

**Tested** `npm run check` (i18n 894/880: seven keys gone, three added — `canvas.menu.create/edit/view`; no
dead or missing keys), `npx vitest run` (155: one test removed with `bottomInset`), `make check`. In the
browser (a `/tmp/verify` copy at 8191/3001): no dock in the page at all (only minimap/reset/zoom at the
bottom left), the menu shows the four sections in that order, **Text** created a node, **Undo** removed it
again (the saved `canvas.json` agreed both times), **Blank** wrote `backgroundMode: "blank"`, and **Clear
canvas** opened the existing confirmation.

**Where** `frontend/src/components/canvas/canvas-menu.tsx` (new),
`frontend/src/components/canvas/canvas-toolbar.tsx` (deleted),
`frontend/src/components/canvas/canvas-top-bar.tsx`, `frontend/src/components/kit/floating.tsx`,
`frontend/src/pages/canvas/project.tsx`, `frontend/src/lib/canvas/canvas-node-geometry.ts`,
`frontend/tests/canvas-focus-viewport.test.ts`, both locales.

## 189. The bridge is found beside the gateway, on PATH, or nowhere honest

**Decision** `mcpBridgePath` looks for `comfyloft-mcp` in the order the agent's own binary is found
(`agent.findBinary`): `MCP_BIN`, then beside the gateway's executable, then `PATH`, and only then the bare
name. The startup warning that the bridge is missing asks `bridgeExists`, which treats a path as a file and
a bare name as something to look up — the same way the spawn will.

**Why** A gateway started with `go run` lives in a temporary directory that holds no bridge, and the
`mcp.conf` it wrote named a path inside that directory: every agent session after the run ended failed with
`handshake: EOF`, and the path in the file explained nothing. The beside-the-binary rule is right for a
release directory and wrong for every other way of starting this thing.

**Cost** A `PATH` hit can be a different build from the gateway's own; the bridge checks the protocol
version it speaks in every call (`X-Comfyloft-Bridge`), so a mixed pair says so instead of misbehaving.

**Tested** `go test ./internal/server/ -run TestBridgePath`: a `PATH` holding a bridge is found by a test
binary that has none beside it (which is what `go run` looks like), and `MCP_BIN` still wins. The existing
MCP tests (which go through `writeMCPConf`) still pass.

**Where** `internal/server/agent_config.go`, `internal/server/agent_config_test.go`.

## 190. Preferences and Add workflows are two windows, and the Gateway tab is gone

**Decision** The settings window — one `Dialog` with three tabs, Gateway / Preferences / Add workflows —
is deleted. Two windows replace it, each opened by its own button at the right end of the top bar and
closed by the X in its own top-right corner:

- `PreferencesDialog` (`components/settings/preferences-dialog.tsx`): default image and video model,
  generation defaults, auto-center on select, system prompt. (The card skin and progress-ring skin
  pickers were in this list too; #193 removed them.)
- `AddWorkflowsDialog` (`components/settings/workflows-dialog.tsx`): the resource panel in a frame. The
  first-run `ResourceSetupGate` opens the same window with its own heading and no close button, so the
  two cannot drift apart in size or padding. The panel's summary card lost its own "Add workflows" line
  for this: the window title says it once.

`use-config-store` keeps two flags, `preferencesOpen` and `workflowsOpen`, instead of `isConfigOpen`
plus a `configTab`.

The Gateway tab went, with everything only it reached: `channel-editor-drawer.tsx`, `kit/drawer.tsx`
(its last user), `kit/nav.tsx`'s `Tabs`, `withChannels` / `pickDefaultModel` / `saveChannel`,
`normalizeModelOptionValue`, `config.title` / `modalDescription` / `saved` / `savedContinue` /
`tabs.*`, the display half of `config.channels.*`, all of `config.channelEditor.*`,
`config.preferences.defaultTextModel` / `defaultAudioModel` (the model list was already filtered to
image and video, so those two branches could never render), `topNav.settings` and `common.done` —
28 keys, with `config.preferences.title` / `description` and `topNav.preferences` /
`topNav.addWorkflows` added.

**Why** The tab edited three things and none of them was a setting: the channel's name (nothing on
screen names a channel outside a model label's fallback), its address (it comes from the page and is
rewritten by `use-local-gateway-sync` on every scan, #71), and a model's media kind (an override the
same sync then preserved, whose only author was that editor — the sync now takes the gateway's `type`,
which is the side that knows what a graph does). A form whose fields are re-derived behind it is a form
that lies. Splitting the window is the other half: "Preferences" and "Add workflows" are answers to
different questions, and one gear labelled "Settings" described neither.

**Why the Done button went with it** A preference is written when it changes (#155, #166), so the
gateway already had the value before the button could be pressed — "Done" saved nothing. The toast it
raised ("Settings saved. Continue with your previous request.") promised a continuation that no call
site performed: all twenty blocked-generation call sites did `openConfigDialog(true)` and returned, and
Continue was then a click the user made anyway. They now call `openPreferences()`, and
`shouldPromptContinue` / `clearPromptContinue` are gone with the flag.

**Cost** Re-tagging a workflow whose registry `type` is not what you want is now an edit to
`workflows/registry.json`; there is no UI for it. The preferences window has no "saved" feedback,
because a window that saves as you type has nothing left to announce.

**Tested** `npm run check` (i18n 870 zh / 856 en: 28 keys gone, 4 added, no dead or missing keys;
exports 170 modules), `npx vitest run` (155 — `tests/overlay-z-index.test.ts` lost its `drawer.tsx`
half), `make check`. In the browser, on a `/tmp/verify` copy (8191/3001): the top bar shows
"Preferences" and "Add workflows" where the gear was, each opens its own 1000×646 window with the X in
its own top-right corner and leaves the other shut; `/config` still opens the preferences window and
returns to the canvas; toggling "Auto-center on select" reached `data/settings.json` with no button
pressed (`autoFocusOnSelect: true` through `GET /api/settings`); the first-run gate — forced open in the
throwaway copy, since every pack here is installed — renders its own "Prepare resources" heading over
the same frame, no close button, and the skip footer with the new hint.

**Where** `frontend/src/components/settings/preferences-dialog.tsx` (new),
`frontend/src/components/settings/workflows-dialog.tsx` (new),
`frontend/src/components/settings/app-config-modal.tsx` (deleted),
`frontend/src/components/settings/channel-editor-drawer.tsx` (deleted),
`frontend/src/components/kit/drawer.tsx` (deleted), `frontend/src/components/kit/nav.tsx`,
`frontend/src/components/settings/resource-center-panel.tsx`,
`frontend/src/components/settings/resource-setup-gate.tsx`,
`frontend/src/components/layout/user-status-actions.tsx`, `frontend/src/layouts/user-layout.tsx`,
`frontend/src/stores/use-config-store.ts`, `frontend/src/hooks/use-local-gateway-sync.ts`,
`frontend/src/pages/panel-entries.tsx`, `frontend/src/i18n/locales/*`, `frontend/scripts/check-*.cjs`,
`frontend/tests/overlay-z-index.test.ts`, `docs/server.md`.

## 191. The left column: one width, three stacked boxes

**Amended by #195** The middle box holds two lists now — the canvases in the workspace and the nodes in this
one — behind a switch at its top, and the height it opens to is `CANVAS_COLUMN_HEIGHT`, the same three
numbers this entry declares. The widths, the gutters and the one-client-of-the-number rule are unchanged.

**Decision** The bar at the top left, the side panel and the zoom dock are one column — same width, same
left edge, same radius, same shadow — and they are *stacked*: the bar on top, the panel under it, the dock
at its foot. The panel's bottom edge *is* the dock's height plus the two gaps (`CANVAS_ABOVE_DOCK_BOTTOM`),
so opening the panel shortens the panel and moves nothing else. The canvas name sits at the right end of the
bar (`ml-auto`), so the column has one left edge *and* one right edge. It answers a hover by dimming, with
no box and no underline: a 10% white pill on a translucent bar reads as a border, and the name is the bar's
title before it is a button. The divider that used to stand in front of the name is
gone with the move: it separated the name from the icons it sat against, and at the far end there is nothing
to separate.

The width is the panel's `width` in `use-canvas-side-panel-store` (280 to start, 220–480), so the drag
handle on its right edge resizes the whole column. `useCanvasChromeWidth()` hands it over as a CSS length,
`min(<width>px, calc(100vw - 300px))`: the same clamp for all three, so a window too narrow for the column
and the bar on the right shrinks them together instead of squeezing one. The drag starts from the width on
screen rather than the stored one, so the clamp cannot leave a dead zone under the cursor.

`CANVAS_CHROME_GUTTER` (12), `CANVAS_CHROME_GAP` (8), `CANVAS_ZOOM_DOCK_HEIGHT` (56) and
`CANVAS_TOP_BAR_ROW` (64) live in the same module as that hook, because the panel's bottom is the dock's
height plus two gaps: a panel that guessed would overlap the dock or leave a hole that moves with the
window.

The minimap hangs off the compass button that opens it: the same left edge, the column's width, and its
bottom on `CANVAS_ABOVE_DOCK_BOTTOM`, so it appears directly above the dock the way a menu appears above its
trigger. It used to be pushed out of the panel's way and sized 240×160, which left it floating in the middle
of the board at a width of its own — a third version of this entry, from the same two screenshots. Its box is
a clamped CSS length, so the map is drawn from the box it *measured* (`ResizeObserver`), not from a constant:
the only thing that knows what a `min()` came out as is the element.

`useSidePanelInset` — the step-over rule — is gone with it: nothing on the board sits beside the panel any
more.

**Why** Three boxes on one edge at three widths read as three unrelated panels. And the first version of
this got the stacking wrong: it kept the old rule that pushes the dock out of the panel's way (`left =
width + gap`), which on a 740px-wide window left the bottom-left corner empty and put a full-width dock in
the middle of the board. That is a staircase, not a column — the screenshot that came back showed it, and
this entry is the second version.

**Cost** The bar at the top, the dock and the minimap now take the panel's width, so a wide panel makes them
wide: at 480 the bar has slack and the dock's slider stretches, and the minimap is a wide letterbox rather
than a map-sized square. Below `100vw - 300px` the column stops shrinking the way it was dragged: the boxes
stay equal, but they are narrower than the stored number until the window grows or the panel is dragged in.

**Tested** `npm run check`, `npx vitest run` (155), `make check`. In the browser (`/tmp/verify`, 8191/3001),
measured with `getBoundingClientRect`, three window sizes: 573px viewport with 348 stored — bar, panel and
dock all 12 → 285 (273 wide, clamped), right bar 297 → 561 inside the window; 709px viewport with 480
stored — all three 12 → 421 (409 wide, clamped), right bar intact; a 740px viewport at 348 — all three
12 → 360 (348, unclamped), the panel ending at 574 with the dock at 582 → 638, so one 8px gap, and the dock
sitting in the bottom-left corner. The minimap measured 12 → 360 at 348 (348×160), its bottom on the panel's
(534) and 8px above the dock, and a click at its centre moved the viewport rect (120,80) → (118,30), so the
hit-testing follows the measured box. Dark and light, panel open and shut, minimap open with the panel open
and shut.

**Where** `frontend/src/stores/canvas/use-canvas-side-panel-store.ts`,
`frontend/src/components/canvas/canvas-side-panel.tsx`,
`frontend/src/components/canvas/canvas-top-bar.tsx`,
`frontend/src/components/canvas/canvas-zoom-controls.tsx`,
`frontend/src/components/canvas/canvas-mini-map.tsx`,
`frontend/src/components/canvas/canvas-refresh-shell.tsx`.

## 192. Canvas content goes under the chrome, and only popovers go over it

**Decision** The board has one layering order, and it is about what a thing *is*, not what it is attached
to:

| z | what |
| --- | --- |
| 0 | the stage (nodes, node-internal chrome: its own `z` values are local to the transformed layer) |
| 40 | the selection lasso |
| 45 | the node hover toolbar and the selection's group/sync bar |
| 50 | the top bar, the zoom dock |
| 58 | a generating node's charge ring |
| 60 | the side panel |
| 70 | the minimap — a popover on the dock button, and the one thing above the panel |
| 80–120 | context menus, create menus, the hover preview, the mention list |
| 1200 | a node's image / video / audio settings popover — a canvas layer, the last one below the frame |
| 1300–1301 | dialogs (`kit/dialog.tsx`): overlay, then frame |
| 1400–1401 | confirmations (`kit/confirm.tsx`) |
| 1500 | everything portalled *out* of a popup: select lists, menus, tooltips, the brush ring |
| 3000 | the gateway reconnect banner |

The rule that makes the table usable: **a layer the user opens from another layer has to outrank it.** A
list portalled to `body` is a sibling of the dialog that opened it, not a child, so it cannot inherit the
dialog's number — which is why 1500 is one number shared by every portalled popup instead of a choice per
call site (#194). The 1200 row is the exception that proves it: those three popovers are opened from a node
panel and never from a dialog, and a sweep of every `<Dialog` in the tree found no portal below 1300 inside
one — the prompt editor's dialog is a textarea and a reference bar.

The two node toolbars were at 70 and the lasso at 65, so a node slid under the side panel while its white
toolbar stayed on top of it: a tool floating in the middle of the panel, attached to nothing.

**Why** A node's toolbar is part of the node — it is the node's own affordances, drawn one gap above it. The
panel is a board laid *over* the canvas, so anything that belongs to the canvas is under it, and a toolbar
that outranks it is the layering telling the user something untrue. The same rule puts the toolbars under the
top bar and the dock: chrome is the frame, and the frame wins.

**Why the minimap is the exception** It is not part of the canvas and not part of the column either — it is a
popover opened by the compass button, and it sits exactly where the panel is when the panel is open. Under
the panel it would look like a button that does nothing.

**Cost** A node parked under the panel loses its toolbar with it: to use the toolbar you bring the node back
into view. Nothing else changes hands.

**Tested** In the browser (`/tmp/verify`, 8191/3001), a text node created at the panel's edge and left
selected: `getComputedStyle` says panel 60, toolbar 45, and at a point inside both `elementFromPoint` returns
the panel, while a point on the toolbar's free half still returns the toolbar. The selection bar and the
lasso share that parent and those two numbers.

**Where** `frontend/src/components/canvas/canvas-node-hover-toolbar.tsx`,
`frontend/src/components/canvas/canvas-selection-toolbar.tsx`.

## 193. The card skins, the progress-ring skins and the unlock flow are gone

**Decision** The canvas has one card look and one charge light. Four things left whole:

- **Card skins.** Six palettes — `warm`, `cream`, `mist`, `forest`, `angel`, `fish` — each overriding a dozen
  `canvasThemes[].node` colours per light/dark, two of which also replaced the card fill with a gradient and
  painted character art inside the card; a second table did the same to the toolbar palette; a `Map` cached
  the theme × skin pair. All of it went, with `getCanvasTheme()`'s second argument, `getCardBackground()`,
  `useEffectiveCardSkin()`, the `data-card-skin` attribute and `globals.css`'s
  `[data-card-skin="cream"] button:disabled` rule. `theme.node.fill` is the card background again, and
  `use-canvas-theme.ts` is a hook, not a palette resolver: `canvasThemes[theme]`.
- **The character animation.** The two art skins carried a rig beside and inside the card — a lantern jellyfish
  with an "AT field" halo, an angel with falling feathers — plus *Character animation while generating* and its
  left/right toggle, reachable only while one of those two skins was selected. Deleted with the skins:
  `fish-guard-*` and `angel-*` in `globals.css` (about 380 lines of keyframes and rules), `public/skins/` (four
  images, 2.3 MB), `theme.fishWhipEnabled` / `theme.fishWhipSide` and the art-skin branches in `canvas-node.tsx`
  (a backdrop, the inline artwork, the blessing, the halo, the two mascot rigs).
- **Progress-ring skins.** Seven palettes × two themes, each with its own stroke widths, blur radii, tail length
  and breathing period, and one of them — `tide` — a second rendering path that filled the card with rising
  water. The ring stays, with the palette and the numbers it shipped with (`cyan`, `balancedStyle`): the glow is
  the run's progress, not a preference. `lib/canvas/progress-ring-skins.ts` and `config.progressRingSkin` are
  gone; `tide` went with the other six.
- **The unlock flow.** A PBKDF2-SHA256 verifier in the client bundle gated exactly one skin; unlocking posted to
  `POST /api/skin-unlocks`, which `store.Skins` persisted to `data/skin-unlocks.json`, and
  `useSkinUnlockPersistence` merged the server's list into the store and pushed back every local unlock the
  server did not have. Both routes, the store, its two tests, the hook, the service and the password dialog are
  gone. `theme` in `use-theme-store` is now one field.

45 i18n keys per locale went with them (870/856 → 825/811). `lib/design-tokens.ts` went too: its last reader was
the progress-ring preview grid, so the `stone` table had no importer left and the two comments that pointed at it
now point at Tailwind's `stone` scale.

**Why** Every one of those mechanisms changed a colour or a timing constant on the same renderer, and the "skins"
differed by appearance alone — seven rings that all meant "charging", six cards that all meant "a card". They cost
a cache keyed by theme × skin, two override tables to keep in step with the base palette, a stylesheet section
larger than the rest of the canvas chrome, 2.3 MB of art, an HTTP route and a file on disk, for a choice the
canvas does not need. The unlock flow is the loudest case: the verifier shipped in the bundle it gated, so the
password protected nothing — its only real effect was that `fish` could not be selected until a record existed.

**Why the character animation did not survive on its own** It was good to watch, but its only door was the
card-skin picker: the switch appeared under the `fish`/`angel` entry. With the skins gone it could not be turned
on and nothing would trigger it, which is dead code with a name. If it comes back it should come back as its own
setting with its own door, not as a property of a palette.

**Cost** The only appearance choice left is light/dark. Bringing any of the six looks back means writing the
tables again rather than flipping a flag, which is the point. A workspace whose saved settings still name a
`cardSkin`, `fishWhipSide` or `progressRingSkin` keeps those keys until the next save — nothing reads them, and
no migration was written for them (the same no-backward-compatibility rule as #190).

**Tested** `npm run check` (i18n 825/811, no dead keys, export check clean), `npx vitest run` (21 files, 155
tests), `make check`, `CGO_ENABLED=1 go test -race ./cmd/... ./internal/...`, `make verify-static`, and
`npm run build`. A grep of the tree for `skin`, `cardSkin`, `progressRingSkin` and `fishWhip` over Go, TS, TSX,
CSS and the check scripts returns nothing. `TestSkinsUnlockAndValidate` and `TestSkinsReadLegacyStringEntries`
went with the store; `internal/server`'s settings round-trip test lost the `cardSkin` key it happened to carry.
Not exercised in a browser: the two surviving paths are the ones the default settings already used — `warm` had
an empty override table and `cyan` was the default ring — so what the default workspace rendered is what it
renders now.

**Where** `frontend/src/components/canvas/canvas-node.tsx`,
`frontend/src/components/canvas/canvas-node-progress-ring.tsx`,
`frontend/src/components/settings/preferences-dialog.tsx`, `frontend/src/lib/canvas-theme.ts`,
`frontend/src/lib/canvas/use-canvas-theme.ts`, `frontend/src/stores/use-theme-store.ts`,
`frontend/src/stores/use-config-store.ts`, `frontend/src/styles/globals.css`, `frontend/src/i18n/locales/*`,
`frontend/src/components/layout/client-root-init.tsx`, `internal/store/preferences.go`,
`internal/server/routes_admin.go`, `internal/server/server.go`.

## 194. A dropdown's list outranks the dialog that opened it

**Decision** The listbox in `kit/select-primitive` sets `z-[1500]`, and no caller passes a layer of its own any
more: `model-picker` (both pickers), `kit/select` and `agent-settings-controls` lost theirs. 1500 is the app's one
floating-layer number — above dialogs (overlay 1300, frame 1301), above the canvas panel (60) and its menus
(80–120), shared with tooltips and `kit/floating` menus.

**Why** The list is portalled to `body`, so it is a *sibling* of the dialog that opened it, not a child. The two
default-model pickers in the Preferences window passed `z-[1200]`, and `cn` is tailwind-merge, so that number
replaced the primitive's: with the overlay at 1300 and the frame at 1301, opening a picker drew its options
behind the window, under a 45%-black scrim. The trigger flipped to open, nothing was visible or clickable, and
the report was "the default image and video models cannot be chosen". Every other select in the app was fine
because `kit/select` carried 1500 itself — which is exactly why only those two were broken, and why the number
belongs to the primitive: a caller cannot know what layer it will be opened from, and this one went stale the
moment the dialog's own numbers moved to 1300/1301.

**Cost** A dropdown opened from a dialog now paints over a confirm dialog (1400/1401) if one opens while it is
open. Nothing opens a confirm from inside an open listbox — selecting an option closes it.

**Tested** In the browser (`/tmp/verify`, 8191/3001, its own data directory): `bsk` opened Preferences, clicked the
default image model, saw the list render its six options, and choosing "MOSS Balanced fast 8-step" changed the
trigger from "Z-Image Turbo" to that label — the list is above the dialog and takes the click. The video picker's
list opened with the four H3 workflows. `tailwind-merge` resolves both callers' class lists to `z-[1500]`
(checked directly), the built bundle contains no `z-[1200]`, and `tsc --noEmit`, `npm run check`, the 155 tests
and `npm run build` all pass.

**Where** `frontend/src/components/kit/select-primitive.tsx`, `frontend/src/components/kit/select.tsx`,
`frontend/src/components/model-picker.tsx`, `frontend/src/components/canvas/agent-settings-controls.tsx`.

## 195. The left column has two lists, and the panel opens downward

**Decision** The canvases in the workspace and the nodes in this one are two sections of the left column
(`CanvasSidePanel`), one at a time, behind a switch at the top of the box. The 1000×760 window that held the
canvas list (`canvas-manager-dialog.tsx`), its tall card (`canvas-project-card.tsx`) and its one-boolean store
(`use-canvas-panel-store.ts`) are gone; the column is where a list lives now.

- **One column, one surface.** The top bar's grid button opens the column on `canvases`
  (`openSection`), the panel button opens and shuts it, and the switch inside moves between the two lists. The
  section is stored (`canvas-side-panel-section`) beside the width and the open flag, so the column comes back
  the way it was left.
- **Both lists stay mounted**, the inactive one `hidden`. Switching back finds its search box, its filter and
  its selection where they were — cheaper and more honest than lifting seven pieces of list state into a store.
- **A row, not a card.** The list is 220–480px wide: a title, the updated time, a tick for the canvas you are
  in, and a `⋯` menu with export / rename / delete. The card's three icon buttons became named menu items for
  the reason the bottom dock became a menu (#188) — at this width, three 12px glyphs was all that fitted.
- **Delete all became select-all.** The canvases list now has the bar the elements list has: select-all, a
  count, one action. One button that deletes the whole workspace, in a 280px column, is a trap; the same place
  is still reached through the same confirmation.
- **It opens by height, from its top edge.** `height: 0 → calc(100dvh - 140px)` on the box, with the content
  inside pinned to that full height (`CANVAS_COLUMN_HEIGHT`) so the reveal clips it instead of squashing it.
  This replaces #98's sideways `translateX` slide, by request. `transform` and `scaleY` are both wrong here,
  for different reasons: a translate keeps the list's own top edge still and moves the box *through* it, and a
  scale squashes every row on the way down. `height` also costs nothing outside the box — the panel floats over
  the canvas (#98), so the board does not reflow.
- **Nothing paints while it is shut.** At `height: 0` the box's own border and shadow still drew a two-pixel
  line across the canvas at the top of the column — measured in the browser, 1.6px of it. `overflow: hidden`
  cannot clip a border, so the box leaves with `visibility: hidden` on a transition *delayed by the animation's
  own duration*; on the way in the delay is zero, or there would be nothing to grow. `inert` covers the
  collapsing frames, when the content is still focusable.
- **The element list's search reads the words a node holds.** It searched `title`, `content` and `prompt`, which
  was wrong in both directions: it could not find the text in the prompt box the panel shows (`composerContent`,
  where a node that holds a result keeps its words) while it *did* search `content`, which for a picture is a
  file name — so "png" matched every image on the canvas. `nodeWords()` sits next to `holdsResult()` in
  `lib/canvas/node-prompt-field.ts`, which is the module that already knows which field a node's prompt is in. A
  search that finds nothing now says so: it used to say "no nodes on this canvas", which reads as if the list had
  lost its contents.

**Why** The window was the last surface that had to be summoned and dismissed, and it was the only list that
lived outside the column that exists for lists. The two questions it answered are not the same question: "which
canvas am I in" is a place, "which node is this" is a thing, and merging them into one *surface* with two
sections keeps both answers one click away without giving either half a column — at 220px, stacked, the elements
list would lose the room its hover preview needs.

Replacing the elements list instead — the first shape of this request — was the one thing not to do. That list is
the only name-based navigation on a board bigger than the window, the only multi-select export, and its hover
preview is how you tell four similar pictures apart before jumping to one. Keeping the preview was the
requirement; the column is what both lists needed.

**Cost** The canvas list lost its 1000px frame: titles truncate where they used to wrap, and deleting everything
is two clicks instead of one. `height` is a layout animation — the rows relayout on each frame for 240ms — which
is the price of a reveal that does not distort anything; it is confined to this box because the panel floats.
And the section is a stored preference: a second browser opening the same workspace starts on Elements.

**Amended by #198** Picking a canvas used to switch the column to Elements, on the theory that the question
"which canvas?" had just been answered. It does not: the board behind changes, and watching it change is how
you check you picked the right one — the first version hid exactly that.

**Tested** `npm run check` (i18n 824/810, no dead or missing keys — `canvas.sidePanel.elements`,
`canvas.deleteAll`, `canvas.project.saveName` and `canvas.project.cancelRename` went with the card, and
`canvas.sidePanel.tab.*`, `canvas.sidePanel.noMatch` and `canvas.project.more` are new), `npx vitest run` (155),
`npm run build`, `make check`. In the browser (`/tmp/verify`, 8191/3001, its own data directory, a copy of the
workspace's one canvas):

- The animation, measured frame by frame with `getBoundingClientRect`: opening, `top` 64 on every frame and
  `bottom` 66 → 1402, `height` 2 → 1338 = `100dvh - 140`; closing, `top` 64 and `bottom` 1402 → 66, finished in
  200ms of a 240ms transition. Settled shut: `height` 1.6 (two 0.8px borders) and `visibility: hidden`, so
  nothing paints.
- The switch: both tabs render, clicking Canvases shows New / Import / Select and the row "Canvas 1 — Updated
  11/03, 03:25 AM" with its "More actions" menu (Export / Rename / Delete items). The section and the open flag
  were written to `data/settings.json` (`canvas-side-panel-section: "canvases"`), and the top bar's grid button
  re-opened the column on that list.
- Select mode: the header's Select became Cancel, the row grew a "Select Canvas 1" tick, and the bar showed
  "Select all", "0 selected" with Delete disabled — "1 selected" with Delete enabled after ticking it.
- The search: `zzz` now says "No nodes match" (it said "No nodes on this canvas"), and `森林` brings the four
  rows back. Hovering a row put the preview overlay at `opacity: 1` with that node's image, which is the
  behaviour the whole column had to keep.

**Where** `frontend/src/components/canvas/canvas-side-panel.tsx`,
`frontend/src/components/canvas/canvas-side-panel-canvases.tsx` (new),
`frontend/src/components/canvas/canvas-side-panel-elements.tsx` (the old `CanvasNodesTab`),
`frontend/src/components/canvas/canvas-side-panel-parts.tsx` (new),
`frontend/src/components/canvas/canvas-manager-dialog.tsx` (deleted),
`frontend/src/components/canvas/canvas-project-card.tsx` (deleted),
`frontend/src/stores/canvas/use-canvas-panel-store.ts` (deleted),
`frontend/src/stores/canvas/use-canvas-side-panel-store.ts`,
`frontend/src/components/canvas/canvas-top-bar.tsx`, `frontend/src/pages/canvas/project.tsx`,
`frontend/src/lib/canvas/node-prompt-field.ts`, both locales, `frontend/scripts/check-i18n.cjs`.

## 196. The canvas menu holds this canvas's commands

**Decision** The menu on the canvas's name is about the canvas on screen and nothing else: the four sections it
already had (New, Edit, View, then export current canvas and clear canvas), and no workspace commands. Its list
of every canvas is gone, and so are **Rename**, **New canvas** and **Delete current canvas**. Switching happens
by clicking a row in the left column; renaming and creating and deleting are the `⋯` menu on a row of that list,
which is also where the count and the selection are (`canvas-side-panel-canvases.tsx`, #195).

Two consequences moved with them:

- **Deleting the canvas you are standing on** was the one workspace command with consequences the list could not
  see: it forgot the canvas as "the last one opened" and told the gateway to drop its agent conversation. That
  handling now lives in `canvas-delete-projects-dialog.tsx`, which is the only thing that deletes canvases and
  already had half of it. Deleting the current canvas still navigates away — to `/canvas`, which the router
  resolves to whatever the root route would open next.
- **The title stopped being an editor.** The top bar's inline rename (a draft, an `autoFocus` input, a
  pointerdown-outside listener) is gone; renaming is the row's input, which already existed and already saves
  through `renameCanvas`.

**Why** A menu labelled with one canvas's name that then offers to rename it, replace it or leave it is a menu
whose scope you have to read item by item. The name identifies a canvas; the list of canvases is a different
place, and since #195 it is a place rather than a popup — the one surface in the app meant for "which canvas?".
This is the same split as the column's two sections: the workspace's commands live with the workspace's list, the
canvas's commands live on the canvas. It also removes a second implementation of rename, which is the one that
had drifted (the bar's editor had no failure path and saved on blur; the row's has Enter/Escape).

**Cost** Reaching the canvas list from a shut column is two clicks through the column's switch instead of one
through a top-bar button (that button is gone too, #197). Renaming a canvas now requires opening the column, and
deleting one is two gestures (row menu → Delete, or select → Delete).

**Tested** In the browser (`/tmp/verify`, 8191/3011, its own data directory): the menu opened from the title
holds exactly the four sections and 18 items — Text, Image, Video, Group, LoRA card, Upload files, Undo, Redo,
Center focus, Delete selected, Select, Move, Dots, Lines, Blank, Image info, Export current canvas, Clear canvas
— with no canvas names, no Rename, no New canvas and no Delete. The title is no longer an input: clicking it opens
that menu. `npm run check` (i18n 823/809; `canvas.switchProject`, `canvas.deleteCurrent`,
`canvas.deleteCurrentTitle`, `canvas.deleteCurrentDescription` and `canvas.projects` are gone,
`canvas.menu.title` is new), `npx vitest run`, `npm run build`.

**Where** `frontend/src/components/canvas/canvas-top-bar.tsx`, `frontend/src/pages/canvas/project.tsx`,
`frontend/src/components/canvas/canvas-delete-projects-dialog.tsx`, both locales.

## 197. One button opens the column, and its icon is the geometry

**Decision** The top bar's left column has one button. The grid button beside the panel toggle — "My Canvases",
which opened the column on its canvas list — is deleted, and so is the store's `openSection`, which existed only
for it. The toggle opens the column on whichever list it was left on, and the switch inside picks the other.

The icon changed with it, from `PanelLeftClose`/`PanelLeftOpen` to `PanelTopClose`/`PanelTopOpen`. The old pair
draws an arrow pointing left, which described the sideways slide the panel stopped doing in #195: its top edge is
the hinge, so it folds *up* into the bar and unfolds *down* from it, and the icon should say so.

**Why** Two buttons that open the same box on two different tabs is one control too many, and the wrong half of
the pair wins depending on which mode you are in — with the column shut, both of them open it, so which one you
press decides which list you get. The section is remembered, so the one button is enough: the list you use is the
list you get back.

**Cost** The canvas list is one click further when the column is shut on the elements section. This is the same
cost #196 records, and it is the price of one column with one way in.

**Tested** In the browser: the top bar's left bar holds the panel toggle and the title, nothing between them; the
toggle's SVG class is `lucide-panel-top-close` open and `lucide-panel-top-open` shut, with the tooltips "Collapse
panel" / "Expand panel". `npm run check` (i18n: `canvas.projects` removed, no dead keys), `npx vitest run`,
`npm run build`.

**Where** `frontend/src/components/canvas/canvas-top-bar.tsx`,
`frontend/src/stores/canvas/use-canvas-side-panel-store.ts`, both locales.

## 198. The canvas list does not move under the pointer

**Decision** The rows of the canvases list are ordered by when each canvas was **created**, newest first, and
picking one changes only which row is highlighted. The comparator is `byCreatedAtDesc`, which replaces
`byUpdatedAtDesc` (the same instant-vs-text parse, reading `createdAt` instead).

**Why** The list sorts itself by `updatedAt` from the gateway, and every edit — including the autosave of the
canvas you are looking at — bumps that, so the row under the cursor kept jumping to the top: you go to click the
second canvas in the list and it is now the first. A list that reorders itself while you use it is a list you can
misclick, and "recently worked on" is a property of *your* session, not of the canvas — the ordering hint the rows
already carry is the updated time printed under the title, which is enough.

**Cost** A canvas you just edited does not move to the top, so "the one I was working on" is found by reading the
times rather than by looking at the first row. Creating a canvas still inserts at the top, because creation is an
explicit act and the new canvas is where you are taken.

**Tested** `tests/last-canvas.test.ts` gained "the last write does not move a canvas", which sorts two canvases
whose `updatedAt` contradicts their `createdAt` (156 tests). In the browser: with two canvases, clicking the
second row changed the route and the highlighted row and left the row order `[Canvas 2, Canvas 1]` exactly as it
was.

**Where** `frontend/src/lib/canvas/last-canvas.ts`,
`frontend/src/components/canvas/canvas-side-panel-canvases.tsx`, `frontend/tests/last-canvas.test.ts`.

## 199. The list's header row has a height of its own

**Decision** Both lists in the column draw their header through one component, `PanelHeaderRow` — 32px of fixed
height, contents centred inside it — instead of a `div` whose height came from whatever was in it.

**Why** The row's contents change while it is being used, and they are not the same height as each other: the
type filter's "All" box is `h-7` (28px), the ghost buttons beside it are 24, the count is 16, and pressing
**Select** takes the "All" box away. So the row was 28px with the box and 24px without it, and everything below
it — the search box, every row — moved four pixels down and up again with each press. That is the flinch the
report described. It is also why the two sections' rows are now the same: the canvases list's row was built from
28px icon buttons, so switching tabs moved the list by the difference.

Keeping the "All" box mounted and hiding it was the other way to stop the movement, and it is worse: it leaves an
80px hole in a row that select mode needs for nothing, and it fixes only that one control, not the count, not the
next thing added, and not the difference between the two sections.

**Cost** The row is 32px where it used to be 24–28, so the list starts four pixels lower. A future control taller
than the row would overflow it rather than stretch it — the row is the fixed thing, and the fix for that is to
raise the number in one place, which is also the point.

**Tested** In the browser (`/tmp/verify`, 8191/3011, its own data directory), measured with `getBoundingClientRect`:
the elements list's visible header row is 32px and its search box sits at y=154 in all three states — before
pressing Select, in select mode with the "All" box gone, and after cancelling — and the canvases list's header is
also 32px at y=111, so switching tabs no longer moves the list either. The "All" box itself measures 28px, which
is the four-pixel difference the report was seeing. `npm run check`, `npx vitest run` (156), `npm run build`.

**Where** `frontend/src/components/canvas/canvas-side-panel-parts.tsx`,
`frontend/src/components/canvas/canvas-side-panel-elements.tsx`,
`frontend/src/components/canvas/canvas-side-panel-canvases.tsx`.

## 200. A rename has a button that finishes it

**Decision** The row that turns into a field in the canvases list carries a tick and a cross beside the input.
The tick commits, the cross throws the edit away, and Enter and Escape still do exactly what they did — the
tick and the cross are the same two actions, drawn. An empty field disables the tick.

**Why** Enter was the only way to finish a rename, and nothing on screen said so. The menu says **Rename**, the
row becomes a field, and then the one way out of it is a key on a keyboard the user is not looking at. A
control that can only be finished by a shortcut is a control most people will abandon, having already typed
the new name.

**Why a cross as well** Because Escape was the other invisible key. Without it, a user who cleared the field —
the state the tick refuses — has no visible way to say "never mind" and only the escape hatch they were never
told about, so the row would sit there as a field forever.

**Why an empty field is refused rather than taken as a cancel** `renameCanvas` already trims and returns on
nothing, so committing it would close the editor having changed nothing, which reads as "it worked" while the
canvas still has the old name. The tick is disabled in that state and Enter does nothing either, so the two
agree; the name is one cross away, and a name is not something to lose to a stray select-all.

**Why the row's height is pinned in the same change** The editor is a 32px input where the display row is a
title and a date, so entering rename made the row 8px shorter and pulled the rows under it up with it — the
same flinch #199 removed from the header row, one row lower down. `h-13` (52px) is the height the row already
had in every other mode it can be in, now stated instead of inferred.

**Cost** 52px is a number in the markup, and a row asked to hold more than that would overflow rather than
grow — the fix is the number, in one place, which is the point. Two more tab stops in a rename, and a green
the rows do not otherwise use, borrowed from `Text`'s success tone so it is not a new one.

**Tested** In the browser (`/tmp/verify`, 8191/3011, its own data directory), both themes. Renaming **Beta**
through the tick and reading `GET /api/canvases` → the canvas answers `Gamma`, so the click really saves;
typing "Discard me" and clicking the cross leaves `Gamma` and writes nothing; clearing the field reports
`button "Confirm rename" [disabled]`; Enter from the field still commits (`Gamma two`) and Escape still leaves.
The list holds still: the current row measured 65 device pixels at ratio 1.25 — 52 CSS px — both before the
editor opened and while another row was in it (it was 44px, 55 device pixels, with the editor open before this
change). `npm run check` (zh 825 / en 811 keys), `npx vitest run` (156), `npm run build`.

**Where** `frontend/src/components/canvas/canvas-side-panel-canvases.tsx`,
`frontend/src/i18n/locales/zh-CN.ts`, `frontend/src/i18n/locales/en-US.ts`.

## 201. The agent's models are edited through the agent, and the key stays on the gateway

**Decision** The preferences window grows an **Agent models** section: the list AlayaCore announces, one row per
model (name, protocol, what it points at, and its key as six dots), a pencil and a cross on each row, and one
**Add model** button that opens a small form — name, model id, URL, protocol (`openai` / `anthropic`), API key.
Every change, add, edit or delete, is sent to the agent as its own `:model_sync` with the whole list. The gateway
completes that list before the agent sees it: a model it already knows is rebuilt from the entry the agent
announced, and only the fields the canvas can see are replaced. A `SM model_list` the agent restates after the
write is forwarded as a `models` event, and so is the same list to every other live session.

**Why through the agent** Because `model.conf` is AlayaCore's file, and #75 recorded the rule: the format
(`protocol_type`, `reasoning_0/1/2`, `serial_tool_calls`, …) belongs to the agent, so the editor writes through
the command plane rather than parsing and re-emitting the file from Go. The gateway therefore knows the
*protocol's* JSON and nothing about the file's key-value syntax.

**Why the gateway completes the list, and why that is not a detail** `:model_sync` replaces *every* model and
rewrites the file from what it was given. The list a canvas is shown is `agent.Model`: id, name, protocol, base
URL, model id, context limit and `hasKey` — no `api_key`, because `SM model_list` carries every key from
`model.conf` in cleartext and the gateway strips them (#75, "the event surface is a whitelist"). Forwarded
as-is, removing one model would delete every key on the machine, and every `reasoning_N` block and token cap
beside them. So the gateway keeps each announced entry **whole** (`modelObject`, the raw JSON), the canvas says
which ids stay and what changed, and `Session.mergeModelSync` rebuilds the rest. Whole is the point: a field
AlayaCore adds tomorrow survives a round trip through a page that has never heard of it. Ids are rewritten to
the models' positions, which is what `:model_sync` assigns them — the ids the canvas's `model_set` will have to
use once the file is written. An empty key field means "keep the stored one": the page cannot see the key, so
it is in no position to mean it away, while a key that is typed is how one is rotated.

**Why the other sessions are told** `model.conf` is one file for the whole host, and every agent process reads
it into its own memory at startup. A list written through the preferences window would otherwise leave the
canvas panel's picker offering a model that no longer exists and missing the one that was just added, until
that process was replaced. The gateway is the only layer that knows there is one file behind several processes,
so `Sessions.ModelSync` hands the list it is about to write to every other session (`tellModels`). Their `active`
model is their own and is left alone.

**Why the write is atomic** It is AlayaCore's, on purpose: `modelManager.writeConfigFile` goes through
`internal/atomicfile`, which writes a sibling temp file, fsyncs it and renames it over the target — so a reader
sees the old list or the new one, never half of either, and an interrupted write cannot leave the only copy of a
key truncated. The gateway never writes that file. The one config file it does write, `mcp.conf`, is installed
the same way (`agent_config.go`: temp file in the same directory, then a rename).

**Why the log redactor learned a second spelling** Because this is the first change that puts a *complete*
model list — keys included, since the gateway has just put them back — into a frame the gateway itself writes.
`redactKeys` matched `"api_key":"…"`, the spelling of a field in a frame; `:model_sync`'s argument is the list
as a JSON **string**, so its keys are escaped (`\"api_key\":\"…\"`) and went into the transcript in cleartext.
Found by pointing the transcript at a canary key and grepping it, which is now what
`TestRedactKeysReachesInsideAnArgument` does in miniature. The frontend was never involved: that frame goes the
other way, towards AlayaCore.

**Why a dialog rather than five inputs under the list** The first shape put them inline, and the verdict was
immediate and correct: a model is a small document, and five labelled fields wrapped into a row of inputs nobody
read. The list stays a list; the form appears when there is a form to fill.

**Cost** A session per open preferences window — the list is the agent's, so it has to be asked — and the list is
as fresh as that session's start: a `model.conf` edited outside the app is invisible until the window is
reopened. A rejection on the agent's side (an entry it will not accept) leaves the other sessions holding a list
slightly ahead of the file until their next start; the rejection itself is shown in the agent's own words under
the list. Six dots say a key exists, never that it is the right one.

**Tested** Go: `internal/agent/models_test.go` (the merge keeps what the canvas cannot see, replaces only the
edited fields, rotates a key only when one is sent, numbers the list positionally, refuses a non-array, never
puts a key in the event, tells the other sessions) and `TestModelSyncPutsBackWhatTheCanvasCannotSee` in the
server's e2e, which reads the frame the fake agent received: the stored key is in it, the canvas's edit is in it,
the deleted model is not, and the other socket got the new list. `make check`, `go test -race ./cmd/...
./internal/...`, `make verify-static`. Frontend: `npm run check` (zh 845 / en 831 keys, no dead ones, exports
clean), `npx vitest run` (165), `npm run build`. In the browser (`/tmp/verify`, 8191/3011, its own data
directory and its own `AGENT_CONFIG_PATH` holding a two-model fixture), dark and light: adding wrote a third
entry with its key; editing renamed the first and left its `api_key`, `max_tokens` and `reasoning_1` in place;
retyping only the second model's key changed only that key; deleting the middle model left the other two, keys
and reasoning intact. The canvas agent panel's picker offered the model added a moment earlier without a reload.
Atomicity measured, not assumed: `stat -c %i` reported a different inode after an edit (38282622 → 38283412) —
a rename rather than a truncate — and no `.tmp-*` file was left in the config directory.

And a canary run for what must never travel: a `model.conf` whose two keys are `sk-CANARY-…` strings that exist
nowhere else, a real AlayaCore, and a socket client that captured every frame while it set a model, edited the
list without a key, added a model with one, and sent a prompt — 8 frames, 1175 bytes, **no canary in any of
them**. A model entry as the canvas receives it is
`{"id":1,"name":"…","protocolType":"openai","baseUrl":"http://…","modelName":"…","contextLimit":262144,"hasKey":true}`.
Every HTTP route the page can reach (`/health`, `/api/settings`, `/api/workflows`, `/api/canvases`, `/api/runs`,
`/api/loras`, `/api/resources/status`, `/api/resources/replacement`, `/api/system/stats`, `/system_stats`) was
fetched and searched: no canary. The gateway's own log has none either, after the redactor fix above. The two
canaries *are* in `model.conf` on disk, which is where a key belongs.

**Where** `internal/agent/{events.go,models.go,run.go,models_test.go}`, `internal/server/routes_agent.go`,
`internal/server/agent_e2e_test.go`, `frontend/src/components/settings/{agent-models-section.tsx,agent-model-dialog.tsx,preferences-dialog.tsx}`,
`frontend/src/lib/agent-models.ts`, `frontend/src/services/api/agent.ts`,
`frontend/src/i18n/locales/{zh-CN,en-US}.ts`, `frontend/tests/agent-models.test.ts`.

## 202. The workflow list has one frame, not three

**Decision** Only the top level of the resource panel is drawn as a frame. A pack is still a bordered card; the
workflows inside it are filled blocks — emerald while the workflow is in the model picker, plain while it is
hidden — and the resources inside a workflow are rows divided by a hairline on that same fill. `ResourceCard`
and the inline "run this yourself" command block lost their borders the same way, keeping a fill. The pulsing
emerald ring on an enabled workflow (`workflow-active`, a `box-shadow` animation that drew a second border) is
gone, together with its keyframes.

**Why** The panel was a column of boxes inside boxes: pack card, workflow card inside it, resource surface inside
that, each with its own 1px outline and the innermost one the smallest of the three — so the loudest frames were
the ones carrying the least. Three outlines around fifteen rows of text also made the list hard to scan: what a
row *belonged* to was stated in three places at once. One frame plus fills says the same thing with fewer marks,
and the frame that remains is the one that groups the most.

**Cost** The enabled/hidden distinction now rests on a fill rather than an outline, so it is weaker in a
screenshot printed in greyscale — the `Enabled` / `Hidden` label and the muted name still carry it, and 40% of
`emerald-950` in the dark theme keeps it legible on the screen. The extent of an expanded workflow is implied by
the edge of its fill instead of drawn; nothing marks the group when the tints are turned off by a display filter.

**Tested** `npm run check` (zh 845 / en 831 keys, no dead ones, exports clean, prettier, `tsc --noEmit`),
`npx vitest run` (22 files, 165 tests), `npm run build`. In the browser (`/tmp/verify`, gateway 8191 and canvas
3011 on its own data directory, the real `resources.json` index so the packs and their rows are the ones the
report was about) in dark and light, collapsed and expanded, with one workflow enabled and one hidden: the pack
card is the only frame: the collapsed list of seven packs, the expanded pack, the expanded workflow with its four
resource rows and a hidden workflow beside two enabled ones were screenshotted before and after and compared.

**Where** `frontend/src/components/settings/resource-center-panel.tsx`, `frontend/src/styles/globals.css`.

## 203. A prompt is said once: the box or the text node, never both

**Decision** The always-on canvas prompt gains a fourth rule — *a node's own prompt is the user's words; a
text node connected to it is an input, and its words are added to that prompt when the node generates; so
when a text node already holds what a node needs, leave that node's own prompt empty and connect it* — and
`connect`'s description gains the mechanism rather than the policy: "a text node's words are added to the
target's own prompt when it generates, so a target that already says them in its own prompt would say them
twice". The agent's own `connect` and `set_prompt` answers then name the state, in the same reply that made
it: `… already says text-…'s words in its own prompt, so generating it would send them twice — clear it with
set_prompt ""`. One helper computes that (`repeatedConnectedText` in `canvas-node-generation.ts`, which is
the module that already knows what feeds a node), and two call sites ask it.

**Why** Because the agent re-made the bug #185 removed from the UI. The canvas `3df8b7a65088` still holds the
evidence: `canvas_read_node` + `canvas_list_nodes` (one text node), then three `canvas_create_node` calls
carrying `"prompt": "宫崎骏吉卜力风格插画：一片纯净茂密的森林全景"` — the text node's words, copied in at
creation — then three `canvas_connect` from the text node, then three `canvas_generate`. The saved nodes keep
both halves: `prompt` is those words and `sentPrompt` is `宫崎…\n\n【Text 1】\n宫崎…`, so every picture was
asked for the same thing twice. It was not doubt that made it copy: its reasoning says "That's fine—since the
text node is connected to the image node, the content will flow through the connection", so it believed the
copy was harmless. #185 decided this exact rule ("the box is the node's own content, the connection is an
input") and its Where list named only frontend files: the UI stopped copying, and the half of the system that
*writes* through tools was never told.

**Why not a skill** A skill is activated by reading it, and this agent read nothing: its first move was a tool
call. The rule has to be true from the first token, which is what `canvasInstructions` is for (#183, #184);
`h3-prompt-writing` is the opposite case — deep reference material that one task needs and no other.

**Why a note and not a refusal, and why not a silent rewrite** The canvas allows this state: a user can drag a
text node into a node whose box already says the same words, and #185's test deliberately keeps that
composition "still appended when the box repeats the words". A tool that refused would be a second policy
dressed as a tool (the tools do what the buttons do), and one that cleared the box would be the canvas
guessing intent — #185 already refused the first half of that. The note is the honest third option: the
connection is made, and the agent is told what it built while it can still undo it. `create_node` and
`generate` were left alone on purpose — a new node has no connections, so the mistake cannot be created there,
and a third copy of the same sentence is sediment.

**Cost** The duplication is discouraged, not impossible: a model that ignores the note still sends the doubled
request, and the user sees it in the box. The check is exact after trimming — an input whose words merely
appear inside a longer prompt is not flagged — so a copy that reworded the words as it copied is missed; the
other way round would fire on correct work. Two answers are longer by one clause.

**Tested** Go: `TestAgentSpawnCarriesTheCanvasRule` now requires the fourth rule in the system prompt and the
mechanism clause in `connect`'s description. Frontend: four cases in
`tests/canvas-generation-context.test.ts` — the repeated text is named, only the exactly-repeated one of two
is named, a mention inside a longer sentence is not, and nothing when nothing is connected or the prompt is
empty. `npm run check` (zh 845 / en 831, exports 168, prettier, `tsc --noEmit`), `npx vitest run` (22 files,
169 tests), `npm run build`, `make check`. In the browser, with the real agent: a `/tmp/verify` copy on
8191/3011, its own data directory and its own `AGENT_CONFIG_PATH`, and a canvas seeded with one text node
holding those words. **Turn one** ("根据画布上的 Text 节点生成一张图片"): `canvas_list_nodes`, then
`canvas_create_node` with `{"position":{…},"type":"image"}` — **no `prompt` at all** — then `canvas_connect`,
then `canvas_generate`; the saved node is `prompt: ""` with `sentPrompt: "【Text 1】\n宫崎骏吉卜力风格插画：一片
纯净茂密的森林全景"`, so the words travelled once, as the connection, and the picture came out. **Turn two**,
asking for the mistake on purpose ("把 Text 节点里的文字也写进这张图的提示词里"): the tool answered
`the prompt of image-… is now: 宫崎…; note: image-… already says text-…'s words in its own prompt, so
generating it would send them twice — clear it with set_prompt ""`, and the agent's reply repeated that in its
own words with the two ways out (drop the connection, or clear the box). Nothing refused, nothing rewritten.

**Where** `internal/server/agent_instructions.go`, `internal/server/routes_mcp.go`,
`internal/server/mcp_test.go`, `frontend/src/components/canvas/canvas-node-generation.ts`,
`frontend/src/pages/canvas/hooks/use-canvas-agent-tools.ts`,
`frontend/tests/canvas-generation-context.test.ts`, `docs/server.md`.

## 204. The viewport follows what the answer is about

**Decision** The viewport rule in `canvasInstructions` now names three triggers — *the node that changed, the
node the user asked about, the one they could not find* — and one limit: "One node per answer is enough."

**Why** The old sentence said "something that changed or is out of sight", which is the agent's own edits only.
A question about a node is neither: asked what the second picture looks like, an agent that answers in words
leaves the user hunting for it on a board bigger than the window, and `focus_node`'s own description ("use it
to show them something that changed or is out of sight") repeated the same gap, so neither place could teach
it. Brought up by the user, and it is the mirror of #203: the prompt said what the agent may not do and not
what it should.

**Cost** The viewport is the one thing a tool moves that the user did not ask to move, so an agent that focuses
on every mention takes the user's place away mid-work: the one-node-per-answer limit is that price, and it is
in the rule rather than in the tool because the tool cannot see an answer's shape. A node already in view is
still focused — the agent has no way to know where the user is looking, and selecting it is the other half of
the gesture.

**Tested** In the browser with the real agent (the run above): turn one ended with `canvas_focus_node` on the
node being reported — "selected image-… and moved the view to it" — and the screenshot shows the board centred
on it. In turn two the same agent declined to focus again ("The node is already visible (I focused on it
earlier). I'll just reply."), so the limit held without a second sentence. `make check`,
`TestAgentSpawnCarriesTheCanvasRule` (which pins the new trigger's wording), `npm run check`, `npx vitest run`.

**Where** `internal/server/agent_instructions.go`, `internal/server/mcp_test.go`, `docs/server.md`.

## 205. A connection's id is not a timestamp

**Decision** `addConnection` — the one function a drag, the reference bar and the agent's `connect` all end
up in — names a connection with `nanoid()`, not `conn-${Date.now()}`. The other places that make one
(`createConnectedNode`, `selectNodeReference`, `duplicateNode`, the paste path) already did.

**Why** The agent wires several nodes in one batch, so three `connect` calls finish inside the same
millisecond, and a timestamp is not unique at that resolution: `canvases/3df8b7a65088/canvas.json` holds
three connections that all carry `conn-1793651086334`. The id is not cosmetic — it is what selecting,
highlighting and deleting go by (`deleteConnection` filters on it, `relatedHighlight` collects it, React uses
it as the key), so deleting one of those three connections would have removed all three, and clicking one
would have lit up the others. Found while verifying #203, which makes the agent wire text into image nodes.

**Cost** An id is no longer readable as a timestamp, which nothing ever read.

**Tested** On a `/tmp/verify` copy (8191/3011, its own data directory and `AGENT_CONFIG_PATH`): a canvas
seeded with one text node and three empty image nodes, and one message asking the agent to wire all three —
three `canvas_connect` calls answered in one batch (three `UF` frames at 20:47:21.049–.067) — then the saved
`canvas.json` held three connections with three distinct ids (`XNyw9uV2g0qVsKpK6xVjL`,
`8s_-1Jsq57ZSS_Zb6Liro`, `4uuoCxPREuq_dFLde1dcR`), where before the change the same gesture produced one id
three times. `tsc --noEmit`, `prettier --check`, `npx vitest run` (22 files, 169 tests), `npm run build`,
`make check`, `go test -race`.

**Where** `frontend/src/pages/canvas/project.tsx`.

## 206. `connect` carries an example of both directions

**Decision** The description of `connect` gained two sentences naming the two orders as the thing they mean:
"the words into the picture: `fromNodeId` is the text node, `toNodeId` is the image node. The other order is
real too — a picture into a text node is a reference that text node reads." Nothing else changed: the tool's
answers, the canvas's rules and the arguments keep the shape they had.

**Why** The table described one example and it was a picture into a config node, which is not what an agent
does all day — since #203 the common wiring is a text node's words into a picture, and that had no shape to
copy. A throwaway run showed the cost: asked to wire three pictures and a text node, an agent answered
`fromNodeId: image-…, toNodeId: text-…` and reasoned "the user said 把这三张图都接上这个 Text 节点, so the image
is the source" — it parsed an ambiguous sentence literally, and the words available to it never said which
order produces which relation.

**Why not in the answer, which was the first plan** Because a sentence that agrees with what the agent already
believes does not get read: the #203 note works by contradicting a judgement ("would send them twice"), and
"text-y now takes image-x" would only confirm the direction it had just chosen. The strongest branch of that
plan — "image-x holds nothing to send yet, so text-y gains no input" — describes a state the agent created a
moment earlier and already knows, so it reads as a status report. Three branches and a noun table for that is
not worth the noise on a tool called several times per turn.

**Cost** One more sentence in every `tools/list`. A wrong direction is still accepted and not flagged: a
picture that never receives the words is not an error the canvas can recognise — image into text is a real
wiring (the reverse-prompt flow builds exactly that) — and the human-visible signal is the panel's Generate,
which #185 disables when a node has nothing to send.

**Tested** `make check` (the new assertions in `TestAgentSpawnCarriesTheCanvasRule` pin both example clauses,
and the existing one pins "say them twice"), `go test ./internal/server/`. Not exercised in a browser: no code
path changed, only the text of a description, and the example is read by the model rather than run by the page.

**Where** `internal/server/routes_mcp.go`, `internal/server/mcp_test.go`.

## 207. The agent window is part of the canvas document

**Decision** `CanvasDocument` gained `agent: { open, position, size }`. The agent panel's open state and
the place and size the user dragged or resized it to are saved in `canvas.json` beside the viewport,
written through the same save queue, and restored when the canvas opens. The in-memory zustand store is
keyed by canvas id, so one canvas's window cannot appear on another.

**Why** The panel sits *on* the canvas, but how it was left is how the person left the *canvas*: reopening
a project should show the conversation where it was, not a closed button in the corner. The viewport has
always worked this way, and a resize or a collapse is the same kind of fact — "this is the arrangement I
was working in". A session-only value meant a reload lost the arrangement, and switching canvases carried
the last canvas's geometry across.

**Why not the history / export separately** The viewport is not in undo either: moving the board is not an
edit to its content, and undoing a node move must not also un-maximise the panel. The field travels in
`canvas.json`, so an export carries it, and `documentOf` is still the one place that decides what the
document is.

**Cost** `canvas.json` has one more field. A document written before this change has no `agent`; it reads
back as closed at the default corner, which is what those canvases did before. A remembered pixel position
may be outside a smaller browser window, so drawing clamps it into the canvas, but the stored value is kept
as written. Geometry is debounced 500 ms (open/closed is written at once), and `pagehide` runs the pending
write before the page goes, so the debounce is a save-rate choice rather than a hole a refresh falls into.

**Tested** `npm run test` (`tests/canvas-document.test.ts` pins the field in the document and
`tests/canvas-agent-window.test.ts` pins per-canvas isolation, restore-once and the old-document default),
`tsc --noEmit`, `node scripts/check-exports.cjs`. Not exercised in a browser in this change.

**Where** `frontend/src/types/canvas.ts`, `frontend/src/services/api/canvases.ts`,
`frontend/src/lib/canvas/canvas-document.ts`, `frontend/src/stores/canvas/use-canvas-agent-store.ts`,
`frontend/src/components/canvas/canvas-agent-panel.tsx`, `frontend/src/pages/canvas/project.tsx`,
`frontend/tests/canvas-document.test.ts`, `frontend/tests/canvas-agent-window.test.ts`.

## 208. A save's version check and its write are one step

**Decision** `canvas.Store.Write` takes `Store.writeMu` for the read-check-write, so the rev a save is
compared against cannot move between the comparison and the rename that follows it.

**Why** The check was a plain read: two saves that named the same rev both read it, both matched, and both
wrote — the later rename winning, and the earlier caller told its document had been stored under a rev that
no longer describes it. That is a lost edit with no conflict reported, which is the one outcome `If-Match`
exists to prevent. Measured on the unguarded code with eight goroutines writing against one rev: five were
answered 200 and three 409, so four of the five "successes" never reached the disk.

**Cost** One mutex for every canvas. A save is a few milliseconds of local I/O and the queue already
serialises per canvas, so the contention is theoretical. `Create` and `Delete` do not take it: they touch a
directory nobody else names.

**Tested** `TestTwoSavesAgainstOneRevHaveExactlyOneWinner` in `internal/canvas/canvas_test.go` — eight
goroutines, one winner, seven conflicts, and the surviving document is a whole one. It fails without the lock
(5 winners) and passes with it; `go test -race` on the package is clean.

**Where** `internal/canvas/canvas.go`, `internal/canvas/canvas_test.go`.

## 209. The document that carried duplicate connection ids was repaired where it lives

**Decision** `canvases/3df8b7a65088/canvas.json` — the one document in this workspace that held two
connections with one id — was rewritten once with distinct ids: a one-off edit of the file, not a step in the
product. The read path does nothing about it — no normalisation, no migration branch, no compatibility field.
#205 already made every new id unique (`nanoid()` in `addConnection`), so nothing mints a duplicate again.

**Why the data and not the reader** #205's own evidence pointed at a live bug — clicking one of those two
connections lit both (one click, two paths at `stroke-width="3"`), and deleting either removed both — and the
temptation is to repair it on load, which also fixes any zip exported before the change. But this project has
no installed base and no released version: there are no old documents, no old exports, and nothing in the
world that a migration would be run against. A reader that repairs what it reads is then permanent code for a
case that cannot occur — the same reflex that produces version-0 formats nobody dares remove. One document was
wrong; one document was fixed.

**Cost** If a duplicate ever turns up again — a hand-edited `canvas.json`, a zip from an unrecoverable
build — the fix is an edit of the file, not a restart, and the symptom is visible (two connections
highlighting together) rather than silent. That is a worse day than a read-time repair would give, and it is
the correct trade for a tree with no users.

**Tested** Not a code change: the document was rewritten and re-read (`GET /api/canvases/3df8b7a65088`), the
four DOM ids are distinct, and one click now lights one path.

**Where** `canvases/3df8b7a65088/canvas.json` (not tracked), `frontend/src/pages/canvas/project.tsx` (#205).

## 210. An import skips directory entries

**Decision** `importArchive` (`internal/server/canvas_import.go`) ignores a zip entry that is a directory.
Everything else about the archive is unchanged: `canvas.json`, `manifest.json` and `files/<name>`, with `..`
still refused before the name is cleaned.

**Why** `files/` is what every zip tool writes for a folder — `zip -r`, Finder's Archive Utility, Explorer —
so the ordinary way of moving an export (unzip it, zip it again) produced an archive this gateway refused with
`422 import_unexpected_entry`, naming an entry that carries no bytes at all.

**Cost** A directory entry is no longer an error. Nothing was ever restored from one, and an archive whose
`files/` entry is a directory with contents still fails on those contents only if they are not
`files/<valid name>`.

**Tested** `TestAnImportAcceptsTheDirectoryEntriesARezipAdds` builds the same archive `zip -r` produces; the
live gateway was checked both ways — `422 import_unexpected_entry` before, `200` and a fetchable file after.

**Where** `internal/server/canvas_import.go`, `internal/server/canvas_e2e_test.go`.

## 211. A run that panics fails its task, not the gateway

**Decision** `task.Store.pump` calls the run through `runGuarded`, which recovers a panic and turns it into
that task's error. The queue records the failure and starts the next task.

**Why** Go has no per-goroutine recovery: an unrecovered panic in the worker goroutine takes the process down —
every canvas, every other run, and the queue with it. The run is the one place here that executes code shaped
by data (a graph from `workflows/`, its parameters, ComfyUI's answer), so it is the one place worth guarding;
`httpx.Recover` already does the same for a request.

**Cost** A panic no longer crashes the process, so a deterministic bug becomes a run that always fails instead
of a stack trace at startup. The log line names the task and the panic value; the stack is not printed, which
is the one thing a developer would want — `debug.Stack()` is the obvious next step if that turns out to
matter.

**Tested** `TestAPanickingRunFailsItsTaskAndTheQueueCarriesOn`: the first task fails with "the run panicked",
the second one queued behind it completes.

**Where** `internal/task/task.go`, `internal/task/task_test.go`.

## 212. A WebSocket write has a deadline

**Decision** `ws.Conn.writeFrame` sets a 30-second write deadline on the underlying connection before every
write.

**Why** A write to a peer that stopped reading — a suspended tab, a network that went away without a FIN —
blocks in the kernel once the send window fills, and nothing on this side can interrupt it. The write holds the
connection's mutex, so the keep-alive ping that would have noticed cannot go out either, and the writer (the
agent's pump, under the session's lock) waits with it: one dead tab could hold a whole session's routes. The
deadline turns "blocked for ever" into an error, and an error shuts the connection down, which wakes the
reader and detaches the session.

**Cost** A frame that cannot be delivered in 30 seconds closes the socket instead of waiting. The largest
frame this socket carries is an 8 MiB message bound, and the client is a browser on the same machine or the
LAN, so 30 seconds is generous by an order of magnitude.

**Tested** The package's existing tests (handshake, frames, ping/pong, close) pass with it; `go test -race`
on `internal/ws` and `internal/server` is clean. Not reproduced against a stalled peer: a blocked socket is
not something a unit test can build without a fake transport.

**Where** `internal/ws/ws.go`.

## 213. An export asks whether the file is there before zipping it

**Decision** `exportCanvas` and `exportCanvasNodes` (`frontend/src/lib/canvas/canvas-export.ts`) go through
`fetchFileBlob`, which returns null on a non-2xx response instead of the body.

**Why** `fetch` resolves for a 404 as readily as for a 200, so the old `(await fetch(url)).blob()` zipped the
gateway's error envelope, and an import then restored that JSON under a `.png` name — a canvas whose picture
is a sentence. A file can genuinely be missing: the sweep has a 24-hour grace (#156), a task record can
outlive its canvas, and a canvas can be exported from a copy whose `files/` was edited by hand.

**Cost** An export silently carries fewer files. That is the same information the missing node will show on
screen (a broken reference) rather than a corrupt one it cannot explain.

**Tested** `tsc --noEmit` and the existing suites. The behaviour is not covered by a test: the module calls
`saveAs` and the browser's download machinery, which vitest does not run.

**Where** `frontend/src/lib/canvas/canvas-export.ts`.

## 214. An answer stops listening for its abort when the turn ends

**Decision** `askAgentSession` (`frontend/src/services/api/agent.ts`) removes its `abort` listener in the
`finally` that already detaches the event listener, and refuses a request whose signal is already aborted.

**Why** The listener was added with `{ once: true }` and never removed on the success path, so it outlived the
turn it belonged to. A caller that reuses one `AbortController` for several questions — the shape the node
panels use — accumulated one listener per answer, and an abort later on cancelled whatever the agent was doing
*then*, not the turn the caller meant to stop. An already-aborted signal was the mirror failure: `addEventListener`
never fires on it, so the ask waited for an answer to a question nobody was going to cancel.

**Cost** Nothing measurable; one closure per turn.

**Tested** `tsc --noEmit` and the existing suites (179 tests). Not covered by a test: the module owns a
module-level `WebSocket` map and the failure is a listener that is not there, which a unit test would have to
reach through the socket.

**Where** `frontend/src/services/api/agent.ts`.

## 215. The H3 rewrite is not asked for an output language

**Decision** The instruction `optimizePrompt` sends for a video node no longer carries a `输出语言：…` clause.
The image one (`optimizeImagePrompt`) keeps it.

**Why** It could not be honoured. The H3 guides say the rewrite sections are written in English and that
dialogue, lyrics and on-screen text are carried inside `<d>` verbatim, in their original language
(`prompts/skills/h3-prompt-writing/references/ref-en.txt`, `base-en.txt` §4.4). So the clause asked the agent
to do the one thing the format forbids, on every click, and the agent — correctly — followed the skill. For an
image model it is a real choice: a Chinese prompt is what a Chinese reader wants to edit, and nothing forbids
it there.

**Cost** A video prompt still comes back in English, with the user's Chinese dialogue inside it. That is the
format, not a choice this project makes; `promptOptimizeLanguage` (no control on screen, default `zh`) now
affects image prompts only.

**Tested** `npm run check` (tsc, i18n, exports, prettier), `npx vitest run`, `npm run build`; the built bundle
carries the H3 instruction without the clause. Not exercised against an agent: the change is one template
string, and what the agent does with it is the skill's business.

**Where** `frontend/src/components/canvas/canvas-node-prompt-panel.tsx`.

## 216. A comment about Chinese data is still a comment

**Decision** Five doc comments that quoted a Chinese string in the middle of an English sentence are
rewritten in English: the citation module's header and `referenceEntries` (`agent-references.ts`),
`node-title.ts`'s header, `sent-prompt-disclosure.tsx`'s header, `channelName`'s doc comment
(`use-config-store.ts`), and one inline comment in `canvas-agent-panel.tsx`.

**Why** #17 asks for everything written for a human to be English, and #9's exception is for *data* — a value
a model or ComfyUI reads. A comment that quotes `图片` is neither: it is prose, and the string it quotes is
already defined a few lines away (`MARKERS`, the i18n dictionary, `titleKey`). The result was a rule with an
asterisk nobody could check: the four comments sat in an exception list, so "no Chinese in the source except
data" was true only if comments counted as data.

**Cost** Saying "the default title for the type" instead of naming it is one turn of the screw less vivid.
The source now has 60 Chinese lines in six files, every one of them a value: the catalogue map, the agent's
instructions, the MOSS prefix, `MARKERS`, the `PromptOptimizeMode` union, one endonym.

**Tested** `npm run check` (tsc, i18n, exports, prettier), `npx vitest run` (175), `npm run build`. A scan for
CJK in `frontend/src` outside the two dictionaries reports those 60 lines and nothing else.

**Where** `frontend/src/lib/canvas/agent-references.ts`, `node-title.ts`,
`frontend/src/components/canvas/sent-prompt-disclosure.tsx`,
`frontend/src/stores/use-config-store.ts`, `frontend/src/components/canvas/canvas-agent-panel.tsx`.

## 217. An editor exports a picture it decoded in CORS mode

**Decision** `loadDrawableImage` (`frontend/src/lib/canvas/canvas-image-data.ts`) decodes a picture with
`crossOrigin="anonymous"` and, if a response does not answer the CORS request, fetches the same bytes and
decodes them through a `blob:` URL instead. The mask editor composites its source through it, and so do crop
and split.

**Why** `canvas.toDataURL()` throws `SecurityError: Tainted canvases may not be exported` the moment a canvas
has drawn bytes from another origin, and the two origins are structural: the bundle is served on `:3000` and
the gateway holding the files on `:8190` (`start.sh`). InPaint's Generate and Export both died on it, because
the overlay they send as the second reference *is* the picture with the mask drawn over it — the export was
never about the mask, it was about the source underneath. The taint is a property of how the bytes arrived,
not of the pixels, so the fix belongs at the load: `crossOrigin` makes the browser ask for the image in CORS
mode, and the gateway already answers that (its middleware allows the canvas's own host, `httpx.CORS`). The
blob fallback covers a deployment that answers the headers on `fetch` but not on a subresource; a source that
is already `data:` or `blob:` is this document's own and skips both.

**Cost** One more decode per edit, as a separate cache entry from the `<img>` on screen. It is not on the
click: the load starts when the dialog opens, so Generate awaits a download that already happened. A gateway
that answers no CORS at all now reports "Failed to read image" instead of throwing from a click handler.

**Tested** `npm run check` (tsc, i18n, exports, prettier), `npx vitest run`, `npm run build`. Not exercised
against a tainted canvas in a browser: jsdom's canvas does not taint, so the argument rests on the headers
`internal/httpx/middleware.go` sets and on the same attribute already used for cross-origin video
(`canvas-video-frame.ts`, `camera-orbit-widget.ts`).

**Where** `frontend/src/lib/canvas/canvas-image-data.ts`,
`frontend/src/components/canvas/canvas-node-mask-edit-dialog.tsx`,
`frontend/src/pages/canvas/hooks/use-image-editors.ts`.

## 218. A node's `content` is the URL it is shown from, and `storageKey` is the reference

**Decision** `imageMetadata`, `videoMetadata` and `audioMetadata` (`canvas-node-factory.ts`) put the URL a
file is served at into `metadata.content` and keep `files/<name>` in `metadata.storageKey`. `documentOf` was
already swapping them back, so nothing on disk changed.

**Why** These three functions were the only place writing the reference into `content`, and every reader of
`content` treats it as something an `<img>` can load: the lightbox in `project.tsx` (`previewContent`), the
hover preview, the mask, crop, outpaint and angle dialogs, and `pickImageSource`'s `originalUrl` once a node
is magnified past the preview's size. A node made in this session therefore pointed at `files/<name>`, which
under `/canvas/<id>` is a 404 — so the picture appeared in its node (that path resolves the reference itself,
`previewUrlFor`) and was broken in every view that did not: click to enlarge failed, and so did zooming in far
enough to leave the preview. A reload fixed it because loading a canvas is what resolves `content`
(`hydrateCanvasImages`), which is the shape this entry makes unnecessary to rely on.

**Cost** An absolute URL lives in memory for as long as the canvas is open. It reaches neither `canvas.json`
nor an export zip: `documentOf` replaces it with `storageKey` before either is written, and #152's rule — a
document that carries no host, port or canvas id — still holds. A file with no derivable URL keeps the
reference, which is no worse than before.

**Tested** `frontend/tests/canvas-node-metadata.test.ts` (the URL in `content`, the reference back in the
document, the fallback for a file without a URL), `npm run check`, `npx vitest run` (179), `npm run build`.

**Where** `frontend/src/lib/canvas/canvas-node-factory.ts`, `frontend/src/lib/canvas/canvas-document.ts`.

## 219. The gateway serves the canvas bundle, from its own origin

**Decision** `WEB_DIR` names a canvas bundle and `GET /` serves it: a file under that directory, or its
`index.html` for a path that names no file (a client-side route). `start.sh` starts one process instead of
two, `frontend/dist` is what it points at, and `make run` does the same from source. The first-paint file
carries a gateway address only when the operator names one (`PUBLIC_BASE_URL`); the frontend otherwise uses
the origin it was loaded from.

**Why** The canvas was a second process — `vite preview` on `:3000`, gateway on `:8190` — and that cost more
than a second window. `vite` is a development dependency, so a release could not ship at all without
shipping a build tool. Every picture was cross-origin, and `canvas.toDataURL()` refuses a canvas that has
drawn one, so InPaint, crop and split could not export what they drew (#217 patched the symptom).
`CORS_ORIGINS` had to be kept per address, with `*` refused and a "same host name" rule to paper over the
usual single-machine case. And the frontend had to *guess* the gateway's address and carry it into the
page, which is wrong for a LAN name, a phone, or a reverse proxy — the page it came from is the only answer
none of those can get wrong. Serving bytes is not knowing what a node is: `/api/*` remains the whole
protocol, and `canvas.Store`'s boundary is untouched.

**Cost** The gateway now owns two things it did not: a cache policy, and the failure mode where the bundle
is stale. `/assets/*` carries a content hash and is served `immutable`; everything else is `no-store`,
because a cached `index.html` outlives an upgrade and asks for chunks that are gone — a white page a reload
cannot fix, since the reload is what reads the cache. A missing asset answers 404, never the page, for the
same reason. There is no compression: the wire is loopback or a LAN, which is the argument the bundle's own
chunking already makes. A `go:embed` build (one file to ship) is not done: it would make `make build` depend
on npm, and reading the directory keeps "copy a new `dist/` over the old one" working without a restart. One
of its two blockers is already gone: nothing is written into the bundle any more (#220).

**Tested** `internal/server/web_test.go` (root and a client route answer with the page, a hashed asset is
`immutable`, `config.js` and the page are `no-store`, a missing asset and an unknown `/api/*` path stay 404
JSON, no bundle means the old 404, and no request serves a file outside the bundle), the two first-paint
tests (an address when `PUBLIC_BASE_URL` names one, none when the gateway serves the canvas),
`frontend/tests/gateway-origin.test.ts` (the page's origin is the answer in a browser, a named address
wins over it, loopback outside one), `go test ./internal/...`, `npm run check`, `npx vitest run` (184),
`npm run build`. Smoke-tested by hand: the gateway
served the built bundle on a spare port and answered `/`, `/canvas/<id>`, `/assets/*`, `/config.js` and
`/api/nope` as above; `npm run dev` proxied `/api/canvases` through vite to a gateway. Not exercised in a
browser against a real ComfyUI.

**Where** `internal/server/web.go`, `internal/server/web_test.go`, `internal/config/config.go` (`WEB_DIR`,
`PUBLIC_BASE_URL` explicitness), `internal/server/runtime_config.go`, `internal/server/routes_admin.go`,
`frontend/src/constant/app-mode.ts`, `frontend/vite.config.ts`, `start.sh`, `Makefile`, `README.md`,
`docs/server.md`.

## 220. The first paint is computed from the settings document, not copied into the bundle

**Decision** `GET /config.js` is a route: it renders `data/settings.json` — plus a gateway address when
`PUBLIC_BASE_URL` names one — into the script the page loads before its bundle, with `ETag`/`304` so a
repeat load costs a header. `RUNTIME_CONFIG_PATH` becomes opt-in: nothing is written anywhere unless the
operator names a file, for a canvas a static host publishes with no gateway in the request path.

**Why** The file existed because nothing could answer `/config.js` — a static server owned the bundle, so
writing the document into `frontend/dist` was the only way to get a synchronous read (#155). That premise
ended with #219. Keeping the file meant a second writer of one truth, and every failure mode of a copy: a
write that failed only logged a warning and left the page opening light and English; `make frontend`
replaced the file with the template; a `dist` copied to another machine carried this machine's settings,
model list and last canvas id; and the write needed the installation to be writable, which rules out a
read-only deployment and the single embedded binary #219 lists as future work. A route cannot be stale,
cannot fail to be written, and needs no write access. The document had also grown: `settings.config` holds
the whole `AiConfig` — channels and their models, synced from `/api/workflows` — so the file was carrying
several kilobytes of model metadata into a build artifact because it mirrored the store instead of
projecting it.

**Cost** The first paint now waits for the gateway to answer — a round trip on loopback, and the gateway was
already the only thing serving the page, so nothing new can be missing. The body is stored by the browser
under `no-cache` and revalidated by `ETag`; it is the same document `/api/settings` already hands out, so it
is not a new exposure. A canvas published by a static host must name `RUNTIME_CONFIG_PATH`, or it opens with
defaults and picks the preferences up over HTTP (which is also what the template in `frontend/public/`
means, and what `npm start` gets). `frontend/dist/config.js` still exists in a build — `public/` is copied
into it — but the gateway never serves it: the literal route outranks the `GET /` subtree, and a test holds
that.

**Tested** `internal/server/settings_e2e_test.go`: the script is the live document (an empty one at start,
a save visible on the next request with no file involved), the assignment the frontend expects, the
address only when named, `ETag`/`304` and a new `ETag` after a save, and the opt-in file written only when
asked — plus nothing appearing in `WEB_DIR`. `internal/server/web_test.go` holds the route against the
template in the bundle. `go test ./internal/...`, `make check`, `npm run check`, `npx vitest run` (184),
`npm run build`, `make build`.

**Where** `internal/server/runtime_config.go`, `internal/server/routes_admin.go`,
`internal/server/routes_settings.go`, `internal/server/server.go`, `internal/config/config.go`
(`RuntimeConfigPath`), `start.sh`, `Makefile`, `frontend/index.html`, `frontend/public/config.js`,
`frontend/src/constant/runtime-config.ts`, `docs/server.md`, `README.md`.

## 221. A message is a list of parts, drawn in the order the frames arrived

**Decision** The panel's transcript is built by one reducer, `transcriptEvent`, and a message is a **list of
parts** — text, reasoning, a tool call — appended as the frames arrive and never moved. The tool list that
hung off a message is gone, and with it the block that drew every call above every sentence. Message ids
come from a counter, not a timestamp, padded so that sorting them as strings is the order they arrived in.

**Why** A `text` field plus a `tools` array cannot say *where* in a message a call happened, so the renderer
had to choose — and it chose the top. A real transcript shows what that costs: in
`data/agent/sessions/canvas-d35c56e43bf8-3de3706a.session` two `canvas_read_node` calls sit between the
reasoning that decided to make them and the paragraph that reads their output, and the panel drew both calls
before both sentences. The frames already carry the order; only the shape lost it.

The same question one level up is which bubble a frame belongs to, and the answer is the end of the list and
nothing else: a message that arrives takes the end, and text and calls keep going into the answer that is at
the end — if what is at the end is not an answer, they open one below it. That is why the panel reaches back
into no earlier bubble. Scheduling is not this side's business: a message said mid-answer is echoed by the
agent when the agent says it, drawn where it lands, and the answer goes on underneath. What the person typed
is not drawn at all — it appears when the echo arrives (#104), so there is still one copy of it.

**Cost** One more module and one indirection: the panel no longer builds messages inline. An answer that is
echoed over mid-turn reads as two bubbles with that message between them, where it used to be one bubble with
later words written above them. A message can now be several paragraphs, so each run of text is read for `@`
mentions on its own — two citations with the same label on either side of a call resolve to the first of them
twice, which is the fallback a transcript written before labels were unique already got (#163).

**Tested** `frontend/tests/agent-transcript.test.ts` (14): a call keeps its place between two sentences; the
order of several calls and the sentences between them; ids unique and sorting in arrival order; one step for
the two frames of a call; a message echoed mid-answer taken at the end with the answer continuing below it;
history replacing rather than appending; a frame that says nothing opening nothing. Replayed through the
reducer, the session file above produced `user → [reasoning, tool, tool, reasoning, text] → user →
[reasoning, tool, tool, reasoning, text]`, where the panel had drawn `[tool, tool, text]` with both reasonings
dropped. `npx vitest run` (198), `npm run check`, `npm run build`.

**Where** `frontend/src/lib/canvas/agent-transcript.ts`,
`frontend/src/components/canvas/canvas-agent-panel.tsx`, `frontend/tests/agent-transcript.test.ts`.

## 222. A tool step says how it ended, reasoning is folded, and the agent's notices are drawn

**Decision** Three things the panel did not say before, all of them about what a frame means rather than what
it is:

1. A tool step carries a state — running, ok, failed — and draws a coloured mark after its name: a spinner
   while the call is out, a green tick when the result said it worked, a red cross when it said it did not,
   and a grey dash for a step a stopped turn never answered. The verdict is the UF frame's own `is_error`,
   which the gateway now relays as `isError` instead of dropping.
2. Reasoning is drawn, folded away: one `思考` line per reasoning block that opens on a click and stays
   open. It used to be accumulated into a field nothing rendered.
3. The agent's **system messages** are drawn. `SM notify` — "Summarizing conversation…", "retrying in 5s
   (retry 1/3)", "prompt deferred until MCP initialization completes" — was collected by nobody and dropped
   on the floor; it is relayed as `notice` and drawn between the bubbles, smaller than either.

**Why** A step without a verdict is a spinner that means nothing: the panel showed `调用 canvas_read_node`
and left the reader to guess whether the call had come back, and after a stop it showed a spinner that would
never stop. The answer was two fields away — UF carries `is_error`, and the gateway's own tool path already
knew the idea (`toolAnswer.IsError`) — so the mark is the frame's verdict and not a guess from the text.

Reasoning is the part that is written but not said: it is what a surprising answer is explained by, and noise
in the common case. Folded, it costs one line; unfolded, it is the whole trace. Dropping it entirely (the
first version) was the one option that helps nobody.

The notices are how the agent says what it is doing to itself while the user waits on a long turn. They are
not in the session file and not errors — a `notify` drawn as an error would be a red line for "summarizing",
which is normal work — so they travel as their own kind and are drawn as their own row.

**Cost** One more event type across the wire, and one more field on `tool_result`. A failed call still shows
no reason of its own: UF's text is the first content item, and a failure's words are in it only when the tool
put them there. A notice is the one thing that does not come back after a reload, because AlayaCore does not
put it in the session file: it is the live stream saying what it is doing at that moment, not something that
was said. That is the agent's file and its call, not a gap to patch here — the rest of the turn (reasoning,
calls, results) is replayed and drawn as it was (#223).

**Tested** `internal/server/agent_e2e_test.go`'s
`TestSocketRelaysTheSystemNoticeAndTheFailure`: the fake agent sends `SM notify`, an `AF`, a UF with
`is_error: true` and a task that ends — the socket relays all three, the failure with `isError`. On the
frontend, `frontend/tests/agent-transcript.test.ts` covers the state of a call that worked, one that failed,
one never answered, and a notice arriving mid-answer. In the browser: not exercised — the marks were checked
by rendering a replayed transcript, not against a live AlayaCore. `go test ./internal/...`, `npx vitest run`
(198), `npm run check`, `npm run build`.

**Where** `internal/agent/events.go` (`IsError`, `systemNotice`), `internal/agent/run.go` (`notify`),
`internal/server/agent_e2e_test.go`, `frontend/src/services/api/agent.ts`,
`frontend/src/lib/canvas/agent-transcript.ts`,
`frontend/src/components/canvas/canvas-agent-panel.tsx` (`ToolStepLine`, `ReasoningBlock`),
`frontend/src/i18n/locales/{en-US,zh-CN}.ts`.

## 223. The replayed conversation is the frames, relayed as they come

**Decision** `Event.History` is `[]Event` — the replayed frames carried as the events a live turn sends — and
`HistoryEntry` (`{role, text}`) is gone. `replayed()` calls the same parsers a live turn does (`userContent`,
`contentDelta`, `toolCall`, `toolResult`) and passes each frame on as `user` / `delta` / `reasoning` /
`tool_call` / `tool_result`, in the order the agent wrote them. The panel folds that list through
`transcriptEvent`, the same reducer that draws a live turn.

**Why** The session file is AlayaCore's, and it holds the whole turn: the question, the reasoning, every call
and its result, the answer. `replayed()` read only the text of that stream, so a reloaded page drew a
conversation with its thinking and its tool steps cut out — a copy that was cheaper to produce and not what
the agent said. Nothing needed to be summarised or reconstructed: the file is already in order, and reading
only part of it was the whole defect. Relaying the frames also removes a second shape from the wire and a
second renderer from the panel, which is the version that cannot drift: a reload is drawn by the code that
drew it live, from the same frames.

**Cost** `AX`/`AF`/`UF` frames from the startup window now travel to the page as events, so the `history`
message is larger than bare role/text pairs — the tool inputs and outputs a turn carried. A `Uf` preview
(result before it is final) and the textless `AX` marker are still skipped: they are display-only or nothing
said. Notices are not in this list and cannot be: AlayaCore does not write `SM notify` to the file, so what
the agent was doing to its own context at 14:03 is not part of the conversation it replays.

**Tested** `internal/server/agent_e2e_test.go`'s `TestSocketGoingAwayReplaysTheConversation`: the fake agent
writes a turn to its session file — reasoning, a call with arguments, the result, the answer — the socket is
dropped, and the next connection replays `user, reasoning, tool_call, tool_result, delta` in that order, with
the call's arguments intact. `frontend/tests/agent-transcript.test.ts` folds the same list and gets one user
message and one answer carrying its reasoning and its finished call. `go test ./internal/...`, `npx vitest
run` (198), `npm run check`, `npm run build`.

**Where** `internal/agent/events.go` (`Event.History`, `replayed`), `internal/agent/sessions.go`
(`Connected.History`), `internal/server/routes_agent.go`, `internal/server/agent_e2e_test.go`,
`frontend/src/services/api/agent.ts`, `frontend/src/lib/canvas/agent-transcript.ts`.

## 224. The panel draws the agent's own numbers: how full the context is, and how fast it is going

**Decision** The canvas agent panel shows the agent's telemetry in a small row at the foot of the
conversation — `22K/1M 2.2% | 129.5 tok/s (ttft 0.8s)` — from a new `usage` event carrying SM `task`'s
`context_tokens`, `step_tps` and `ttft_ms`, and from the startup broadcast, which carries the count the
agent restored from its session file. The numbers are written the way AlayaCore's own status bar writes them
(`formatTokenCount` and the two segments in its `internal/adapters/terminal/tui_status.go`), so the panel and
the terminal never disagree about the same session. Nothing is measured, estimated or counted on this side:
the three values are relayed and printed.

**Why** Both facts already existed and neither was shown. `context_tokens` was read only to decide whether a
task had ended, and `step_tps`/`ttft_ms` were dropped with the rest of the payload. Someone waiting two
minutes on a video wants to know whether the model is working or stuck, and how close the conversation is to
the model's ceiling; the agent already answers both, in the frame it sends at every step.

The shape stays the agent's. `step_tps` is end-to-end throughput with latency included — deliberately not a
decode rate, for the reason AlayaCore's `speed-tracking.md` gives — so the panel prints it rather than
recomputing anything from the deltas it happens to see. `ttft_ms` qualifies that figure and rides in
parentheses. A step that produced no output tokens reports no speed, and `0.0 tok/s` on screen would read as
a stalled model, so nothing is drawn for it. The context cell is `used/limit share` only when the model says
how much it holds; a percentage of an unknown limit is not a number worth inventing.

**Cost** One more event type, three fields on it, and one field's worth of state on the session
(`AgentSession.usage`). The row is hidden until the agent has said something, so a fresh conversation shows
no numbers rather than zeros. The restored count arrives only for a session started on a file — a box opened
on nothing has nothing to report until its first step ends. The format is fixed English-ish by nature
(`tok/s`, `ttft`): it is the agent's own vocabulary, and translating it would put the panel and the terminal
at odds over the same number.

**Tested** `internal/agent/session_test.go`'s `TestSessionRelaysTheContextAndTheStepSpeed`: the count the
agent restored rides on the startup broadcast (and carries no step figures), a step frame mid-turn is relayed
as `12.5 tok/s` with a 1200 ms first token, the frame that ends the turn is relayed *before* `done`, and a
step that has counted nothing (`context_tokens: 0`) is not drawn as a zero. `frontend/tests/agent-usage.test.ts`
(6): the token-count format in both units, the share, the count alone when the limit is unknown, the speed
with and without a first-token time, the blank for a step with no output, and the whole line. In the browser:
not exercised against a live AlayaCore — the row was read off a replayed transcript. `go test
./internal/...`, `npx vitest run` (206), `npm run check`, `npm run build`.

**Where** `internal/agent/events.go` (`usage`, `taskUsage`, `ContextTokens`/`StepTps`/`TtftMs`),
`internal/agent/run.go` (`task`), `internal/agent/session_test.go`,
`frontend/src/lib/canvas/agent-usage.ts`, `frontend/tests/agent-usage.test.ts`,
`frontend/src/services/api/agent.ts` (`AgentUsage`, `adopt`),
`frontend/src/components/canvas/canvas-agent-panel.tsx`, `frontend/src/i18n/locales/{en-US,zh-CN}.ts`,
`docs/server.md`.

## 225. A run's end is a message to the agent that asked for it

**Decision** `POST /api/canvases/{id}/runs` takes an optional `askedBy: {session, node}`, filled in by the
page when it submits a run because an agent called `generate`. The run record keeps it (`task.Ask`), and
when the run reaches a terminal status the gateway says what became of it to that session — one sentence
naming the node, the files or the reason — through `agent.Sessions.Tell`, which sends it as a prompt. It
therefore arrives the way anything typed into the panel does: AlayaCore echoes it as a user message, draws
it, and answers in a turn of its own.

The store reports a run once (`Store.SetOnFinish`, guarded by a flag that is never serialized), from
whichever side reached a terminal status first: the worker that unwound it, or a cancel that took it out of
the queue before a worker ever saw it.

The tool's own answer carries the same distinction, because the agent's next move depends on it. A press
reports one of three things, from the moment the run exists rather than later: a **run id**, so a message is
coming; a **refusal with the page's own reason** — no model set, nothing to generate from, stopped before it
started — which is also a failed call, since a quiet success would leave the agent waiting for a message
that will never come; or, if the page says nothing within 15 s, that **no run has been reported** and it may
still be setting up (a reference uploading, a node hydrating), with both outcomes named. The middle of those
is the reason this answer exists at all: "started" has to mean a run id, not the absence of an error.

**Why** `generate` is answered the moment the run is queued, because a picture takes minutes and a tool call
is not a progress bar. So the agent's turn can end — usually does end — with the work still going, and the
tool's own answer said only "the node shows its own progress". The agent that started a two-minute video
then waits for a message that never comes, and the user says "it's done" by hand. That is the whole defect.

Two shapes were rejected. Keeping the pairing in the page — the promise `generateNode` returns, and a send
when it settles — is a hundred lines shorter and dies on the one occasion this exists for: reload the tab,
or leave the canvas and come back, and the run goes on while the memory of who asked goes with the page.
Deriving it instead from the tool call at the gateway is a timing heuristic: the call knows the session and
the node but not the run (the page's own button creates that), so "the next run on this canvas" would
attribute a user's own generation to an agent that happened to be idle.

It is sent as a *user* message rather than a frame of its own, because the conversation belongs to the agent
and a finished run is the kind of thing a person would tell it. Anything else would need AlayaCore to grow a
frame.

**Cost** One more optional field on the run body, threaded from the tool handler through `handleGenerateNode`
and the four generation modes to each API helper (`askedBy` on `RunRequest`), one hook on the task store, and
a callback the other way for "a run exists" (`onStart`, fed from the `onRun` hooks the canvas already had
and from the video task's own return). The tool call now blocks until that word arrives — a second at most in
practice, capped at 15 s against the MCP call's own 30.

What this serves is the canvas conversation. A node panel's agent is one-shot: its session is released with
its answer, so a run it started has nobody left to tell and reports into the log.
A session that is gone when the run ends hears nothing, and the log says so: the message is not queued for
the next process. The ask is a *name*, which is what lets it survive a reload — and also what lets it
outlive a conversation cleared mid-run, whose successor under the same name would be told about a run it
never asked for. A text node's generate is not a run — that node's own agent writes the answer into it — so
it is not reported, and the tool's answer says so instead of promising a message. `generate`'s description
and answer now set the expectation ("you will be sent a message; do not poll"), which is the other half of
the feature: an agent told nothing waits, and an agent told too little polls.

**Tested** `internal/task/task_test.go`: `TestTheEndOfARunIsReported` (a run that worked, one that failed,
one nobody asked about — with `Ask` intact on the snapshot the hook receives) and
`TestACancelledRunIsReportedOnce` (a queued cancel is reported by the cancel; a cancel that lands mid-run is
reported once, not again by the worker that unwinds afterwards). `internal/server/run_notice_test.go`: the
body parsing, and the three sentences. `internal/agent/session_test.go`:
`TestTellSendsTheWordsAsAPrompt` (the words leave as one `UX` frame flushed with `UE`) and
`TestTellReportsASessionThatIsGone`. `internal/server/agent_e2e_test.go`:
`TestARunFinishingTellsTheAgentThatAskedForIt` — a real run on the fake ComfyUI, the socket relaying the
echo and the fake agent's reply — and `TestARunNobodyAskedAboutTellsNoOne`, where nothing is said on the
socket at all. `frontend/tests/api-runs.test.ts`: the body carries `askedBy`, and does not carry it when nobody asked.
`frontend/tests/agent-generate.test.ts` (4): the three answers — a run id with no claim of failure, a refusal
carrying the page's reason *and* "nothing to wait for", and the unmatched case naming both outcomes — plus
the flag that makes a refusal a failed call. `go test ./internal/...`, `make check`, `npx vitest run` (210),
`npm run check`, `npm run build`. In the browser: not exercised — the panel shows the notice because it shows every user message, and
that path is covered, but the round trip was read from a socket, not off a screen.

**Where** `internal/task/task.go` (`Ask`, `SetOnFinish`, `finishedLocked`, `finish`),
`internal/server/run_notice.go`, `internal/server/routes_runs.go`, `internal/server/runs.go`,
`internal/server/server.go`, `internal/server/routes_mcp.go`, `internal/agent/sessions.go` (`Tell`),
`internal/server/agent_e2e_test.go`, `frontend/src/services/api/{runs,image,audio,video}.ts`,
`frontend/src/pages/canvas/hooks/{use-canvas-agent-tools,use-generation-runs}.ts`,
`frontend/src/pages/canvas/project.tsx`, `docs/protocol.md`, `docs/server.md`.

## 226. The start script rebuilds the binaries too, not only the bundle

**Decision** `./start.sh` runs `make build` when `bin/comfyloft-server` or `bin/comfyloft-mcp` is missing or
older than `cmd/`, `internal/`, `go.mod`, `go.sum` or the `Makefile`. It is the rule #181 already applies to
the canvas bundle, and it replaces the check that only asked whether the gateway binary existed.

**Why** "Is the binary there" answers *has this ever been built*, not *is this the build this tree makes*.
Edit a `.go` file, run `./start.sh`, and the previous binary starts — silently, with the bundle beside it
rebuilt from the new sources. That is the failure #181 was written to end, one half worse: the two sides are
then from different trees, so they can disagree about the protocol instead of both being merely old — a
panel waiting for a `usage` event from a gateway that predates it, with nothing in the log to say so.

**Cost** One `find` per binary per start — the cost #181 already accepted, and Go's build cache makes the
rebuild itself a fraction of a second when it happens at all. The `Makefile` is on the list because the build
recipe is part of what produces the binary; the data files are deliberately not, since `workflows/`,
`resources.json` and `prompts/` are read at run time and nothing is embedded (#219).

A release directory holds neither `cmd/` nor `internal/`, so there is nothing newer to find, the check passes,
and no toolchain is asked for — which is what keeps "a static binary and nothing else" a supported layout.
That is also the case the error message has to serve: a binary missing on a machine with no `go` now says
both halves of it ("missing or older than their sources, and there is no Go toolchain here; run: make build").

**Tested** By hand, against a copy of the script that stops before `exec`: nothing touched → no build;
`touch internal/server/run_notice.go` → "→ building the gateway and the bridge (missing, or older than their
sources)", both rebuilt; immediately again → no build; `bin/` and `frontend/dist/` copied into a directory
with no sources and started under `env -i PATH=/usr/bin:/bin` → starts, no toolchain needed; the same copy
with `bin/comfyloft-mcp` removed → exit 1 with the sentence above. The script is not part of `make check`.

**Where** `start.sh`, `README.md`.

## 227. A node remembers the run that made it: the workflow, and when it finished

**Decision** A node's metadata carries two more facts about its own content — `workflow` (the gateway's id
for what ran: `image-z-image-turbo`) and `generatedAt` (the instant that run finished, ISO 8601 in UTC,
kept verbatim). They are written when the run's file becomes the node's content, and erased while a node's
picture is being replaced by a new run — the old one is gone, and the run that made it describes nothing.

The facts ride on the *artifact* rather than being passed to each node patch. `Run` already answers both —
`workflow` and `finished_at` — so `factsOf(run)` (`services/api/runs.ts`) puts them on what
`generatedImage` / `generatedVideo` / `generatedAudio` return, and the three metadata builders
(`imageMetadata`, `videoMetadata`, `audioMetadata`) turn them into node fields. Every path from a finished
run to a node goes through those two places: a live run, a batch fill, an in-place regeneration, a resumed
poll after a reload, a retry, an inpaint or upscale child. A picked file, a crop, a mask: no run on the
artifact, and the fields are simply absent.

The canvas tools then say it, in one place: `generationClause(metadata)`
(`lib/canvas/node-generation-facts.ts`) returns `made 2026-11-03T13:09:19.928Z with image-z-image-turbo`.
`list_nodes` puts it on the node's line, before the prompt; `read_node` ends its answer with it. The node
information dialog shows the same two facts as rows, and the timestamp there is rendered in the reader's
own clock — a person is looking at their own machine, a model is not.

**Why** A node held everything about a picture except what made it and when. `metadata.model` was there but
unreachable through any tool, and held the *pick* (`default::image-z-image-turbo`), which the settings can
rename or delete after the fact. There was no time anywhere on the node at all.

The time was recoverable in principle, and every route was worse than writing it down. The run record has
it (`createdAt`, `startedAt`, `completedAt`) but is pruned (`TASK_RETENTION_DAYS`, `MAX_STORED_TASKS`) and
names only `object: "image"` — no node — so a run cannot be traced back to what it drew. The output file's
name carries the run id (`files/task_<id>.png`) and its mtime is the moment it was written, which is a
derivation through two accidents; `imageRunId` is cleared when the image lands, so even that link is gone
for pictures (video keeps `videoTaskId`). The canvas's `updatedAt` is the whole document. The node id's
leading number is when the *node* was created — a node re-run in place keeps its id, so it answers a
different question. And the agent has no HTTP path to `/api/runs` at all: its tools are the canvas ones.

So an agent asked "which model drew this, and when" could only guess from the prompt, and the honest answer
was "I cannot tell". Worse for the case that made this worth fixing: a canvas with a dozen pictures from
three models, where the question is precisely *which* of them drew the one under discussion.

**Cost** One optional field on the two artifact types, two optional fields on `CanvasNodeMetadata`, and one
`{workflow: undefined, generatedAt: undefined}` patch (`NO_MAKER`) where a node forgets its maker. The
`list_nodes` line grows by about fifty characters per generated node — accepted, because the alternative is
a `read_node` per node, and that answer carries the picture's bytes.

What this does not cover: a text node's answer is not a run (its own agent writes it), so it has no
`generatedAt`; it keeps `model` and nothing else. Nodes written before this decision have neither field and
their tools say nothing about a maker — there is no backfill, and inventing one from the filename would put
a guess where every other fact here is a record. The one other way a node's content could once change
without a run — the user putting their own file into an existing node — no longer exists (#228), which is
also why `model` no longer has to be scrubbed from a clip or a sound that a picked file replaced.

**Tested** `frontend/tests/api-runs.test.ts`: `factsOf` — the workflow with `finished_at`, the `created_at`
fallback, nothing for a run that names no workflow, nothing for one with no time; the artifact carries the
two facts; and the seam — a finished run through `generatedImage`, `imageMetadata` and `generationClause`
comes out as `made 2026-11-03T13:09:19.928Z with audio-minimax-music-3`, which is the sentence the two
tools print. `frontend/tests/canvas-node-metadata.test.ts`: all three builders stamp both fields from the
artifact's run, and a file nothing made has neither. `frontend/tests/node-generation-facts.test.ts` (4):
both facts, workflow alone, time alone, and nothing at all for a node nothing made (or another node's empty
strings). `npx vitest run` (222), `npm run check`, `npm run build`, `make check`, `go test ./internal/...`.
Not exercised against a live gateway in a browser: the wire was already carrying `workflow` and
`finished_at`, so what is untested on screen is the two dialog rows and the two tool sentences, and the
sentences are unit-tested.

**Where** `frontend/src/services/api/runs.ts` (`RunFacts`, `factsOf`),
`frontend/src/services/image-storage.ts`, `frontend/src/services/file-storage.ts`,
`frontend/src/lib/canvas/generated-media.ts`, `frontend/src/lib/canvas/canvas-node-factory.ts`,
`frontend/src/lib/canvas/node-generation-facts.ts`, `frontend/src/types/canvas.ts`,
`frontend/src/pages/canvas/hooks/{use-canvas-agent-tools,use-generation-runs}.ts`,
`frontend/src/components/canvas/canvas-node-hover-toolbar.tsx`, the two locales,
`internal/server/routes_mcp.go` (the two tool descriptions).

## 228. A file enters the canvas as a node, never into a node

**Decision** A node is never handed a file. Every file the user brings — dropped, pasted, or chosen in the
picker — becomes a node of its own, made complete in one step: the bytes are uploaded and the node is built
with the media already in it. The per-node upload is gone: the image quick tool `replace`, the empty image
node's upload button, and the clip's and the sound's `替换视频` / `替换音频`. What is left of the picker is
one entry in the canvas menu, and it makes new nodes exactly as a drop does.

**Why** The feature was inherited, not decided: it came in with the initial import, and no entry in this
file ever argued for it. What it did was put a new file into a node that already held one, so every claim
that node made about its content had to be scrubbed — `model`, `size`, `quality`, `generationType`,
`references`, a `mask` storage key, the run id it was still polling, the preview of a frame being drawn —
and the three branches that did it (image, clip, sound) each scrubbed a different subset. None scrubbed all
of it: an image node replaced by a clip kept `imageMode`, `outpaint`, `layout` and a mask the cleanup then
kept alive forever; a clip replaced by a sound kept `videoTaskId`. The picker also took *any* kind of file
for *any* node, so choosing a video for a sound node silently changed that node's type and left both kinds'
fields on it. Adding `workflow`/`generatedAt` (#227) would have meant a fourth thing to scrub in three
places, which is what surfaced the whole shape.

None of it is needed. What replacement bought was the node's id — its connections, its group, its position
— and that is a *graph* edit, not a content edit. Graph edits are what the agent already does:
`create_node`, `connect`, `move_node`, `delete_node`, `focus_node`. "Use my picture instead, and keep the
wiring" is therefore a thing it can already say, one visible step at a time, and a person can do the same
by hand. What no amount of scrubbing recovers is a node claiming the wrong maker for what it holds — and
that is what this removes: on a canvas where the core is the agent's workflow, the old feature's only
remaining product was the debris the agent would then be told about as fact.

**Cost** Three entry points with their handlers, and `use-content-ingress`'s entire target mechanism
(`uploadTargetRef`, the three replacement branches — about ninety lines), whose file filtering and
staggered placement collapsed into one `addFiles` that the drop and the picker share (a paste is one image
at the centre and was already its own line). Six i18n keys. One image quick tool. The one entry that
still opens the picker is named after what it does — `canvas.toolbar.import`, 导入文件 / Import files — since it
imports files *as nodes*; "upload" named the mechanism and promised a destination there no longer is.

What is lost: a node that is already placed, wired and grouped can no longer take a local file in place —
the file becomes its own node, and the old one is deleted or rewired. If that gesture turns out to be
missed, it should come back as *dropping a file onto a node*: one gesture, one meaning, and only then does
the question "what does the node keep?" have to be answered. A settings blob that still lists the `replace`
quick tool is harmless: `normalizeImageQuickToolIds` returns only the ids it knows, so the stored one drops
out by itself.

**Tested** `npm run check` — the i18n script found exactly the six keys this removes and nothing else;
`npx vitest run` (222, unchanged: no test covered the removed paths); `npm run build`; `make check`. Not
exercised in a browser: the four gestures (drop, paste, menu picker, and the buttons that no longer exist)
were read, not clicked.

**Where** `frontend/src/pages/canvas/hooks/use-content-ingress.ts`,
`frontend/src/components/canvas/canvas-node-hover-toolbar.tsx`,
`frontend/src/components/canvas/canvas-image-toolbar-tools.tsx`,
`frontend/src/pages/canvas/project.tsx`, `frontend/src/i18n/locales/{en-US,zh-CN}.ts`.

## 229. A node's words are three fields with three meanings, and each question has one function

**Decision** `content` is what a node holds; `prompt` is the words it will be asked next (the ones that
made it, for a node a run made and nobody has retyped since); `composerContent` is what you type when it
already holds something, so typing cannot throw the result away. The canvas asks three
questions of those fields, and each has exactly one answer, in `lib/canvas/node-prompt-field.ts`:
`nodeContentOf` (what it says), `nodePromptOf` (what was asked of it), `promptPatch` (where an instruction
goes). The panel and the agent's `set_prompt` call `promptPatch`, so they cannot write different fields for
the same words. `holdsResult` is no longer a whitelist of text and image: every content type answers by
whether `content` is there.

The agent gets the verb it was missing. `set_text(nodeId, text)` writes a text node's card — the same thing
double-clicking the card does — and leaves its prompt alone, because rewriting an answer by hand does not
make the question untrue. `set_prompt` keeps writing the question, and on a text node that already says
something its answer says so: *that is the question it will answer next, not its text*.

`list_nodes` names the two kinds of words apart (`content:` / `prompt:`) and collapses a prompt's
paragraphs onto one line, which is what "one line per node" always promised. `read_node` answers with what
the node holds — a text node's card, every text of a batch, the picture itself — and no longer with the
prompt that made it. `create_node` stops advertising `lora`, which it has never been able to make.

**Why** One function with a chain of fallbacks — `composerContent ?? prompt ?? content ?? texts[0]` —
answered all three questions, and that is fine exactly as long as no node's content is words. Reading a
picture answered with its prompt and nobody minded, because the picture came along in the same answer. A
text node's content *is* words, so the chain answered "what does this node say" with the question that was
asked to make it: the agent could read the prompt box and never the card, and when it was asked to change
the text it wrote the only field it could see. That is the screenshot that started this — a text node still
saying 宫崎骏风格的森林。 with 宫崎骏风格的森林场景，无文字… in the box below it. It was not misuse. The tools told
one story and the canvas told another, and the tools won because that is what an agent acts on.

The same chain hid three more of itself. An imported picture has `content` and no `prompt` at all, so the
fallback made `read_node` answer with `/api/canvases/…/files/a.png` and `list_nodes` print it as the node's
prompt — a file path where words were promised, and #228 has just made imports the common case. A film or a
sound holds a result as plainly as a picture, but `holdsResult` said otherwise, so the next instruction
overwrote `prompt` and the words that made it were gone; the artifact-protection rule (#91) applied to
pictures only. And a config node's panel writes `composerContent` while `set_prompt` wrote `prompt` — both
read, so it worked, but the claim that the tool writes where the panel writes was false for that type.

**Cost** One new tool (`set_text`), one new module (`lib/canvas/canvas-agent-view.ts`, so the list's format
is testable without a page), and the tool functions moved out of the hook
(`lib/canvas/canvas-agent-tools.ts`) for the same reason: they are decisions, not wiring. The panel's
`onPromptChange` prop and `project.tsx`'s `handleNodePromptChange` are gone — one writer for one field.

What this does **not** do: it does not make a text node hold one field. A card written by an agent needs a
question standing beside it, so the two fields stay; what goes away is five different stories about which
one a word lives in. `composerContent` also stays, with one reason: a node that already holds something
must be able to take an instruction without losing it.

`prompt` is a question, not evidence of provenance, and the labels now say so: editing a card by hand —
which the user can always do, and `set_text` does on their behalf — leaves the question those words no
longer answer, because that is still what running the node sends. Nothing is left claiming to have made
them: a text node has no run behind it, so #227's maker facts are stamped on media only, and there is no
second field to scrub. That is the line between this and #228 — a file entering a node had ten fields
describing bytes that were gone; a hand editing words has none.

The placeholder had to change with it: 「请输入你想要将本段文本修改成什么」 promised a revision the code never
did — generating a text node asks the question again and replaces the card (see the comment in
`handleGenerateNode`), it does not hand the old answer over. The box now says what the button does
(「说你想让它写什么，生成会替换现有文本」 / "Say what it should write; generating replaces this text"), and
editing the text itself is the card — by hand, or with `set_text`.

**Tested** `npx vitest run` (252: 13 for `set_text`/`set_prompt`/`read_node`/`generate`/`create_node` as
called with a fake page, 12 for the field rules, 5 for the list's format). `npm run check` (i18n 847/833,
no dead keys; exports: no export without a caller — `holdsResult` and `promptFieldOf` are internal now and
the tests reach them through `promptPatch`). `npm run build`. `make check`, including the tools/list
assertion, which now expects `set_text` in the vocabulary, and the system-prompt assertion, which now
requires `canvas_set_text`. Not exercised in a browser: what is untested is what a person sees — the new
placeholder text, and the agent's own choice between `set_text` and `set_prompt` in a live conversation.

**Where** `frontend/src/lib/canvas/{node-prompt-field,canvas-agent-view,canvas-agent-tools}.ts`,
`frontend/src/pages/canvas/hooks/use-canvas-agent-tools.ts`,
`frontend/src/components/canvas/canvas-node-prompt-panel.tsx`, `frontend/src/pages/canvas/project.tsx`,
`frontend/src/i18n/locales/{en-US,zh-CN}.ts`, `internal/server/{routes_mcp.go,agent_instructions.go}`,
`internal/server/mcp_test.go`, `frontend/tests/{node-prompt-field,canvas-agent-view,canvas-agent-tools}.test.ts`.

## 230. A wire carries what a node holds — never what it was asked

**Decision** A node gives away its content and only its content. Every reader that is not the node itself —
a wire into another node, the reference bar, the @ list, the side panel, the export, the agent's citation
block, the "make a picture from this text" button — answers through `nodeContentOf`. A node's prompt is
private: it is what the node was asked, it is read only by the node (its own panel, its own run, its own
Info popover), and it never travels down a wire. There is no fallback and no substitution: a node that holds
nothing gives nothing.

What follows from that:

- `readNodeTextInput` is gone. It returned `content || prompt` for a text node and `prompt` for everything
  else, which is how an empty picture node came to offer the words it was asked as though they were
  something it held.
- A run refuses a wire that would carry nothing, and names the node: `inputsHoldingNothing` +
  `describeEmptyInputs` in `canvas-node-generation.ts`, asked at the top of `handleGenerateNode` and again by
  the agent's `generate` before it presses. A person reads a toast in their own language; the agent reads a
  sentence through #225's refusal channel, which already says "there is nothing to wait for, and why". The
  refusal tells empty, still being made and last run failed apart, because what to do about them is
  different. The tool asks as well because a text node's press reports nothing back: it streams, so there is
  no run id to report, and without the pre-check the agent would be told an answer was on its way when
  nothing had started. (#231 then took away the one type that made this rule need a hub walk.)
- `applyPromptResult` (the panel's optimize path) writes the prompt and nothing else. It was the last place
  the pre-#229 model survived: one sentence written into `content`, `prompt` and `composerContent` at once.
- `generateImageFromTextNode` reads `nodeContentOf` and no longer stamps the same words on the text node's
  `prompt`, which nothing had asked it.
- The panel says `nothingToSend` instead of returning silently when there is nothing typed and nothing on
  the other end holding words. An empty node is not an input, so that is the state a half-wired canvas
  reaches, and a button that does nothing is the one answer nobody can act on.
- `runTool`'s unknown-tool answer names the real cause: the page in front of the user was built before the
  tool list the agent was given. The old wording — "this canvas has no tool called set_text" — sent an agent
  hunting for a naming bug that was not there.
- The agent's system prompt states the rule in one paragraph, next to "say a thing once", because that is
  the paragraph it already reads when it is about to wire something up.

**Why** The rule is the user's, and it is one sentence: *the node above hands its content down the wire; its
prompt is private*. Ten places broke it, all with the same shape — `content || prompt`, and in the @ list
`content || composerContent || prompt` — because #229 gave the canvas `nodeContentOf` and then only taught
the agent's tools to use it. What that produced was not cosmetic:

- an empty picture node's prompt became a `【参考文本】` block inside the downstream request: the user wired a
  reference and got a sentence;
- an unwritten text card's question did the same;
- a text node with no card still counted as a text resource, so the @ list offered its question as its words;
- the export wrote the question into the `.txt`;
- the agent's citation line quoted the prompt of the node the user had pointed at.

And it is what the screenshot after #229 shows: asked to take the text out of three pictures, the agent wrote
`set_prompt` and then `set_text` with the same words. Its own reasoning says why — *"the connection adds the
text node's text (not its prompt) to the image generation, so I need to also update the text content"* — which
is a correct reading of a canvas that had told it two different things about where a text node's words live.
The first `set_text` had been refused by a page older than its tool list, so it did the thing that still
worked, and then the thing that was right. Both landed, and the card and the box ended up saying the same
sentence: no longer a lie about what the node holds, but a question nobody asked.

**Cost** `readNodeTextInput` deleted; three exports added (`inputsHoldingNothing`, `describeEmptyInputs`,
`generationInputCandidates`), all with a caller; the `EmptyInput` type stays internal. One i18n key pair
(`connectionHoldsNothing`) and one more (`nothingToSend`). A stale page now says what it is instead of what it
is not.

**What this does not do** It does not collapse a text node to one field. The card and the question stay two
fields, for the reason #229 gave: a card needs the question it answered to stand beside it, and
`composerContent` is what lets a node holding a result take an instruction without losing it. What changes is
who may read which.

There is no migration. A text node whose words were only ever in `prompt` now shows an empty card and gives
nothing away — the words are still in its panel box, so the fix is to write them on the card (double-click,
or `set_text`), or to let the node answer the question. That is the strict reading the user chose over the
alternative that let the typing box also write the card: the card is the answer to a run, and typing in the
box must not pretend to be one.

`list_nodes` still prints `prompt:`. The agent is not another node — it is the operator's hands, and #229
labelled the field as the question it will be asked next so the agent can use it deliberately. `read_node`,
which is how the agent *reads a node*, still answers with content only.

`retryNode` composes its own request and keeps the old quiet behaviour: a retry of a node whose upstream has
been emptied runs with what is there. It is a recovery gesture on a node that already ran, and refusing it is
a different decision from refusing a first press — one to make on purpose, not by inheritance.

**Tested** `npx vitest run` (265: 13 new — a wire from an unwritten card carries nothing, a picture carries
itself and not its words, a wired node that holds nothing is named with its state, a group is read by what is
inside it, `generate` refuses before pressing for both a picture and a text node, and a tool name the page
does not know). `npm run check`
(i18n 849/835, no dead keys; exports: no export without a caller). `npm run build`. `make check`, whose
system-prompt assertion now also requires the wire rule. Not exercised in a browser: the toast wording, the
refusal naming a node the user is looking at, and whether the strict card reads well on a canvas written
before this.

**Where** `frontend/src/components/canvas/canvas-node-generation.ts` (the rule and the refusal),
`frontend/src/pages/canvas/project.tsx` (the refusal in front of every run, and the text-to-picture button),
`frontend/src/lib/canvas/{canvas-resource-references,canvas-export,canvas-agent-tools}.ts`,
`frontend/src/components/canvas/{nodes/builtin-nodes.tsx,canvas-side-panel-elements.tsx,canvas-node-reference-bar.tsx,canvas-node-prompt-panel.tsx,canvas-agent-panel.tsx}`,
`frontend/src/i18n/locales/{en-US,zh-CN}.ts`, `internal/server/{agent_instructions.go,mcp_test.go}`,
`frontend/tests/{canvas-generation-context,canvas-agent-tools}.test.ts`.

## 231. The config node is gone, and the panel framework that only it used

**Decision** `config` is no longer a node type. What went with it: its definition and default size, its
`CanvasConfigComposer` ("组装提示词") and `CanvasConfigNodePanel`, the `generationMode` field and the
generation branches that read it, the connection rules that existed only to point a wire at one or draw a
wire from one, `findRetrySourceNode` (a walk upstream that looked for one), the `hasSourceHandle` flag (false
only there), `renderNodeContent` (the renderer hook only it used), `useBuiltinPanel` and its `writeBackToSelf`
branch (a node borrowing the built-in panel to generate), the text node's "用文本生图" toolbar button (it built
one), `kit/media.tsx` (whose only caller was the composer's image preview), four i18n namespaces
(`canvas.composer`, `canvas.configNode`, `canvas.createMenu.config*`, `canvas.nodeTypes.config`,
`canvas.sidePanel.filter.config`) and the `sentPrompt` plumbing that only its panel read.

With no type that could generate into a *new* node, the four run functions stop asking. **Generating writes
in place** — which is what #77 decided and what the image run already did: the `isImageNode` / `reuseTextNode`
/ `reuseVideoNode` / `reuseAudioNode` branches, the nodes they spawned, the connections they added and
`pendingChildIds` (always `[nodeId]` now) are all gone.

**Why** The config node was a card whose only job was to hold a prompt and make nodes. After #229 and #230
every node holds its prompt: the box is the question, the card is the answer, and `composerContent` is what
you type when the card is not to be thrown away. What it alone could do:

- *Keep the old result and make another* — duplicating the node does this, and the copy carries the prompt,
  the model and the size with it.
- *`@` to choose which wired references go into the request* — the one thing with no replacement, and the one
  thing nobody used. It was also a trap: pressing generate after typing a prompt without any `@` silently
  dropped every wired picture, text and video (LoRAs excepted) while the panel still said 参考图 N 张.

Against that, it forced four special cases on everything else: a type branch in `promptFieldOf`, the only
node with no source handle, the only type that generated into a new node, and a hub rule — *a node wired
into a config node takes that config's other wires as its inputs* — that no decision ever explained, and
which #230's refusal then had to mirror so the check saw the same wires the request did.

It was also hard to find: the 新建 menu never offered it. Two gestures made one (drag a wire out to empty
canvas, or the text node's toolbar button), and the double-click menu listed it under a name — 生成配置 —
that nothing else used.

**What this changes for a person** Generating replaces the node's content, always. A variant is a duplicate
node or a second node fed by a wire. The text node's toolbar loses "用文本生图": wire the text node into an
image node instead — the same gesture the agent's instructions describe, and the one the panel already
supports.

**What this changes for the agent** `create_node` makes four types (`image`, `video`, `audio`, `text`).
`generate` no longer reads a `generationMode`. Nothing else: the tools it had for the config node were the
tools it has for any node.

**What this does not do** No migration. A canvas written before this that holds a config node renders it as
an unknown node (`canvas.node.missingNode`), which is what `CanvasNodeTypeId` was made open for: a saved
canvas is data, and a type this build does not have is a missing node rather than a refused file. Deleting
that card is the user's call, and nothing else in their canvas changes.

Also left alone, on purpose: `interactionToggle`, `forceInteractive`, `transparentBackground`,
`showInCreateMenu` and `hidePanel` in the node definition — the plugin framework #148 left behind. The config
node used none of them, so they are unrelated debt, and removing them touches how a node takes pointer
events. A separate decision, not this one.

**Tested** `make check`; `npx vitest run` (261 — the two config-node tests and the hub test are gone, the
rest unchanged); `npm run check` (i18n 824/810, no dead keys, and the stale `canvas.composer.resources`
exemption removed from the checker; exports: `buildNodeGenerationInputs`, `NodeGenerationInput`,
`getInputSummary` and `kit/media`'s `Image` lost their last caller and are no longer exported or no longer
exist); `npm run build` (the bundle lost ~24 kB). Not exercised in a browser: this one changes the generation
path for all four modes, so the first thing to try is a picture, a video, an audio clip and a text answer
each generated twice in place, plus opening a canvas written before it.

**Where** `frontend/src/types/{canvas,canvas-node}.ts`, `frontend/src/constant/canvas.ts`,
`frontend/src/components/canvas/{canvas-node,canvas-create-menus,canvas-node-hover-toolbar,canvas-side-panel-elements,canvas-agent-panel,canvas-node-generation}.tsx`,
`frontend/src/components/canvas/nodes/builtin-nodes.tsx`,
`frontend/src/lib/canvas/{canvas-resource-references,canvas-node-geometry,canvas-generation-helpers,node-prompt-field,node-settings-memory,canvas-agent-tools}.ts`,
`frontend/src/pages/canvas/project.tsx`, `frontend/src/pages/canvas/hooks/use-generation-runs.ts`,
`frontend/src/i18n/locales/{en-US,zh-CN}.ts`, `frontend/scripts/check-i18n.cjs`,
`internal/server/{routes_mcp.go,mcp_test.go}`, `frontend/tests/{canvas-generation-context,canvas-agent-tools,node-prompt-field}.test.ts`.
Deleted: `frontend/src/components/canvas/canvas-config-composer.tsx`,
`frontend/src/components/canvas/canvas-config-node-panel.tsx`, `frontend/src/components/kit/media.tsx`.

## 232. The node definition loses the flags nothing set

**Decision** `CanvasNodeDefinition` drops `interactionToggle`, `forceInteractive`, `transparentBackground`,
`showInCreateMenu`, `hidePanel` and `description`, and `CanvasNodeMetadata` drops `interactive`. What read
them is gone too: the interaction/move gate on content pointer events, the two transparent-border branches,
the two menu filters, the two panel-opening conditions and the description slot in the creation menu.

**Why** #231 left them as "separate debt"; reading them showed they were not debt but *inert*. No built-in
definition ever set any of them, and `metadata.interactive` had no writer anywhere in the tree — so
`supportsInteractionToggle` was always false, `contentInteractive` always true, `pointerEvents` always
`undefined`, `transparentBg` always false, and every `hidePanel`/`showInCreateMenu`/`description` check a
constant. They were the shape of the plugin framework #148 removed, kept as flags nothing could reach: a
branch nothing takes reads like a feature that exists.

**What this does not change** Nothing at runtime, by construction: every condition removed was constant. The
node card renders the same background, border and pointer events; the creation menus list the same entries;
a click opens the same panel.

**Tested** `make check`; `npx vitest run` (261); `npm run check`; `npm run build`; and one look at a real
canvas in the browser — cards, borders, the two creation menus, clicking a node to open its panel.

**Where** `frontend/src/types/{canvas,canvas-node}.ts`,
`frontend/src/components/canvas/{canvas-node,canvas-create-menus}.tsx`, `frontend/src/pages/canvas/project.tsx`.

## 233. A prompt is read on purpose: `read_prompt`, and out of the list

**Decision** The agent gets `read_prompt {nodeId}`: the words a node will be asked — the prompt its own panel
shows, and the words `set_prompt` writes. `read_node` stays what it is (what the node *holds*), and the two
are named as a pair. `list_nodes` stops printing `prompt:`: a line carries `content:` and nothing else.

**Why** #230 made a prompt private between nodes and #229 taught the tool that wrote it to say which kind of
words it was, but the list still carried every node's prompt on every call. Two costs, neither about privacy
as such:

- **Size.** A canvas of forty nodes sent forty prompts whether or not the question was about prompts, and the
  list is the tool an agent calls most.
- **Attention.** A prompt on the line is a fact the agent did not ask for and may act on, which is how the
  screenshot that started #229 happened — a text node's question read as its body because it was simply
  there. A prompt one call away is a prompt someone wanted.

So the pair is now explicit: `read_node` for what it holds, `read_prompt` for what it will be asked. The
answer says which is which where the two are easiest to confuse — a text node's card is what it says, its
prompt is what it will be asked next — and points at the other tool.

**What this does not buy** Privacy against the agent. It runs as a child process in the project root with
`read_file` enabled (that is how it opens a skill), so `canvases/<id>/canvas.json` is readable and holds every
prompt on the canvas. Removing `prompt:` from the list removes an accidental read, not a possible one; a real
boundary would be a sandbox, which is a separate decision.

**Tested** `npx vitest run` (265: four new for `read_prompt` — the question, the empty answer, a picture's
prompt, a node that is not there; and the list's format test now asserts a prompt is *not* on the line).
`make check`, including the tools/list vocabulary (now twelve names, `read_prompt` after `read_node`) and the
system-prompt assertion, which now requires `canvas_read_prompt`. `npm run check`. `npm run build`. Not
exercised in a browser: what to look for is one live conversation — "这张图当时用的什么提示词" answered from
`read_prompt`, and a canvas of many nodes whose `list_nodes` is shorter than it was.

**Where** `internal/server/{routes_mcp.go,agent_instructions.go,mcp_test.go}`,
`frontend/src/lib/canvas/{canvas-agent-tools,canvas-agent-view}.ts`,
`frontend/tests/{canvas-agent-tools,canvas-agent-view}.test.ts`.

## 234. A watch is not the job: neither end gives up on a run that is still out

**Decision** The gateway stops giving up on a run that is still out, and the second way to re-run a node is
gone. (The browser half of this decision was a retry loop that waited three minutes; #235 replaced it with
making a reload actually re-attach, for all three kinds of content.)

- **Browser ↔ gateway** (`waitForRun`, `services/api/runs.ts`): the watch ends when a read fails, and the node
  keeps the run id so the next open of the canvas re-attaches (#235). What this decision ends here is the
  *other* half: the node no longer treats "could not ask" as "the run failed" by throwing the id away.
- **Gateway ↔ ComfyUI** (`waitForHistory`, `internal/generate/runner.go`): the same rule one layer down. A
  `/history` poll that could not be made is retried until the run's own timeout; a 4xx — ComfyUI saying it
  will not run this — still ends the task at once, because asking again gets the same sentence. When the
  timeout does arrive after an outage, its message says so instead of pretending the render was just slow.
- **`retryNode` is deleted**, with `resolveMetadataReferences`, `sourceNodeReferenceImages`, and the three
  ways in: the hover toolbar's 「重试」, its 「获取任务状态」, and the error banner's button. The banner keeps
  the reason and nothing else. Running a node again is the generate button, which is where running it the
  first time was.

**Why** The user's reading was right and mine was muddled: on "the run is still out" the canvas has exactly
one duty — keep watching. There were two loops, and both of them treated "could not ask" as "the answer is
no":

- One dropped `/history` request ended the task while ComfyUI went on rendering it. That is the expensive one:
  a video's minutes are paid for and nobody collects the clip, and the user is told the run failed when it
  did not.
- The browser ended the watch on one failed poll, so a wifi blip or a busy gateway showed up as 查询失败 with
  a live render behind it.

And the retry button was a second generation path beside `handleGenerateNode` — with its own composition, its
own reference resolution (from what the failed attempt recorded, not from the connections the canvas shows)
and therefore its own drift: it ignored #230's empty-wire refusal and reported nothing to the agent. Deleting
it removes a mechanism, not a convenience: a node that failed is a node to fix and press generate on, and
that is the same button the agent uses.

**What this does not do** A **gateway restart** still loses the run: the job is a goroutine in the gateway,
and a task that was `running` on disk is loaded as `failed` ("the gateway restarted before the task finished",
`internal/task/task.go`). The record keeps its ComfyUI `PromptID`, so re-attaching *there* is possible — that
is a queue-recovery decision, not this one, and it is the only thing left between here and "the run belongs
to nobody but ComfyUI".

**Tested** `make check` (two new: a `/history` outage is waited through and the completed answer still lands;
a 400 ends the task without burning the timeout). `npx vitest run` (268: three new for `waitForRun` — an
unreachable gateway is asked again and the run is picked up, a 404 stops at once, the budget says
`runUnreachable`). `npm run check` (i18n 820/806, both new keys used). `npm run build`. Not exercised in a
browser: the case worth trying is stopping ComfyUI mid-video and starting it again — the node should keep its
progress and finish, not turn red.

**Where** `frontend/src/services/api/runs.ts`, `frontend/src/pages/canvas/hooks/use-generation-runs.ts`,
`frontend/src/lib/canvas/canvas-generation-helpers.ts`,
`frontend/src/components/canvas/{canvas-node,canvas-node-hover-toolbar}.tsx`,
`frontend/src/pages/canvas/project.tsx`, `frontend/src/i18n/locales/{en-US,zh-CN}.ts`,
`frontend/tests/api-runs.test.ts`, `internal/generate/{runner.go,generate_test.go}`.

## 235. One name for the run, one rule for surviving a reload

**Decision** Five leftovers of the same kind, all of them somewhere between "a run outlives the page" and
"what the node keeps when the page goes away":

- **One field.** `runId` on the node metadata, for every kind of content. It was three —
  `videoTaskId`, `audioRunId`, `imageRunId` — named after the order the three were moved onto the gateway. A
  canvas written before this is read into the one field when it is opened (`adoptLegacyRunIds`), so a run that
  was in flight then is still picked up.
- **One predicate.** `hasResumableRun` — content node, a run id, nothing to show yet — for all three. It used
  to be three predicates, and two of them also demanded `status === "loading"`, so a node in error could never
  re-attach: one failed poll left an audio or image node permanently unable to resume, while video resumed
  whatever its status said.
- **One pass.** The two resume effects (video on one gate, audio and image on another) become one, which
  dispatches to the poller for the kind of content it is, once per opened canvas.
- **One rule for a failed watch.** `failedWatch`: a `RunFailedError` means the gateway answered about the run
  — it failed, so the node says so and lets the id go. Anything else means the question did not get there, so
  the node keeps the id and says it could not confirm the run, and the next open picks the watch up. Before
  this the two pollers threw the id away on *any* error, which is what made "just reload" impossible for
  audio and image.
- **One error type for a failed run.** `VideoTaskFailed` is gone: `waitForVideoRun` used to rewrap
  `RunFailedError` under a video-only name, which is why the rule above would have needed three variants.

Also gone: `clearStaleNodeErrors`, which ran straight after `resetInterruptedGeneration` and turned every
error back to idle — including the "generation was interrupted" message that had just been written. Net
effect: a run that a page refresh killed came back as a silently idle node. A canvas now says what happened,
and an error that was already on the canvas when it was closed is still there when it is opened.

**Why** The user's model was the right one and the code kept contradicting it in small ways: *the run belongs
to the gateway, so refreshing the page is how you re-attach.* Every item above is a place where that was not
true — two of the three kinds could not re-attach at all, the id was destroyed by the failure that most needed
it, and the one message that explained a lost run was deleted on the next line by another function.

The three names were also the reason the rules had drifted: three fields invite three predicates, three
predicates invite three gates, and nothing compares them.

**What this does not do** It does not make a **gateway restart** survivable: the job is a goroutine in the
gateway, and a task that was `running` on disk loads as `failed` ("the gateway restarted before the task
finished"). The record keeps ComfyUI's prompt id, so re-attaching *there* is possible — a queue-recovery
decision, still open.

**Tested** `npx vitest run` (264: `canvas-resumable-runs` now covers the one predicate, the interrupted
message, errors surviving an open, the legacy names being read into `runId`, and `failedWatch` both ways; the
video task contract test now expects `RunFailedError`). `npm run check` (i18n 820/806, `runUnwatched` used).
`npm run build`. `make check`. Not exercised in a browser: the case worth trying is a run left in flight —
close the tab mid-render, open the canvas again, and it should still be watching, for a picture, a clip and a
sound alike.

**Where** `frontend/src/types/canvas.ts`, `frontend/src/lib/canvas/canvas-generation-helpers.ts`,
`frontend/src/services/api/{runs,video}.ts`, `frontend/src/pages/canvas/{project.tsx,hooks/use-generation-runs.ts}`,
`frontend/src/components/canvas/canvas-node-hover-toolbar.tsx`,
`frontend/src/i18n/locales/{en-US,zh-CN}.ts`,
`frontend/tests/{canvas-resumable-runs,api-runs,api-video-runs,model-selection}.test.ts`.

## 236. A restart costs the progress bar, not the run

**Decision** The gateway picks up the runs it was watching when it stopped.

- **The record survives.** `task.Load` no longer fails a task that was `running` or `queued` *and* has a
  prompt id: nobody submitted nothing, ComfyUI has been rendering it the whole time, and the only thing the
  dead process took with it is the goroutine that was watching. Such a task is marked `Resumed` and left
  alone. A task with no prompt id was never submitted, so it is failed with the reason it already had.
- **Collecting, not resubmitting.** `Runner.Collect` takes a prompt id and does the half of a run that is left:
  wait for `/history`, download the files, hand them back. Nothing is submitted, nothing is paid for twice.
- **Resumed first.** `resumeInterruptedRuns` runs before the server serves anything, so the queue that was
  interrupted is the queue that resumes. It hands the task back by **id** (`Store.Resume`), because `Get` and
  `List` hand out *snapshots*: enqueuing one of those runs the job against a copy — the output file lands in
  the canvas, and the record the canvas reads stays `running` for ever. That is not a hypothetical: the first
  version of this did exactly that, and a video sat finished on disk with the node still saying 等待结果.
- **The canvas says so.** `resumed` is in the run payload, and a node watching a resumed run drops its step
  ring and says 等待结果 / "Awaiting result — reattached after a gateway restart, so there is no progress to
  show". The step count and the preview frames come from ComfyUI's socket bound to the process that
  submitted; without that process there is nothing honest to draw, and a frozen bar reads as "stuck".

**Why** #235 made a *reload* survivable and left the one case that costs real money: restarting the gateway
mid-video. The render keeps going on ComfyUI — the gateway simply stopped watching — so recovering it is one
`/history` call and the download that was going to happen anyway. The alternative (start over) pays for the
same minutes twice and leaves ComfyUI working on a clip nobody will collect.

**What this does not do** No progress for a resumed run, by construction (see above). A task that was *queued*
and not yet submitted is lost by a restart — it never cost GPU time, and pressing generate again is the fix;
that case is why `Resumed` is a per-task fact rather than a global "restart happened". And nothing survives
**ComfyUI** restarting: if its history does not know the prompt, the collect fails and the task says so.

**Tested** `make check` (three new: a submitted task comes back `Resumed` and alive while an unsubmitted one is
failed; `Collect` reattaches and never submits, and fails for a prompt ComfyUI does not know). `npx vitest run`
264. `npm run check` (i18n 822/808). `npm run build`. Not exercised in a real restart: the case worth trying is
a video mid-render, `Ctrl+C` and `./start.sh`, then watching the node say 等待结果 and finish with the clip.

**Where** `internal/task/task.go`, `internal/generate/runner.go`, `internal/server/{server.go,runs.go,routes_runs.go}`,
`frontend/src/types/canvas.ts`, `frontend/src/services/api/{runs,video}.ts`,
`frontend/src/pages/canvas/{project.tsx,hooks/use-generation-runs.ts}`,
`frontend/src/components/canvas/canvas-node.tsx`, `frontend/src/i18n/locales/{en-US,zh-CN}.ts`,
`internal/task/task_test.go`, `internal/generate/generate_test.go`.

---

## 237. An answer is drawn as the document it is, and a table scrolls in its own box

**Decision** The panel parses the text parts of an **assistant** message as a small Markdown subset, into
tokens, and draws the tokens with React. A table's cells do not wrap: the table's own box scrolls sideways.

- **Tokens, never HTML.** `lib/markdown.ts` turns the text into `MarkdownBlock[]` / `MarkdownInline[]`;
  `components/canvas/agent-markdown.tsx` maps them to elements. Nothing is ever set as `innerHTML` and no
  parser was added. Two reasons, and the first is not style: the words are a model's, quoting files on the
  canvas, in a page served over plain HTTP — a token tree cannot become a tag or an event handler, and
  `<img src=x onerror=…>` is asserted to stay eleven characters of text. The second is that a citation has
  to stay a button: `renderText` hands every run of text back to the panel's `withMentions`, so formatting
  and citing walk the text together instead of one rewriting what the other produced.
- **The subset is what an answer writes.** Headings, paragraphs, fenced code, quotes, rules, lists (nested,
  loose, numbered from whatever the model started on), tables with alignment, and inline code / strong /
  emphasis / strikethrough / links. Not in: images (a picture in this app is a node), raw HTML, footnotes,
  math, reference-style links, task-list boxes. A construct outside the subset is not an error — it stays the
  characters that arrived, which is also what a half-streamed `**` and a stray `|` end up as, and why an
  unclosed fence is the code written so far rather than a broken message.
- **A soft break is a break.** CommonMark makes a single newline a space; here it stays a line break, because
  that is what every reply already drawn under `whitespace-pre-wrap` did. Joining them would silently reflow
  the whole history of a conversation to fix a rule nobody asked for.
- **A table is the reason this exists**, and it must not resize the card: cells are `whitespace-nowrap` and
  the table is `w-max` inside a `max-w-full overflow-x-auto thin-scrollbar` box. Wide table, scrollbar under
  it, transcript and input exactly where they were.
- **Only the assistant's text.** What the user typed is drawn as typed — their asterisks are theirs. Reasoning
  (folded, one line) and errors stay plain too: neither is a document.

**Why not a library** Measured in a scratch directory, minified and gzipped: `marked` 14.2 kB plus a
sanitiser (+11.7 kB for DOMPurify, which is `MPL-2.0 OR Apache-2.0`) and it still produces HTML, so it cannot
interleave a citation button; `markdown-it` 40.7 kB and 7 packages, same wall; `react-markdown` +
`remark-gfm` 48.6 kB and **93 packages**, which is exactly what #35's audit spent its time removing; `snarkdown`
is 1.0 kB and has no tables. Handwritten: 0 packages, and the built entry grew 537.8 → 545.1 kB (160.1 →
164.2 kB gzipped) — the cost is a file to maintain and its tests, which is the price the rest of this panel
already pays.

**What a frame costs** An answer arrives one delta at a time and every delta re-renders the panel, so the
cost that matters is per frame, not per message. Measured in jsdom with a 4 kB answer streaming at four
characters a frame (absolute numbers are jsdom's and run high; the ratios are what the fix is about):

| transcript | before | after |
| --- | --- | --- |
| 1 answer streaming | 3.2 ms | 3.2 ms |
| + 10 finished 4 kB answers | **73 ms** | 3.5 ms |
| + 40 finished | — (never finished) | 3.6 ms |

Three things got it flat, and none of them is a cache:

- **A finished message is not rebuilt.** `AnswerBody` / `PlainBody` are `memo`, and their props are exactly
  what they read — text, the message's citations, the canvas's labels, the accent colour — all of them
  stable once a message is finished. Before this, every frame also parsed and rebuilt every finished answer
  in the transcript, which is what the 73 ms was.
- **The canvas's labels are mapped once per render** (`citationLabels`), not once per run of text. The old
  walk called the translator for every node on every run: 166 runs × 50 nodes per frame.
- **The citation tables are prepared once per message** (`mentionResolver`). Sorting the canvas's labels
  inside the per-run scan cost 6.5 µs a run — 1 ms of every frame — and it is the same answer every time.
  `mentionSegments` became the resolver's returned function; the queue that hands out one citation per
  occurrence stayed per call, because that is per text and not per message.

**Deliberately not done** The answer being written is still parsed and rebuilt whole on every delta. At 4 kB
that is 0.05 ms of parsing, so incremental block reuse would trade a real amount of machinery (stable block
keys, diffing a growing tail) for a rounding error. Also no virtualised transcript: the memo already makes a
long conversation cost the same per frame as a short one.

**Tested** `npx vitest run` 288 (24 new in `tests/markdown.test.ts`: paragraphs and soft breaks, heading
levels, a fence that keeps `**` and pipes verbatim, an unclosed fence mid-stream, rules against bullets,
quotes, lists that keep their indent / their start number / their loose spacing, tables with alignment, without
outer pipes, with an escaped `\|`, with a short row, with inline markup in a cell, and *not* a table without a
column-mark row or with one of the wrong width, `snake_case` staying a name, `a * b * c` staying arithmetic,
`\*` escaping, links to `https`/`mailto` opening and `javascript:` not, and raw HTML staying text).
`npm run check` (i18n 822/808, no dead keys; 173 modules, no dead exports). `npm run build`. `make check` 19
packages. The rendered markup was checked by hand — a reply with a heading, a three-column table, a nested
ordered list, a quote and a fence — not by a component test: `vitest` here runs `tests/**/*.test.ts` in a
`node` environment, so the renderer is exercised through the tokens it is given.

**Where** `frontend/src/lib/markdown.ts`, `frontend/src/components/canvas/agent-markdown.tsx`,
`frontend/src/components/canvas/canvas-agent-panel.tsx`, `frontend/tests/markdown.test.ts`.

---

## 238. Stopping is a choice: the queued words can outlive the task

**Decision** A cancel carries AlayaCore's optional `keep_steering` argument, and the panel offers the choice
exactly while there is a queue it would decide about.

- **The word is AlayaCore's and the gateway forwards it.** `Session.Cancel(args string)` writes
  `{"command_id":"cancel","name":"cancel","args":…}`; an empty word is the bare cancel, which is what the
  socket-closed path still sends. The gateway does not translate `keep` into anything — the same rule
  `agent.Request` already states for commands: the pair is forwarded, and what it means is the agent's.
- **The socket already had a field for it.** `socketMessage.Args` was a command's; a cancel now reads it too,
  so one action did not grow a second representation (`cancelArgs`, or worse a second message type).
- **One optional word at the far end**: `commands.CancelArgKeepSteering` = `keep_steering`, declared as
  `Optional(Token(...))` on `cancel` and read by `cancelSteeringFate`. Empty drops the queue and announces
  `steering dropped — the task was canceled before it was delivered`; `keep_steering` leaves it to
  `deliverLeftoverSteering`, which promotes it to the next prompt and reports the batch `delivered`. Only what
  is queued at the instant of the cancel is settled — anything typed after it is a fresh intent. A signal or a
  keystroke carries no argument, so those paths always drop, which is why "stop" cannot silently keep going.
- **The choice is asked at the moment of stopping**, in a dialog, and only when there is a queue to decide
  about: press stop with `steering > 0` and the panel asks 「还有 N 条消息在排队…要一起取消吗?」 with the two
  answers the command has — 保留排队 (`keep_steering`) and 一起取消 (bare). With nothing queued, stopping has
  one answer and the button is it: no dialog over a question with no alternatives.
- **Two answers, not three.** Closing the dialog (X, Esc) sends nothing at all — the turn goes on — but that
  is what closing anything means, not an option the design offers. The earlier version of this put the choice
  on a checkbox in the steering notice, which asked the user to decide *before* they had decided to stop, kept
  a state nobody could see, and had to be reset every time the queue emptied; asking at the moment of the
  press has none of those problems and puts the count in the question.
- **Every other caller keeps the drop.** `cancelAgentSession(name)` with no second argument is what a node's
  one-shot prompt interruption sends, and `release()` on socket close sends `Cancel("")` — neither has a queue
  on screen to speak for.

**Why bother** The panel already showed 「N 条消息已排队」 and then threw those messages away when the stop
button was pressed — the one moment the user is most likely to want either answer, and the two are genuinely
different intents ("stop, I'll retype it" versus "stop this, then do what I just told you"). AlayaCore had
already built the distinction and the panel could not reach it.

**Tested** `make check` (one new: `TestCancelForwardsTheWordThePanelChose` — `keep_steering` reaches the frame,
and a bare cancel carries `"args":""` rather than dropping the field, read from the fake agent's own log).
`npx vitest run` 291. `npm run check` (i18n 824/810). `npm run build`. Not exercised against a real AlayaCore:
the case worth trying is queue two messages into a running turn, tick the box, press stop, and watch them
arrive as the next prompt (`delivered`, which the panel already uses to clear the counter).

**Where** `internal/agent/sessions.go`, `internal/server/routes_agent.go`, `internal/agent/session_test.go`,
`frontend/src/services/api/agent.ts`, `frontend/src/components/canvas/canvas-agent-panel.tsx`,
`frontend/src/i18n/locales/{zh-CN,en-US}.ts`.

## 239. Speech is a hop: the gateway carries one file to the address the page names

**Decision** The agent's prompt can be filled by talking. Holding `Ctrl`/`⌘` + `'`, or holding the microphone
button in the panel, records while it is held and puts the transcript in **at the caret** when it is released.
There is one speech server supported: an OpenAI-compatible `POST /v1/audio/transcriptions` that takes a WAV
file and answers `{"text": …}`, with `http://127.0.0.1:18080/v1/audio/transcriptions` filled in as the default
and the address as the only setting (`config.preferences.speech`).

**Why the browser cannot make that request** Measured against the server this was built on (an audio.cpp
build, `model=refine`, a Qwen3-ASR-0.6B): it answers **no CORS headers** — `OPTIONS` is a 404 and a `POST`
comes back without `Access-Control-Allow-Origin` — so a page on the gateway's origin can send the request and
can never read the answer. The address is also usually `127.0.0.1`, which is true of this machine and of no
other: a canvas opened on a phone over the LAN would be asking the phone for a speech server. So the page
posts to `/api/speech/transcriptions` on the gateway, and the gateway posts to the address the page named.
The address travels **in the request** rather than being read out of `data/settings.json`: the gateway
deliberately understands no key in the preferences document (`internal/settings`), and this route has no
reason to become the first exception.

**Why only WAV, and why the encoder is ours** The same server refuses anything that is not a real WAV file —
`MediaRecorder` produces webm/opus (Chrome) or mp4 (Safari) and both are refused by name, and renaming the
file does not help because the bytes are what gets sniffed ("input is Matroska/WebM, not WAV"). So the panel
captures raw samples through the Web Audio graph (`ScriptProcessorNode` — deprecated, and still the shortest
path that starts inside the gesture with no second module to load) and writes the 44-byte header itself
(`lib/wav.ts`). No resampling on this side: the server was measured transcribing 24, 44.1 and 48 kHz files
with the reported duration intact, so the true rate in the header is less code and less to be wrong about.

**Why `Ctrl`/`⌘` + `'`** A quote is what a person uses to quote speech, and the chord collides with nothing
here: `Space` is the canvas's temporary tool, `Shift` alone is additive selection, `Ctrl` alone is the
temporary tool and the multi-select click, and a printable in the chord means it cannot be started by accident
the way a held modifier can. `Ctrl+'` types nothing and is bound by no browser; `⌘+'` is Firefox's quick-find
on macOS, which is why `Ctrl` is said first. Repeats are dropped (`event.repeat`) and the window losing focus
ends the recording — the one failure worth code, a held key whose keyup arrives on a page that is not
listening.

**Why the caret** Speaking is another way of typing, so it does what typing does: the words go in at the
caret, replacing a selection, and the caret ends up after them (`lib/canvas/agent-dictation.ts`, a pure
function of the draft and a range, which is the only way it can be tested without a DOM). The range is the
box's own selection — a textarea keeps it while unfocused, which is exactly the state it is in, since the
gesture started on the canvas — with the end of the draft as the answer for a box never touched. A gesture
that produced less than 0.2 s of sound is dropped silently rather than being sent and refused.

**The language is a hint, and that was measured rather than assumed** `language` follows the interface
(`zh`/`en`), which raised the obvious question — an English interface and a Chinese sentence. Tested on the
same server: English audio transcribed correctly with a `zh`, a `Chinese` and a garbage `English-zh` hint alike,
and Japanese audio transcribed correctly with `ja`, `zh`, `en` and auto; the field is advisory on this model
("Recognition language code or label. Omit to detect language automatically"). A wrong hint does not corrupt an
answer, so the interface language is a safe default and the field is one line to change if a server is ever
found where it is not.

**The cost of the hop** `make check` covers it: the audio arrives at the configured address as a multipart
`file`, the fields the page sent are the ones that got there (and `url` is **not** among them — a destination
that is echoed back to the server is a destination that could be pointed anywhere), a refusal comes back in
the speech server's own words with the 4xx/5xx distinction kept, an unreachable address names the address, and
a missing or non-http one is a 400 with nothing sent. `npx vitest run` covers the encoder (header, sizes,
rates, clamping), the insertion (caret, selection, out-of-range) and the request body.

**Not verified here** A real microphone: there is no browser in this tree and no DOM in the tests, so the
capture path, the permission prompt and the feel of the gesture are for a person to try. Two limits worth
knowing: the very first press of a session waits on the permission prompt (a gesture that ends while the
prompt is up records nothing, silently), and `getUserMedia` needs a secure context — `127.0.0.1` is one,
`http://192.168.x.x` on the LAN is not, so on a phone the button works only over https or on localhost.

**Where** `internal/server/routes_speech.go` (+`_test.go`), `routes_admin.go`, `frontend/src/lib/{wav,pcm-recorder}.ts`,
`frontend/src/lib/canvas/agent-dictation.ts`, `frontend/src/services/api/speech.ts`,
`frontend/src/components/canvas/{use-hold-to-talk.ts,canvas-agent-panel.tsx}`,
`frontend/src/components/settings/preferences-dialog.tsx`, `frontend/src/stores/use-config-store.ts`,
`frontend/src/components/canvas/canvas-top-bar.tsx`, `frontend/src/i18n/locales/{zh-CN,en-US}.ts`,
`frontend/tests/{wav,agent-dictation,api-speech}.test.ts`.

## 240. The binary is `comfyloft-server`, and nothing is called a gateway any more

**Decision** The service is `comfyloft-server`. The binary, the package (`cmd/comfyloft-server`), the
environment (`COMFYLOFT_SERVER_HOST` / `COMFYLOFT_SERVER_PORT` / `COMFYLOFT_SERVER_ROOT`), the per-host agent
configuration directory (`<UserConfigDir>/comfyloft-server/<host>/alayacore`), the Go identifiers, the
frontend identifiers and file names, and the documentation all say **server**. `bin/` is now
`comfyloft-server` and `comfyloft-mcp` — one prefix, two programs, which is what it should have been.

**Why** "Gateway" described one of the five things this process does, and the smallest one. It proxies
ComfyUI's generation; it also serves the canvas bundle (`GET /`), answers `/config.js`, owns the canvases,
uploads and preferences on disk, runs the loopback MCP listener the agent calls back through, and — as of
#239 — carries a WAV to a speech server. A reader who meets "the gateway owns your canvases" has been told
something false by the name. #138 had already drawn the line "that is the binary, not the product" and left
`comfyui-gateway`; that was the right distinction applied to the wrong word.

**No compatibility, on purpose** There are no users, so nothing here keeps the old spelling alive: no aliased
environment variable, no fallback config directory, no shim binary. A single accepted name is the whole point;
a migration path for a thing that has never been released is a permanent second source of truth paid for up
front. This is also why the on-disk agent directory moves rather than being read from both places.

**What was renamed, mechanically** 81 Go files, 78 frontend files, 8 moved files
(`cmd/comfyui-gateway` → `cmd/comfyloft-server`, `docs/gateway.md` → `docs/server.md`,
`services/api/gateway-status.ts` → `server-status.ts`, `lib/gateway-{labels,models}.ts` → `server-*.ts`,
`hooks/use-local-gateway-sync.ts` → `use-local-server-sync.ts`,
`components/layout/gateway-reconnect-banner.tsx` → `server-reconnect-banner.tsx`, and two test files). Go
identifiers went with the rest: `cfg.GatewayHost` → `cfg.ServerHost`, `newTestGateway` → `newTestServer`,
`LOCAL_GATEWAY_URL` → `LOCAL_SERVER_URL` (the wire name in `config.js` too — one rename, both sides), and a
handful of locals that collided with the new name were given their own rather than a number.

**What keeps the word** HTTP 502 is *Bad Gateway*, and the one string that reports it says so: the apiErrors
key stays `badGateway`, Chinese keeps 「网关错误（502）」, English keeps "Gateway error (502)". That is the
protocol's name for a status, not this program's name. `GATEWAY_TOKEN` survives only inside historical records
that describe a token that no longer exists. No prose in `docs/decisions.md` before this entry was rewritten:
the log records what was decided and in which words, and rewriting "the gateway" out of #1–#239 would be
editing the past to look consistent. What *was* rewritten there is anything a reader follows — the ten
`comfyui-gateway` paths, the `docs/gateway.md` links and the `GATEWAY_*` variable names — because a pointer to
a file that no longer exists makes the whole log unfollowable (#137 made the same split for a directory move).

**Tested** `make check` (19 packages; five test functions needed their two `startMCPServer` results
disambiguated — both were called `gateway` and then `server`, so the blanket rename produced `server, server`),
`npx vitest run` 311, `npm run check` (i18n 836/822 with `server.models` / `server.variants` declared as
dynamic prefixes, 178 modules, prettier, tsc), `npm run build`. The page was then loaded from
`http://127.0.0.1:8190` against the rebuilt binary and the agent socket connected — which is how #241 was
found.

**Where** `cmd/comfyloft-server`, `internal/{config,server,workflow,setup}`, `Makefile`, `start.sh`,
`.env.example`, `docs/{server,protocol,known-issues,decisions}.md`, `README.md`, `frontend/src/**`,
`frontend/{scripts,tests}/**`.

## 241. The server's address is the page's, never the document's

**Decision** `config.baseUrl` and every channel's `baseUrl` are filled from `LOCAL_SERVER_BASE_URL` — the origin
that served the page, or `PUBLIC_BASE_URL` when the operator named one (#220) — and a stored address is
discarded on hydration. It is not a preference any more; it is a fact about where the page came from.

**The bug** Open the canvas at `http://192.168.3.232:8190`, restart the server on `127.0.0.1`, open the page
again: everything still dialled `192.168.3.232`, the agent's socket included —
`ws://192.168.3.232:8190/api/agent/socket/canvas%3A2dfdadcd440f failed: net::ERR_CONNECTION_REFUSED`. The
address was stored in `data/settings.json` when the channel was created, and `createModelChannel` kept what it
found: "The stored address is the server root". That sentence was true when a channel could be a cloud provider
you typed an address into. There is no such channel any more (#190 deleted the tab that added them), and the
gateway has served the canvas itself since #219 — so the only address a stored one can disagree with is the one
the page is on.

**Why the page wins** It is the one value that cannot be stale: the bundle came from that origin, so the API is
there too. Any other answer is a memory, and memories of a moved server fail in the worst way — the page loads,
the canvas draws, and only the things that talk to the server break, one at a time.

**Tested** `tests/server-address.test.ts` seeds a settings document that names the old machine and a page that
is on the new one, then asserts that the document's address, every channel's address, the models and the stored
selection are what the store hands out. Verified to fail against the previous code (`×` on both address
assertions, `✓` on the models) so it pins the bug rather than the fix. `npm run check`, `npx vitest run` 314,
`make check`, `npm run build`.

**Where** `frontend/src/stores/use-config-store.ts`, `frontend/tests/server-address.test.ts`.

## 242. A page that cannot have a microphone says so, instead of throwing

**Decision** Before a gesture asks for the microphone, the panel asks whether this page can have one:
`navigator.mediaDevices.getUserMedia` only exists in a **secure context** — https, `localhost`, or an origin
Chrome has been told to trust. When it is missing, the panel shows a sentence naming the address and the two
ways out, and no permission prompt is raised.

**The report** `Cannot read properties of undefined (reading 'getUserMedia')`, from the run documented in #239,
on `http://192.168.3.232:8190/canvas/2dfdadcd440f`. The page was served over plain http from a LAN address, so
the browser had not "denied the microphone" — it never offered the API at all, which is why the error was a
`TypeError` about a missing object rather than a rejected promise. A browser will not give a page a microphone
on an insecure origin, and no code can change that; what code can do is not blame the microphone.

**Why the sentence carries the workaround** The two fixes are both outside the app — trust the origin in
`chrome://flags/#unsafely-treat-insecure-origin-as-secure`, or open the canvas over https / from `127.0.0.1` —
so a shorter message ("microphone unavailable") would leave the reader with a feature that is simply gone.
The same check also covers the practical case that follows from it: recording works on the desktop and not on
the phone until the canvas is served over https, which is stated in #239 and is nobody's bug.

**Tested** `npm run check` (i18n 837/823), `npx vitest run` 314, `make check`, `npm run build`. Not testable
here in the only way that matters: the predicate itself is one expression over a browser global, and the
browser is not in this tree — the run that reported the error is the test.

**Where** `frontend/src/lib/pcm-recorder.ts`, `frontend/src/components/canvas/use-hold-to-talk.ts`,
`frontend/src/i18n/locales/{zh-CN,en-US}.ts`.

## 243. The agent's directory belongs to the machine, not to the bind address

**Decision** `<UserConfigDir>/comfyloft-server/<segment>/alayacore` keys `<segment>` by `os.Hostname()`, not by
`COMFYLOFT_SERVER_HOST`. Changing the address the server listens on no longer moves the agent's models, its API
keys or its `runtime.conf`.

**Why** #241 was the same disease one layer down: a stored address outliving the address it named. Here the
address was in a *path*, and the cost was the operator's model list. The trigger was mundane — the microphone
needs a secure context (#242), so `COMFYLOFT_SERVER_HOST` went from `192.168.3.232` to `127.0.0.1`, and the agent
started in a directory that had never been used: no `model.conf`, so AlayaCore wrote its placeholder model
(`Ollama (127.0.0.1) / MiniCPM-V 4.6`, protocol `anthropic` at `http://127.0.0.1:11434`), and the first message
came back `provider stream failed: API error (status 404): 404 page not found` — which is Go's own 404 text,
from a model that was never the user's.

**Why the old reason does not survive** The comment it replaces said one directory per host because `mcp.conf`
names the address an agent dials back to. But `mcp.conf` is rewritten on every start (`writeMCPConf`) for the
address in use, so it is the one file that cannot go stale, and nothing per-address needs to be preserved. What
is preserved here — models, keys — belongs to the operator and has nothing to do with which interface the server
is bound to. Per **machine** the split still earns its keep: two machines sharing one home directory would
otherwise fight over the same `mcp.conf`.

**Tested** `TestAgentDirectoryDoesNotMoveWithTheBindAddress` (loads the config twice, on a LAN address and on
loopback, and requires the same directory while requiring that the bind itself did change, so the test cannot
pass by the variable being ignored) and `TestAgentHostDirIsASafePathSegment` (no separator, colon or space, and
stable). `make check` 19 packages, `npx vitest run` 314, `npm run check`, `npm run build`.

**Where** `internal/config/config.go`, `internal/config/config_test.go`.

## 244. A test server keeps its own agent directory

**Decision** `newTestServer` passes `config.WithAgentConfigPath(<temp dir>)`, and the two helpers that used to
set `AGENT_CONFIG_PATH` in the environment pass the option instead.

**Why** `config.Load` fills `AgentConfigPath` from `<UserConfigDir>` when nothing names one, and `server.New`
writes `mcp.conf` there at startup (`writeMCPConf`). So every `make check` wrote into the developer's home
directory — `~/.config/comfyloft-server/<machine>/alayacore/mcp.conf` — and, once the agent's directory was keyed
by the machine (#243), that also meant a test run could create the directory the *next* real start would use.
A test that writes into the operator's configuration is wrong twice: it is not isolated, and the thing it
writes is the file that tells an agent where to call back to.

**Why the option and not the environment** The environment variable still works for the binaries, but options
are applied *after* the environment when `Load` runs, so a test that sets both would silently keep the
environment's answer. One mechanism, applied last, is easier to reason about than a precedence rule.

**Tested** `rm -rf ~/.config/comfyloft-server` then `make check`: exit 0 and the directory is not recreated.
`npx vitest run` 314, `npm run check`, `npm run build`, `make build`.

**Where** `internal/config/config.go`, `internal/server/e2e_test.go`, `internal/server/{mcp_test,agent_e2e_test}.go`.

## 245. No segment: the agent's configuration is `comfyloft-server/alayacore`

**Decision** `<UserConfigDir>/comfyloft-server/alayacore`, and nothing between the two. #243 replaced the bind
address with the machine name; that is now gone as well.

**The three keys, and what each cost** The directory holds `model.conf` (the operator's models and API keys),
`runtime.conf` (which of them was active) and `mcp.conf` (the address an agent dials back to, rewritten at every
start).

- **The bind address** — lost the models whenever the address moved, which is what happened (#243).
- **The hostname** — the same failure, one order of magnitude rarer: it takes a renamed machine rather than a
  changed port. Rarer is not the same as right.
- **Nothing** — the models are the operator's, and the operator has one set of keys whether the server listens
  on loopback or on the LAN. This is the answer.

**What dropping the segment gives up** Two machines sharing one home directory (an NFS `$HOME`) and running a
server each would write the same `mcp.conf` and fight over it: the last one to start wins, and the other
machine's agent dials a socket that belongs to its neighbour. That is one operator with a shared home, which is
both rare and — unlike the two failures above — something the operator would immediately suspect, since an
`AGENT_CONFIG_PATH` in the unit file is already the normal way to run two servers from one home. A path that
never moves beats a path that defends a setup nobody has.

**Tested** `TestAgentDirectoryDoesNotDependOnWhereTheServerListens` (two loads, a LAN address and loopback, same
directory — while requiring the bind itself to have changed, so it cannot pass by the variable being ignored)
and `TestAgentDirectoryHasNoSegmentOfItsOwn` (the path ends in `comfyloft-server/alayacore`). `make check`
19 packages. The migration on this machine is one `mv`: `~/.config/comfyui-gateway/*/alayacore/model.conf` →
`~/.config/comfyloft-server/alayacore/model.conf`.

**Where** `internal/config/config.go`, `internal/config/config_test.go`.

## 246. The speech server's model and key are settings; the key never leaves the server

**Decision** Speech-to-text has three facts about the server at the other end, and each is where the protocol
says nothing: the **address** (#239), the **model name** (a setting now, default `refine`, blank meaning "send
no model"), and the **credential** — which is stored on this server, `data/speech-key.json` mode `0600`, and
sent as `Authorization: Bearer` on the request this server makes. The page can ask whether one is stored
(`GET /api/speech/key`), replace it, or clear it (`PUT /api/speech/key`); it never receives it. A refusal from
the speech server now keeps its **status** as well as its words: 401, 413 and 429 pass through as themselves,
and only a 5xx becomes 502. This replaces one sentence of #239 — the address is no longer "the only setting" —
and leaves the rest of it standing: the hop, the WAV, the gesture and the caret are unchanged.

**Why the model had to stop being a constant.** Measured against `127.0.0.1:18080` (audio.cpp) and against
OpenAI's OpenAPI spec:

- `POST /v1/audio/transcriptions` is OpenAI's shape, copied by every OpenAI-compatible server, and its
  `CreateTranscriptionRequest` is `required: [file, model]`. audio.cpp agrees and enforces it: no `model`
  field answers `500 multipart transcription request requires a 'model' field`, an empty one the same, and
  `model=whisper-1` answers `500 unknown model id: whisper-1`.
- The name is a fact about one machine. This server's `GET /v1/models` lists `refine` (qwen3_asr, offline,
  measured rtf 0.36 on a second of audio) and `stream` (SenseVoice-Small, streaming, rtf 0.04 — and it
  answered a pure tone with "Okay.", where `refine` answered nothing). OpenAI's enum is `whisper-1`,
  `gpt-transcribe`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, `gpt-4o-transcribe-diarize`, and two of
  those carry an announced shutdown date of 2027-02-26. A name baked into the build fits one machine and, on
  that machine, expires.
- So `refine` is a default that matches the default address, and blank is honest for the one shape that names
  nothing at all (`whisper.cpp`'s `/inference`). The empty case is not made into an error here: the server that
  wants a model says so in its own words, and a name invented by this build would be worse than the silence.

**What is deliberately not a setting.** `additionalProperties: false` on OpenAI's request object means an
extra field is an error, not a shrug (audio.cpp ignores everything it does not know — `response_format`,
`temperature`, `prompt` and a `bogus_field` all answered 200). `response_format` defaults to `json`, which is
the only format `gpt-4o-transcribe` accepts and the only one this build reads (`text`), so configuring it
would be a way to break dictation. `language` is ISO-639-1 and follows the interface (`zh`/`en`), measured to
be advisory (#239). The audio is 16 kHz mono WAV, which is on the allowed-format list and which the server
resamples for itself. None of these is a preference; a field for any of them would be a field that can only be
set wrong.

**Why the key is not in the preferences document — measured, not assumed.** `data/settings.json` is served
whole by two routes that need no authentication: `GET /config.js`, which the page loads before its bundle so
the first frame is themed (#220), and `GET /api/settings`. It is also, when the operator names
`RUNTIME_CONFIG_PATH`, written out as a file **for a static host with no server in the request path**. A
credential in that document would be a credential for every client that can load the canvas, and a published
one for the internet. This build already had the rule for the agent's model keys — `agent.Model` carries no
`api_key`, only `hasKey`, and `config.preferences.apiKeyStored` says so on screen — and the speech key now
follows it. `GET /api/speech/key` answers `{"stored":…}`, `PUT` takes `{"key":…}` (blank removes the file).

**The two costs of that choice.** The key cannot be shown, only replaced: a password field that autosaved would
write a half-typed credential on every keystroke, so this is the one control in the preferences window with a
Save button, and a blank field means "keep what is stored" (`apiKeyKeepHint`). And the field cannot be filled
in from the page's own state, so the section asks the server once when it opens.

**What a stray credential costs nothing.** The audio.cpp build this was built against checks no `Authorization`
at all: a request carrying `Bearer whatever` answered 200. So sending a stored key to a local server costs a
header and nothing else, and a key is only ever stored because the user typed one.

**Tested** `internal/server/routes_speech_test.go`: the model travels as given and a name this build has never
heard of (`whisper-1`) arrives intact; the credential comes from the store and never from the request (a `key`
field is dropped, not forwarded, and no header is invented when nothing is stored); the key file is written
`0600`, `GET` never answers it, and a blank `PUT` removes the file; 401/413/429 pass through while 500 becomes
502 with the server's own sentence. `frontend/tests/api-speech.test.ts`: no `key` field is on the wire, no
`model` is sent when the field is blank, the model follows the config, the key routes are called with the right
method and body, and a refusal is shown in the server's words. Verified live: `/api/speech/key` round-trips,
`data/speech-key.json` is `-rw-------`, dictation through the server answered 200 both with and without a
stored key, `/config.js` carries no key.

**Where** `internal/server/routes_speech.go` (+`_test.go`), `internal/store/speech.go`, `internal/server/server.go`,
`frontend/src/services/api/speech.ts`, `frontend/src/components/settings/preferences-dialog.tsx`,
`frontend/src/stores/use-config-store.ts`, `frontend/src/i18n/locales/{zh-CN,en-US}.ts`,
`frontend/tests/api-speech.test.ts`, `docs/server.md`, `README.md`.

## 247. Sweep after #246: two gates the rename left red, a silent error, a map nobody read

**Decision** Four things the sweep found and fixed, and one it did not touch.

**The rename left two gates failing (#240's tail).** `frontend/scripts/check-i18n.cjs` still listed
`ZH_ONLY_PREFIXES = ["gateway.models.", "gateway.variants."]`, so after the rename to `server.*` fourteen keys
(`server.models.*.label`, `server.variants.*`) were reported as "only in zh-CN" and the gate exited 1 — with
the summary line `failed: 0 dead key(s), 0 missing key(s)` printed just above it, which is how it went
unnoticed: the counts read clean and the exit code was not looked at. `check-exports.cjs` still had its
`TEST_ONLY` reason keyed to `src/lib/gateway-models.ts:modelsOf`, which the rename had moved to
`src/lib/server-models.ts`, so the same run reported that export as having only a test's caller. Both are
strings in scripts that nothing compiles, and the only thing that can catch them is running the gates —
which is the whole reason `npm run check` is a gate. Fixed, and the two comments that still said
`lib/gateway-labels.ts` now name `lib/server-labels.ts`.

**An error with nothing to say rendered as an empty message.** `httpx.WriteError` opened with
`message := "Internal error"` and then assigned it on both branches, so `ineffassign` flagged the literal as
dead — and it *was* dead: an error whose `Error()` is `""` (or a `*httpx.Error` with a blank message) reached
the canvas as `{"message":""}`, a blank toast that cannot be told from a broken renderer. The literal is now
the fallback it was always meant to be, with a test over both spellings of a silent error.

**`Hub.promptByRequest` was written and deleted and never read** (`internal/generate/preview.go`) — a map kept
in step with `progressByPrompt` by hand, and one more thing for a future change to keep in step for no reason.
Removed.

**Verified and left as it stands.** `go vet`, `gofmt`, `go test -race ./internal/...` and `golangci-lint`
(errcheck, govet, ineffassign, staticcheck, unused) are clean, the last two having nothing to report but the
`ineffassign` above and two SA5011 false positives in tests that are guarded by `t.Fatal`. No `@ts-ignore`, no
`as any`, no `console.log` in `frontend/src`. No `comfyui-gateway` string anywhere outside `docs/decisions.md`.
The missing timeouts are deliberate and documented where they are: `internal/comfy` puts a deadline on each
request rather than on the client ("that is what allows a 10-minute video job"), `cmd/comfyloft-server` sets
`ReadHeaderTimeout`/`IdleTimeout` and no global write timeout for the same reason. Uploads are bounded twice
(`MaxUploadBytes` per file, `ParseMultipart` stopping at the ceiling rather than spooling).

**Docs brought back in line.** `docs/known-issues.md` #2's list of exported Go symbols with no caller was
stale in two entries — `WithPublicBaseURL` and `OutputPath` are called by tests — and is now eleven, verified
symbol by symbol; it also records why a `deadcode` scan cannot run here (`proxy.golang.org` unreachable).
`README.md` and `docs/server.md` name the new file where they inventory the data directory.

**Tested** `make check` 19 packages, `npx vitest run` 321, `npm run check` (843 zh / 829 en, 178 modules,
prettier and `tsc` clean), `npm run build` 556.94 kB, `make build`.

**Where** `frontend/scripts/{check-i18n,check-exports}.cjs`, `internal/httpx/httpx.go` (+`_test.go`),
`internal/generate/preview.go`, `docs/{known-issues,server}.md`, `README.md`.

## 248. An agent is asked to quit, never killed, and shutdown asks every agent

**Decision** Ending an agent is one `CI` command frame — `{"command_id":"quit","name":"quit","args":""}` — and
nothing else. `Process.Release` sends it, gives the agent `releasePatience` (2 s) to end, sends end of input as
the second request, gives it 2 s more, and then **returns without killing it**. `Sessions.CloseAll` releases
every session in parallel, and `Server.Close` calls it: the shutdown path used to leave agents to the pipes
closing on process exit, which is not a promise anyone had written down.

**Why the command and not a signal** `quit` is AlayaCore's own exit (`docs/commands.md` in its tree: "End the
session. A task that is already running is allowed to finish first"), and a rawio client quits with exactly
this frame. It is also the *only* way out that is not destructive: a socket closing mid-turn is the common case
— the page was closed while the agent was writing a node — and a signal there loses the turn the canvas asked
for, silently. `SIGTERM` and `SIGKILL` were in a draft of this change and were removed: they were a guess about
what a wedged agent needs, and the answer to "it has not finished yet" is to let it finish, not to end it.

**The hang that was there** `Release` closed stdin and then waited for the process with no bound. It is called
from `Sessions.Close`, which is called from three places, two of them on a path where the wait is visible: the
`DELETE /api/agent/session/{session}` handler answers from it, and shutdown reaches it through `Close`. An agent
that did not read its input — wedged, or working — would have hung an HTTP request forever and a stop
indefinitely, and the comment there said the OS would reap it, which it will not: `Wait` blocks. Both waits now
have a bound and a log line when the bound is hit. The trade is explicit: a server that stops on time, and an
agent left to end when its task does.

**What `CloseAll` is for** `Sessions.Close`'s own comment claimed it runs "when the server is shutting down",
and nothing called it there: `Server.Close` closed the MCP listener and stopped. In practice agents ended when
the process exited and their stdin closed — an ordering nobody owned, and one that a wedged agent survives. It
is a line now.

**One frame at a time** `Process.Write` writes a frame and then flushes it, which is two calls, so a `quit`
racing a prompt could put half of each on the agent's stdin. The new `writeMu` holds a frame's bytes together;
the session's own lock is still what orders a *sequence* (a prompt and its images).

**A false alarm, recorded because the sweep reported it** The pid this was chased from — an `alayacore` process
alive for ten hours — turned out to be a hand-started agent on a terminal (`/dev/pts/4`, cmdline `alayacore`,
parent an interactive shell), not a leftover of a server. There was no evidence of the leak it was written up
as, and the entry that claimed one is deleted rather than left standing: a known-issues file that keeps a
problem nobody has seen is the same defect as a comment that lies. The two real gaps above were found while
looking, and they are fixed.

**Tested** `internal/agent/release_test.go`: the frame on the wire is exactly the `quit` command; an agent that
exits on it is reaped and remembered as a clean exit; one that answers neither request is **still alive**
afterwards (the assertion the whole decision is about) and `Release` returns on the bound; `CloseAll` empties
the list and every pid is gone. The test double gained the real agent's answer to `quit` (a `CO` and an
`SM session closed`), which also took the package's tests from 57 s back to 4 s — they had been waiting out the
patience because the double spoke one frame fewer than the real thing. Verified against the real binary by
stopping the server: the agent exits on the frame, logging a clean `exit pid=… err=<nil>`.

**Where** `internal/agent/{spawn.go,sessions.go}` (+`release_test.go`, `session_test.go`'s `fakeAgent`),
`internal/server/server.go`, `docs/known-issues.md`.

**Superseded in part by #250**: the release is end of input and then a kill, and `quit` is not on that path.
`CloseAll` and the per-frame write lock are what remains of this entry, and both stand.

## 249. The model form has every field of the entry, and the reasoning blocks are JSON the user types

**Decision** A model's `model.conf` entry is editable in full from the preferences window. The page is shown
every field but the key — `context_limit`, `max_tokens`, `reasoning_0/1/2`, `reasoning_field`,
`serial_tool_calls` joined the five that were there — and every one of them is a field the merge will replace
(`agent.modelEditorFields`). The three reasoning blocks are edited as **JSON text**, because that is what they
are, and a cleared box sends `null`, which removes the block.

**What was wrong** The form showed five fields and the server replaced four. AlayaCore's entry has twelve:

```
name, protocol_type, base_url, api_key, model_name, context_limit, max_tokens,
reasoning_0, reasoning_1, reasoning_2, reasoning_field, serial_tool_calls
```

So a user whose provider needed a 65536 output cap, a `reasoning_field`, serial tool calls or a per-level
thinking block had to open `~/.config/comfyloft-server/alayacore/model.conf` in an editor — and the next edit
in the UI round-tripped the file through a `model_sync` that kept those values but could never change them.
Measured on the real agent before and after (`alayacore --rawio … < /dev/null`, one startup broadcast):
`{"id":1,…,"context_limit":262144,"max_tokens":65536,"reasoning_1":{"reasoning_effort":"medium"},
"reasoning_2":{"reasoning_effort":"xhigh"},"serial_tool_calls":false}`.

**Why the blocks are text and not named fields** `reasoning_N` is "raw provider-level JSON merged into the
request body at that level" (AlayaCore's own words). OpenAI wants `{"thinking":{"type":"enabled"},
"reasoning_effort":"high"}`; Anthropic wants its own vocabulary inside the same field; a third provider will
want a third. A form of named fields would be a form that can only describe the two providers somebody thought
of, and would have to be rebuilt for the third. The text is the value, and the form's whole contribution is
saying when it does not parse.

**The one place `null` is the answer.** Everywhere else, a field left empty says nothing and the stored value
stands — the `api_key` above all, which the page has never been shown. A reasoning block is different: the form
displayed it, so emptying the box is a decision, and it is sent as `null` and merged away. *Absent* still means
"nothing to say", which is what keeps this honest for a browser running a bundle from before this change: it
does not know these fields exist, so it must not be able to delete them.

**Where the refusal lives** A block that is not a JSON **object** is refused twice: the form keeps Save off and
says which of the two things is wrong (`reasoningError`), and the merge refuses it again with a sentence naming
the field (`model_sync: reasoning_1 must be a JSON object, or empty to remove it`). The second exists because
the first is a browser: the blocks go into a request body as they stand, so a string or an array would be a
request AlayaCore sends malformed, and `model.conf` is not a file to learn that from.

**Numbers as text in the form** `contextLimit` and `maxTokens` are strings in the draft, not numbers: a
half-typed `1` on the way to `1000000` must not become a `NaN` that reads as zero, and a cleared box means zero
— which is what `model.conf` writes for "not set". `InputNumber` gives back `null` for empty, and the draft
converts both ways in one place (`lib/agent-models.ts`).

**Tested** `internal/agent/models_test.go`: the list a canvas sees carries the token caps, the blocks, the
reasoning field and the tool-call mode (and still no `api_key`); an edit replaces every one of them; a cleared
block is removed while the key stays; a page that never mentions a block does not delete it; a block that is a
string, a number or an array is refused by name. `frontend/tests/agent-models.test.ts` (19 tests): the draft
fills every field and shows a block as indented JSON, `null` is sent for a cleared one, an empty
`reasoning_field` is sent as nothing, a cleared cap is `0`, and `reasoningError` separates "not JSON" from "not
an object". Verified live against the real agent's startup frame, above. `make check` 19 packages, `npx vitest
run` 330, `npm run check` (853 zh / 839 en), `npm run build` 560.88 kB.

**Where** `internal/agent/{events.go,models.go}` (+`models_test.go`), `frontend/src/services/api/agent.ts`,
`frontend/src/lib/agent-models.ts`, `frontend/src/components/settings/agent-model-dialog.tsx`,
`frontend/tests/agent-models.test.ts`, `frontend/scripts/check-i18n.cjs` (two hand-resolved keys),
`frontend/src/i18n/locales/{zh-CN,en-US}.ts`.

## 250. A release ends input, waits two seconds, and then kills; `quit` is not on that path

**Decision** Ending an agent is two steps: close its stdin, wait `releasePatience` (2 s), and kill it if it is
still there. The `quit` frame #248 sent first is gone from this path. `Sessions.CloseAll` on shutdown and the
per-frame write lock stay as #248 left them.

**Why `quit` had to go** Its semantics are the problem, not its implementation: AlayaCore's `:quit` is "a task
that is already running is allowed to finish first". For an agent with nothing in flight, end of input ends it
in a second and `quit` buys nothing. For an agent with something in flight, `quit` defers to that task — and
the case where a release is *needed* is the case where the task does not finish: a loop, a wedged provider
call, a tool that never returns. So the one command that exists could only help where it was not needed. Its
terminal interface completes the pair by asking a person whether to `cancel` first; there is no person here.

**What end of input is** Measured on the real binary before writing this: a `--rawio` session whose stdin
closes ends by itself — it finishes the current step, writes `SM{"type":"session","data":{"state":"closed"}}`
and exits. Mid-turn and idle alike, about a second. So the first step is not a signal and not a negotiation; it
is the agent's own end of input, and the kill is only for the process that does not take it.

**The trade, said plainly** A kill can cost the tail of a turn in flight, and nothing else: the conversation
file already holds what was written, and the sessions here are short. In exchange a release always ends —
which matters because it is on the request path (`DELETE /api/agent/session/{session}` answers from it) and on
the way out, where an agent that will not end is a server that will not stop. The earlier shape of this — close
stdin and wait forever (#248's predecessor) — had no bound at all; #248's — ask, then leave it running — had a
bound but no ending. This has both, and gives up the tail of one turn to get them.

**Tested** `internal/agent/release_test.go`: an agent that ends on end of input is **not killed** (its exit
status is not a signal) and `Release` returns as soon as it goes; an agent that never reads its input is killed
and `Release` returns within the wait plus the kill; `CloseAll` releases both of two sessions and leaves none
alive. The test double dropped the `quit` answer it had gained in #248, since nothing sends that frame now —
and the package's tests went from 3.9 s to 1.5 s with it.

**Where** `internal/agent/spawn.go` (+`release_test.go`, `session_test.go`), `docs/decisions.md` #248.

## 251. A dictation gesture stops itself at a minute

**Decision** One recording may hold `MAX_SPEECH_SECONDS` (60 s) of sound. At the cap the recorder ends itself,
hands what it has to the hook, and the words still land at the caret; the panel says why the microphone
stopped, in the quiet line rather than the red one, because nothing failed.

**Why a cap at all** The gesture is *held*, so its length is the user's and the window's at once: a pointer
capture that never releases, a key whose keyup the window never hears, a person who walks away mid-sentence.
Today that records until the tab closes and uploads the lot on release — a minute of someone's room in memory
and on the wire. Nothing else enforces this: the server bounds the *upload* (`MaxUploadBytes`, 50 MB ≈ 26
minutes of this format) because that is its business, and it would transcribe a longer file happily. The cap is
about how long a person may hold the button, which only this side knows.

**Why a minute** It is already far longer than a dictated prompt — the gesture is one breath of text, and this
is a paragraph — and it is where the wait stops being free. Measured against the server this build was built
for (rtf ≈ 0.12 on `refine`, 0.04 on `stream`): 30 s → 3.6 s, 60 s → 7.2 s, 120 s → 14.4 s, 300 s → 36 s of
transcription, at 32 kB/s of audio. Seven seconds is a wait a person will sit through after speaking a minute;
fifteen is one they will not, and the failure mode of a lost keyup would then be a long wait for a long
recording nobody asked for.

**Ended, not discarded** The cap is a stop, not a refusal: `finish()` in the recorder remembers its result, so
the cap ends the recording and the later release reads the same samples (a second, empty recording is exactly
the bug this shape avoids). The hook marks the gesture as ended-by-length and the notice is set on the way
through, so the transcript arrives with an explanation next to it.

**Tested** `frontend/tests/agent-dictation.test.ts`: a sample short of the minute is still recording, the
minute ends it at 16/44.1/48 kHz, a zero rate says nothing, and the constant stays in a range a person would
recognise. `npx vitest run` 334, `npm run check` (853 zh / 839 en, 178 modules), `npm run build`. The recorder
itself needs a browser and a microphone, so what is tested is the rule, not the capture — the same line #239
drew.

**Where** `frontend/src/lib/canvas/agent-dictation.ts`, `frontend/src/lib/pcm-recorder.ts`,
`frontend/src/components/canvas/use-hold-to-talk.ts`,
`frontend/src/components/canvas/canvas-agent-panel.tsx`, `frontend/src/i18n/locales/{zh-CN,en-US}.ts`,
`frontend/tests/agent-dictation.test.ts`.

## 252. Speech servers are a list, and the active one is what dictation uses

**Decision** Speech-to-text has more than one server now. A list of **profiles** lives in `data/speech.json`
(mode `0600`): each is a name, an address, a model name and a key, one of them is active, and the active one is
where a recording goes. `GET /api/speech/profiles` answers `{"profiles":[{id,name,url,model,hasKey}],"active":<id>}`,
`PUT /api/speech/profiles` takes the **whole list** back with one entry added, changed, removed or activated, and
`POST /api/speech/transcriptions` no longer names a server at all. This replaces the single `asrUrl`/`asrModel`
pair of settings and the single `data/speech-key.json` of #246, and it retires one sentence of #239: the address
no longer travels with the request, because the list is the server's own file and not the preferences document.

**Why a list.** #246's own words were "the key is one value, not a keyring: this build talks to one speech
server". The second half of that sentence stopped being true the moment the address, the model name and the key
became settings: a workspace is used from a desk with a local audio.cpp on the CPU and from a café with a hosted
whisper, and one field each means editing all three between them — or leaving an address pointing at a machine
that is not there. Profiles are the shape the agent's models already have (#249), so the window has one list
pattern and one dialog pattern rather than two.

**Why the list is the server's.** A profile *is* an address **and** a credential, and the preferences document
is served whole by `GET /config.js` to every browser that loads the canvas and written out as a file for a static
host when the operator names `RUNTIME_CONFIG_PATH` — measured, not assumed (#246). So the key cannot live in it,
and a list with per-profile keys can only live where the keys are. The page is shown `hasKey` and never a key,
exactly as `agent.Model` shows the agent's models. The form's only keys are the ones the user has just typed: a
new profile's, or a replacement for a stored one.

**The five rules that make one list safe to write from two windows.** The whole list goes back, in the page's
order, so an entry that is missing is a profile that was deleted — the same rule `model_sync` takes, and one
atomic rename rather than a sequence of edits that can half-apply. An entry that arrives **without a `key` field
says nothing** about the stored key, which is how a stored key survives an edit to the address; `""` removes it,
and removing one is a checkbox on the form, because a blank field cannot mean both "keep" and "delete". An **id
the server does not have is refused** (`speech_profile_unknown`, 400) rather than adopted: two pages disagreeing
is a reload, not a duplicate. **Ids are the server's to assign** — a page sends none for a new profile — so no
client invents an id that another client's list already has. And **the active id is never 0 while a profile
exists**: an id that names nothing becomes the first entry, so deleting the active profile leaves the microphone
working instead of failing with nothing on screen explaining it.

**What the request carries now.** `file` and `language`, and nothing else. The model name and the credential come
from the active profile, so a form field cannot redirect a recording: the old route forwarded every field the
page sent except `url` and `key`, which meant a `model` field could name a different model than the one the user
configured. The body is now built from two named parts. `language` stays the page's because it is a fact about one
utterance — the interface's language — and not about the server.

**Two costs.** A profile's address, model and `hasKey` are on the server, so the window reads them when it opens
(a failed read says so, and the Add button waits for the answer: a PUT that merges into a list the page has not
seen would delete the profiles it does not know about). And `data/speech-key.json` from #246 is no longer read;
it is left alone rather than deleted — a credential is not this process's to remove — and the log says once that
it is dead (`speech: … is no longer read`).

**Tested** `internal/server/routes_speech_test.go`: the recording goes to the **active** profile and the inactive
one is never called; the model and the `Authorization: Bearer` are the profile's even when the page's form names a
different model, key and address; a profile with no key invites no header; a blank model sends no `model` field;
no profile is a 400 `speech_profile_missing`; 401/413/429 pass through while 500 becomes 502; `speech.json` is
`0600`, holds the key, and no answer contains it; an entry sent back without a key keeps the stored one and `""`
removes it; an unknown id, a duplicated id, a fractional id, a non-list, a profile with no address and an `ftp`
address are each a 400 with a code and leave the list untouched; the active id falls back to the first entry.
`internal/store/store_test.go`: a hand-edited file with colliding, missing and unusable entries loads as three
usable profiles with distinct ids, and ids are never reused across a reload.
`frontend/tests/api-speech.test.ts` and `speech-profiles.test.ts`: the request names no server, model or key; the
list is read and written as a whole; an untouched entry carries no key field; a typed key is trimmed and sent; a
blank field sends nothing and `removeKey` sends `""`. Exactly two refusals are re-worded in the dictionary
rather than passed on: `speech_profile_missing` (an empty list, which is a setting in this window) and
`speech_profile_unknown` (another window wrote the list first, where "there is no speech profile 7" is not
something a reader can act on). Everything else, including every refusal from the speech server itself, keeps the
server's words. `frontend/tests/config-speech-migration.test.ts`: a stored document carrying the old `asrUrl` and
`asrModel` hydrates to a config that has neither, and the rest of the document survives that. `make check` 19
packages, `npx vitest run` 345, `npm run check` (864/850 keys), `npm run build`.

**Where** `internal/store/speech.go` (+`store_test.go`), `internal/util/util.go` (`WriteFileAtomicMode`),
`internal/server/routes_speech.go` (+`_test.go`), `internal/server/server.go`,
`frontend/src/services/api/speech.ts`, `frontend/src/lib/speech-profiles.ts`,
`frontend/src/components/settings/{speech-profiles-section,speech-profile-dialog,preferences-dialog}.tsx`,
`frontend/src/stores/use-config-store.ts`, `frontend/src/i18n/locales/{zh-CN,en-US}.ts`,
`frontend/tests/{api-speech,speech-profiles,config-speech-migration}.test.ts`, `docs/server.md`, `README.md`.

## 253. Twelve Go exports nothing could reach are gone, and a gate says so from now on

**Decision** Delete the eleven exported Go symbols `docs/known-issues.md` listed — and the twelfth that surfaced
once they were gone — and add `tools/deadcode` to `make check`, so the question is answered by the gate rather
than by somebody grepping once.

**What went, and the shape of each one.** Ten were public spellings of work the package already did privately, or
a knob nothing turned:

- `comfy.Client.Queue` — a `/queue` reader; a run's progress comes from the hub and the task store, never from
  ComfyUI's queue.
- `config.WithAudioTimeout`, `WithServerPort`, `WithMaxImportBytes` — constructor options from the port, where every
  other option has a caller.
- `httpx.WriteJSONError` — a one-line wrapper over `WriteError`; middleware calls `WriteError`.
- `resource.Manager.DerivedDependencies` — its comment still claimed to be "the single source of truth for a
  workflow's dependency list", which is exactly the kind of sentence that keeps a dead function looking load
  bearing. The list is derived by `entryDeps`, which `packModelIDs` and the scan call.
- `setup.Manager.IsAvailable` — `WorkflowStatus` answers the same question with the problems attached, and is what
  every caller uses.
- `setup.Manager.ModelCandidates` — the wrapper for `modelCandidatesLocked`, which `scan.go` calls directly.
- `store.MainModels.Snapshot` — "for diagnostics" that nobody ran.
- `workflow.NormalizeModelPath` — a second `strings.ReplaceAll(value, "\\", "/")` beside `util.NormalizeSlashes`.
- `workflow.ReadGraphFile` — a public reader beside `Registry.readGraph`, which also rejects UI-format documents and
  is the one the registry uses.
- `workflow.DecodeGraph` — decoded the bytes `ReadGraphFile` had read; with that gone it had no caller at all.

Deleting `ReadGraphFile` is what exposed `DecodeGraph`, which is the argument for the gate in one sentence: the
dead call each other, so a sweep that stops at the obvious ones leaves a smaller ring behind.

**The gate, and what it is not.** `tools/deadcode` parses every `.go` file of the module and reports an exported
declaration whose name appears in no other file **and** which no reachable declaration mentions. That second half
is the whole design: a type is reached structurally, so `store.SpeechProfile` — never written outside its package,
but `Active()`'s answer — is not reported, and `agent.MaxFrameSize`, read only by the code beside it, is not
either. Roots are: a name another file mentions, a method any interface declares (including anonymous ones written
at a call site, plus a short list of the standard library's — `Error`, `MarshalJSON`, `ServeHTTP`…), a test, and
everything a *private* declaration mentions, because `golangci-lint`'s `unused` is what says the private half is
used.

It over-approximates on purpose and the report is therefore always real: the scan is name-keyed rather than
package-keyed (resolving a mention to a package needs type-checking, so one `New` keeps every `New` alive), any
identifier position counts (a selector `x.Foo` for `Foo`, a struct field's name), and test files are live. What it
misses is dead code that shares a name with something live; what it reports cannot be a false alarm.

**Why not `deadcode` or `golangci-lint`'s `unused`.** `deadcode` loads packages through the module proxy, which
this machine cannot reach (`proxy.golang.org` refused, #247's note), and `unused` only looks at unexported names —
the exact blind spot. A 220-line program with seven unit tests is smaller than the vendoring it would take to make
`deadcode` run offline.

**Tested** `tools/deadcode/main_test.go` pins each rule with a small source tree: a function nobody calls is
reported; a caller in another file of the same package counts; a type answered by a live function and a constant a
live function reads are reachable; what a private function answers is reachable; interface methods (module's own,
anonymous, and standard library's) are exempt while an exported interface nobody names is not; tests and the knobs
they drive are live; and two constants in one `const (...)` are two declarations, so one being read does not save
the other. `go run ./tools/deadcode` on the tree: `503 exported declaration(s) in comfyloft, every one reachable
from another file`. `make check` 20 packages (the tool is now vetted and tested with the rest — `PKGS` gained
`./tools/...`), `npx vitest run` 343, `npm run check`, `npm run build`.

**Where** `tools/deadcode/{main.go,main_test.go}`, `Makefile` (`deadcode`, `check`, `PKGS`, `.PHONY`),
`internal/{comfy,config,httpx,resource,setup,store,workflow}/*.go`, `docs/known-issues.md` (entry 2 leaves it),
`docs/server.md`, `README.md`.

## 254. One writer for every write: five copies of temp-file-then-rename became one

**Decision** `internal/canvas`, `internal/settings`, `internal/server` (the first-paint script and `mcp.conf`) and
`internal/store` (already there) all write through `util.WriteFileAtomic` / `util.WriteFileAtomicMode`, and those
are the only two functions in the tree that create a temporary file. The four private copies — `canvas.writeFile`,
`settings.writeFile`, `writeRuntimeFile`, `writeMCPConf` — are now three-line wrappers that add their package's
error text.

**Why it was wrong before.** Four implementations of the same six steps had drifted apart in the ways that matter
and agreed in the ways that do not: `mcp.conf` was written to a *fixed* `mcp.conf.tmp` name, so two writers could
interleave into it (and a `SweepTempFiles` pattern could not collect it either); the other three each had to
repeat the `CreateTemp`-makes-it-0600 correction; and the mode — the one thing a credential file must not get
wrong — existed in four places, one of which was `0o600` and three of which were `0o644` with nothing but a comment
saying why. That is the shape a copy takes before it stops agreeing.

**What the single writer does now.** `os.CreateTemp` for the name (O_EXCL over a counter and a random suffix: the
one thing a `.UnixNano()` name cannot promise is that two writers of the same file never land in the same
nanosecond — and the previous `WriteFileAtomic` had exactly that race), `Chmod` before any byte is written, then
write, close, rename. The name it leaves behind is `.` + the file's base + `.<digits>.tmp`, which is the shape
`SweepTempFiles` already matches, so a killed process still leaves something collected rather than a file per kill.

**What is deliberately still per call site.** The two things that are not the writer's business: whether the
document ends with a newline (`settings.json` does, `canvas.json` does not, and neither is the file layer's opinion)
and the sentence an error carries (`canvas: cannot write …` says where it happened).

**Tested** `internal/util/util_test.go`: the mode survives the rename (`0600` written, `0600` read back), the bytes
are the bytes, a second write replaces the document and leaves the directory holding only the file, the default is
`0644`, and a temporary file in the shape the writer produces is what `SweepTempFiles` collects — with an ordinary
file beside it untouched. `make check` 20 packages including the new dead-export gate, `npx vitest run` 343.

**Where** `internal/util/util.go` (+`util_test.go`), `internal/canvas/canvas.go`, `internal/settings/settings.go`,
`internal/server/{runtime_config,agent_config}.go`.

## 255. Both requests that leave this server say where they are going, in the log

**Decision** Two destinations are printed: the **speech server** dictation posts to — at startup, whenever the
active profile changes, and once per recording — and the **model server** a session's turns go to — when the
session starts and whenever the destination changes. Neither line ever contains a credential.

**Why it had to be printed at all.** Both are requests this server makes on the user's behalf to a server the user
configured, and until now neither said where: the speech list was visible only in the preferences window (which
shows an *address*, not which of five profiles is active when the window is closed), and the agent's line was
`agent: connected session=… models=2 active="Fleet / qwen3"` — the model's **name**, which is not the address. So
"it is slow", "it answered nonsense", "it refused with a key error" and "my dictation is silent" all arrived with
nothing in the log to correlate them against. The failure paths did better than the successes: a hop that cannot
connect says `could not reach the speech server at <address>`, and an empty transcript says nothing at all — which
is exactly the case where the address is the answer.

**Why the address had to be looked up, not read.** `SM model` carries `active_id`, `active_name` and
`context_limit`; the `base_url` and `model_name` only ever arrive in `SM model_list`. So `startup.destination()`
resolves the active id against the list it holds, and says so when the id is not in it (`"gone" (its entry is not in
the list)`) rather than looking like "no model". An active model with no `model_name` (`whisper.cpp`'s `/inference`
shape, a local llama.cpp with no alias) prints the address and the protocol only.

**One line per change, not per frame.** The agent restates its state — the same `model` frame can arrive again, and
a canvas saves the model list on every edit — so the pump and `adoptModels` compare `destination()` either side of
the frame and write only when it differs. Measured: re-sending `model_set 2` when two is already active writes
nothing; switching to it writes `agent: session=… sending to "Fake / two" -> …`.

**Where each line lives.** The store owns the speech ones (`Load`, `Replace`), because the file is the answer and the
store is the only thing that reads it — including the case where the file is *absent*, where the line says "no
profile configured, so dictation will say so", which is the sentence a reader needs when the panel refuses. The
route adds the per-recording line just before the hop, because the bytes are there and "which server did that?"
is a per-request question. The agent's lines are in the session (`Connect`, the pump, `adoptModels`), the only
places that see the agent's own frames; `Session` gained the `Log` it was missing.

**What is deliberately not printed.** The `api_key` (`SM model_list` carries every one in cleartext, and a log line
ends up in an issue), and the profile's key — only `with a key`, so "the server wants a credential and mine is
wrong" is still visible.

**Tested** `internal/agent/startup_test.go`: `destination()` is empty before the agent names a model, resolves the
address and model name of the active entry, prints the address alone for a model with no name, says so when the
active id is not in the list, and never carries the key. `internal/agent/session_test.go`: a spawned fake agent logs
`sending to "Fake / one" -> http://127.0.0.1:1/v1, model m, openai` at connect, logs `"Fake / two"` after a
`model_set`, and writes nothing when the destination did not move. `internal/store/store_test.go`: the line for a
configured profile names it, its address, its model and `with a key` but not the key; switching the active profile
prints the new address; re-saving the same list prints nothing; an empty store says nothing is configured. Verified
live: `speech: 1 profile(s) loaded; dictation goes to "Local audio.cpp" -> http://127.0.0.1:18080/v1/audio/transcriptions, model refine, with a key`
and, with no file, `speech: no profile configured, so dictation will say so`. `make check` 20 packages,
`npx vitest run` 345, `npm run check`, `npm run build`.

**Where** `internal/agent/{events.go,sessions.go,models.go}`, `internal/agent/{startup_test.go,session_test.go}`,
`internal/store/speech.go`, `internal/store/store_test.go`, `internal/server/routes_speech.go`, `docs/server.md`.

---

## 256. `input_modalities` is a switch and four boxes, because the file has three states

**Decision** A model's `input_modalities` is edited by one switch — does this model declare anything at all — and,
when it does, four checkboxes: image, video, audio, document. Switch off writes no line, on-and-empty writes `[]`,
and the boxes write the list. The field is stated in every model a page is shown, `null` included, so "not
declared" and "no media" never have to be guessed apart. `null` sent back removes the line; a list replaces it; a
field not mentioned keeps what is stored.

**Why the three states are the whole problem.** AlayaCore reads a missing line as *the protocol decides* (an
OpenAI-format endpoint takes image, audio and video; an Anthropic one image and document), `[]` as *declared, no
media*, and a list as itself. A row of checkboxes on its own can only say two things, so whichever of the first two
it collapses, one of them becomes unreachable — and the worse direction is the silent one: a model whose `[]` travels
as an absent field comes back through `model_sync` as a model that takes everything its protocol carries. AlayaCore
keeps those two apart for the same reason (`json:"input_modalities"` with no `omitempty`, and `input_modalities` in
`fatalParseKeys`), and the wire here follows: `agent.Model.InputModalities` has no `omitempty`, like
`serialToolCalls` (#249), so `"inputModalities":null` is always present and always means "not declared".

**Why there is no `text` box.** Text is never filtered — a message is text, and there is no way to send one without
it — so `[]` and `["text"]` are one model, in AlayaCore's own words. A box that changes nothing would suggest the
opposite, so the vocabulary offered is the four media words and a stored `["text"]` is kept spelled as it is: the
dialog edits the four boxes inside the list it was handed and leaves every other word where it was. A sixth word
from a newer AlayaCore would travel the same way, which is why the server checks only that the value is an array of
strings: the vocabulary is AlayaCore's, and it names a bad word itself when the list is written.

**Why switching on starts empty.** The two mistakes are not symmetric. A medium the endpoint does not accept makes
it reject the whole request — and keep rejecting, because the part is in the conversation the agent replays every
turn. A medium it would have accepted is only replaced by a note saying it was not delivered, which the user can
see in the answer and undo in one click. Pre-ticking the protocol's defaults would put the silent failure on the
common path (most models are text-only), so the boxes start unticked and say what unticked means.

**Cost** Adding a media type to AlayaCore means adding a word to `INPUT_MEDIA` in `frontend/src/lib/agent-models.ts`
and a label to each dictionary — until then such a value is preserved but not offered. The switch is one more
control than a checkbox row, and the model list does not summarise what a model declares: the declaration is only
visible in the dialog, so a model quietly receiving notes rather than images is found by opening it.

**Cost, the upgrade.** An agent process from before the option neither reports the line nor keeps it —
`model_sync` re-formats `model.conf` from the struct that process holds, so a rename through it deletes a
declaration it never parsed. Measured against the pre-upgrade build: a model whose file said
`input_modalities: ["text","image"]` was announced with `inputModalities: null`, and the edit wrote the file
without the line. Nothing here can repair that from the outside (the server does not parse `model.conf`); the
answer is that agent processes are per session, so restarting the server replaces them.

**Tested** `internal/agent/models_test.go`: `[]`, a list and an absent line stay three different things through
`info()` and out to the page (`"inputModalities":null` is stated, `[]` is not `null`); a page's list replaces the
stored one, `[]` stays `[]`, `null` removes the line, and a page that does not mention the field keeps it;
`input_modalities` that is a string, an object or an array of numbers is refused by name. `frontend/tests/agent-models.test.ts`:
the draft keeps `[]` apart from `null` in both directions, an edit sends a list, `[]` and `null` as themselves, a
model the form did not open says nothing about the field, and `withModality` toggles without duplicating while
keeping words it does not know. Verified live against AlayaCore `ea3978c1` on a throwaway instance: the line was
written as `input_modalities: ["text","image"]`, then `[]`, then removed, each announced back unchanged
(`models` frame) with `{"type":"command","ok":true}`. `make check` 20 packages, `npx vitest run` 351,
`npm run check` (872 zh keys, 858 en), `npm run build`.

**Where** `internal/agent/events.go`, `internal/agent/models.go`, `internal/agent/models_test.go`,
`frontend/src/lib/agent-models.ts`, `frontend/src/components/settings/agent-model-dialog.tsx`,
`frontend/src/services/api/agent.ts`, `frontend/src/i18n/locales/{zh-CN,en-US}.ts`,
`frontend/scripts/check-i18n.cjs` (the `config.preferences.modality` namespace), `frontend/tests/agent-models.test.ts`,
`docs/server.md`.

## 257. The prompt panel has no ✨: rewriting a prompt is the agent's job

**Decision** The two sparkle buttons are gone — 优化提示词/H3 优化 on video nodes and 优化提示词 on image
nodes — with everything only they used: `promptOptimize*` on `CanvasNodeMetadata`, `lib/canvas/prompt-optimize-jobs.ts`,
the `PromptOptimizeMode` type, the eleven dictionary keys they carried (`optimize*`, `originalPrompt*`), the
`promptOptimizeLanguage` setting, and `OriginalPromptDisclosure`. The text node's 反推 stays, because it is a
different job (a picture in, words out) rather than a rewrite of words the user already wrote. `read_prompt` now
ends its answer with what the node is set to run (`n3 is set to run video-h3-frames, 4 s`), because the workflow
id and the duration are the two facts a rewrite depends on and no other tool stated them.

**Why** Both buttons had stopped working, and had been dead since 336e331 (2026-11-01): the button asked on
`node:<id>`'s session, and nothing on a video or image node ever opens one — the panel shows a model picker there,
not 连接 — so `askAgentSession` rejected before it dialled. Pressing ✨ showed `请求失败` in the preview and nothing
else. That refactor renamed `askAgentSession` to `askOnceAgentSession` ("ask, and release either way") and left
`optimizePrompt` assuming a session it never opened; the reverse-prompt button it also touched was safe only because
a text node's own generation opens that session first. Verified before deleting: a probe test calling
`askOnceAgentSession("node:never-opened", …)` rejects without constructing a `WebSocket`.

**Why remove rather than repair** Repairing is one line (`await openAgentSession(config, agentName)` before the
ask), and it was still the wrong one. The H3 button's only real content was a sentence — "把下面这段需求改写成一条
MiniMax H3 视频生成提示词。任务类型：… ；时长：… 秒。" — that duplicated the skill's own vocabulary
(`prompts/skills/h3-prompt-writing/SKILL.md` step 1 is "identify the input mode"), inside the canvas, in Chinese,
with no test. That is exactly the second wording site #76 deleted a whole backend over. The image button had less
than that: there is no image skill, so it was "rewrite this into a prompt, answer in X" — a sentence a user can say
to the canvas agent, and it attached no facts at all.

**What the agent gets instead** The task type, the duration and the reference media are all reachable from the
canvas: `read_prompt` for the words plus what the node will run, `list_nodes` for the connections, `read_node` for
each reference picture (which answers with the image itself), `set_prompt` to write the rewrite back. What was
missing was the fact the button derived from the picker, so `read_prompt` gained it — one clause, from
`configuredClause` in `node-generation-facts.ts`, the module that already words "made with …". It says what the
*next* run will ask for, which is not what `generationClause` says: change the picker and the two disagree.

**Cost** One click became a conversation, and the agent has to be told which node — the panel it stands in has no
chat of its own on a video or image node. It may also have to ask for the input mode when the workflow id does not
settle it (`video-h3-frames` is I2VA, L2VA or FL2VA depending on the frames that are wired); `frameMode` is derived
by the panel from the references, and the tool reports the id alone rather than guessing. Undo is `git revert`.

**Tested** `npx vitest run` (357: six new — `read_prompt` names the run and stays silent without a picker,
`configuredClause` for a pick, a bare name, no duration and no model, and `requestPromptChat` dialling a session that
was never opened). `make check` (20 packages, 504 exports), `npm run check` (863 zh keys, 849 en, 180 modules,
prettier + tsc), `npm run build` 561.56 kB. The deleted files: `prompt-optimize-jobs.ts` was its only caller, so
`check-exports` drops from 181 modules to 180 with nothing orphaned.

**Where** `frontend/src/components/canvas/canvas-node-prompt-panel.tsx`,
`frontend/src/components/canvas/sent-prompt-disclosure.tsx` (a comment only, see #258),
`frontend/src/lib/canvas/node-generation-facts.ts`, `frontend/src/lib/canvas/canvas-agent-tools.ts`,
`frontend/src/services/api/prompts.ts`, `frontend/src/stores/use-config-store.ts`, `frontend/src/types/canvas.ts`,
`frontend/src/i18n/locales/{zh-CN,en-US}.ts`, `frontend/tests/{api-prompts,canvas-agent-tools,node-generation-facts}.test.ts`,
`docs/server.md` (two paragraphs that still described `internal/prompt` as the home of the H3 instructions).

## 258. The sent-prompt count is characters, and now it is the count it says

**Decision** `SentPromptDisclosure` counts `[...sent].length` — code points — where it counted `sent.length`.

**Why** The label says 字 / chars, and `sent.length` is UTF-16 code units: one emoji, or one of the CJK ideographs
outside the BMP (𠮷, 𰻞), counts as two. The user asked whether it should be bytes instead, because UTF-8 writes a
Chinese character in three of them; it should not. Bytes are not a fact about a prompt: nothing in this pipeline
stops at a byte boundary (the gateway's transcript truncates at 400 *runes*, `internal/agent/spawn.go`), and the
number would triple as a user switched to Chinese while the text stayed the same length, which is the opposite of
what the count is for. Code points are the unit the rest of this codebase already uses for text length, and they
make the word 字 true.

**Cost** Two characters that are one grapheme (a letter plus a combining accent) still count as two. Grapheme
clusters would need `Intl.Segmenter` for a difference nobody reads this line to see.

**Tested** By reading it: the component renders into JSX and `vitest.config.ts` is `environment: "node"`, so there
is no DOM to assert against — the same gap the rest of this panel has (no component test exists for it). The
expression is a one-liner whose behaviour is the language's; `npx vitest run` and `npm run check` cover the module
loading and the types.

**Where** `frontend/src/components/canvas/sent-prompt-disclosure.tsx`,
`frontend/src/i18n/locales/{zh-CN,en-US}.ts` (`sentPrompt`).

## 259. A music run is told how long it may be

**Decision** The audio settings panel has a duration control whenever the selected workflow declares a range for
one, and `requestAudioGeneration` sends that number as `seconds`. The bounds come from the workflow's declaration
(`parameters[].duration`, 4–360 s for `audio-minimax-music-3`), carried on the model entry as `duration: {min, max}`;
the node keeps the value in `metadata.seconds` (where a video's length already lives) and the config field is
`audioSeconds`, defaulting to 60.

**Why it was missing** Nothing on the client ever sent a length, so every song came out at the graph's own
`max_duration: 60` whatever the panel said — the workflow could be told 4 to 360 seconds and only the registry knew
it. Everything downstream was already there: `bindings.duration` reads `ctx.Seconds` into `37:13.max_duration`,
`routes_runs.go` builds `ctx.Seconds` from `inputs.seconds` (falling back to `inputs.duration`), and
`internal/workflow/shipped_audio_test.go` pins both the 45-second and the 60-second-default paths. The gap was one
missing input on one request.

**Why the bounds come from the registry rather than a constant** `VIDEO_SECONDS_MIN/MAX` (4–30) are constants because
every video workflow is the same shape of clip; a song is not, and 4–360 is this model's own ceiling, not a fact about
audio. A client that hardcodes it would need editing when a longer music workflow arrives, and would offer 360 seconds
to a workflow that stops at 30. So `durationOf` in `server-models.ts` reads the declaration once, when the model list is
built, and everything else — the slider, the number box, the request — reads those bounds. The step is the exception:
the declaration's is 0.04 s (1/25, the latent's grid) and the UI rounds to whole seconds, because this number is an
upper bound the model may finish under and nobody reads a song length to a hundredth.

**Why the declaration is also the switch** A workflow that declares no duration gets no control and is sent no
`seconds` — its binding default answers, and the client does not invent a length for a workflow whose inputs it has
not been told about. That is the same rule as the rest of the panel: what the panel shows, the run receives.

**Cost** `defaultConfig.audioSeconds` is `"60"`, a copy of the value the binding writes when the request says nothing,
so the control opens showing what the first run will actually ask for. If the registry's default changed, the client
would keep sending 60 — visible on the panel before the run, not a silent substitution. A node that has never been
touched has no `metadata.seconds`, so the agent's `read_prompt` reports the workflow without a length until the user
picks one (a video node behaves the same way). The panel and `buildGenerationConfig` both read `metadata.seconds`
for `audioSeconds`, so an audio node's length also lands in `videoSeconds` and vice versa — the two are only ever read
by the kind of node that owns them.

**Tested** `npx vitest run` (368: `tests/audio-duration.test.ts` posts 90 s for a 4–360 workflow, clamps a stored
600 to 120 for a 4–120 one, sends no `seconds` at all for a workflow that declares none, and keeps the lyrics and the
container beside it; `clampAudioSeconds` at both ends, on a fractional value, and on a value that is not a number;
`tests/server-models.test.ts` takes the range from the `duration` declaration, ignores a non-numeric one, and the
signature changes when the range does). Against the live server (no render):
`GET /api/workflows` reports `duration 4–360`, and `GET /api/workflows/audio-minimax-music-3/schema` lists `seconds`
as an accepted number input. The end-to-end wiring — `seconds` → `ctx.Seconds` → `max_duration` — is
`TestShippedMusicWorkflowBindsCaptionAndLyrics`, which reads the same `registry.json` the server loads.

The panel itself was rendered, not just type-checked: `renderToStaticMarkup` of `AudioSettingsPanel` in a throwaway
`tests/tmp-render-audio.test.ts` (node environment, `createElement` because vitest here only collects `.test.ts` and
the file had no DOM) printed the Format pills, a range and number box at 4–360 with the stored `999` clamped to
`360`, the `s` suffix, the hint with both bounds filled in, and the lyrics box — in both locales (`格式`/`时长`/
`4–360 秒的上限；模型可能提前结束`/`歌词` and the English ones) — and no voice or speed group; with a model that
declares no range, the duration group is absent. Deleted afterwards, so this is a check that was run rather than a
test that stays: the repository has no component test and this entry does not start the pattern.

**Where** `frontend/src/lib/server-models.ts`, `frontend/src/stores/use-config-store.ts`,
`frontend/src/services/api/audio.ts`, `frontend/src/components/audio-settings-panel.tsx`,
`frontend/src/components/canvas/canvas-audio-settings-popover.tsx`,
`frontend/src/components/canvas/canvas-node-prompt-panel.tsx`,
`frontend/src/lib/canvas/{canvas-generation-helpers,canvas-node-factory,node-settings-memory}.ts`,
`frontend/src/lib/audio-generation.ts`, `frontend/src/i18n/locales/{zh-CN,en-US}.ts` (`settingsPanels.audio.seconds`),
`frontend/tests/{audio-duration,server-models}.test.ts`.

## 260. The audio panel has no voice and no speed

**Decision** The audio settings panel lost its Voice group (13 OpenAI voice names) and its Speed group (0.75×, 1×,
1.25×, 1.5× and a free number). `audioVoice`, `audioSpeed` and their helpers are gone from the config, the node
metadata, the inheritance list and the locale files.

**Why they went** They reached nothing. `requestAudioGeneration` sent the caption, the lyrics and the container; a
voice and a speed were values the panel collected, stored, inherited and displayed, and no request ever read. They are
leftovers from OpenAI's `/v1/audio/speech`, which this server no longer has (`internal/server/audio_runs_e2e_test.go`
opens with that fact). The one audio workflow the registry holds takes a caption, lyrics, a length and a format; it has
no voice input and no speed input to bind them to.

**What stayed, and why** The format pills stay even though `audio-minimax-music-3` writes only mp3, flac and opus: the
container is sent as chosen and the server answers with a message naming the set it accepts, which is a deliberate rule
(`services/api/audio.ts`) rather than a substitution the node's label would then be wrong about. The lyrics field stays
— it is the run's `lyrics` input — with its label and placeholder narrowed to lyrics, since the "speech workflows" the
old text mentioned are not a thing this server registers.

**Why no migration** There are no users, so there is nothing to upgrade: a document written by an older build of this
tree is not data anyone has. Dead keys in a local document are read by nothing, so they are not a reason for a
`delete` on the hydrate path and a test for it — that branch was written and then removed before this landed.
Migration earns its lines when someone
else's document has to keep working; until then the answer is to fix the shape and let old copies be old. Applied to
the one place the leftovers actually lived: `data/settings.json` carried six keys nothing in `AiConfig` declares —
`audioVoice`, `audioSpeed`, `canvasImageCount`, `count`, `progressRingSkin`, `promptOptimizeLanguage` — and they were
deleted from the file rather than tolerated, so the served `/config.js` now carries none of them (`/data/` is runtime
state, ignored by git, so this is a file edit and not a commit). (The
`asrUrl`/`asrModel` deletes above it are #252's, from a different argument: those two are now owned by the server, so a
copy in the preferences is a second answer to where audio goes.)

**Cost** A future speech workflow has no voice control to inherit; it will get one from its own declaration, the way
the duration control in #259 does. Undo is `git revert`.

**Tested** `npx vitest run` (368). `npm run check`'s export checker is what forced the helpers out rather than leaving
them orphaned (180 modules, none without a caller).

**Where** `frontend/src/lib/audio-generation.ts`, `frontend/src/components/audio-settings-panel.tsx`,
`frontend/src/components/canvas/canvas-audio-settings-popover.tsx`,
`frontend/src/stores/use-config-store.ts` (type, default, the model list's normaliser), `frontend/src/types/canvas.ts`,
`frontend/src/lib/canvas/{canvas-generation-helpers,canvas-node-factory,node-settings-memory}.ts`,
`frontend/src/i18n/locales/{zh-CN,en-US}.ts`.

## 261. A button's label gives way where the button ends

**Decision** `Button`'s label slot (`span[data-slot="text"]`) is `min-w-0 truncate`, and the three composer
pills — the video, image and audio settings triggers — carry their whole sentence in a `title` as well.

**What was wrong** The video node's settings pill showed `480p · 1:1 · 4s · First & last frame` drawn *past* its
own rounded background, 34 px of text on nothing. The button was capped (`!max-w-[200px]`) and the call site had put
`truncate` on a `span` inside it, which cannot work: `Button` wraps children in a `span[data-slot="text"]`, that
wrapper is a flex item of the button, and a flex item's `min-width: auto` refuses to shrink below its text — so the
wrapper stayed 208 px wide inside a 200 px button, and the inner `truncate` did nothing because an inline box has no
overflow to hide. Nothing in the app noticed: the pill is laid out by flexbox, no test has a layout, and `tsc` and
prettier cannot see a paint that escapes its box.

**Why the kit and not the call site** One call site remembered `truncate` and it silently failed. Put the rule where
the box is: the slot shrinks (`min-w-0`), and the slot ellipsises (`truncate`) — so a `truncate` inside the slot is
harmless and a missing one no longer matters. `Button` already promised `whitespace-nowrap`; a label that cannot wrap
has to have somewhere to go when the button is narrower than it is, and the only alternatives are spilling or
clipping. This is the clipping one, with an ellipsis to say so.

**Why the titles** With the label ellipsised, the sentence is unreadable at a glance — and it is the only place the
resolution, ratio, seconds and mode are shown together. `title` costs nothing and matches what `ModelPicker` already
does for the same reason (`title={optionLabel(current)}`).

**Measured, not assumed** A standalone page with the built stylesheet, the real button classes and the two markups,
rendered in headless Chrome: before, `button=200.0px slot=208.5px spill=+34.1px`; after, `button=200.0px
slot=165.4px spill=-9.0px` with `slotScroll=209` — i.e. the text now ends inside the pill and is clipped with an
ellipsis (the screenshot shows `480p · 1:1 · 4s · First & l…`). The 34 px is the same 34 px counted off the user's
screenshot (`pill fill ends at x≈445, text at x≈479`).

**What else changed on the way** The image popover's trigger computed `qwen ? label : hasReferences ? size : size` —
both branches identical, so `hasReferences` was a prop that changed nothing (`tsc` then refused to let it stay once
the redundant branch went). It is gone from the component and from its one call site. `globals.css` still carries
`.canvas-composer-icon` / `.canvas-composer-tools` rules whose only purpose was to shrink these labels; nothing
renders those classes since the composer was rebuilt, so they are dead CSS rather than the fix — left in place here,
noted for the next sweep.

**Cost** A label that would have been readable at full width is now ellipsised when the button is clamped — which is
what `!max-w-*` asked for. Buttons with an element child that is meant to poke outside their box would be clipped;
none exists (checked: no `absolute` child inside a `Button`).

**Tested** The headless-Chrome measurement above (throwaway, `/tmp/pill.html`), and `Button` is on every screen in the
app: `npx vitest run` (368), `npm run check` (863/849 keys, 180 modules, prettier, tsc), `npm run build` 561.61 kB,
`make check` (20 packages, 504 exports) all pass afterwards.

**Where** `frontend/src/components/kit/button.tsx`,
`frontend/src/components/canvas/canvas-video-settings-popover.tsx`,
`frontend/src/components/canvas/canvas-image-settings-popover.tsx`,
`frontend/src/components/canvas/canvas-audio-settings-popover.tsx`,
`frontend/src/components/canvas/canvas-node-prompt-panel.tsx`.

## 262. The video node's Edit button is gone

**Decision** The video node's hover toolbar no longer carries an `Edit` item. Everything it did was already
somewhere else, and the "somewhere else" is the same panel.

**What it was** `onToggleDialog(node)` — open (or close) the node's prompt panel. A click on a node body opens
exactly that panel (`project.tsx`: a mouse-up that did not move anything calls `setDialogNodeId`), so the button was
a second way to do the one thing a click does. It was also the only button whose label promised an *edit* and whose
action was a **generate**: inside that panel, `↑` re-runs the node and replaces its clip in place. A user who pressed
"Edit" on a finished clip to look at it found the thing that would overwrite it.

**What went with it** The `onToggleDialog` prop, the `MessageSquare` import, and `common.edit` in both dictionaries
(the i18n check refuses a dead key, which is how the last trace of it would have been found anyway).

**Cost** None measured: nothing referenced the button — no test, no agent tool, no keyboard shortcut — and clicking
the node still opens the panel. The panel itself still re-runs in place, which is its own question (#263 makes the
difference between "runs a step" and "answers a prompt" visible, which is most of what made this button read wrong).

**Tested** `npm run check` (863→862 keys, i18n/dead keys, exports, prettier, tsc) and `npx vitest run` (368) pass
with the button gone.

**Where** `frontend/src/components/canvas/canvas-node-hover-toolbar.tsx`, `frontend/src/pages/canvas/project.tsx`,
`frontend/src/i18n/locales/{en-US,zh-CN}.ts`.

## 263. A workflow's request contract is on the wire, and a step is a node's model

**Decision** Three things, one idea — *the panel reads what the workflow declares*:

1. `GET /api/workflows` carries the request contract: `accepts` (per media kind, `max: 0` meaning "takes none"),
   `mode` (`text` / `frames` / `reference`), `frameMode`, and `variantContracts` (one per mode) for a workflow with
   variants. These are the exact fields `PlanMedia` validates against, resolved by the same helper
   (`variantContractOf`) that `ResolveForMode` uses, so the panel and the 400 cannot disagree.
2. A workflow the canvas also drives from a button (interpolate, upscale, angle) is **tagged, not dropped** from the
   model list. A node can be one — that is how an interpolation node exists — but `defaultModelOptions` keeps it out
   of the "default model for new nodes" setting, because a default must run from a prompt.
3. A node whose workflow has no `prompt` binding gets a panel built from its contract: the connected media and what
   it still needs (from `accepts`), its knobs (from `parameters`), and no prompt box, no size/second/mode controls.
   Its run sends only those knobs and its media by kind, so nothing is accepted-and-ignored.

**What was wrong** The interpolation node created by the toolbar's Interpolate button showed **H3 text-to-video**: its
`metadata.model` was the workflow id `video-rife`, which the model list filtered out, so `resolveModelForCapability`
could not find it and fell back to the configured default video model. The same fallback then drew the rest of the
lie — a red "text-to-video does not accept images" warning over a clip that was the thing it ran on, and
`720p · 1:1 · 6s · First & last frame` for a workflow with no size, no seconds and no mode. Two sources of truth were
the cause: the registry declared `mode` and `accepts` for every H3 workflow and none of it reached the client, so the
canvas re-derived it from ids (`video-model-mode.ts`, `isH3T2V`, the `videoMode: "interpolate"` invented value that
`videoModeLabel` then bent back into "First & last frame").

**Why the contract and not a name list** A name list is what drifted: `video-h3-frames` was spelled in the client to
decide a mode, `video-rife` was spelled in a second list to decide visibility, and neither could know about a
workflow added tomorrow. `mode` and `accepts` are already the registry's own words — `video-h3-t2v` says
`mode: "text"`, `accepts: {images: {max: 0}}` — so `videoModelModePatch` became a one-line read of `mode` and the
tool panel a render of `accepts` + `parameters`.

**Why not fold H3 into one entry with `variants`** It would work — `ResolveForMode` + `mergeVariantContract` are
exactly that mechanism, and `image-qwen21` uses it (`edit`/`inpaint`/`outpaint`/`t2i`, each with its own `accepts`).
But the four H3 workflows are four *ids* in every saved canvas, so folding them means an alias or a hydrate
migration, and after this change the client already gets the same mode switch from `mode` for free. Two traps found
while checking: `mergeVariantContract` does not merge `Parameters` (a variant cannot declare its own knobs), and
`video-h3-character-swap` declared no `mode` — now `"reference"`, its behaviour made explicit.

**What stays hardcoded** The composer's own H3 branches (`isH3T2V`, the frames/reference mode switch in
`video-settings-panel.tsx`): they still recognise `video-h3-*` to decide *which mode options to offer*, which is now
a UI question about one family of workflows rather than a fact about the run. `accepts.note` is deliberately not on
the wire — it is English registry data, and the panel's copy comes from `i18n` (#66).

**Also** A step writes no settings onto its node: `videoRunMetadata` / `buildImageGenerationMetadata` keep `model` +
`params` + `references` and drop size/seconds/resolution/mode, so a node cannot claim a 720p it was never asked for.

**Tested** `internal/workflow/render_test.go` (the row carries `accepts`; each mode carries its own contract, and
the run path resolves the same one), `tests/server-models.test.ts` (a tool is tagged, says `hasPrompt: false`, and
carries its contract), `tests/api-video-runs.test.ts` (a step submits `{multiplier: 3}` + `media.video` and no
prompt), `tests/api-image-upscale.test.ts` (an upscaler submits `{upscale_model}` + `media.image`). `go test ./...`,
`npx vitest run` (373), `npm run check` (870/856 keys, 182 modules) pass.

**Where** `internal/workflow/render.go`, `internal/workflow/registry.go`, `workflows/registry.json`,
`frontend/src/services/api/{workflows,video,image}.ts`, `frontend/src/lib/server-models.ts`,
`frontend/src/lib/canvas/{tool-workflows,video-model-mode,video-run-metadata,canvas-node-factory}.ts`,
`frontend/src/stores/use-config-store.ts`, `frontend/src/hooks/use-local-server-sync.ts`,
`frontend/src/components/canvas/{canvas-tool-node-panel,canvas-node-prompt-panel}.tsx`,
`frontend/src/components/{model-picker.tsx,settings/preferences-dialog.tsx}`,
`frontend/src/pages/canvas/{project.tsx,hooks/*.ts}`, `frontend/scripts/check-i18n.cjs`.

## 264. A card that frames a picture is the picture's shape

**Decision** The image node's free-resize toggle is gone. `keepRatio` is now one read of the node
definition — `Boolean(definition?.keepsAspectRatio)` — with the image definition saying `true` exactly as
the video one already did, and the picture is drawn `object-contain` with no branch. Three things went with
it: the three clauses that used to answer "may this card change shape" (an `Image && !freeResize` test, a
bare `Video` test, and the definition), the field itself, and the function shape of the flag — it was a
`(node) => boolean` only because the answer once depended on the node, and now that it does not,
`keepsAspectRatio?: boolean` says the same thing without an argument nothing reads.

**Why** No one decided it. `freeResize` came in with the initial import (`ccfe94b`) and no entry in this
file ever mentioned it — searching `freeResize`, "Lock ratio" and "free resize" found nothing, which is the
same diagnosis #228 made of the per-node `replace`: inherited, not decided. Three pieces of
evidence say the same thing. It was hidden from the first day — `defaultVisible: false`, the only one of
twelve image quick tools a user had to go into the toolbar config to find. It was implemented as
`object-fill`, which stretches the photograph, and this app spends crop, outpaint and mask exactly to avoid
distorting a picture; if the need was "fill this slot", `object-cover` was the mechanism and it was never
the one built. And its own code already treated the picture's shape as the truth: switching the lock back
on recomputed the height from `naturalWidth/naturalHeight` and kept the centre, so free resize was
implemented as a temporary deviation, not a mode.

**The rule that replaces it** A card whose content is a picture or a film is that content's shape: drag its
corner and it scales. A card whose content is words is a reading choice — wide for one line, narrow for a
column — and a group's dashed rect is a layout statement; both are free, as they always were, because
neither has a shape to keep. That is why only the two media types carry `keepsAspectRatio` at all.

**Cost** None that has to be paid, and this is the reason to do it now rather than later. The project is
unreleased, so there is no document outside development that could carry `freeResize`: `grep` over `data/`
and `canvases/` finds none, and nothing has to be migrated or tolerated. A document written by a build
before this one would render its node `object-contain` and snap its next corner drag back to the picture's
ratio, which is the behaviour this entry is asking for anyway. Doing it after the first canvas is saved
would have meant either a migration or a field nobody reads.

**What it simplifies downstream** The agent's `resize_node` (not built yet) loses a branch: there is no
"was this node unlocked?" question, so a card that frames a picture has one degree of freedom and states
one number, and text/audio/group state two. A video never had an escape hatch; now an image does not either,
and the two types read the same everywhere.

**Tested** `npx tsc --noEmit` (deleting the field made every reader a compile error, which is the mechanical
proof that the list was complete), `npm run check` (the i18n check found the four now-dead keys and nothing
else: 866/852 keys, 182 modules, prettier clean), `npx vitest run` (40 files, 374 tests), `npm run build`
(569.02 kB, 1.3 kB smaller). No test pins the drag's ratio: the component's pointer math has no harness, and
the rule it now follows is a field on the definition rather than arithmetic in this file.

**Where** `frontend/src/types/{canvas,canvas-node}.ts`, `frontend/src/components/canvas/canvas-node.tsx`,
`frontend/src/components/canvas/nodes/builtin-nodes.tsx`,
`frontend/src/components/canvas/canvas-image-toolbar-tools.tsx`,
`frontend/src/components/canvas/canvas-node-hover-toolbar.tsx`, `frontend/src/pages/canvas/project.tsx`,
`frontend/src/i18n/locales/{en-US,zh-CN}.ts`.

## 265. A branch for a workflow the registry does not have

**Decision** The two places that still named `video-h3-fast` are gone: the filter inside
`WorkflowModelPicker` and the special case in the H3 composer's mode switch. The composer now always routes
a mode change through `videoModelForWorkflow`, which is what every other H3 node already did.

**Why** The workflow is not in `workflows/registry.json` — the video entries are `video-h3-t2v`,
`video-h3-frames`, `video-h3-ref2va`, `video-h3-character-swap` and `video-rife` — and no Go file names it
either. So both branches guarded an id the server cannot send: the picker filtered out a model that can
never be in the list, and the composer's early return was unreachable. #263 left the remaining `isH3*`
branches in this file on purpose, calling them a UI question about one family of workflows; a branch for a
workflow that is not in the registry is not a question, it is a leftover of the days when the client knew
which workflows existed.

**Cost** None. The only thing that could still reach those branches is a saved node whose model is
`video-h3-fast`, and there is no such node: the project is unreleased, and nothing was written while that id
existed. That is why this is a deletion rather than a compatibility shim — the shim would have had to be
carried forever and would have taught the next reader that the id means something.

**Tested** `npx tsc --noEmit` (removing the only `channelModelOf` use in the picker left an unused import,
which the compiler refuses), `npm run check` (866/852 keys, 182 modules, prettier clean), `npx vitest run`
(40 files, 374 tests), `npm run build` (568.88 kB).

**Where** `frontend/src/components/model-picker.tsx`,
`frontend/src/components/canvas/canvas-node-prompt-panel.tsx`.

## 266. The composer asks what a workflow declares, not which workflow it is

**Decision** The five id tests left in the video composer are now reads of the declaration:

- `isH3Text` / `isH3Frames` / `isH3Reference` → the model's `mode` (`text` / `frames` / `reference`), which
  #263 put on the wire; "this workflow is one of a family that has modes" → it declares a `mode` at all.
- The SelfLift fast/quality pills → the workflow declares `transition_step`, the knob that toggle writes
  (`services/api/video.ts`), carried as `selfLift`.
- A locked length ("follow source video") → no binding reads `seconds`, carried as `bindsSeconds`;
  `video-h3-character-swap` is the case: its `videos` binding names `sourceLengthInput`, so the clip decides.
- "This workflow takes no media" — the red warning and the disabled reference bar — → the contract's own
  caps: `images.max + videos.max + audios.max === 0`.
- The mode switch → `videoModelForMode` returns the model whose declared `mode` is the one chosen, instead of
  a table mapping `reference`/`frames`/`text` to `video-h3-ref2va`/`-frames`/`-t2v`.

`durationLocked` stopped being a prop threaded through two components: the panel and the settings pill both
ask `videoFollowsSource(config, model)`, so the control and the sentence about it cannot disagree.

**Why** #263 recorded these as "what stays hardcoded": the client still recognised `video-h3-*` to decide which
controls to offer. Each had the same defect — a workflow added tomorrow is invisible to the rule, and a
workflow removed leaves a branch that quietly does nothing. The SelfLift toggle was worse than invisible: it
writes `transition_step` into the request, so on a workflow that does not declare that knob the value travels
to the server and is ignored. The id test was right about which workflows to offer the toggle for, for the
wrong reason, and that is the kind of rightness that stops being right.

**The three-state read** `bindsSeconds` is a `boolean` on the wire (a listed workflow either binds the request's
seconds or does not) but `boolean | undefined` in the store, because a model the server did not list claims
nothing: an old local selection is then neither locked nor unlocked by the canvas. Same rule as #256 gave the
input kinds.

**What the pills say now** A locked length has two causes and they are not the same sentence: a clip being
edited sets it (a source duration is known, and the row names it) or the workflow fixes its own. `lengthFixed`
is the second, and `lockedDurationLabel` chooses between them from the one fact the panel has.

**Cost** For the shipped registry nothing changes: all four H3 workflows declare a mode, all four declare
`transition_step`, three bind `seconds` and character swap does not. Two edges move for a workflow the operator
added to their own `model.conf` (a Wan i2v, a custom graph): it is offered the frames/reference pills only if it
declares a mode, and it loses the seconds slider if none of its bindings reads `seconds`. Both are the
declaration's answer rather than ours, and the second one deletes a silent no-op — a seconds value that nothing
read was being sent on every run.

**Tested** `npx tsc --noEmit` (removing the id tests left `videoWorkflowId` used only inside its own file, which
the export check then refused), `npm run check` (867/853 keys, 182 modules, prettier clean), `npx vitest run`
(40 files, 377 tests — three new: `bindsSeconds` both ways, `selfLift` only where the knob is declared, a mode
finding its model while an unlisted model claims nothing), `npm run build` (569.25 kB), `make check` (deadcode
505). Not checked in a browser: the composer needs a server with the new registry on the other side of it, and
what changed is which branch a control takes, with the shipped registry's declarations unchanged.

**Where** `frontend/src/lib/server-models.ts`, `frontend/src/stores/use-config-store.ts`,
`frontend/src/lib/canvas/video-model-mode.ts`, `frontend/src/components/video-settings-panel.tsx`,
`frontend/src/components/canvas/{canvas-video-settings-popover,canvas-node-prompt-panel}.tsx`,
`frontend/src/i18n/locales/{en-US,zh-CN}.ts`, `frontend/tests/{server-models,model-selection}.test.ts`.

## 267. A step is a tool, and the mode sent is one the model declares

**Decision** Three fixes, one root: a workflow's *identity* was standing in where what it *declares* was the
answer.

1. **The image mode sent is resolved against the model that will run it.** `imageModeFor(config, model)` — the
   node's choice when the model declares it, else `t2i` when that is declared, else the first mode declared,
   and nothing at all for a workflow with no modes. `requestGeneration` uses it to decide the media roles and
   the outpaint numbers, and the settings pill uses it for the mode it claims to be on.
2. **A step is a tool.** `modelIsStep` is `tool === true || hasPrompt === false`, and the five places that have
   to agree now ask it: the node panel, the image request, the video request, and the two metadata builders.
   `modelTakesPrompt` stays, asking the different question it always asked — whether that step has a text box.
3. **The angle workflow declares its three knobs.** `image-qwen21-angle` binds through
   `from: params.horizontalAngle`, `params.pitchAngle`, `params.cameraDistance`, but declared no parameters —
   and a name is a valid input only when it is a semantic request key, a declared parameter, or a binding
   addressed as `params.<binding key>`. So the names the client sent were refused as `unknown_input`, and the
   binding's own keys were refused too: the knobs had no way in from either side.

**Why** Each one was a silent wrong request, not an untidiness:
- A node keeps its `imageMode` when the model under it changes, so an "inpaint" chosen on Qwen travelled to a
  workflow with one mode and no mask binding. The panel clamped that for its label; the request did not, and
  sent a mask role and padding to a graph that binds neither.
- The angle re-render takes words, so `hasPrompt` was true, so it was treated as a from-prompt model: its panel
  showed no knobs (they were unsettable) and its run went down the from-prompt path, where a step's parameters
  are never sent. A tool that happens to accept words is still a tool.
- With the knobs declared, the step panel renders them from the declaration with no client code — which is the
  same shape as #263: the panel shows what the workflow declares, and the server validates against the same
  declaration.

**Found on the way** The step request dropped the prompt entirely, which was invisible while every step
happened to have no prompt binding. It would have broken the one step that takes words the moment that step
started going down the step path. The step request now carries the prompt exactly where the workflow binds one,
and the step panel shows the box exactly there too.

**Cost** The angle workflow accepts three inputs it used to refuse — a widening of one workflow's surface, by
declaration. No ranges are declared for them, so a knob is unbounded at the API: the graph's own transform
(`int`, `invert10`) is the only judge. A bound belongs in the registry beside the default, and inventing one
here would be a second answer to a question the graph already answers.

A stale `imageMode` is now dropped rather than sent: someone who chose inpaint on Qwen and switched to Z-Image
gets a plain text-to-image run instead of a refusal. That is a silent substitution, and it is the deliberate
one — a request that cannot mean what it says is worse than one that means what the panel has been showing all
along.

**Tested** `go test ./...`, `make check` (deadcode 505) — `TestShippedAngleWorkflowAcceptsItsKnobs` pins the
declaration from both sides: the three names are accepted, the binding's own key (`horizontal`) is still
refused because nothing reads it, and a word is refused where a number belongs. Frontend: `npx tsc --noEmit`,
`npm run check` (867/853 keys, 183 modules), `npx vitest run` (40 files, 380 tests — `modelIsStep` covering a
tool that takes words, a tool that does not, a composer model and an unlisted one; `imageModeFor` covering a
declared mode, a stale one, an empty one and a workflow with no modes; and an angle step's request carrying the
prompt beside its knobs), `npm run build` (569.95 kB).

**Where** `internal/workflow/shipped_angle_test.go`, `workflows/registry.json`,
`frontend/src/lib/canvas/image-mode.ts`, `frontend/src/stores/use-config-store.ts`,
`frontend/src/services/api/{image,video}.ts`, `frontend/src/lib/canvas/{video-run-metadata,canvas-node-factory}.ts`,
`frontend/src/components/canvas/{canvas-node-prompt-panel,canvas-tool-node-panel,canvas-image-settings-popover}.tsx`,
`frontend/tests/{model-selection,api-image-upscale}.test.ts`.

## 268. The mode a stale node falls back to is the one that asks least

**Decision** `imageModeFor` no longer names a fallback mode. When the node's `imageMode` is not one the model
declares, the answer is the declared mode whose contract asks the least — the smallest sum of `minTotal` and
the per-kind minimums — and a family whose modes declare no contracts at all ties at zero and answers with its
first declared mode. This revises the fallback in #267, which spelled out `t2i`.

**Why** The name was the last one in a function that otherwise reads declarations, and it was right only by
accident: `t2i` is what the Qwen family calls "words only", and a video or audio family with modes would have
had no such mode to fall back to. The per-mode contracts are already on the wire (#263), so the fact was
there: the mode that needs nothing is the mode a request cannot be refused for.

**Cost** Two modes that both need nothing tie, and the first declared one wins — deterministic, but chosen by
the server's ordering rather than by meaning. A `defaultMode` field in the registry would say it outright; it
is not worth a wire field until a family actually has two equally-cheap modes and the wrong one matters.

**Tested** `npx vitest run` (380): the Qwen family still resolves a stale mode to `t2i` because that is what
its contract says (`images.max: 0`), and a two-mode family whose cheapest is `beta` resolves to `beta` — the
second case is the proof that no mode's name is left in the code.

**Where** `frontend/src/lib/canvas/image-mode.ts`, `frontend/tests/model-selection.test.ts`.

## 269. A knob is named by the dictionary, like every other registry string

**Decision** Parameter labels go through `serverParameterLabel(key, fallback)` in `lib/server-labels.ts`, the
same helper shape as `serverModelLabel` and `serverVariantLabel`: the Chinese label comes from
`server.parameters.<key>`, keyed by the identifier the server sends, and the registry's English is the
fallback. Both renderers use it — the step panel's `ParameterControl` and the super-resolve dialog's fields —
and the zh-CN dictionary gained an entry for every `key` the shipped registry declares. `check-i18n` declares
`server.parameters` as a dynamic prefix and as zh-only, like the other two.

**Why** #8 settled this question already: `workflows/registry.json` is data written in English, the dictionary
words it, and an identifier the dictionary does not know falls back to the registry's text so a hand-written
workflow still renders instead of showing a raw key. Parameters were the one family of registry strings that
had skipped it: the step panel printed `Multiplier` and `Horizontal angle` in a Chinese UI, and the
super-resolve dialog printed the same. The alternatives — a `labelKey` in the registry, or dropping `label`
from the wire — would be a second mechanism for a problem #8 answers, and would take away the fallback that
keeps an unknown workflow readable.

**Cost** The Chinese labels are a hand-kept list, and a parameter added to the registry tomorrow ships in
English until someone adds an entry. The check cannot catch that, because the set of parameters is registry
data rather than something the source names — #8's cost, now paid by knobs as well. The English screen is
unchanged, since `chinese()` answers only when the reader's language is zh-CN.

**Tested** `npm run check` (886 zh keys against 853 en, still "the two agree": the block is zh-only by design,
as declared), `npx tsc --noEmit`, `npx vitest run` (380), `npm run build` (570.69 kB). Not checked in a
browser: the labels are text in two components, and what could break is a missing entry, which shows the
registry's English exactly as before.

**Where** `frontend/src/lib/server-labels.ts`, `frontend/src/components/canvas/canvas-tool-node-panel.tsx`,
`frontend/src/components/canvas/canvas-node-super-resolve-dialog.tsx`, `frontend/src/i18n/locales/zh-CN.ts`,
`frontend/scripts/check-i18n.cjs`.

## 270. The agent can see a card's box, and set it

**Decision** Two things the agent was blind to:
- `list_nodes` now carries the box — `at (1541, 438), 320×240` — and, when a picture's own pixels are not
  that size, the picture's as well: `(picture 1920×1280)`. Two sizes, because a card is the *shape* of what it
  holds but not its size, and the second one is left out when the two agree.
- `resize_node(nodeId, size: {width, height?})` sets the box, and the top-left corner stays where it is — the
  same corner `move_node` states, so a resize never disturbs a node that was just placed.

A card that frames a picture or a film is that picture's shape (#264), so it has one degree of freedom: the
width, with the height following. A height stated beside it is *checked*, and a pair that disagrees is refused
with the height that fits (1 px of tolerance for the caller's own rounding). A card holding words, a sound or a
group takes both numbers, and one left out keeps the height it has.

Nothing here is new policy re-implemented: the ratio is `nodeRatio`, which was the expression inlined in the
corner drag; whether a card keeps it is the node definition's `keepsAspectRatio`; the floor is `NODE_MIN_SIZE`,
which the drag also used as two local numbers. For a locked card the effective minimum width is
`max(220, ceil(160 × ratio))` — the clamp the drag already applied without ever stating it, now a number the
agent is told.

**Why** With a box on the list and a size to set, laying out a row is arithmetic the model can do, and the tool
carries no new policy. #184 recorded "no collision test and no snapping" as the cost of `move_node`; the answer
was never a collision test, it was the numbers. The alternative — a size argument on `move_node` — merges two
intents into one call, which is the same reason `set_prompt` and `set_text` are two tools.

**Why a refusal and not a clamp** A clamp answers `isError: false` while doing something other than what was
asked, and the caller has to read the sentence to discover it. A refusal is a failed call that carries the fix
(`480 wide is 320 high — state that, or change only the width`), so the second call is the right one.

**Cost** Two things the tool says it cannot do, and both are content requests wearing a size request: a
picture's card cannot be made square (that is a crop or an outpaint, which the user has and the agent does not),
and a film's card cannot be freed from its film's shape (nothing can, since #264). A resize also moves the
node's centre, so its group membership can be stale afterwards without the box being wrong — the drag has the
same gap, and closing it in one path only would make the tool and the gesture disagree about what a resize
leaves behind.

**Tested** `make check` (deadcode 505), `go test ./...`,
`TestMCPHandshakeIsEnoughToDiscoverTheTools` (thirteen names, in order), `npx tsc --noEmit`,
`npm run check` (886/853, 183 modules), `npx vitest run` (386 — six new: the width-only resize on a 3:2 card,
the refused contradictory pair, a text card taking both numbers and keeping its height when given one, the
floor refused and named from both sides, a call with no size, and an id the canvas does not hold), `npm run
build` (572.72 kB). The tool tests register the real node definitions, so `keepsAspectRatio` is the real rule
rather than a stub. Not checked in a browser: the page on `:8190` is a build that does not advertise these
tools, and what changed is a tool's decision plus one line of `list_nodes`.

**Where** `internal/server/routes_mcp.go`, `internal/server/mcp_test.go`,
`frontend/src/lib/canvas/{canvas-agent-tools,canvas-agent-view,canvas-node-size}.ts`,
`frontend/src/components/canvas/canvas-node.tsx`, `frontend/src/pages/canvas/project.tsx`,
`frontend/src/pages/canvas/hooks/use-canvas-agent-tools.ts`,
`frontend/tests/{canvas-agent-tools,canvas-agent-view}.test.ts`.

## 271. `layout` is the node's word, not a mode

**Decision** `requestGeneration` reads the layout attachment from the node's own choice
(`config.imageMode === "layout" && config.layout`) instead of from the resolved mode, which is what
`requestEdit` had always done. The resolved mode — the one the model declares — decides only what `mode` the
request carries.

**Why** #267 changed that line to read the resolved mode, and the resolved mode is never "layout": it is not a
variant any workflow declares. `layout` is the client's name for "a text-to-image run whose prompt carries a
MOSS layout", which the server renders into the prompt (`internal/prompt/layout.go`). So the guard became
false, and every layout run dropped its layout — on the workflows where the feature actually works (the MOSS
ones, which declare no variants), the payload vanished and the run produced a picture from the prompt alone.

This is the failure mode #267 was written against, arriving from the other side: a client word read as if the
server had declared it. Caught while mapping the image family's remaining id-shaped decisions, not by a test —
which is why the test now exists.

**Cost** None: the line goes back to what `requestEdit` does, and the two request paths now agree about what a
layout run is. A stale `layout` on a family that declares modes pins the mode that asks least (#268) *and*
keeps the layout, which is one more reason the pseudo mode cannot be read from the resolved one.

**Tested** `npx vitest run` (388, two new): a MOSS-shaped workflow sends `layout` + `layoutEnabled` and no
`mode` at all; a family with declared modes sends `mode: "t2i"` (the mode that asks least) and still carries the
layout. The first of those fails against #267's line, which is what makes it a regression test rather than a
description. `npx tsc --noEmit`, `npm run check` (886/853, 183 modules), `npm run build` (572.73 kB).

**Where** `frontend/src/services/api/image.ts`, `frontend/tests/api-image-upscale.test.ts`.

## 272. What the browser said

**Decision** None — this is the browser check that #264, #266, #267, #269, #270 and #271 were missing. The
server on `:8190` was rebuilt from this tree and restarted (`make build`, `./start.sh`), the page hard-loaded,
and eight things looked at. What follows is what was seen, not what the tests promised.

**On the wire** `GET /api/workflows` carries it: `mode` and `accepts` on the four H3 video workflows,
`variantModes: ["edit","inpaint","outpaint","t2i"]` on `image-qwen21`, `parameters: [horizontalAngle, pitchAngle,
cameraDistance]` on `image-qwen21-angle` (the declaration from #267), `multiplier` on `video-rife`. The agent's
startup frame answered `MCP servers initialized: 1 servers, 13 tools loaded` — twelve tools and `resize_node`.

**The bug this thread started from is gone.** A canvas with a RIFE node saved as `model: default::video-rife`,
`params: {multiplier: 2}` shows a node titled `RIFE 插帧 2×` whose panel is: one connected clip, `Needs 1
clip(s) · 1 connected`, `Multiplier` with the pills `2` and `3`, and Generate. No prompt box, no size/seconds/
mode pills, no red "text-to-video does not accept images" warning. In Chinese: `需要 1 条视频 · 已连 1`,
`插帧倍数`, and the picker reads `RIFE 帧插值` — three dictionaries answering, the requirement, the knob and the
model.

**The angle step renders from its declaration.** Retargeting an image node to `Qwen Image 2.1 多角度` switches
the panel from the composer to the step panel: a prompt box (the step takes words), `需要 1 张图片 · 已连 0`, and
`水平角度` / `俯仰角度` / `镜头距离` as number inputs at their declared defaults (0, 0, 5), with Generate disabled
while the requirement is unmet. Before #267 this was the composer — prompt and size pills, no knobs — and its
request would have been refused for inputs the workflow did not declare.

**Already in the page's own transcript, from a session the user drove**: `list_nodes` answered with the boxes
(`文字节点 (558×222)`, `视频 420×420`, `插值视频 420×420`) and the agent worked out a non-overlapping layout
from them; then `canvas_resize_node` was called and the panel reported `The call succeeded`. That is the tool's
round trip through the bridge, the socket and the page — done before this entry was written, by the person using
it.

**Not exercised** The ratio refusal: the live resize was a square picture into a square card, so the
disagreement path was never taken in the browser (it is unit-tested). Nor was the group-membership gap after a
resize (#270's cost).

**What the browser showed that the tests could not** An image node retargeted to a step keeps its own picture but
the step wants a *connected* one: the angle panel says `已连 0` on a node that visibly holds an image, so the step
cannot run until another node is wired into it. That is how steps have always worked (their media arrive as
references, not as their own content) and it is consistent — but "turn this picture into an angle" is exactly the
sentence a user will say next, and the engine already has the picture in hand. Left as a question, not changed
here.

**Where** Nothing. The server is running the rebuilt binary on `:8190`; the page was reloaded against it.

## 273. A node panel asks its kind for its controls instead of branching

**Decision** The controls a node's panel shows beside its prompt are a static table, one component per
generation kind, in `frontend/src/components/canvas/panels/`: `NODE_CONTROLS[mode]` answers with
`ImageControls`, `VideoControls`, `AudioControls` or `TextControls`. The panel keeps the shell — the reference
bar, the prompt box, the agent settings, the generate button — and renders `<Controls … />` where a four-arm
`mode === … ? … : …` chain used to sit in the middle of its JSX.

**Why** That chain put four different clusters of pickers and popovers inside one function, and the facts that
actually differ per kind (which pickers, which popover, which session) were spread around it as ternaries on
`mode === "text"`. The card itself made this move long ago — `nodeContentRenderers[type]` is the same shape, one
component per type, looked up at render — so the panel was the one place left asking what it was drawing.

**What it is not** A registry: no `register…`, no lifecycle, nothing that runs at startup. The table is a
`Record<CanvasGenerationMode, ComponentType<NodeControlsProps>>`, written out once, so the compiler refuses a new
kind with no controls. The canvas had a plugin mechanism and deleted it (#148); a table typed by a closed union
is not that.

**The seam** `NodeControlsProps`: the shared core (`node`, `config`, `onConfigChange`, `onOpenPreferences`) and
the few optional members only one kind has (the image popover's open notification and its three editors, the
video kind's frame mode and mode switch and source length, the text kind's agent). A kind reads what it needs.

**Cost** The panel went from 588 lines to 538 — less than the "~350" I said it would, because the arms were only
about fifty lines and the rest of the panel is the shell that stays. What is left are the `mode === "text"`
ternaries around the placeholder wording, the caption button and the generate button's "connect the agent"
behaviour: those are the shell's behaviour rather than a kind's controls, and moving them would mean the table
carrying `placeholder` and `primary` — a second decision, not this one. Every kind also receives the whole props
object, so a kind that needs two fields still takes a bag of twelve; that is deliberate (four near-identical prop
types are worse) and it is the part most likely to drift.

**Tested** `npx tsc --noEmit`, `npm run check` (189 modules, 886/853 keys, prettier clean), `npx vitest run`
(40 files, 388 tests), `npm run build` (573.31 kB). In the browser, on an isolated copy of the workspace
(`/tmp/verify`, port 8191, its own canvas root): a text node's panel shows its agent cluster; an image node's
shows the workflow picker, the base-model picker and its settings popover (Size, Aspect ratio); a video node's
shows the workflow picker and its popover (Resolution, Seconds, Refine, Mode) — and picking `Quality` wrote
`videoSelfLiftMode: quality` onto the node, which is the moved `videoConfigPatch` working. An audio node could
not be made from the canvas menu (there is no such entry — a sound arrives by import, through a native file
chooser), so that panel was not looked at; it is the same three lines as the video one.

**Where** `frontend/src/components/canvas/panels/{node-controls,node-controls-props,image-controls,video-controls,audio-controls,text-controls}.tsx`,
`frontend/src/components/canvas/canvas-node-prompt-panel.tsx`.

## 274. The keys a run may take are on the wire, and the canvas prunes to them

**Decision** `PublicEntry` and every `VariantContract` now carry `inputs`: the keys a run of that workflow (in
that mode) may carry. It is `Entry.AcceptedInputs()`, which is `InputSpecs` reduced to its keys — the same list
`ValidateInputs` enforces. On the client, `paramsAcceptedBy(config, model, params, mode)` keeps only the stored
knobs that list names, and the four request paths ask it before they send: `requestGeneration`, `requestEdit`,
`createServerVideoTask`, `createVideoStepTask`.

**Why** A node keeps its `params` when the model under it changes, and a knob belongs to the model that
declared it, not to the node. So a value from a previous model travelled with the request and was refused:

```
POST /api/canvases/…/runs  {"workflow":"image-z-image-turbo","inputs":{"prompt":"probe","upscale_model":"…"}}
→ 400 unknown_input "upscale_model"; workflow image-z-image-turbo accepts: …
```

That is reachable with the shipped workflows and no operator additions: upscale a picture (the node stores
`upscale_model`), change the node's model to Z-Image, press generate. The refusal names a field the user never
typed.

**The same line closes the latent one** `videoSelfLiftMode` used to be sent to every from-prompt video workflow
as `transition_step`. It is a declared parameter of the four H3 workflows and of nothing else, so an operator's
own video workflow was refused on every run. Now it is a knobs-like value that survives the same pruning.

**Why the wire and not a client rule** The client could have guessed — union of `parameters` with a hardcoded
`editCanvasSize` — but `editCanvasSize` is a *request* key rather than a declared parameter, so that rule would
have dropped it, and a future workflow whose knob is bound as `params.<name>` without a declaration would have
been dropped too. The server already computes this list for validation; carrying it is what makes the panel and
the 400 the same answer rather than two.

**Three states, again** `inputs` is absent when a server does not say, and the client then sends everything it
has: a model it knows nothing about is not a model that takes nothing. `[]` is normalised away for the same
reason.

**Cost** The workflows payload grows by one array per workflow and per mode (15 to 24 short strings each, the
request's own keys included). A knob the server does not declare is now dropped silently instead of refused
loudly — which is the same outcome seen from the other side, since the server would have refused the run
anyway; what changed is that the run now happens.

**Tested** `go test ./...` (`TestPublicProjectionCarriesTheKeysARunMayTake`: the entry's keys, the variant's own,
and that a key the projection offers is one `ValidateInputs` accepts), `make check` (deadcode 506),
`npx tsc --noEmit`, `npm run check` (189 modules, 886/853 keys), `npx vitest run` (391: the picker entry carries
the list per workflow and per mode, an empty list normalises to absent, `paramsAcceptedBy` keeps an accepted
knob and `editCanvasSize`, drops the stale one, returns nothing when nothing is left, and passes everything
through for a model it knows nothing about; and one request-shaped test whose body is exactly
`{prompt, seed, size}` where `upscale_model` used to be), `npm run build` (574.04 kB). On an isolated copy
(`/tmp/verify`, port 8191): all thirteen shipped workflows report their keys, `upscale_model` only on the
upscaler, `multiplier` only on the interpolation, `transition_step` only on the four H3 ones, and
`image-qwen21/outpaint` adds exactly the eight padding keys its siblings do not have.

**Where** `internal/workflow/{inputs,render,render_test}.go`, `frontend/src/services/api/{workflows,image,video}.ts`,
`frontend/src/lib/server-models.ts`, `frontend/src/stores/use-config-store.ts`,
`frontend/tests/{server-models,model-selection,api-image-upscale}.test.ts`.

## 275. `negative` is a key only a graph with a negative text encoder can take

**Decision** `InputSpecs` now adds `negative` only when a binding reads that field — a `negative` binding with
no `from`, or one that names `negative` explicitly. Every other request key is still added for every workflow.
The helper is `negativeBound`; the rule is one `if` in the one function that both the wire projection and the
validator already share.

**Why** `/api/workflows` declared `negative` for all thirteen shipped workflows, and nine of them could not
have used it: Z-Image and the four H3 video workflows wire `ConditioningZeroOut(positive)` as their negative
(there is no second text encoder to write to), ESREGAN has no text at all, `image-qwen21-angle` has the negative
string baked into the graph with no binding, and the music workflow has no text encoder either. A run carrying
the key was accepted and dropped — the same lie #274 removed from the other direction, where the client sent a
key the server refused. A key the contract offers is a key a client may build a control for, and a control that
provably does nothing is worse than no control.

**Why the control is not what was added** Nothing in the UI needed this. Measured on the real server: at `cfg 1`
the negative branch is not evaluated at all (ComfyUI's cfg-1 skip), so two different negative strings give
byte-identical pictures on MOSS and Qwen-Image and identical 22-frame video on H3, while `cfg 2` changes the
whole image. Every shipped image graph runs `cfg 1` and the H3 sampler's own default of 5 is overridden to 1, so
a negative box would be a box that changes nothing until cfg is raised — and raising cfg is exactly what these
distilled models are not trained for (the node's declared parameter range is 1..10, the graphs pin 1). When a
non-distilled model arrives, `negative` and `cfg` are one decision made together; today `negative` is silently
inert and must not be advertised as if it worked.

**Cost** Nine workflows lose a key from their `inputs`: a caller that used to send `negative` there and see no
effect now gets `unknown_input` naming the key. That is the intended trade — the answer changed from "yes, and
nothing happened" to "no". A workflow that gains a negative text encoder later must bind it by name, which is
the rule every other knob already follows.

**Not closed here** Other request keys are still offered to workflows that ignore them: `size` to the upscaler,
`seconds` to an image workflow, `layout` to anything but MOSS. Closing that class is the same shape of fix, but
it needs the client to stop sending those keys first — `services/api/image.ts` sends `size` and `background`
unconditionally — so it is its own change. It is written down where the list lives, in `semanticInputs`.

**Tested** `go test ./...` (`TestShippedNegativeIsAcceptedOnlyWhereItIsRead`: the four entries and four Qwen
modes that bind it accept `negative` and are not refused; the nine that cannot refuse it with the ordinary
unknown-key message; `TestNegativeIsAnInputOnlyWhenABindingReadsThatField`: a `from`-less binding makes the key
real, a binding that reads `params.other` does not, and a workflow with no negative binding does not advertise
it), `make check` (deadcode 506), `npx tsc --noEmit`, `npm run check` (189 modules), `npx vitest run` (391),
`npm run build` (574.04 kB). On an isolated copy (`/tmp/verify`, port 8191) `GET /api/workflows` reports
`negative` only for `image-qwen21` (all four variant contracts) and the three MOSS workflows, and for none of
Z-Image, ESREGAN, the angle workflow, the four H3 ones, RIFE or the music one.

**Where** `internal/workflow/inputs.go`, `internal/workflow/shipped_negative_test.go`.

## 276. A server built in a test is closed in that test

**Decision** `newTestServerWith` registers `t.Cleanup` that calls `srv.Close()` and then `srv.Tasks().Close()`.
Nothing in production changed; only the fixture.

**Why** A server starts what it owns — the task pump, the cleanup ticker, the MCP bridge — and those goroutines
write into the directories the test just made. `t.TempDir()` removes its tree as soon as the test body returns,
so a run that an assertion had queued was still being persisted while the removal walked the same tree:

```
--- FAIL: TestRunValidatesTypedInputs (0.01s)
    testing.go:1464: TempDir RemoveAll cleanup: unlinkat /tmp/TestRunValidatesTypedInputs…/001/data: directory not empty
```

It is not a rare interleaving: the test failed four runs in five on an otherwise clean tree (`git stash` of the
change under test reproduced it), and passed or failed depending only on whether the pump finished first. A gate
that reports a different answer for the same code is worse than a gate that reports a failure, because the
failure gets re-run until it is green and the real one gets re-run with it.

**Cost** Every test server now waits for its store to drain (up to `Store.Close`'s two-second bound) at the end
of its test, and its MCP bridge stops there rather than with the process. Both closes are idempotent, so a test
that already closed them is unaffected. The server package takes ~31s for three runs afterwards, unchanged.

**Tested** `go test -count=1 -run TestRunValidatesTypedInputs ./internal/server/` eight times in a row (was 4/5
failing, now 8/8 passing), `go test -count=3 ./internal/server/` (green), `go test ./...`, `make check`
(deadcode 506).

**Where** `internal/server/e2e_test.go`.

## 277. A click on a clip is a click on the node

**Decision** `VideoNodeContent` renders the clip without native controls and without pointer events until it is
playing. The only way in is a play button over the still frame (`canvas.node.play`); starting playback attaches
`controls`, so seeking, volume and fullscreen stay the browser's own. The node's state comes from the element's
`play` / `pause` / `ended` events rather than from the button, so playback started anywhere — the button, the
multi-selection's "Play together", the native controls — leaves the node in the same shape.

**Why** `<video controls>` plays when its own surface is clicked, and on a canvas that surface is most of the
node. Measured in the browser before the change: a click on the frame took the clip from `t=0` to playing, while
the same click also selected the node and opened its composer. One gesture, two meanings, and the louder one won
— selecting a clip, or opening the composer to rewrite its prompt, started it. The element now carries
`pointer-events-none` while it is not playing, which puts the node back in the pointer's way: the click selects
and opens, exactly as it does on an image.

**Why not `preventDefault` on the element's click** It was tried and it works — a `click` listener calling
`preventDefault` kept the clip at `t=0` (verified in the page). It was rejected because it leaves the video as
the click target: the frame would still swallow the right-click that opens the node's menu, the wheel would still
be guarded, and the result would rest on a user-agent default action we measured once, with the risk that the
same default is what makes the controls' own play button work. Taking the element out of the pointer's way has
none of that: what happens next is the same DOM arithmetic as every other node.

**Cost** Playback needs one deliberate click where a click used to be enough. A canvas full of paused clips shows
one play button each, over the frame. Wheel over a *paused* clip now zooms the canvas, because the target is the
node and `data-canvas-no-zoom` no longer matches — the same as an image, and the guard still holds while the
clip plays and its controls are live. The controls are the browser's, so they fade when the pointer leaves; a
pause needs a hover first.

**Tested** In the browser on an isolated copy (`/tmp/verify`, port 8191) of a real canvas: clicking the frame of
a paused clip leaves `paused=true, controls=false, currentTime=0` and selects the node (`z-50`) with its composer
open; the play button takes it to `paused=false, controls=true` and the button disappears; `pause()` and reaching
the end both bring the still frame and the button back; shift-click plus "Play together" plays both clips muted
from 0 as before; a wheel over a paused clip moves the canvas zoom 100% → 112%. Photographed at both states.
`npx tsc --noEmit`, `npm run check` (887/854 keys, 189 modules), `npx vitest run` (391), `npm run build`
(574.92 kB), `go test ./...`, `make check` (deadcode 506).

**Where** `frontend/src/components/canvas/canvas-node.tsx`, `frontend/src/i18n/locales/{en-US,zh-CN}.ts`.

## 278. A text card is words, and nothing asks it anything

**Decision** A text node has one field: `content`. It has no `prompt`, no `composerContent`, no panel and no
generate button — `generate` is refused on one and so is `set_prompt`, and `set_text` is the only writer. The
反推提示词 button is gone with everything it needed: `captionStatus`/`captionPrompt`/`captionError`,
`caption-jobs.ts`, `requestPromptChat` (`services/api/prompts.ts`), `askOnceAgentSession`, `endAgentSession`, and
the `node:<id>` session name — a text node's own agent had no other caller. The batch machinery went with the
generation that made it: `texts`, `primaryTextId`, `textCount`, and `TextContent`'s `BatchFrame` /
`ExpandedTextCard` / `TextSlotStatus`. `CanvasGenerationMode` lost `"text"`, so the compiler had to visit every
place that had assumed four kinds.

**Why** A text node's prompt was read by exactly one thing: the node's own agent, which answered it and wrote the
card. Nothing else — a connection carries `content` (`resourceText`, `resourceKind` and `builtinResource` all go
through `nodeContentOf`), the server never reads the field, and no run ever carried it. So the field existed to
feed a process whose whole job was to fill the card, and the canvas agent does that directly: `read_node` hands
it a picture, `set_text` writes words, `create_node` makes a card that already says them. Measured on the user's
own canvas first: its one text node held `content` and no `prompt` at all — the one-off agent had never been
used there.

反推 was the last caller, and it was the thing #257 deleted everywhere else: a sentence written inside the canvas
(`用一段话描述这张图片…`, hardcoded Chinese, no skill, no test) whose answer went into `prompt` — a field nothing
downstream reads — so the real flow was 反推 → press ↑ → the same model asked to repeat that sentence → the card.
Two round trips to say one thing, from a button that made a node to hold a question nothing else wanted.

**Why not keep 反推 as a tool** A tool would have to carry the same sentence, and there is nowhere honest to put
it: the canvas has no place for prompt wording that is not a skill (#76, #257), and a tool description is read by
the model before it acts rather than being the thing it acts on.

**Cost** Turning a picture into words is now a conversation with the canvas agent instead of one click, and it
needs a model that declares image input — `read_node` hands the bytes over either way, but whether a model can
read them is AlayaCore's judgement, not this server's. The per-node model picker for writing a card goes with the
panel: the canvas agent's model is the one that writes now. A canvas saved before this change may hold a text
node whose `prompt` had words in it; that field is no longer read, and folding it into `content` would be
inventing an answer to a question nobody can see.

**Tested** In the browser on an isolated copy (`/tmp/verify`, port 8191) of the user's canvas: a click on the
text card opens no panel (0 `[data-node-panel]` elements; before the change it opened one with a prompt box and a
连接 button), a double-click still opens the card's editor with the words in it, an image node's panel is
unchanged (model picker, 1:1, Generate, sent-prompt disclosure — and no 反推 and no agent picker), and the
hover toolbar lists info/remove/download/copy prompt/mask/crop/split/upscale/super-resolve/angle/view/configure
with no 反推, as does the quick-tools window. `npx vitest run` (378 in 39 files — `api-prompts.test.ts` went with
its subject, the rest rewritten for the new answers), `npm run check` (862 zh keys, 829 en, 25 dead keys removed
from each, 186 modules), `npm run build` 558.77 kB, `make check` (deadcode 506), `go test ./...`.

**Where** `frontend/src/types/canvas.ts`, `frontend/src/lib/canvas/node-prompt-field.ts`,
`frontend/src/lib/canvas/canvas-agent-tools.ts`, `frontend/src/components/canvas/canvas-node.tsx`,
`frontend/src/components/canvas/canvas-node-prompt-panel.tsx`,
`frontend/src/components/canvas/{canvas-node-hover-toolbar,canvas-image-toolbar-tools}.tsx`,
`frontend/src/components/canvas/panels/{node-controls,node-controls-props}.tsx`,
`frontend/src/pages/canvas/project.tsx`, `frontend/src/pages/canvas/hooks/use-generation-runs.ts`,
`frontend/src/services/api/agent.ts`, `frontend/src/i18n/locales/{en-US,zh-CN}.ts`,
`internal/server/{routes_mcp.go,agent_instructions.go}`, `docs/server.md`.

## 279. A tool answer is one frame, and the socket admits as much

**Decision** `internal/ws.maxMessage` is the agent's frame bound (`agent.MaxFrameSize`, 64 MiB) rather than a
number of its own, and a test holds the two equal. `MAX_INLINE_MEDIA_BASE64` in `canvas-agent-tools.ts` follows
it: 40 MiB of base64, about 30 MB of file, instead of 5 MiB.

**Why** A tool answer is one message on the agent socket and one frame on the agent's stdin. Those two hops had
unrelated bounds — 8 MiB and 64 MiB — so a picture that the agent would have accepted was refused, and refused
badly: `ws.ReadMessage` fails, the socket dies and the turn with it, and the page shows 请求失败. The number
that was supposed to produce a sentence (`MAX_INLINE_MEDIA_BASE64`, checked in the page) sat in front of a wall
it did not know about, with no relation to it: 5 MiB base64 into an 8 MiB message, 2.3× of headroom, chosen once
by nobody in particular.

Nothing was protected by the smaller number. 64 MiB is already the size the agent's own reader permits one hop
later, so the only thing the 8 MiB bought was an inconsistent refusal — and a tool answer is not a dangerous
message: it is the page the user is looking at answering a call that page made.

**Why not scale the picture here** AlayaCore already scales what it hands a model, so doing it in the page would
be a second answer to the same question and a worse one (it would also mean deciding what a picture is for — a
look, a detail, a colour). What this side owes is the bytes on the wire, and to say so when they do not fit.

**Cost** One WebSocket message may now allocate 64 MiB on each side, where it used to be capped at 8. That is the
same allocation the agent's frame reader already allows, so it is not a new class of failure — and a tool answer
over 40 MiB of base64 is still refused with a sentence that says how to look at the file instead.

**Tested** `go test ./internal/ws/` (the new test fails if the two bounds drift; it is the reason the number can
be stated in one place and read in two), `go test ./...`, `make check` (deadcode 506), `npx tsc --noEmit`,
`npm run check`, `npx vitest run` (378), `npm run build` (558.77 kB).

**Where** `internal/ws/ws.go`, `internal/ws/ws_test.go`, `frontend/src/lib/canvas/canvas-agent-tools.ts`.

## 280. Whether a session keeps a conversation is the name's business, not the client's

**Decision** `GET /api/agent/socket/{session}` carries no query. `agentOptionsFor(session)` asks
`sessionFile(session)`: a `canvas:<id>` is spawned with `<CANVAS_ROOT>/<id>/session.alaya`, and any other name is
spawned with no `--session` at all. "This name is not a canvas" is now a sentinel (`errNotACanvas`) rather than
the one generic error, so the caller can tell a name that keeps nothing from a canvas whose directory cannot be
resolved — which used to arrive as the same string.

**Why** `?history=1` asked the client to say whether the server should keep a conversation, while the server
already reads the name to decide *where* it goes (`sessionFile`, #178). One question answered in two places, and
the answer the client gave was the one that could be wrong: a canvas that forgot the flag kept nothing, and a
name that was not a canvas could ask for a file it had no home for. The flag was made for the node panels (#104),
and those no longer exist (#278).

**Why not give every name a file** Measured rather than assumed: `alayacore --rawio --session /tmp/probe.alaya`
writes nothing until something is said, and a `model_sync` command exchange writes nothing either — only
conversation content is persisted. So the choice was never "a file for the models editor or not"; it was "one
rule or two". The name decides where, and a name with nowhere has nothing.

**Cost** The models editor cannot ask for a file even if a future one wanted to; that would have to be a name
with a home, not a flag. The models editor keeps its session, because it cannot not: `model.conf` is a
`---`-separated hand-edited file and AlayaCore is the only thing that writes it, so `model_sync` needs a process
to send it to. What a canvas gains is that it cannot forget its conversation any more.

**Tested** `TestTheNameDecidesWhetherTheConversationIsKept` (a canvas is spawned with a file inside its own
directory, `settings` with none, and a missing canvas is still an error), `go test ./...`, `make check`
(deadcode 506), `npx tsc --noEmit`, `npm run check`, `npx vitest run` (378), `npm run build` (558.72 kB). The
probe above ran against a copy of the real `model.conf` in `/tmp/probeconf`, so nothing the user owns was
written.

**Where** `internal/server/{agent_conversations.go,agent_config.go,routes_agent.go}`,
`internal/agent/sessions.go` (a comment that named the wrong caller of `List`),
`frontend/src/services/api/agent.ts`, `frontend/src/components/canvas/canvas-agent-panel.tsx`,
`internal/server/agent_e2e_test.go`, `docs/decisions.md` (#104).

## 281. A tool line leads with how it went, and names what it was about

**Decision** A tool call in the agent panel is one line: the state mark, then `calling <tool>`, then the argument
that names what the call was about, then — for a file read — the part of the file it asked for. The mark stands
where the wrench icon stood — a ball turning while the call is out, a green tick when it came back, a red cross
when it came back as a failure, a dashed circle when the turn ended before the call did. The subject comes from
`toolSubjectOf` (`lib/canvas/tool-argument.ts`), a table of the built-in tools' identifying arguments read out of
the call's own JSON — `read_file`/`edit_file`/`write_file` → `path`, `execute_command` → `command`,
`search_content` → `pattern` — plus, for `read_file`, `start_line`/`num_lines` as `start=12, count=40`. The tool's
name and that range never shrink; the subject is the half that gets an ellipsis when the line runs out of room.

**Why the mark first** The question the line is read for is "did it work, or is it still going". A line answers
left to right, so an answer at the right-hand end is the last thing found — and once a path is on the line it is
the first thing an overflow takes. A tool icon was also the one glyph on the line that said the same thing every
time: that a tool ran. The mark says the part that differs.

**Why the range is its own half of the line** Which file is one question and where in it is another, and the
answer to the second is two numbers wide. Drawn at the end of one truncating span, `start=12, count=40` is the
first thing a long path eats — the reader would get a file name and no idea which part of it was read. So the path
gives way and the numbers do not. `start_line: 0` and `num_lines: 0` are AlayaCore's "from the top" and "to the
end", so they are left out rather than drawn as a place in the file.

**Why the argument, and only for these tools** "calling read_file" ten times over is ten identical lines; the file
is what tells them apart. The table stops at the tools whose arguments name a subject in words: the canvas's own
tools take node ids, which a reader cannot follow and which the panel beside them already shows, and a call whose
arguments have not arrived yet — the name frame comes first (#221) — has no subject at all, so the line is what it
was.

**Why a ball** One mark, four forms, and only one of them moves: at 11px a turning outline and a settled success
read too much alike, and a solid disc is unmistakably not a tick. It is `theme.node.muted` with a white specular
highlight off centre, so the rotation is a highlight going round rather than a whole dot rotating invisibly — in
both palettes, since it wears the theme's own colours rather than the two the tick and cross need to mean what
they mean.

**Cost** The table knows AlayaCore's field names, so a built-in added upstream shows no subject until the table
learns it — nothing is guessed from an argument's shape, because "the first string in the JSON" is the sort of
guess that shows a node id to a reader. The wrench icon is gone from the panel's imports.

**Tested** `tests/tool-argument.test.ts` (each built-in, each shape of a line range, a range with nothing to
narrow, an unknown tool, arguments that have not arrived, are not JSON, or hold an empty or non-string field, and a
command folded onto one line). The states and the truncation were rendered in a throwaway harness at 1× and 4× in
both palettes — a long path cut to `frontend/src/components/c…` with `start=12, count=40` whole beside it — and
two screenshots of the turning ball differ only around the marks, so it turns. End to end on an isolated `:8191`
with the real AlayaCore: a `read_file` call drew `✓ calling read_file frontend/src/main.tsx` in the panel, and a
`canvas_read_node` call was caught while `[aria-label="The call is running"]` was set. `make check` (deadcode
506), `go test ./...`, `npx tsc --noEmit`, `npm run check` (i18n 861/828, exports 187 modules), `npx vitest run`
(387), `npm run build` (559.28 kB).

**Where** `frontend/src/components/canvas/canvas-agent-panel.tsx` (`ToolStepLine`),
`frontend/src/lib/canvas/tool-argument.ts`, `frontend/tests/tool-argument.test.ts`.

## 282. A folded thought shows its two ends

**Decision** A collapsed reasoning row reads `Thinking <head> … <tail>`: the first 120 characters of the thought,
one ellipsis, and its last 20. `reasoningPreview` (`lib/canvas/reasoning-preview.ts`) cuts both halves by length,
folds their line breaks into single spaces, drops half a character at either edge, and drops the punctuation a cut
can leave at the front of the tail. Expanded, the preview is not drawn at all — the whole thought is under the row.

**Why** A closed row that says only "Thinking" hides the one thing that tells a reader whether to open it. The two
ends answer the two questions a fold is checked for: the start, to recognise the thought; the end, to know what it
concluded. The middle is the part a reader skips anyway.

**Why the ellipsis is drawn once** The row's "…" is a mark, not a character: it says the middle is gone. A head that
also ended in an ellipsis of its own — which is what an overflowing line does by default — made the row read
`blah… …blah`, two marks for one elision, and that is what an hour of looking at it caught (#282,
`text-overflow: ellipsis` → a fade). So the head *fades* out over the last 24px of its box where it runs out of
room, and the only ellipsis on the row is the one between the halves. A thought short enough that the head is all
of it has no second half and so no "…" to share: that one keeps the ellipsis an overflowing line is supposed to
end in.

**Why the tail is never cut** It is 20 characters by construction, so it fits even a panel dragged to its 320px
minimum, and a tail elided at its own end would drop the very words the tail exists to show. The head is the half
that gives way, and at narrow widths that means the head shows ten characters and fades — the conclusion is what
was asked for.

**Why by length and not by measurement** The thought arrives a delta at a time and the row is redrawn on every
frame (#237). Measuring text per frame — `scrollWidth`, `measureText` — is a layout read per frame; slicing is not.
Both slices are cut before they are tidied, so their cost is the 120+20 units asked for, whatever the thought has
grown to. That is the whole answer to "is this a performance problem": no, and the reason is in the order of the
two operations.

**Why `w-full` on the row, and why it is written down** A `<button>` is sized by its content, so the truncating
head had no width to truncate against: the row grew to the length of the thought's first 120 characters and the
transcript scrolled sideways instead of eliding. Found by asking the panel which elements had `scrollWidth >
clientWidth`, not by looking. The same trap waits for the next row that puts long text inside a button.

**Cost** A tail can begin mid-word, which is the price of not measuring, and a word is worth more than a boundary.
A head that fades takes a couple of its characters with it. The two lengths are constants in one file, and a wider
panel shows more of the same thought rather than more of the thought's ends.

**Tested** `tests/reasoning-preview.test.ts` (a short thought shown whole, a long one's two ends, the head reaching
the end so there is no middle to elide, line breaks folded, a cut through an emoji at either edge, punctuation left
at the front of the tail, and nothing to show for nothing). In the real panel against a real replayed conversation
on an isolated `:8191`, at 520px and at 408px: the folded rows read
`Thinking 用户希望把几个图片节点的尺寸改成一样的。当前三个图片节点的尺寸分别是：- image-17 … height 会根据图片形状自动计算。`
and, narrowed,
`Thinking 用户希望把几个图片节⌷ … height 会根据图片形状自动计算。` — one ellipsis in the middle either way, the
end whole either way. Opening a row hides the preview and draws the whole thought, and no element in the transcript
overflows horizontally once the button has a width. `make check` (deadcode 506), `go test ./...`,
`npx tsc --noEmit`, `npm run check` (i18n 861/828, exports 188 modules), `npx vitest run` (394), `npm run build`
(560.20 kB).

**Where** `frontend/src/components/canvas/canvas-agent-panel.tsx` (`ReasoningBlock`),
`frontend/src/lib/canvas/reasoning-preview.ts`, `frontend/tests/reasoning-preview.test.ts`.

## 283. The summarize threshold is the operator's, and it is a flag or nothing

**Decision** `AGENT_AUTO_SUMMARIZE` (0–100, unset = 0) is read by `config.Load` and carried to every spawn as
`--auto-summarize=<n>`. Zero means the flag is not passed at all, not that `--auto-summarize=0` is passed. A value
that is not a whole number in 0–100 stops the server at startup with a sentence naming the variable.

**Why it is an environment variable, and not a field in the models editor** AlayaCore reads this threshold from its
command line, not from `model.conf`: it belongs to the process, not to a model, and a session's model can be changed
after the process exists (`model_set`). The models editor edits `model.conf`, which is AlayaCore's file; a field there
would either do nothing or need AlayaCore to grow one. The other two agent knobs (`ALAYACORE_BIN`,
`AGENT_CONFIG_PATH`) are in the same table in `docs/server.md` for the same reason, and the server is the side that
spawns the process, so the number arrives where the flags are built.

**Why not the settings document** It would put the number where a user could set it in the UI, which is what the other
preferences do — but the server spawns on socket connect, so a client-written document would be steering process
arguments, which is exactly what #280 took away when it deleted `?history=1`. If this ever needs a control in the
panel, it needs a server-owned setting, and that is a different decision.

**Why strict** Every other number in the loader falls back to its default when it cannot be parsed, because those
defaults work. This one's default is "off", and off is invisible: a mistyped threshold would look exactly like a
conversation that never filled up. AlayaCore refuses the same values for the same reason (its `validate.go`), and a
server that accepted 150 would hand it a flag the agent rejects a moment later, turning a configuration mistake into a
spawn failure at the first message instead of a startup failure.

**Cost** The threshold is one number for every session on the server, canvas and models editor alike; per-canvas
thresholds would need a flag per spawn chosen by something, and nothing has asked for one.

**Tested** `TestAutoSummarizeIsTheOperatorsNumberOrNothing` (unset, `0`, `65`, `100`, padded, `101`, `-1`, `65%`,
`sixty` — the last four must fail and name the variable), `TestAutoSummarizeIsAFlagOnlyWhenAskedFor` (0 leaves the
flag off, 65 and 100 carry it), and on an isolated `:8191` with the real AlayaCore: `AGENT_AUTO_SUMMARIZE=150` refused
to start with `startup failed: AGENT_AUTO_SUMMARIZE must be 0 (off) or 1-100 (a threshold percentage), got 150`; with
`=65` the spawned process's `/proc/<pid>/cmdline` read
`alayacore --rawio --builtin-tools=read_file --auto-summarize=65 --config-path …` and the session connected
(`models=3`), so the agent accepts the flag it was given; with the variable unset the same line has no
`--auto-summarize` in it at all. `make check` (deadcode 506), `go test ./...`.

**Where** `internal/config/config.go` (`AgentAutoSummarize`, `autoSummarizeValue`), `internal/config/config_test.go`,
`internal/agent/spawn.go` (`SpawnOptions.AutoSummarize`, `args`), `internal/agent/args_test.go`,
`internal/server/routes_agent.go` (`agentOptions`), `docs/server.md`, `.env.example`.

## 284. The running line says the work, not the thought

**Decision** While an answer is streaming and has not said anything yet, the transcript shows one line under its
parts: a turning circle and `处理中… / Working…`. The folded reasoning row above it keeps its own title
(`思考 / Thinking`, #282). The two rows no longer share a word.

**Why** They were both labelled "Thinking": the fold titled the thought, the line said a turn was in progress, and
side by side in the same bubble they read as one thing drawn twice — the reader cannot tell which one opens. They
also are not the same claim. The line is true of the whole turn, and a turn that is running `canvas_move_node` is not
thinking; the fold's title is true only of that part, which is what it holds. One word each: the fold names what is
inside it, the line says the agent is still going.

**Why the line stays at all** The start of a turn has neither of the other two things — no fold, no call — so without
it the bubble is empty text over a panel that looks stuck, and the only other evidence is the stop button at the
composer, a panel's height away. It also carries the turn's shape for a reader who scrolls back mid-answer: the last
row of the transcript tells them whether anything is still arriving.

**Cost** "Working" does not say what work. That is #281's tool lines and the fold's ends; a word that tried to say
both again would be the duplicate this decision removes. The line also disappears the moment the first word of the
answer arrives — the condition is "nothing said yet" — so a turn that goes straight to text never shows it, which is
correct: its answer is the progress.

**Tested** On an isolated `:8191` with the real AlayaCore and a real turn, the panel's HTML was sampled every
~0.2 s across the whole turn: `Working…` was present from the instant the turn opened until it ended, absent for the
sixteen idle samples before it and every sample after it, and `Thinking…` appeared in none of the 100+ samples. Two
screenshots of the same turn: running, the bubble read
`> Thinking 用户想要把三个图片节点排成水平直线，间距 40px。当前三个图片节点的位置：… 视频节点：(880, 0)` above
`◌ Working…`; finished, the folds and the three `✓ calling canvas_move_node` rows with no status line under them.
`make check` (deadcode 506), `go test ./...`, `npx tsc --noEmit`, `npm run check` (i18n 861/828, exports 188 modules),
`npx vitest run` (394), `npm run build` (560.20 kB).

**Where** `frontend/src/components/canvas/canvas-agent-panel.tsx` (the streaming-and-silent line),
`frontend/src/i18n/locales/{zh-CN,en-US}.ts` (`canvas.agent.working`, renamed from `canvas.agent.thinking`).
