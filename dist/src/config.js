import 'dotenv/config';
import { z } from 'zod';
const envSchema = z.object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().default(3000),
    DATABASE_URL: z.string(),
    REDIS_URL: z.string(),
    ZOLARA_BOT_TOKEN: z.string(),
    MANAGED_BOTS_TOKEN: z.string(),
    WEBHOOK_BASE_URL: z.string().url(),
    WEBHOOK_SECRET: z.string().min(16),
    GEMINI_API_KEY: z.string().optional(),
    MINIMAX_API_KEY: z.string(),
    MINIMAX_MODEL: z.string().optional(),
    ENCRYPTION_KEY: z.string().min(32),
    HEALING_MODE: z.enum(['auto', 'approval', 'observe']).default('auto'),
});
export const config = envSchema.parse(process.env);
