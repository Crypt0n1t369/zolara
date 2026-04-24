import { config } from '../../config';
import { llm as llmLog } from '../../util/logger';
const MINIMAX_API_URL = 'https://api.minimax.io/v1/chat/completions';
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
        let response;
        try {
            response = await fetch(MINIMAX_API_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${this.apiKey}`,
                },
                body: JSON.stringify(body),
            });
        }
        catch (err) {
            llmLog.apiError(`Network fetch failed: ${err.message}`, { model }, err);
            throw err;
        }
        let data;
        try {
            data = await response.json();
        }
        catch (err) {
            llmLog.parseFailed('Response JSON parse failed', { model }, err);
            throw err;
        }
        // Check for API-level errors
        if (data.base_resp && data.base_resp.status_code !== 0) {
            const msg = `MiniMax API error ${data.base_resp.status_code}: ${data.base_resp.status_msg}`;
            llmLog.apiError(msg, { model });
            throw new Error(msg);
        }
        if (data.error) {
            const msg = `MiniMax API error ${data.error.http_code}: ${data.error.message}`;
            llmLog.apiError(msg, { model });
            throw new Error(msg);
        }
        const text = data.choices?.[0]?.message?.content ?? '';
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
