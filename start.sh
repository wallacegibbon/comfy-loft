#!/usr/bin/env bash
# Starts what this project runs: one gateway process, which also serves the canvas bundle from its own
# origin (docs/decisions.md #219). Ctrl+C stops it; there is no crash recovery.
#
# There used to be a second process here — `vite preview` on :3000 — and with it two origins, a CORS
# allow-list to maintain, and every picture a cross-origin image that a canvas could not export. The
# bundle is static files, so the gateway serves it.
#
# ComfyUI is external and stays that way: nothing here starts, stops or waits for it. It may
# be on another machine, in a container, or under whatever manager the user prefers — the
# gateway only needs COMFY_URL.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# .env is data, not shell state: a variable the caller passed explicitly wins over it.
# Sourcing without this makes `GATEWAY_PORT=9000 ./start.sh` come up on the .env port instead.
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
export GATEWAY_HOST="${GATEWAY_HOST:-127.0.0.1}"
export GATEWAY_PORT="${GATEWAY_PORT:-8190}"

GATEWAY_BIN="$ROOT/bin/comfyui-gateway"
MCP_BIN="$ROOT/bin/comfyloft-mcp"
DIST_INDEX="$ROOT/frontend/dist/index.html"

# The bundle is build output: `frontend/src` moves on, `dist/` does not, and a start script that served
# the old one changed the meaning of "restart it and try again". Rebuild when the bundle is missing or
# older than anything that goes into it, so what the gateway serves is what this tree builds.
if [ ! -f "$DIST_INDEX" ] || [ -n "$(find "$ROOT/frontend/src" "$ROOT/frontend/public" "$ROOT/frontend/index.html" \
  "$ROOT/frontend/vite.config.ts" "$ROOT/frontend/package.json" "$ROOT/frontend/package-lock.json" \
  -newer "$DIST_INDEX" -print -quit 2>/dev/null)" ]; then
  command -v node >/dev/null 2>&1 || { echo "node not found; install Node.js first" >&2; exit 1; }
  echo "→ building the canvas bundle (missing, or older than its sources)"
  ( cd "$ROOT" && make frontend ) || { echo "canvas build failed" >&2; exit 1; }
fi

# The canvas itself: the gateway answers `GET /` with this directory (#219), and `GET /config.js` with the
# workspace preferences read from data/settings.json (#220) — so there is no address to inject, no origin to
# allow, and nothing written into the bundle the build produced.
export WEB_DIR="$ROOT/frontend/dist"

# The gateway is a static binary: build it once when it is missing, then startup is instant.
# `make build` produces both it and the bridge.
if [ ! -x "$GATEWAY_BIN" ]; then
  echo "→ building the gateway (first run, needs the Go toolchain)"
  ( cd "$ROOT" && make build ) || { echo "gateway build failed" >&2; exit 1; }
fi

# The bridge is spawned by AlayaCore from the static mcp.conf, which names it beside the gateway binary.
[ -x "$MCP_BIN" ] || { echo "missing $MCP_BIN; run: make build" >&2; exit 1; }

echo "→ canvas    http://${GATEWAY_HOST}:${GATEWAY_PORT}   (served by the gateway)"
echo "→ gateway   http://${GATEWAY_HOST}:${GATEWAY_PORT}   (ComfyUI at ${COMFY_URL})"
echo
echo "Up. Ctrl+C stops it."
# From the gateway root: workflows/, resources.json and prompts/ are found from there.
cd "$ROOT"
exec "$GATEWAY_BIN"
