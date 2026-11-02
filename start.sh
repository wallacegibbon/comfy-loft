#!/usr/bin/env bash
# Starts what this project runs: the gateway (default :8190) and a static server for the
# canvas bundle (default :3000). Ctrl+C stops both; there is no crash recovery.
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
CANVAS_HOST="${CANVAS_HOST:-127.0.0.1}"
CANVAS_PORT="${CANVAS_PORT:-3000}"

VITE_BIN="$ROOT/canvas/node_modules/.bin/vite"
GATEWAY_BIN="$ROOT/bin/comfyui-gateway"
MCP_BIN="$ROOT/bin/comfyloft-mcp"
DIST_INDEX="$ROOT/canvas/dist/index.html"

command -v node >/dev/null 2>&1 || { echo "node not found; install Node.js first" >&2; exit 1; }
[ -x "$VITE_BIN" ] || { echo "missing $VITE_BIN; run: make web-deps" >&2; exit 1; }
[ -f "$DIST_INDEX" ] || { echo "canvas bundle is missing; run: make web" >&2; exit 1; }

# The canvas's first paint. The gateway writes this file on every start and after every settings save,
# with the address a browser should use plus the workspace preferences (docs/decisions.md #155), so the
# theme and the language are known before the first frame. `make web` restores the template from
# canvas/public/config.js, which is what a page served before the gateway is up reads.
export RUNTIME_CONFIG_PATH="$ROOT/canvas/dist/config.js"

# The gateway accepts a canvas served from its own host already; this covers a canvas on
# another machine or a name that differs from the address the browser used for the gateway.
export CORS_ORIGINS="${CORS_ORIGINS:-http://localhost:${CANVAS_PORT},http://127.0.0.1:${CANVAS_PORT},http://${CANVAS_HOST}:${CANVAS_PORT},http://localhost:8188,http://127.0.0.1:8188}"

pids=()
cleanup() {
  trap - EXIT INT TERM
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# The gateway is a static binary: build it once when it is missing, then startup is instant.
# `make build` produces both it and the bridge.
if [ ! -x "$GATEWAY_BIN" ]; then
  echo "→ building the gateway (first run, needs the Go toolchain)"
  ( cd "$ROOT" && make build ) || { echo "gateway build failed" >&2; exit 1; }
fi

# The bridge is spawned by AlayaCore from the static mcp.conf, which names it beside the gateway binary.
[ -x "$MCP_BIN" ] || { echo "missing $MCP_BIN; run: make build" >&2; exit 1; }

echo "→ gateway   http://${GATEWAY_HOST}:${GATEWAY_PORT}   (ComfyUI at ${COMFY_URL})"
( cd "$ROOT" && exec "$GATEWAY_BIN" ) & pids+=($!)

echo "→ canvas    http://${CANVAS_HOST}:${CANVAS_PORT}"
( cd "$ROOT/canvas" && exec "$VITE_BIN" preview --host "$CANVAS_HOST" --port "$CANVAS_PORT" ) & pids+=($!)

echo
echo "Both services are up. Ctrl+C stops them."
wait
