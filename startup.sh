#!/bin/bash
# Starts cloudflared tunnel, waits for URL, updates .env, then starts/restarts zolara.

cd ~/projects/zolara

echo "[Startup] Starting cloudflared tunnel..."
cloudflared tunnel --url http://localhost:3000 > /tmp/cloudflared_tunnel.log 2>&1 &
CF_PID=$!

echo "[Startup] Waiting for tunnel URL..."
TUNNEL_URL=""
for i in $(seq 1 20); do
  sleep 2
  TUNNEL_URL=$(grep -o 'https://[^ ]*trycloudflare.com' /tmp/cloudflared_tunnel.log | head -1)
  if [ -n "$TUNNEL_URL" ]; then
    break
  fi
done

if [ -z "$TUNNEL_URL" ]; then
  echo "[Startup] ERROR: Could not get cloudflared tunnel URL"
  exit 1
fi

echo "[Startup] Tunnel URL: $TUNNEL_URL"

# Update WEBHOOK_BASE_URL in .env
sed -i "s|WEBHOOK_BASE_URL=.*|WEBHOOK_BASE_URL=$TUNNEL_URL|" .env
echo "[Startup] Updated WEBHOOK_BASE_URL in .env"

# Restart zolara to pick up new URL
echo "[Startup] Restarting zolara..."
pm2 restart zolara 2>/dev/null || pm2 start dist/server/index.js --name zolara

echo "[Startup] Done!"
