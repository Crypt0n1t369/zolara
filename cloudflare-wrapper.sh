#!/bin/bash
~/.local/bin/cloudflared tunnel --url http://localhost:3000 2>&1 &
CF_PID=$!
echo "[Cloudflare] Started PID $CF_PID"
# Wait for URL to appear in cloudflared's output
for i in $(seq 1 30); do
  sleep 2
  URL=$(grep -o 'https://[^ ]*trycloudflare.com' ~/.pm2/logs/cloudflare-tunnel-out.log 2>/dev/null | tail -1)
  if [ -n "$URL" ]; then
    echo "[Cloudflare] Got URL: $URL"
    sed -i "s|WEBHOOK_BASE_URL=.*|WEBHOOK_BASE_URL=$URL|" ~/projects/zolara/.env
    echo "[Cloudflare] Updated .env"
    cd ~/projects/zolara && pm2 restart zolara
    break
  fi
done
# Keep running
wait $CF_PID
