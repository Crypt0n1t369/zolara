import Redis from 'ioredis';
import { config } from '../config';

export const redis = new Redis(config.REDIS_URL);

redis.on('connect', () => console.log('[Redis] Connected'));
redis.on('error', (err) => console.error('[Redis] Error:', err));

// Conversation state helpers
export async function getConversationState(
  chatId: number,
  botId: string
): Promise<Record<string, unknown> | null> {
  const raw = await redis.get(`conv:${botId}:${chatId}`);
  return raw ? JSON.parse(raw) : null;
}

export async function setConversationState(
  chatId: number,
  botId: string,
  state: Record<string, unknown>,
  ttlSeconds = 86400
): Promise<void> {
  await redis.setex(`conv:${botId}:${chatId}`, ttlSeconds, JSON.stringify(state));
}

export async function clearConversationState(chatId: number, botId: string): Promise<void> {
  await redis.del(`conv:${botId}:${chatId}`);
}
