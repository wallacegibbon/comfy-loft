#!/usr/bin/env bash
# Starts what this project runs: one server process, which also serves the canvas bundle from its own
# origin (docs/decisions.md #219). Ctrl+C stops it; there is no crash recovery.
#
# There used to be a second process here — `vite preview` on :3000 — and with it two origins, a CORS
# allow-list to maintain, and every picture a cross-origin image that a canvas could not export. The
# bundle is static files, so the server serves it.
#
# ComfyUI is external and stays that way: nothing here starts, stops or waits for it. It may
# be on another machine, in a container, or under whatever manager the user prefers — the
# server only needs COMFY_URL.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# .env is data, not shell state: a variable the caller passed explicitly wins over it.
# Sourcing without this makes `COMFYLOFT_SERVER_PORT=9000 ./start.sh` come up on the .env port instead.
if [ -f "$ROOT/.env" ]; then
  declared=$(sed -nE 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=.*/\2/p' "$ROOT/.env")
  saved=()
  for name in $declared; do
    if [ -n "${!name+set}" ]; then saved+=("$name=${!name}"); fi
  done
  set -a
  # shellcheck disable=SC1091
  . "$ROOT/.env"
  set +a
  if [ "${#saved[@]}" -gt 0 ]; then
    for pair in "${saved[@]}"; do export "$pair"; done
  fi
fi

export COMFY_URL="${COMFY_URL:-http://127.0.0.1:8188}"
export COMFYLOFT_SERVER_HOST="${COMFYLOFT_SERVER_HOST:-127.0.0.1}"
export COMFYLOFT_SERVER_PORT="${COMFYLOFT_SERVER_PORT:-8190}"

SERVER_BIN="$ROOT/bin/comfyloft-server"
MCP_BIN="$ROOT/bin/comfyloft-mcp"
DIST_INDEX="$ROOT/frontend/dist/index.html"

# The bundle is build output: `frontend/src` moves on, `dist/` does not, and a start script that served
# the old one changed the meaning of "restart it and try again". Rebuild when the bundle is missing or
# older than anything that goes into it, so what the server serves is what this tree builds.
if [ ! -f "$DIST_INDEX" ] || [ -n "$(find "$ROOT/frontend/src" "$ROOT/frontend/public" "$ROOT/frontend/index.html" \
  "$ROOT/frontend/vite.config.ts" "$ROOT/frontend/package.json" "$ROOT/frontend/package-lock.json" \
  -newer "$DIST_INDEX" -print -quit 2>/dev/null)" ]; then
  command -v node >/dev/null 2>&1 || { echo "node not found; install Node.js first" >&2; exit 1; }
  echo "→ building the canvas bundle (missing, or older than its sources)"
  ( cd "$ROOT" && make frontend ) || { echo "canvas build failed" >&2; exit 1; }
fi

# The canvas itself: the server answers `GET /` with this directory (#219), and `GET /config.js` with the
# workspace preferences read from data/settings.json (#220) — so there is no address to inject, no origin to
# allow, and nothing written into the bundle the build produced.
export WEB_DIR="$ROOT/frontend/dist"

# The server and the bridge are build output too, and the rule is the same one the bundle above gets:
# `internal/` moves on and `bin/` does not, so a start script that ran yesterday's binary against today's
# sources is the invisible bug this check exists to prevent — worse than a stale page, because the canvas
# and the server would disagree about the protocol rather than both being old.
#
# A release directory ships neither `cmd/` nor `internal/`, so there is nothing to compare against and no
# toolchain is asked for: a static binary in a directory of its own still starts with nothing installed.
needs_build() {
  if [ ! -x "$1" ]; then return 0; fi
  [ -n "$(find "$ROOT/cmd" "$ROOT/internal" "$ROOT/go.mod" "$ROOT/go.sum" "$ROOT/Makefile" \
    -newer "$1" -print -quit 2>/dev/null)" ]
}

if needs_build "$SERVER_BIN" || needs_build "$MCP_BIN"; then
  command -v go >/dev/null 2>&1 || {
    echo "the server binaries are missing or older than their sources, and there is no Go toolchain here; run: make build" >&2
    exit 1
  }
  echo "→ building the server and the bridge (missing, or older than their sources)"
  ( cd "$ROOT" && make build ) || { echo "server build failed" >&2; exit 1; }
fi

echo "→ canvas    http://${COMFYLOFT_SERVER_HOST}:${COMFYLOFT_SERVER_PORT}   (served by the server)"
echo "→ server   http://${COMFYLOFT_SERVER_HOST}:${COMFYLOFT_SERVER_PORT}   (ComfyUI at ${COMFY_URL})"
echo
echo "Up. Ctrl+C stops it."
# From the server root: workflows/, resources.json and prompts/ are found from there.
cd "$ROOT"
exec "$SERVER_BIN"
