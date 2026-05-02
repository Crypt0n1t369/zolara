#!/bin/bash
# Zolara startup.
# Production/tester mode expects WEBHOOK_BASE_URL in .env to be a stable HTTPS
# hostname (typically a named Cloudflare Tunnel). Random trycloudflare quick
# tunnels are allowed only for local development with ALLOW_EPHEMERAL_TUNNEL=1.

set -euo pipefail

ZOLARA_DIR="/home/drg/projects/zolara"
TUNNEL_URL_FILE="/tmp/tunnel_url.txt"
ENV_FILE="$ZOLARA_DIR/.env"

read_env_webhook_base_url() {
  grep WEBHOOK_BASE_URL "$ENV_FILE" 2>/dev/null | grep -v "^#" | tail -1 | cut -d= -f2-
}

CURRENT_URL=$(read_env_webhook_base_url)
TUNNEL_URL="$CURRENT_URL"

if [ "${ALLOW_EPHEMERAL_TUNNEL:-}" = "1" ]; then
  # Local-dev convenience only: discover quick tunnel URL from PM2 logs or saved file.
  DISCOVERED_URL=$(pm2 logs cloudflared --nostream 2>/dev/null | grep -o 'https://[^ ]*\.trycloudflare\.com' | tail -1 || true)
  if [ -z "$DISCOVERED_URL" ] && [ -f "$TUNNEL_URL_FILE" ]; then
    DISCOVERED_URL=$(cat "$TUNNEL_URL_FILE" | tr -d '\n')
  fi
  if [ -n "$DISCOVERED_URL" ]; then
    TUNNEL_URL="$DISCOVERED_URL"
    echo "[BOOT] ALLOW_EPHEMERAL_TUNNEL=1: using discovered quick tunnel for local dev only."
  fi
fi

if [ -z "$TUNNEL_URL" ]; then
  echo "[BOOT] WARNING: WEBHOOK_BASE_URL is not configured; project-bot webhook registration will be skipped/fail until set."
elif echo "$TUNNEL_URL" | grep -q 'trycloudflare\.com'; then
  if [ "${ALLOW_EPHEMERAL_TUNNEL:-}" != "1" ]; then
    echo "[BOOT] Refusing to use ephemeral trycloudflare WEBHOOK_BASE_URL in tester/prod mode."
    echo "[BOOT] Configure a named Cloudflare Tunnel/stable hostname. See docs/STABLE_WEBHOOK_RUNBOOK.md"
  else
    echo "$TUNNEL_URL" > "$TUNNEL_URL_FILE"
    if [ "$CURRENT_URL" != "$TUNNEL_URL" ]; then
      echo "[BOOT] Local-dev tunnel URL changed: $CURRENT_URL → $TUNNEL_URL"
      sed -i "s|WEBHOOK_BASE_URL=.*|WEBHOOK_BASE_URL=$TUNNEL_URL|" "$ENV_FILE"
    else
      echo "[BOOT] Local-dev tunnel URL unchanged: $TUNNEL_URL"
    fi
  fi
else
  echo "$TUNNEL_URL" > "$TUNNEL_URL_FILE"
  if [ "$CURRENT_URL" != "$TUNNEL_URL" ]; then
    echo "[BOOT] Stable WEBHOOK_BASE_URL set: $TUNNEL_URL"
    sed -i "s|WEBHOOK_BASE_URL=.*|WEBHOOK_BASE_URL=$TUNNEL_URL|" "$ENV_FILE"
  else
    echo "[BOOT] Stable WEBHOOK_BASE_URL unchanged: $TUNNEL_URL"
  fi
fi

cd "$ZOLARA_DIR"
exec npx tsx src/server/index.ts 2>&1 | tee -a /tmp/zolara.log
