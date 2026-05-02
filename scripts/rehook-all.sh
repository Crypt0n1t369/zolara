#!/bin/bash
set -euo pipefail

# Re-register webhooks for all active project bots against the configured stable base URL.
# Safe for tester/prod: refuses random trycloudflare URLs unless explicitly allowed for local dev.

ZOLARA_DIR="${ZOLARA_DIR:-/home/drg/projects/zolara}"
ENV_FILE="${ENV_FILE:-$ZOLARA_DIR/.env}"
TUNNEL_URL_FILE="${TUNNEL_URL_FILE:-/tmp/tunnel_url.txt}"

if [ -n "${WEBHOOK_BASE_URL:-}" ]; then
  TUNNEL_URL="$WEBHOOK_BASE_URL"
elif [ -f "$TUNNEL_URL_FILE" ]; then
  TUNNEL_URL=$(cat "$TUNNEL_URL_FILE")
else
  echo "No WEBHOOK_BASE_URL provided and no tunnel URL file found at $TUNNEL_URL_FILE"
  exit 1
fi

TUNNEL_URL="${TUNNEL_URL%/}"

if [ -z "$TUNNEL_URL" ]; then
  echo "Tunnel URL is empty"
  exit 1
fi

if echo "$TUNNEL_URL" | grep -q 'trycloudflare\.com' && [ "${ALLOW_EPHEMERAL_TUNNEL:-0}" != "1" ]; then
  echo "ERROR: refusing to rehook tester/prod bots to random trycloudflare URL: $TUNNEL_URL"
  echo "Use a named Cloudflare Tunnel/stable hostname. See docs/STABLE_WEBHOOK_RUNBOOK.md"
  exit 1
fi

if ! echo "$TUNNEL_URL" | grep -q '^https://'; then
  echo "ERROR: WEBHOOK_BASE_URL must be https: $TUNNEL_URL"
  exit 1
fi

HOSTNAME=$(node -e "console.log(new URL(process.argv[1]).hostname)" "$TUNNEL_URL")
if echo "$HOSTNAME" | grep -Eq '^(example\.com|example\.org|example\.net|localhost)$|\.example$' && [ "${ALLOW_RESERVED_HOST:-0}" != "1" ]; then
  echo "ERROR: refusing to rehook bots to reserved/non-production hostname: $HOSTNAME"
  exit 1
fi

if [ "${DRY_RUN:-0}" = "1" ]; then
  echo "Dry run: would rehook active project bots to $TUNNEL_URL"
else
  echo "Rehooking active project bots to $TUNNEL_URL"
  if [ "${SKIP_PUBLIC_HEALTH_CHECK:-0}" != "1" ]; then
    HEALTH_URL="$TUNNEL_URL/health"
    HEALTH_STATUS=$(node -e "fetch(process.argv[1], { signal: AbortSignal.timeout(8000) }).then(async r => { const body = await r.json().catch(() => ({})); if (!r.ok || body.status !== 'ok') process.exit(2); console.log('ok'); }).catch(() => process.exit(1))" "$HEALTH_URL" 2>/dev/null || true)
    if [ "$HEALTH_STATUS" != "ok" ]; then
      echo "ERROR: public health check failed at $HEALTH_URL; refusing to rehook project bots"
      echo "Start/fix the stable tunnel first, or set SKIP_PUBLIC_HEALTH_CHECK=1 only for an intentional emergency override."
      exit 1
    fi
    echo "Public health check passed at $HEALTH_URL"
  fi
fi

# Update .env when present so future startup uses the same stable URL. Container
# platforms usually inject env vars and may not have a writable .env file.
if [ -f "$ENV_FILE" ]; then
  if [ "${DRY_RUN:-0}" = "1" ]; then
    echo "Dry run: would update $ENV_FILE"
  elif grep -q '^WEBHOOK_BASE_URL=' "$ENV_FILE"; then
    sed -i "s|^WEBHOOK_BASE_URL=.*|WEBHOOK_BASE_URL=$TUNNEL_URL|" "$ENV_FILE"
  else
    printf '\nWEBHOOK_BASE_URL=%s\n' "$TUNNEL_URL" >> "$ENV_FILE"
  fi
else
  echo "ENV_FILE not found at $ENV_FILE; skipping .env update"
fi

cd "$ZOLARA_DIR"
TMP_TS=$(mktemp "$ZOLARA_DIR/.zolara-rehook.XXXXXX.ts")
trap 'rm -f "$TMP_TS"' EXIT
cat > "$TMP_TS" <<'TS'
import { decrypt } from './src/util/crypto.ts';
import { db } from './src/data/db.ts';
import { projects } from './src/data/schema/projects.ts';
import { eq } from 'drizzle-orm';
import { setManagedBotWebhook } from './src/project/managed-bots/lifecycle.ts';
import { createHash } from 'crypto';

const BASE = process.env.WEBHOOK_BASE_URL;
const DRY_RUN = process.env.DRY_RUN === '1';
if (!BASE) throw new Error('WEBHOOK_BASE_URL missing');

async function main() {
  const rows = await db.select({
    id: projects.id,
    name: projects.name,
    botUsername: projects.botUsername,
    botTokenEncrypted: projects.botTokenEncrypted,
    webhookSecret: projects.webhookSecret,
  }).from(projects).where(eq(projects.status, 'active'));

  let count = 0;
  let skipped = 0;
  let failed = 0;
  for (const row of rows) {
    if (!row.botTokenEncrypted || !row.webhookSecret) {
      if (!row.botUsername) {
        console.warn(`⚠️  ${row.name}: skipped active row without project-bot credentials`);
        skipped++;
        continue;
      }
      console.error(`❌ @${row.botUsername}: missing bot token or webhook secret`);
      failed++;
      continue;
    }
    try {
      const token = decrypt(row.botTokenEncrypted);
      const hash = createHash('sha256').update(token).digest('hex');
      const url = `${BASE}/webhook/projectbot/${hash}`;
      if (DRY_RUN) {
        console.log(`✅ @${row.botUsername}: would register webhook`);
      } else {
        const result = await setManagedBotWebhook(token, url, row.webhookSecret);
        if (!result.success) throw new Error(result.description ?? 'setWebhook failed');
        console.log(`✅ @${row.botUsername}: webhook registered`);
      }
      count++;
    } catch(e) {
      console.error(`❌ ${row.name}: ${e instanceof Error ? e.message : String(e)}`);
      failed++;
    }
  }
  console.log(`\nRegistered ${count} webhooks; skipped ${skipped}; failed ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}
main();
TS

WEBHOOK_BASE_URL="$TUNNEL_URL" DRY_RUN="${DRY_RUN:-0}" npx tsx "$TMP_TS"
