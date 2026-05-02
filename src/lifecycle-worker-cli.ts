import { redis } from './data/redis';
import { logger } from './util/logger';
import { runLifecycleWorkerOnce } from './util/lifecycle-worker';

async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'once';

  if (mode !== 'once') {
    throw new Error(`Unsupported lifecycle-worker mode: ${mode}`);
  }

  const summary = await runLifecycleWorkerOnce();
  console.log(`[LifecycleWorker] summary ${JSON.stringify(summary)}`);
  await redis.quit();
  process.exit(0);
}

main().catch(async (err) => {
  logger.error({
    msg: '[LifecycleWorker] failed',
    err: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  await redis.quit().catch(() => undefined);
  process.exit(1);
});
