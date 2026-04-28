#!/usr/bin/env bash
set -euo pipefail
cd /home/drg/projects/zolara
exec npx tsx scripts/lifecycle-worker.ts once 2>&1 | tee -a /tmp/zolara-lifecycle-worker.log
