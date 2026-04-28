import { warn } from './logger';
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function defaultShouldRetry(err) {
    const anyErr = err;
    const status = anyErr.status ?? anyErr.error_code;
    if (status === 429 || status === 408 || (typeof status === 'number' && status >= 500))
        return true;
    const code = anyErr.code ?? '';
    if (['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(code))
        return true;
    const message = (anyErr.message ?? '').toLowerCase();
    return message.includes('timeout') || message.includes('network') || message.includes('fetch failed');
}
function jitter(delayMs) {
    const spread = Math.floor(delayMs * 0.2);
    return delayMs + Math.floor(Math.random() * (spread + 1));
}
export async function withRetry(operation, fn, options = {}) {
    const attempts = options.attempts ?? 3;
    const baseDelayMs = options.baseDelayMs ?? 500;
    const maxDelayMs = options.maxDelayMs ?? 5_000;
    const shouldRetry = options.shouldRetry ?? ((err) => defaultShouldRetry(err));
    let lastErr;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            return await fn(attempt);
        }
        catch (err) {
            lastErr = err;
            if (attempt >= attempts || !shouldRetry(err, attempt))
                throw err;
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
export function errorStatus(err) {
    const anyErr = err;
    return anyErr.status ?? anyErr.error_code;
}
