/**
 * Shared lifecycle worker implementation for deadline-driven background work.
 * The CLI wrapper lives in scripts/lifecycle-worker.ts.
 */

import { redis } from '../data/redis';
import { checkRoundDeadlines } from '../engine/round-manager';
import { checkValidationDeadlines } from '../engine/phases/phase-2-problem-def';
import { logger } from './logger';
import { auditEvent } from './audit';

export const LOCK_KEY = 'lock:lifecycle-worker';
const LOCK_TTL_SECONDS = Number(process.env.LIFECYCLE_WORKER_LOCK_TTL_SECONDS ?? 300);

export async function withLifecycleWorkerLock<T>(fn: () => Promise<T>): Promise<T | null> {
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

export type DeadlineCheckSummary = {
  checked: number;
  expired: number;
  processed: number;
  failed: number;
};

export type LifecycleWorkerSummary = {
  locked: boolean;
  durationMs: number;
  validation: DeadlineCheckSummary;
  rounds: DeadlineCheckSummary;
  totals: DeadlineCheckSummary;
};

const emptySummary: DeadlineCheckSummary = { checked: 0, expired: 0, processed: 0, failed: 0 };

function combineSummaries(validation: DeadlineCheckSummary, rounds: DeadlineCheckSummary): DeadlineCheckSummary {
  return {
    checked: validation.checked + rounds.checked,
    expired: validation.expired + rounds.expired,
    processed: validation.processed + rounds.processed,
    failed: validation.failed + rounds.failed,
  };
}

export async function runLifecycleWorkerOnce(): Promise<LifecycleWorkerSummary> {
  const startedAt = Date.now();
  const result = await withLifecycleWorkerLock(async () => {
    logger.info({ msg: '[LifecycleWorker] started' });

    const validation = await checkValidationDeadlines();
    const rounds = await checkRoundDeadlines();
    const summary: LifecycleWorkerSummary = {
      locked: false,
      durationMs: Date.now() - startedAt,
      validation,
      rounds,
      totals: combineSummaries(validation, rounds),
    };

    logger.info({
      msg: '[LifecycleWorker] finished',
      ...summary,
    });
    await auditEvent('lifecycle_worker_summary', {
      locked: summary.locked,
      durationMs: summary.durationMs,
      validation: summary.validation,
      rounds: summary.rounds,
      totals: summary.totals,
    });
    return summary;
  });

  if (result) return result;

  const lockedSummary: LifecycleWorkerSummary = {
    locked: true,
    durationMs: Date.now() - startedAt,
    validation: emptySummary,
    rounds: emptySummary,
    totals: emptySummary,
  };
  logger.info({ msg: '[LifecycleWorker] summary', ...lockedSummary });
  await auditEvent('lifecycle_worker_summary', {
    locked: lockedSummary.locked,
    durationMs: lockedSummary.durationMs,
    validation: lockedSummary.validation,
    rounds: lockedSummary.rounds,
    totals: lockedSummary.totals,
  });
  return lockedSummary;
}
