#!/bin/bash
cd ~/projects/zolara
exec npx tsx src/server/index.ts 2>&1 | tee -a /tmp/zolara.log