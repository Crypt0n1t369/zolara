#!/usr/bin/env bash
set -euo pipefail

ZOLARA_DIR="/home/drg/projects/zolara"
STATE_FILE="/tmp/zolara-dev-round-state.json"
LOG_FILE="/tmp/zolara-dev-round-cron.log"
LOCK_FILE="/tmp/zolara-dev-round-cron.lock"
MAX_ROUND=4

cd "$ZOLARA_DIR"
mkdir -p "$(dirname "$STATE_FILE")"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "$(date -Is) already running" >> "$LOG_FILE"
  exit 0
fi

if [ ! -f "$STATE_FILE" ]; then
  printf '{"nextRound":4,"dispatched":[]}' > "$STATE_FILE"
fi

NEXT_ROUND=$(node -e "const fs=require('fs'); const s=JSON.parse(fs.readFileSync('$STATE_FILE','utf8')); console.log(s.nextRound||4)")
if [ "$NEXT_ROUND" -gt "$MAX_ROUND" ]; then
  echo "$(date -Is) all planned dev rounds dispatched" >> "$LOG_FILE"
  exit 0
fi

# Safety: don't dispatch autonomous work if source files have uncommitted changes.
DIRTY=$(git status --short -- . ':!.env' ':!node_modules/.vite/**' | wc -l | tr -d ' ')
if [ "$DIRTY" != "0" ]; then
  echo "$(date -Is) skipped round $NEXT_ROUND: working tree has source changes" >> "$LOG_FILE"
  exit 0
fi

npm run build >> "$LOG_FILE" 2>&1
npx vitest run src/engine/phase-2-problem-def.test.ts >> "$LOG_FILE" 2>&1
curl -fsS http://localhost:3000/health >> "$LOG_FILE" 2>&1 || true

declare -A TASKS
TASKS[4]='Continue Zolara development Round 4: admin clarity/dashboard. Build /dashboard or equivalent admin status surface showing onboarding complete/pending, current validation status, active round status, missing responses, and next recommended action. Test build, run relevant tests, restart PM2 if needed, update WORKLOG, commit and push. Keep secrets out of git.'

MESSAGE="${TASKS[$NEXT_ROUND]}"
if [ -z "${MESSAGE:-}" ]; then
  echo "$(date -Is) no task for round $NEXT_ROUND" >> "$LOG_FILE"
  exit 0
fi

if openclaw agent --agent zolara-builder --message "$MESSAGE" --timeout 120 >> "$LOG_FILE" 2>&1; then
  node -e "const fs=require('fs'); const p='$STATE_FILE'; const s=JSON.parse(fs.readFileSync(p,'utf8')); s.dispatched=s.dispatched||[]; s.dispatched.push({round:$NEXT_ROUND, at:new Date().toISOString()}); s.nextRound=$NEXT_ROUND+1; fs.writeFileSync(p, JSON.stringify(s,null,2));"
  echo "$(date -Is) dispatched round $NEXT_ROUND" >> "$LOG_FILE"
else
  echo "$(date -Is) failed to dispatch round $NEXT_ROUND" >> "$LOG_FILE"
  exit 1
fi
