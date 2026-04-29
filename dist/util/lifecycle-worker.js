/**
 * Shared lifecycle worker implementation for deadline-driven background work.
 * The CLI wrapper lives in scripts/lifecycle-worker.ts.
 */
import { redis } from '../data/redis';
import { checkRoundDeadlines } from '../engine/round-manager';
import { checkValidationDeadlines } from '../engine/phases/phase-2-problem-def';
import { logger } from './logger';
export const LOCK_KEY = 'lock:lifecycle-worker';
const LOCK_TTL_SECONDS = Number(process.env.LIFECYCLE_WORKER_LOCK_TTL_SECONDS ?? 300);
export async function withLifecycleWorkerLock(fn) {
    const token = `${process.pid}:${Date.now()}`;
    const acquired = await redis.set(LOCK_KEY, token, 'EX', LOCK_TTL_SECONDS, 'NX');
    if (acquired !== 'OK') {
        logger.info({ msg: '[LifecycleWorker] skipped: another worker holds lock', lockKey: LOCK_KEY });
        return null;
    }
    try {
        return await fn();
    }
    finally {
        const current = await redis.get(LOCK_KEY).catch(() => null);
        if (current === token) {
            await redis.del(LOCK_KEY).catch((err) => {
                logger.warn({ msg: '[LifecycleWorker] failed to release lock', err: String(err) });
            });
        }
    }
}
export async function runLifecycleWorkerOnce() {
    const startedAt = Date.now();
    await withLifecycleWorkerLock(async () => {
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
