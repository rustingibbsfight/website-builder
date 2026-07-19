#!/usr/bin/env bash
# One-shot cloud setup + deploy for the wb platform:
#   Turso database → R2 buckets → Vercel env → deploy wb-api → deploy Eve
# Idempotent: safe to re-run; it skips what already exists.
#
# Prereqs (each logged in): vercel, turso, wrangler. Node 22+, pnpm.
# Two things it CANNOT automate (it will tell you exactly when):
#   1. Creating the R2 S3 API token (Cloudflare dashboard only)
#   2. Creating the Slack app + pasting the Events URL
set -euo pipefail

DB_NAME="${WB_TURSO_DB:-wb}"
ASSET_BUCKET="${WB_R2_ASSET_BUCKET:-wb-assets}"
API_DIR="apps/wb-api"
EVE_DIR="apps/eve"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
step() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

for cmd in vercel turso wrangler node pnpm; do
  command -v "$cmd" >/dev/null || die "$cmd is not installed (or not on PATH)"
done

cd "$(dirname "$0")/.."

# ── 1. Turso ────────────────────────────────────────────────────────────────
step "Turso database ($DB_NAME)"
if ! turso db show "$DB_NAME" >/dev/null 2>&1; then
  turso db create "$DB_NAME"
fi
WB_DB_URL="$(turso db show "$DB_NAME" --url)"
WB_DB_TOKEN="$(turso db tokens create "$DB_NAME")"
bold "  url: $WB_DB_URL"

# ── 2. R2 buckets ───────────────────────────────────────────────────────────
step "R2 asset bucket ($ASSET_BUCKET)"
wrangler r2 bucket create "$ASSET_BUCKET" 2>/dev/null || echo "  (bucket exists)"

if [ -z "${WB_S3_ACCESS_KEY_ID:-}" ] || [ -z "${WB_S3_SECRET_ACCESS_KEY:-}" ] || [ -z "${WB_S3_ENDPOINT:-}" ]; then
  cat <<'EOF'

  ── MANUAL STEP (R2 S3 credentials) ──────────────────────────────────────
  Wrangler cannot mint S3 API tokens. In the Cloudflare dashboard:
    R2 → Manage R2 API Tokens → Create API Token (Object Read & Write)
  Then re-run this script with:
    WB_S3_ACCESS_KEY_ID=…  WB_S3_SECRET_ACCESS_KEY=… \
    WB_S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com \
    ./scripts/setup-cloud.sh
  ─────────────────────────────────────────────────────────────────────────
EOF
  die "missing WB_S3_ACCESS_KEY_ID / WB_S3_SECRET_ACCESS_KEY / WB_S3_ENDPOINT"
fi

# ── 3. Shared secrets ───────────────────────────────────────────────────────
step "API token"
WB_API_TOKEN="${WB_API_TOKEN:-$(openssl rand -hex 24)}"
bold "  WB_API_TOKEN: $WB_API_TOKEN   (save this — the editor sign-in uses it)"

# Live-deploy target for finished sites (Vercel Deployments API).
if [ -z "${WB_VERCEL_TOKEN:-}" ]; then
  cat <<'EOF'

  WB_VERCEL_TOKEN is unset. Create one at https://vercel.com/account/tokens
  (it lets the API deploy finished sites live). Re-run with WB_VERCEL_TOKEN=…
EOF
  die "missing WB_VERCEL_TOKEN"
fi

# ── 4. Deploy wb-api ────────────────────────────────────────────────────────
step "Deploying wb-api (builder API + editor)"
pnpm install --frozen-lockfile
pnpm -r build

set_env() { # set_env <dir> <key> <value>
  (cd "$1" && printf '%s' "$3" | vercel env add "$2" production --force >/dev/null 2>&1) || true
}

(cd "$API_DIR" && vercel link --yes >/dev/null)
for kv in \
  "WB_DB_URL=$WB_DB_URL" \
  "WB_DB_TOKEN=$WB_DB_TOKEN" \
  "WB_ASSET_STORE=s3" \
  "WB_S3_BUCKET=$ASSET_BUCKET" \
  "WB_S3_ENDPOINT=$WB_S3_ENDPOINT" \
  "WB_S3_ACCESS_KEY_ID=$WB_S3_ACCESS_KEY_ID" \
  "WB_S3_SECRET_ACCESS_KEY=$WB_S3_SECRET_ACCESS_KEY" \
  "WB_API_TOKEN=$WB_API_TOKEN" \
  "WB_PUBLISH_TARGET=vercel" \
  "WB_VERCEL_TOKEN=$WB_VERCEL_TOKEN"; do
  set_env "$API_DIR" "${kv%%=*}" "${kv#*=}"
done
API_URL="$(cd "$API_DIR" && vercel deploy --prod --yes | tail -1)"
bold "  wb API live: $API_URL"
bold "  editor:      $API_URL/editor/"

# ── 5. Deploy Eve ───────────────────────────────────────────────────────────
step "Deploying Eve (Slack agent)"
if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  die "ANTHROPIC_API_KEY is unset — re-run with ANTHROPIC_API_KEY=… (console.anthropic.com)"
fi
SLACK_BOT_TOKEN="${SLACK_BOT_TOKEN:-}"
SLACK_SIGNING_SECRET="${SLACK_SIGNING_SECRET:-}"
if [ -z "$SLACK_BOT_TOKEN" ] || [ -z "$SLACK_SIGNING_SECRET" ]; then
  cat <<EOF

  ── MANUAL STEP (Slack app) ──────────────────────────────────────────────
  1. https://api.slack.com/apps → Create New App → From a manifest
     → paste apps/eve/slack-manifest.yaml → Install to workspace
  2. Grab the Bot token (xoxb-…) and Signing secret
  3. Re-run this script with SLACK_BOT_TOKEN=… SLACK_SIGNING_SECRET=…
  ─────────────────────────────────────────────────────────────────────────
EOF
  die "missing SLACK_BOT_TOKEN / SLACK_SIGNING_SECRET"
fi

(cd "$EVE_DIR" && vercel link --yes >/dev/null)
for kv in \
  "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY" \
  "SLACK_BOT_TOKEN=$SLACK_BOT_TOKEN" \
  "SLACK_SIGNING_SECRET=$SLACK_SIGNING_SECRET" \
  "WB_API_URL=$API_URL" \
  "WB_API_TOKEN=$WB_API_TOKEN"; do
  set_env "$EVE_DIR" "${kv%%=*}" "${kv#*=}"
done
EVE_URL="$(cd "$EVE_DIR" && vercel deploy --prod --yes | tail -1)"
bold "  Eve live: $EVE_URL"

# ── 6. Final hookup ─────────────────────────────────────────────────────────
cat <<EOF

$(bold "✔ Deployed. One last paste:")

  Slack app → Event Subscriptions → Request URL:
    $EVE_URL/api/slack/events
  (Slack sends a challenge; Eve answers automatically. Then /invite @eve)

Smoke test:
  curl -H "Authorization: Bearer $WB_API_TOKEN" $API_URL/health
  In Slack:  @eve create a Breakthrough Medical site and deploy it

Editor: $API_URL/editor/  (sign in with the WB_API_TOKEN above)
EOF
