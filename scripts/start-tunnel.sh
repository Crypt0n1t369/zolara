#!/bin/bash
# Starts cloudflared tunnel and waits for the URL to be available.
# Saves URL to /tmp/tunnel_url.txt for Zolara to read on startup.
# This script is managed by PM2 — cloudflared auto-restarts on crash.

TUNNEL_LOG="/tmp/cloudflared.log"
TUNNEL_URL_FILE="/tmp/tunnel_url.txt"

# Kill any existing cloudflared processes
pkill -f "cloudflared tunnel" 2>/dev/null || true
sleep 1

# Start cloudflared in background, logging to file
cloudflared tunnel --url http://localhost:3000 > "$TUNNEL_LOG" 2>&1 &
CLOUDFLARED_PID=$!
echo "cloudflared started (PID $CLOUDFLARED_PID)"

# Wait for URL to appear in log (max 30 seconds)
TIMEOUT=30
ELAPSED=0
while [ $ELAPSED -lt $TIMEOUT ]; do
  URL=$(grep -o 'https://[^ ]*\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | head -1)
  if [ -n "$URL" ]; then
    echo "$URL" > "$TUNNEL_URL_FILE"
    echo "Tunnel URL: $URL"
    echo "Saved to $TUNNEL_URL_FILE"
    exit 0
  fi
  sleep 2
  ELAPSED=$((ELAPSED + 2))
done

echo "ERROR: Timeout waiting for cloudflared tunnel URL"
exit 1
