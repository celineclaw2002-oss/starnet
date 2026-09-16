#!/usr/bin/env bash
# control-room/start-control-room.sh — boot the StarNet sidecar as the browser-mode "control room" station:
# its own data root, metered budgets, a small fan-out ceiling, no host stdio MCP, a fixed loopback port and a
# fresh API token per launch. Every knob is an environment variable the sidecar reads (STARNET_*); README.md
# next to this script explains each one. Budgets and the fan-out ceiling may be overridden from the caller's
# environment; the data root, port, stdio policy, token and shell mode are pinned on purpose.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
command -v node >/dev/null 2>&1 || { echo "start-control-room: node is required (Node 22 or newer)" >&2; exit 1; }

# The station's private data root. Everything it persists — agent workspaces, channel and connector secrets,
# OAuth token stores, transcripts, budgets — lives under it, never inside the desktop app's own station.
ROOT="${STARNET_CONTROL_ROOM_HOME:-$HOME/.starnet-control-room}"
mkdir -p "$ROOT/workspaces"
chmod 700 "$ROOT" "$ROOT/workspaces"   # browser mode has no keychain: channel/connector secrets are files in here

export STARNET_WORKSPACES="$ROOT/workspaces"
export STARNET_PORT=8787
export STARNET_BUDGET_PER_RUN="${STARNET_BUDGET_PER_RUN:-5}"           # USD ceiling for one run
export STARNET_BUDGET_PER_DAY="${STARNET_BUDGET_PER_DAY:-50}"          # USD pool for the whole station per day
export STARNET_BUDGET_PER_WORKER="${STARNET_BUDGET_PER_WORKER:-2}"     # USD ceiling for each delegated sub-run
export STARNET_MAX_CONCURRENT_AGENTS="${STARNET_MAX_CONCURRENT_AGENTS:-4}"
export STARNET_MCP_STDIO=0                                              # never spawn stdio MCP servers on this host
unset STARNET_API_TOKEN SKYNET_API_TOKEN            # a fresh token per launch, handed only to the page the sidecar serves
unset STARNET_DESKTOP_SHELL SKYNET_DESKTOP_SHELL    # browser mode: no desktop shell, no keychain

echo "control room: data root $ROOT — UI at http://127.0.0.1:$STARNET_PORT" >&2
cd "$REPO"
exec node sidecar/index.js "$@"
