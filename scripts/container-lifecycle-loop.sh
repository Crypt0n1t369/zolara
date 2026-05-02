#!/usr/bin/env sh
set -eu

# Simple recurring lifecycle worker for container hosts that do not provide cron.
# PM2 deployments should continue using ecosystem.config.cjs cron_restart instead.
INTERVAL_SECONDS="${LIFECYCLE_WORKER_INTERVAL_SECONDS:-60}"
WORKER_COMMAND="${LIFECYCLE_WORKER_COMMAND:-npm run lifecycle:once}"

case "$INTERVAL_SECONDS" in
  ''|*[!0-9]*)
    echo "LIFECYCLE_WORKER_INTERVAL_SECONDS must be a positive integer" >&2
    exit 2
    ;;
esac

if [ "$INTERVAL_SECONDS" -lt 10 ]; then
  echo "LIFECYCLE_WORKER_INTERVAL_SECONDS must be at least 10 seconds" >&2
  exit 2
fi

echo "[LifecycleWorkerLoop] starting; interval=${INTERVAL_SECONDS}s command=${WORKER_COMMAND}"

while true; do
  started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "[LifecycleWorkerLoop] tick ${started_at}"

  if ! sh -c "$WORKER_COMMAND"; then
    echo "[LifecycleWorkerLoop] lifecycle run failed; continuing after sleep" >&2
  fi

  sleep "$INTERVAL_SECONDS"
done
