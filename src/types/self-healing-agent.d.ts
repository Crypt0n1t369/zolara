declare module 'self-healing-agent' {
  export type SelfHealingAgent = {
    ingest(signal: {
      code: string;
      domain: string;
      severity: string;
      message: string;
      context?: unknown;
      stack?: string;
    }): Promise<void>;
  };

  export class JSONKnowledgeBase {
    constructor(options: { filePath: string });
  }

  export function createSelfHealingAgent(options: Record<string, unknown>): SelfHealingAgent;
}
