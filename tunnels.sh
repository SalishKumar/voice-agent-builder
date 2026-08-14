#!/bin/bash
# Starts the two cloudflared quick tunnels this app needs and prints both URLs.
#
# A quick tunnel maps exactly one port, and we have two listeners: Next on 3000
# (the TwiML webhook) and the media WebSocket server on 3001. So: two tunnels,
# two hostnames, two env vars.
#
#   ./tunnels.sh            # 3000 + 3001
#   ./tunnels.sh 3000 3001  # explicit
#
# Leave this running; Ctrl-C stops both tunnels.
set -uo pipefail

HTTP_PORT="${1:-3000}"
WS_PORT="${2:-3001}"
CLOUDFLARED="$(dirname "$0")/cloudflared"

if [ ! -x "$CLOUDFLARED" ]; then
  echo "cloudflared not found at $CLOUDFLARED" >&2
  exit 1
fi

LOG_DIR="$(mktemp -d)"
HTTP_LOG="$LOG_DIR/http.log"
WS_LOG="$LOG_DIR/ws.log"

cleanup() {
  echo
  echo "stopping tunnels"
  kill "${PIDS[@]}" 2>/dev/null
  wait "${PIDS[@]}" 2>/dev/null
}
PIDS=()
trap cleanup EXIT INT TERM

start_tunnel() {
  local port="$1" log="$2"
  "$CLOUDFLARED" tunnel --no-autoupdate --url "http://localhost:$port" \
    >"$log" 2>&1 &
  PIDS+=("$!")
}

# Waits up to ~30s for cloudflared to print the hostname it assigned.
await_url() {
  local log="$1" i url
  for ((i = 0; i < 60; i++)); do
    url="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$log" | head -1)"
    if [ -n "$url" ]; then
      echo "$url"
      return 0
    fi
    sleep 0.5
  done
  return 1
}

echo "starting tunnel for Next        -> http://localhost:$HTTP_PORT"
start_tunnel "$HTTP_PORT" "$HTTP_LOG"
echo "starting tunnel for WS server   -> http://localhost:$WS_PORT"
start_tunnel "$WS_PORT" "$WS_LOG"

HTTP_URL="$(await_url "$HTTP_LOG")" || {
  echo "timed out waiting for the Next tunnel; see $HTTP_LOG" >&2
  exit 1
}
WS_URL="$(await_url "$WS_LOG")" || {
  echo "timed out waiting for the WS tunnel; see $WS_LOG" >&2
  exit 1
}

# cloudflared only speaks https; the WebSocket upgrade rides over the same
# connection, so the wss:// form is just the https:// hostname re-scheme'd.
WSS_URL="wss://${WS_URL#https://}"

cat <<EOF

  ----------------------------------------------------------------
  Copy these into .env.local:

  PUBLIC_BASE_URL=$HTTP_URL
  PUBLIC_WS_URL=$WSS_URL

  Twilio number "A call comes in" webhook (HTTP POST):

  $HTTP_URL/api/twilio/voice?agentId=<agentId>
  ----------------------------------------------------------------

EOF

wait
