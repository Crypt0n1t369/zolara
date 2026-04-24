import type { LLMProvider, LLMResponse } from './provider';
import { config } from '../../config';
import { llm as llmLog } from '../../util/logger';

const MINIMAX_API_URL = 'https://api.minimax.io/v1/chat/completions';

export class MiniMaxProvider implements LLMProvider {
  private apiKey: string;
  private model: string;

  constructor(options?: { apiKey?: string; model?: string }) {
    this.apiKey = options?.apiKey ?? config.MINIMAX_API_KEY ?? '';
    // Development: always use M2.7 (most capable)
    this.model = options?.model ?? 'MiniMax-M2.7';
  }

  async generate(params: {
    systemPrompt: string;
    userPrompt: string;
    temperature?: number;
    maxTokens?: number;
    responseFormat?: 'text' | 'json';
    model?: string;
  }): Promise<LLMResponse> {
    if (!this.apiKey) {
      throw new Error('MiniMax API key not configured. Set MINIMAX_API_KEY in .env');
    }

    const model = params.model ?? this.model;
    const messages: Array<{ role: string; content: string }> = [];
    if (params.systemPrompt) {
      messages.push({ role: 'system', content: params.systemPrompt });
    }
    messages.push({ role: 'user', content: params.userPrompt });

    const body: Record<string, unknown> = {
      model,
      messages,
      temperature: params.temperature ?? 0.7,
      max_tokens: params.maxTokens ?? 2048,
    };

    if (params.responseFormat === 'json') {
      body.response_format = { type: 'json_object' };
    }

    let response: Response;
    try {
      response = await fetch(MINIMAX_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      llmLog.apiError(`Network fetch failed: ${(err as Error).message}`, { model }, err as Error);
      throw err;
    }

    let data: {
      choices?: Array<{ message?: { content: string } }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
      base_resp?: { status_code: number; status_msg: string };
      error?: { type: string; message: string; http_code: string };
    };

    try {
      data = await response.json() as typeof data;
    } catch (err) {
      llmLog.parseFailed('Response JSON parse failed', { model }, err as Error);
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

    let parsed: unknown = null;
    if (params.responseFormat === 'json' && text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        const match = text.match(/```json\n?([\s\S]*?)\n?```/);
        if (match) {
          try {
            parsed = JSON.parse(match[1]);
          } catch {
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
