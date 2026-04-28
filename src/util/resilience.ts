import { warn } from './logger';

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  context?: Record<string, unknown>;
  retryAfterMs?: (err: unknown) => number | undefined;
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultShouldRetry(err: unknown): boolean {
  const anyErr = err as { status?: number; error_code?: number; code?: string; message?: string };
  const status = anyErr.status ?? anyErr.error_code;
  if (status === 429 || status === 408 || (typeof status === 'number' && status >= 500)) return true;

  const code = anyErr.code ?? '';
  if (['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)) return true;

  const message = (anyErr.message ?? '').toLowerCase();
  return message.includes('timeout') || message.includes('network') || message.includes('fetch failed');
}

function jitter(delayMs: number): number {
  const spread = Math.floor(delayMs * 0.2);
  return delayMs + Math.floor(Math.random() * (spread + 1));
}

export async function withRetry<T>(
  operation: string,
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 5_000;
  const shouldRetry = options.shouldRetry ?? ((err) => defaultShouldRetry(err));

  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt >= attempts || !shouldRetry(err, attempt)) throw err;

      const retryAfter = options.retryAfterMs?.(err);
      const delayMs = retryAfter ?? jitter(Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1)));
      options.onRetry?.(err, attempt, delayMs);
      warn('webhook', 'RETRYING_OPERATION', `Retrying ${operation} after failure`, {
        operation,
        attempt,
        nextAttempt: attempt + 1,
        delayMs,
        ...(options.context ?? {}),
      });
      await sleep(delayMs);
    }
  }

  throw lastErr;
}

export function errorStatus(err: unknown): number | undefined {
  const anyErr = err as { status?: number; error_code?: number };
  return anyErr.status ?? anyErr.error_code;
}
