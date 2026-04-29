import { beforeEach, describe, expect, it, vi } from 'vitest';

const redisSet = vi.fn();
const redisGet = vi.fn();
const redisDel = vi.fn();
const redisQuit = vi.fn();
const checkValidationDeadlines = vi.fn();
const checkRoundDeadlines = vi.fn();
const loggerInfo = vi.fn();
const loggerWarn = vi.fn();
const loggerError = vi.fn();

vi.mock('./data/redis', () => ({
  redis: {
    set: redisSet,
    get: redisGet,
    del: redisDel,
    quit: redisQuit,
  },
}));

vi.mock('./engine/phases/phase-2-problem-def', () => ({
  checkValidationDeadlines,
}));

vi.mock('./engine/round-manager', () => ({
  checkRoundDeadlines,
}));

vi.mock('./util/logger', () => ({
  logger: {
    info: loggerInfo,
    warn: loggerWarn,
    error: loggerError,
  },
}));

describe('lifecycle worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    let lockToken = '';
    redisSet.mockImplementation(async (_key, token) => {
      lockToken = token;
      return 'OK';
    });
    redisGet.mockImplementation(async () => lockToken);
    redisDel.mockResolvedValue(1);
    redisQuit.mockResolvedValue(undefined);
    checkValidationDeadlines.mockResolvedValue({ checked: 1, expired: 1, processed: 1, failed: 0 });
    checkRoundDeadlines.mockResolvedValue({ checked: 2, expired: 1, processed: 1, failed: 0 });
  });

  it('runs validation deadlines before round deadlines under a Redis NX lock', async () => {
    const { LOCK_KEY, runLifecycleWorkerOnce } = await import('./util/lifecycle-worker');

    await runLifecycleWorkerOnce();

    expect(redisSet).toHaveBeenCalledWith(LOCK_KEY, expect.any(String), 'EX', expect.any(Number), 'NX');
    expect(checkValidationDeadlines).toHaveBeenCalledTimes(1);
    expect(checkRoundDeadlines).toHaveBeenCalledTimes(1);
    expect(checkValidationDeadlines.mock.invocationCallOrder[0]).toBeLessThan(checkRoundDeadlines.mock.invocationCallOrder[0]);
    expect(redisDel).toHaveBeenCalledWith(LOCK_KEY);
  });

  it('skips deadline processing when another lifecycle worker holds the lock', async () => {
    redisSet.mockResolvedValue(null);
    const { runLifecycleWorkerOnce } = await import('./util/lifecycle-worker');

    await runLifecycleWorkerOnce();

    expect(checkValidationDeadlines).not.toHaveBeenCalled();
    expect(checkRoundDeadlines).not.toHaveBeenCalled();
    expect(redisDel).not.toHaveBeenCalled();
    expect(loggerInfo).toHaveBeenCalledWith(expect.objectContaining({ msg: expect.stringContaining('skipped') }));
  });

  it('does not release a lock token it no longer owns', async () => {
    redisGet.mockResolvedValue('different-worker-token');
    const { LOCK_KEY, runLifecycleWorkerOnce } = await import('./util/lifecycle-worker');

    await runLifecycleWorkerOnce();

    expect(redisGet).toHaveBeenCalledWith(LOCK_KEY);
    expect(redisDel).not.toHaveBeenCalled();
  });
});
