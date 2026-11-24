#!/bin/bash
# NoShow Shield: one-shot local setup on macOS (self-hosted n8n from the P3 setup).
# Usage: bash <(curl -fsSL https://raw.githubusercontent.com/AURA-RSE/taw-ind-noshow-shield/main/scripts/setup-mac.sh)
# What it does: restarts n8n + a Cloudflare tunnel, imports the Twilio credential and the three workflows
# (with your calendar, sheet and the new public URL), publishes them, seeds demo data and runs reminders once.
# Secrets are read from local files or typed here; they never leave this Mac except to n8n/Twilio/Google.
set -u
P3="$HOME/Downloads/p3-triage"; P4="$HOME/Documents/taw-ind-trackline-bot"; DIR="$HOME/Documents/taw-ind-noshow-shield"
export PATH="$P3/local-n8n/tools/node/bin:$PATH"
node -v | grep -q '^v24' || { echo "Node 24 not found ($P3/local-n8n/tools). Run the P3 launcher once first."; exit 1; }
[ -d "$DIR/.git" ] || gh repo clone AURA-RSE/taw-ind-noshow-shield "$DIR" -- -q || exit 1
git -C "$DIR" fetch -q origin
# Until the PR is merged the code lives on the feature branch.
if git -C "$DIR" rev-parse -q --verify origin/feature/noshow-shield >/dev/null && ! git -C "$DIR" merge-base --is-ancestor origin/feature/noshow-shield origin/main; then git -C "$DIR" checkout -q feature/noshow-shield 2>/dev/null || git -C "$DIR" checkout -q -b feature/noshow-shield origin/feature/noshow-shield; fi
git -C "$DIR" pull -q
cd "$DIR" || exit 1
umask 077
touch .env
get() { grep "^$1=" .env | tail -1 | cut -d= -f2-; }
put() { grep -v "^$1=" .env > .env.tmp; echo "$1=$2" >> .env.tmp; mv .env.tmp .env; }
[ -z "$(get CALENDAR_ID)" ] && { printf "Google Calendar ID (…@group.calendar.google.com): "; read -r v; put CALENDAR_ID "$v"; }
if [ -z "$(get SHEET_ID)" ]; then printf "Google Sheet link: "; read -r v; v=$(echo "$v" | sed -E 's#.*/d/([^/]+).*#\1#'); put SHEET_ID "$v"; fi
[ -z "$(get LINK_SECRET)" ] && put LINK_SECRET "$(openssl rand -hex 24)"
[ -z "$(get TEST_PHONE)" ] && { printf "Opted-in test phone for demo messages [+2347015639553]: "; read -r v; put TEST_PHONE "${v:-+2347015639553}"; }
[ -z "$(get CHANNEL)" ] && put CHANNEL whatsapp
for k in TWILIO_ACCOUNT_SID TWILIO_AUTH_TOKEN; do
  [ -z "$(get $k)" ] && put $k "$(grep "^$k=" "$P4/.env" 2>/dev/null | cut -d= -f2-)"
  [ -z "$(get $k)" ] && { printf "%s: " "$k"; read -rs v; echo; put $k "$v"; }
done
[ -z "$(get TWILIO_FROM)" ] && put TWILIO_FROM +17372508034
SID=$(get TWILIO_ACCOUNT_SID); TOK=$(get TWILIO_AUTH_TOKEN)

echo "== Finding Twilio's approved appointment-reminder template"
CS=$(curl -s -u "$SID:$TOK" "https://content.twilio.com/v1/Content?PageSize=100" | python3 -c '
import sys, json
d = json.load(sys.stdin).get("contents", [])
m = [c for c in d if "appointment" in (c.get("friendly_name","") + json.dumps(c.get("types",{}))).lower()]
print(m[0]["sid"] if m else "")' 2>/dev/null)
put CONTENT_SID "${CS:-HXb5b62575e6e4ff6129ad7c8efe1f983e}"; echo "   template: $(get CONTENT_SID)"

echo "== Restarting n8n + tunnel"
pkill -f "n8n@latest start" 2>/dev/null; pkill -f "n8n start" 2>/dev/null; pkill -f "cloudflared tunnel --no-autoupdate --url http://localhost:5678" 2>/dev/null; sleep 3
CF=$(command -v cloudflared || echo "$P3/local-n8n/tools/cloudflared")
LOG="$P3/local-n8n/tunnel.log"; : > "$LOG"
"$CF" tunnel --no-autoupdate --url http://localhost:5678 > "$LOG" 2>&1 &
CF_PID=$!
URL=""; for i in $(seq 1 60); do URL=$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1); [ -n "$URL" ] && break; sleep 1; done
[ -z "$URL" ] && { echo "Tunnel failed: $LOG"; exit 1; }
echo "$URL" > "$P3/local-n8n/tunnel-url.txt"; put BASE_URL "$URL"

export N8N_USER_FOLDER="$P3/local-n8n/data" GENERIC_TIMEZONE="Africa/Lagos" WEBHOOK_URL="$URL/" N8N_EDITOR_BASE_URL="$URL/" N8N_SECURE_COOKIE=false N8N_DIAGNOSTICS_ENABLED=false N8N_PERSONALIZATION_ENABLED=false
WORK="$DIR/.local-import"; mkdir -p "$WORK"
echo "== Importing Twilio credential + workflows"
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify([{ id: "noshowTwilio01", name: "Twilio (NoShow Shield)", type: "httpBasicAuth", data: { user: process.argv[2], password: process.argv[3] } }]), { mode: 0o600 })' "$WORK/cred.json" "$SID" "$TOK"
npx --yes n8n@latest import:credentials --input="$WORK/cred.json" 2>&1 | grep -iv "deprecat\|npm warn\|license" | tail -1; rm -f "$WORK/cred.json"
set -a; . ./.env; set +a
node scripts/build-workflows.js "$WORK" >/dev/null || exit 1
for f in reminders patient-links seed-demo; do npx --yes n8n@latest import:workflow --input="$WORK/$f.json" 2>&1 | grep -iv "deprecat\|npm warn\|license" | tail -1; done
for wid in noshowReminders01 noshowLinks01 noshowSeed01; do npx --yes n8n@latest publish:workflow --id=$wid 2>&1 | grep -i "publish" | head -1; done
rm -rf "$WORK"

echo "== Starting n8n"
npx --yes n8n@latest start > "$P3/local-n8n/n8n.log" 2>&1 &
N8N_PID=$!
trap 'kill $N8N_PID $CF_PID 2>/dev/null; exit 0' INT TERM HUP
for i in $(seq 1 120); do curl -fsS http://localhost:5678/healthz >/dev/null 2>&1 && break; sleep 2; done; sleep 6
KEY=${LINK_SECRET:0:12}
echo
echo "================ P5 RESULTS (copy everything from here) ================"
echo "Public URL: $URL"
echo "seed:      $(curl -s -m 60 "$URL/webhook/noshow-seed?key=$KEY")"
sleep 5
echo "reminders: $(curl -s -m 60 -o /dev/null -w 'HTTP %{http_code}' "$URL/webhook/noshow-run?key=$KEY")"
echo "bad link:  $(curl -s -m 30 -o /dev/null -w 'HTTP %{http_code}' "$URL/webhook/noshow?t=fake")"
echo "========================================================================"
echo "Now: check WhatsApp on $TEST_PHONE and the Outbox tab of your sheet (the 'link' column has the one-tap links)."
echo "Run reminders again any time: $URL/webhook/noshow-run?key=$KEY"
echo "Keep this window open: it is running n8n. Ctrl+C to stop."
wait $N8N_PID
