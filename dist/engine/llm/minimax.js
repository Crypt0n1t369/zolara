import { config } from '../../config';
import { llm as llmLog } from '../../util/logger';
import { auditEvent } from '../../util/audit';
import { withRetry } from '../../util/resilience';
const MINIMAX_API_URL = 'https://api.minimax.io/v1/chat/completions';
const LLM_TIMEOUT_MS = 45_000;
class MiniMaxHttpError extends Error {
    status;
    retryAfterMs;
    constructor(message, status, retryAfterMs) {
        super(message);
        this.status = status;
        this.retryAfterMs = retryAfterMs;
    }
}
/**
 * Some reasoning models may return hidden chain-of-thought inside <think> tags.
 * Never surface that to Telegram users; keep only the final answer.
 */
export function stripThinkingTags(text) {
    return text
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<think>[\s\S]*$/gi, '')
        .trim();
}
export class MiniMaxProvider {
    apiKey;
    model;
    constructor(options) {
        this.apiKey = options?.apiKey ?? config.MINIMAX_API_KEY ?? '';
        // Development: always use M2.7 (most capable)
        this.model = options?.model ?? 'MiniMax-M2.7';
    }
    async generate(params) {
        if (!this.apiKey) {
            throw new Error('MiniMax API key not configured. Set MINIMAX_API_KEY in .env');
        }
        const model = params.model ?? this.model;
        const messages = [];
        if (params.systemPrompt) {
            messages.push({ role: 'system', content: params.systemPrompt });
        }
        messages.push({ role: 'user', content: params.userPrompt });
        const body = {
            model,
            messages,
            temperature: params.temperature ?? 0.7,
            max_tokens: params.maxTokens ?? 2048,
        };
        if (params.responseFormat === 'json') {
            body.response_format = { type: 'json_object' };
        }
        const response = await withRetry('minimax.generate', async () => {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
            try {
                const res = await fetch(MINIMAX_API_URL, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${this.apiKey}`,
                    },
                    body: JSON.stringify(body),
                    signal: controller.signal,
                });
                if (!res.ok) {
                    const retryAfter = Number(res.headers.get('retry-after'));
                    const retryAfterMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : undefined;
                    const errorText = await res.text().catch(() => '');
                    throw new MiniMaxHttpError(`MiniMax HTTP ${res.status}: ${errorText.slice(0, 300)}`, res.status, retryAfterMs);
                }
                return res;
            }
            finally {
                clearTimeout(timeout);
            }
        }, {
            attempts: 3,
            context: { model },
            retryAfterMs: (err) => (err instanceof MiniMaxHttpError ? err.retryAfterMs : undefined),
            onRetry: (err, attempt) => llmLog.apiError(`MiniMax call failed on attempt ${attempt}; retrying`, { model, attempt }, err),
        }).catch(async (err) => {
            llmLog.apiError(`MiniMax request failed after retries: ${err.message}`, { model }, err);
            await auditEvent('llm_generation_failed', {
                provider: 'minimax',
                model,
                error: err instanceof Error ? err.message : String(err),
            });
            throw err;
        });
        let data;
        try {
            data = await response.json();
        }
        catch (err) {
            llmLog.parseFailed('Response JSON parse failed', { model }, err);
            await auditEvent('llm_response_parse_failed', { provider: 'minimax', model, error: err.message });
            throw err;
        }
        // Check for API-level errors
        if (data.base_resp && data.base_resp.status_code !== 0) {
            const msg = `MiniMax API error ${data.base_resp.status_code}: ${data.base_resp.status_msg}`;
            llmLog.apiError(msg, { model });
            await auditEvent('llm_generation_failed', { provider: 'minimax', model, error: msg });
            throw new Error(msg);
        }
        if (data.error) {
            const msg = `MiniMax API error ${data.error.http_code}: ${data.error.message}`;
            llmLog.apiError(msg, { model });
            await auditEvent('llm_generation_failed', { provider: 'minimax', model, error: msg });
            throw new Error(msg);
        }
        const text = stripThinkingTags(data.choices?.[0]?.message?.content ?? '');
        let parsed = null;
        if (params.responseFormat === 'json' && text) {
            try {
                parsed = JSON.parse(text);
            }
            catch {
                const match = text.match(/```json\n?([\s\S]*?)\n?```/);
                if (match) {
                    try {
                        parsed = JSON.parse(match[1]);
                    }
                    catch {
                        llmLog.parseFailed('JSON response parse failed, tried markdown extraction too', { model });
                        await auditEvent('llm_response_parse_failed', { provider: 'minimax', model, responseFormat: params.responseFormat });
                    }
                }
            }
        }
        return {
            text,
            parsed,
            usage: {
                inputTokens: data.usage?.prompt_tokens ?? 0,
                outputTokens: data.usage?.completion_tokens ?? 0,
            },
            model,
        };
    }
}
export const llm = new MiniMaxProvider();
