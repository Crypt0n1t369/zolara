import Redis from 'ioredis';
import { config } from '../config';
export const redis = new Redis(config.REDIS_URL);
redis.on('connect', () => console.log('[Redis] Connected'));
redis.on('error', (err) => console.error('[Redis] Error:', err));
// Conversation state helpers
export async function getConversationState(chatId, botId) {
    const raw = await redis.get(`conv:${botId}:${chatId}`);
    return raw ? JSON.parse(raw) : null;
}
export async function setConversationState(chatId, botId, state, ttlSeconds = 86400) {
    await redis.setex(`conv:${botId}:${chatId}`, ttlSeconds, JSON.stringify(state));
}
export async function clearConversationState(chatId, botId) {
    await redis.del(`conv:${botId}:${chatId}`);
}
