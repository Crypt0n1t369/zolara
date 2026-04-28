#!/bin/bash
# Zolara startup: extracts tunnel URL from cloudflared PM2 logs, updates .env, starts Zolara.
# cloudflared is managed by PM2 (ecosystem-tunnel.config.cjs) — auto-restarts on crash.

ZOLARA_DIR="/home/drg/projects/zolara"
CLOUDFLARED_LOG="/tmp/cloudflared.log"
TUNNEL_URL_FILE="/tmp/tunnel_url.txt"

# Try to get tunnel URL from cloudflared PM2 logs first, then from saved file
TUNNEL_URL=$(pm2 logs cloudflared --nostream 2>/dev/null | grep -o 'https://[^ ]*\.trycloudflare\.com' | tail -1)

if [ -z "$TUNNEL_URL" ] && [ -f "$TUNNEL_URL_FILE" ]; then
  TUNNEL_URL=$(cat "$TUNNEL_URL_FILE" | tr -d '\n')
fi

if [ -z "$TUNNEL_URL" ]; then
  echo "[BOOT] WARNING: Could not determine tunnel URL — using .env fallback"
  TUNNEL_URL=$(grep WEBHOOK_BASE_URL "$ZOLARA_DIR/.env" 2>/dev/null | grep -v "^#" | cut -d= -f2)
fi

if [ -n "$TUNNEL_URL" ]; then
  echo "$TUNNEL_URL" > "$TUNNEL_URL_FILE"
  CURRENT_URL=$(grep WEBHOOK_BASE_URL "$ZOLARA_DIR/.env" 2>/dev/null | grep -v "^#" | cut -d= -f2)
  if [ "$CURRENT_URL" != "$TUNNEL_URL" ]; then
    echo "[BOOT] Tunnel URL changed: $CURRENT_URL → $TUNNEL_URL"
    sed -i "s|WEBHOOK_BASE_URL=.*|WEBHOOK_BASE_URL=$TUNNEL_URL|" "$ZOLARA_DIR/.env"
  else
    echo "[BOOT] Tunnel URL unchanged: $TUNNEL_URL"
  fi
fi

cd "$ZOLARA_DIR"
exec npx tsx src/server/index.ts 2>&1 | tee -a /tmp/zolara.log
