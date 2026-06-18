#!/usr/bin/env bash
# Point the salon's Twilio number (TWILIO_NUMBER in .env) at a public webhook URL.
# Re-run this every time your ngrok URL changes.
#
# Usage:
#   bash scripts/set-twilio-webhook.sh https://<your-ngrok-host>
#
# Reads TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_NUMBER from .env.
# Never prints the auth token.
set -euo pipefail

BASE_URL="${1:-}"
if [ -z "$BASE_URL" ]; then
  echo "Usage: bash scripts/set-twilio-webhook.sh https://<your-ngrok-host>" >&2
  exit 1
fi
BASE_URL="${BASE_URL%/}" # strip any trailing slash

read_env() {
  local v
  v=$(grep -E "^$1=" .env | head -1 | cut -d= -f2-)
  v="${v%$'\r'}"            # strip trailing CR (CRLF files)
  v="${v#\"}"; v="${v%\"}"  # strip surrounding double quotes
  v="${v#\'}"; v="${v%\'}"  # strip surrounding single quotes
  printf '%s' "$v"
}

SID=$(read_env TWILIO_ACCOUNT_SID)
TOKEN=$(read_env TWILIO_AUTH_TOKEN)
NUM=$(read_env TWILIO_NUMBER)

if [ -z "$SID" ] || [ -z "$TOKEN" ] || [ -z "$NUM" ]; then
  echo "Missing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_NUMBER in .env" >&2
  exit 1
fi

API="https://api.twilio.com/2010-04-01/Accounts/$SID"

echo "Looking up $NUM ..."
PNSID=$(curl -fsS -G -u "$SID:$TOKEN" "$API/IncomingPhoneNumbers.json" \
  --data-urlencode "PhoneNumber=$NUM" \
  | python3 -c 'import sys,json; n=json.load(sys.stdin).get("incoming_phone_numbers") or []; print(n[0]["sid"] if n else "")')

if [ -z "$PNSID" ]; then
  echo "Number $NUM not found on this Twilio account." >&2
  exit 1
fi

echo "Setting voice webhook -> $BASE_URL/twilio/voice (POST) ..."
curl -fsS -u "$SID:$TOKEN" -X POST "$API/IncomingPhoneNumbers/$PNSID.json" \
  --data-urlencode "VoiceUrl=$BASE_URL/twilio/voice" \
  --data-urlencode "VoiceMethod=POST" \
  | python3 -c 'import sys,json; d=json.load(sys.stdin); print("OK  number:", d.get("phone_number"), "| voice_url:", d.get("voice_url"), "| method:", d.get("voice_method"))'

echo "Done. Call $NUM to test."
