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

## 2. The Go half has no "nothing calls this" gate, and eleven exported symbols have no caller

The canvas fails on an export nobody imports (`scripts/check-exports.cjs`) and `tsc` fails on an unused local.
Neither has a Go counterpart, so an exported function whose last caller a refactor removed stays behind:

`Queue` (`internal/comfy`), `WithAudioTimeout` / `WithServerPort` / `WithMaxImportBytes` (`internal/config`),
`WriteJSONError` (`internal/httpx`), `DerivedDependencies` (`internal/resource` — its comment still calls it
"the single source of truth for a workflow's dependency list"), `IsAvailable` / `ModelCandidates`
(`internal/setup`), `Snapshot` (`internal/store`), `NormalizeModelPath` (`internal/workflow/helpers.go`),
`ReadGraphFile` (`internal/workflow/registry.go`).

**Fix to decide** Delete them, or add a check to `make check` that fails on an exported Go identifier with no
reference outside its own file (`golangci-lint`'s `unused` only sees unexported names; `deadcode` needs the
Network — `proxy.golang.org` was unreachable from here).

**Checked** `WithPublicBaseURL` (`internal/config`) and `OutputPath` (`internal/task`) left this list: a test
calls each. `golangci-lint` (default linters: errcheck, govet, ineffassign, staticcheck, unused) reports
nothing else in the product code, and `Hub.promptByRequest` (`internal/generate`) — a map written and deleted
and never read — was removed (#247).

---

## 3. An agent process can outlive the server that started it

**Symptom** `pgrep alayacore` finds a process whose server has been gone for hours. One was running here with
a ten-hour elapsed time and a parent id belonging to a shell that no longer had a server under it.

**Cause** Shutdown releases every session, and a released session kills its process — but that only runs when
the process is asked to stop. A server that is `SIGKILL`ed, or that dies on a panic outside the handler, leaves
its children behind: `internal/agent/spawn.go` starts them with `exec.Command` and no `Setpgid`, so nothing
else can find them as a group either, and nothing at startup looks for a previous run's leftovers.

**Fix to decide** A pid file written next to `mcp.conf` and read at startup, killing what it names; or
`Setpgid` per spawn plus a kill of the group on start. The first needs the file to be removed on a clean stop
(and to tolerate a recycled pid); the second needs the server's own group to be distinguishable from another
server's. Neither is a one-liner, which is why this is written down rather than guessed at.
