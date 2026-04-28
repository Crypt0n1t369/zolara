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
import { checkRoundDeadlines } from '../src/engine/round-manager';
import { checkValidationDeadlines } from '../src/engine/phases/phase-2-problem-def';
import { logger } from '../src/util/logger';

const LOCK_KEY = 'lock:lifecycle-worker';
const LOCK_TTL_SECONDS = Number(process.env.LIFECYCLE_WORKER_LOCK_TTL_SECONDS ?? 300);

async function withLock<T>(fn: () => Promise<T>): Promise<T | null> {
  const token = `${process.pid}:${Date.now()}`;
  const acquired = await redis.set(LOCK_KEY, token, 'EX', LOCK_TTL_SECONDS, 'NX');
  if (acquired !== 'OK') {
    logger.info({ msg: '[LifecycleWorker] skipped: another worker holds lock', lockKey: LOCK_KEY });
    return null;
  }

  try {
    return await fn();
  } finally {
    const current = await redis.get(LOCK_KEY).catch(() => null);
    if (current === token) {
      await redis.del(LOCK_KEY).catch((err) => {
        logger.warn({ msg: '[LifecycleWorker] failed to release lock', err: String(err) });
      });
    }
  }
}

export async function runLifecycleWorkerOnce(): Promise<void> {
  const startedAt = Date.now();
  await withLock(async () => {
    logger.info({ msg: '[LifecycleWorker] started' });

    const validation = await checkValidationDeadlines();
    const rounds = await checkRoundDeadlines();

    logger.info({
      msg: '[LifecycleWorker] finished',
      durationMs: Date.now() - startedAt,
      validation,
      rounds,
    });
  });
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'once';

  if (mode !== 'once') {
    throw new Error(`Unsupported lifecycle-worker mode: ${mode}`);
  }

  await runLifecycleWorkerOnce();
  await redis.quit();
  // postgres-js keeps an idle pool alive; PM2 cron expects this one-shot to exit.
  process.exit(0);
}

main().catch(async (err) => {
  logger.error({ msg: '[LifecycleWorker] failed', err: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined });
  await redis.quit().catch(() => undefined);
  process.exit(1);
});
