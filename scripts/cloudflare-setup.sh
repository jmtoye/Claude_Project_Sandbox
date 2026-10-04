#!/usr/bin/env bash
# One-time Cloudflare setup + deploy. Run from your own computer (not CI):
#   bash scripts/cloudflare-setup.sh
# Prerequisites: Node 20+, a Cloudflare account. See docs/SETUP.md for the Access steps.
set -euo pipefail
cd "$(dirname "$0")/.."

npm install
npx wrangler whoami >/dev/null 2>&1 || npx wrangler login

if grep -q 'REPLACE_WITH_D1_DATABASE_ID' wrangler.toml; then
  echo "Creating D1 database 'project-dashboard'…"
  out=$(npx wrangler d1 create project-dashboard 2>&1 || true)
  echo "$out"
  id=$(echo "$out" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)
  if [ -z "$id" ]; then
    echo "Could not read the database id. Run 'npx wrangler d1 list', copy the id into wrangler.toml (database_id), and re-run." >&2
    exit 1
  fi
  sed -i.bak "s/REPLACE_WITH_D1_DATABASE_ID/$id/" wrangler.toml && rm -f wrangler.toml.bak
  echo "database_id set to $id"
fi

npx wrangler d1 migrations apply project-dashboard --remote
npm run build
npx wrangler deploy

cat <<'NEXT'

Deployed. Until Cloudflare Access is configured the app refuses every request (503 "Setup required").
Next (docs/SETUP.md, steps 4–7):
  1. Protect the hostname with Cloudflare Access and copy the team domain + AUD tag into wrangler.toml [vars].
  2. Set OWNER_EMAIL (your sign-in address) and PERSONAL_ALLOWED_EMAILS (Renata) in wrangler.toml, then: npm run deploy
  3. Optional secrets: npx wrangler secret put ANTHROPIC_API_KEY | RESEND_API_KEY | GITHUB_TOKEN | NOTION_TOKEN
  4. Sign in, then Settings → Import JSON → data/initial-projects.json
NEXT
