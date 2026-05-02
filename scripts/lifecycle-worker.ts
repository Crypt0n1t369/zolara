#!/usr/bin/env npx tsx
/**
 * Zolara lifecycle worker.
 *
 * Runs deadline-driven background work outside the webhook process:
 * - problem validation vote deadlines → tally votes
 * - round gathering deadlines → synthesize/report
 *
 * Safe to run from cron/PM2: a Redis NX lock prevents overlapping runs.
 */

import { redis } from '../src/data/redis';
import { logger } from '../src/util/logger';
import { runLifecycleWorkerOnce } from '../src/util/lifecycle-worker';

async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'once';

  if (mode !== 'once') {
    throw new Error(`Unsupported lifecycle-worker mode: ${mode}`);
  }

  const summary = await runLifecycleWorkerOnce();
  console.log(`[LifecycleWorker] summary ${JSON.stringify(summary)}`);
  await redis.quit();
  // postgres-js keeps an idle pool alive; PM2 cron expects this one-shot to exit.
  process.exit(0);
}

main().catch(async (err) => {
  logger.error({ msg: '[LifecycleWorker] failed', err: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
  await redis.quit().catch(() => undefined);
  process.exit(1);
});
