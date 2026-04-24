export interface LLMResponse {
  text: string;
  parsed: unknown;
  usage: { inputTokens: number; outputTokens: number };
  model: string;
}

export interface LLMProvider {
  generate(params: {
    systemPrompt: string;
    userPrompt: string;
    temperature?: number;
    maxTokens?: number;
    responseFormat?: 'text' | 'json';
    model?: string;
  }): Promise<LLMResponse>;
}
