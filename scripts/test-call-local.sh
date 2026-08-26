#!/usr/bin/env bash
# LOCAL TEST CALL — talk to the Erica running on this laptop, without touching
# production. No webhook change, no second number: we ask Twilio to place an
# OUTBOUND call from the salon's Twilio number to your cell, with the call's
# TwiML fetched from your local dev server via ngrok. Production's inbound
# webhook stays pointed at Railway the whole time; real customers are never
# routed to the test build.
#
# Prereqs (three terminals):
#   1. npm run dev              # local Erica on :5050
#   2. ngrok http 5050          # public tunnel (any URL — auto-discovered)
#   3. bash scripts/test-call-local.sh [+1XXXXXXXXXX]
#      (defaults to Aryan's test phone; answer it and talk to LOCAL Erica)
#
# Notes:
#  - Uses the REAL Phorest + OpenAI from .env — test bookings land on the real
#    calendar (cancel them after), and a transfer test really rings OWNER_PHONE.
#  - The "caller" Twilio reports for an API-originated call is the salon's own
#    number, so caller-ID recognition won't fire — to exercise recognized-caller
#    flows, tell Erica your number when she asks.
#  - lessons.md: do NOT save src files while a test call is live (tsx watch
#    restarts and kills the call).
set -euo pipefail

TO="${1:-+14432535169}"

read_env() {
  local v
  v=$(grep -E "^$1=" .env | head -1 | cut -d= -f2-)
  v="${v%$'\r'}"; v="${v#\"}"; v="${v%\"}"; v="${v#\'}"; v="${v%\'}"
  printf '%s' "$v"
}

SID=$(read_env TWILIO_ACCOUNT_SID)
TOKEN=$(read_env TWILIO_AUTH_TOKEN)
NUM=$(read_env TWILIO_NUMBER)
PORT=$(read_env PORT); PORT="${PORT:-5050}"

if [ -z "$SID" ] || [ -z "$TOKEN" ] || [ -z "$NUM" ]; then
  echo "Missing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_NUMBER in .env" >&2
  exit 1
fi

# 1. Local dev server must be up.
if ! curl -sf -o /dev/null "http://localhost:$PORT/health"; then
  echo "Local server not responding on :$PORT — start it first: npm run dev" >&2
  exit 1
fi

# 2. Discover the running ngrok tunnel (ngrok's local API).
NGROK_URL=$(curl -sf http://localhost:4040/api/tunnels \
  | python3 -c 'import sys,json; ts=[t for t in json.load(sys.stdin).get("tunnels",[]) if t.get("proto")=="https"]; print(ts[0]["public_url"] if ts else "")' \
  || true)
if [ -z "$NGROK_URL" ]; then
  echo "No ngrok tunnel found — start it first: ngrok http $PORT" >&2
  exit 1
fi

# 3. Sanity: the tunnel must reach THIS laptop's server.
if ! curl -sf -o /dev/null "$NGROK_URL/health"; then
  echo "Tunnel $NGROK_URL is up but /health failed — is it tunnelling port $PORT?" >&2
  exit 1
fi

echo "Local Erica:  http://localhost:$PORT  (via $NGROK_URL)"
echo "Calling $TO from $NUM — answer your phone to talk to the LOCAL build..."

curl -fsS -u "$SID:$TOKEN" \
  -X POST "https://api.twilio.com/2010-04-01/Accounts/$SID/Calls.json" \
  --data-urlencode "From=$NUM" \
  --data-urlencode "To=$TO" \
  --data-urlencode "Url=$NGROK_URL/twilio/voice" \
  --data-urlencode "Method=POST" \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print("OK  call queued:", d.get("sid"), "| status:", d.get("status"))'

echo "Watch the local logs: npm run logs (or the npm run dev terminal)."
