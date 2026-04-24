import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { logger as honoLogger } from 'hono/logger';
import { config } from '../config';
import { webhook as webhookLog, round as roundLog, setSelfHealingAgent, } from '../util/logger';
// ── Self-Healing Agent Setup ───────────────────────────────────────────────────
// Load self-healing-agent lazily; if it fails (ESM/CJS mismatch), server continues without it
try {
    const { createSelfHealingAgent, JSONKnowledgeBase } = await import('self-healing-agent');
    const healingAgent = createSelfHealingAgent({
        mode: config.HEALING_MODE ?? 'auto',
        kb: new JSONKnowledgeBase({ filePath: './data/self-healing-kb.json' }),
        alertRouter: {
            send: async (level, alert) => {
                const emoji = { 0: '💤', 1: 'ℹ️', 2: '⚠️', 3: '🚨', 4: '🔴' };
                console.log(`[SelfHealing Alert L${level}] ${emoji[level] ?? '📢'} ${alert.title}`, {
                    fixId: alert.fixId,
                    level,
                    body: alert.body,
                });
            },
        },
        verifier: {
            check: async (_signal) => true,
            healthCheck: async () => true,
        },
    });
    setSelfHealingAgent(healingAgent);
}
catch (err) {
    console.log('[SelfHealing] Not available — running without it');
}
const app = new Hono();
app.use('*', honoLogger());
// Health check
app.get('/health', (c) => c.json({ status: 'ok', service: 'zolara', timestamp: new Date().toISOString() }));
// Webhook endpoint — OpenClaw delivers Telegram updates here
// This fires when OpenClaw's gateway polls @Zolara_bot and receives an update
app.post('/webhook/zolara', async (c) => {
    const secret = c.req.header('X-Telegram-Bot-Api-Secret-Token');
    if (secret !== config.WEBHOOK_SECRET) {
        return c.json({ error: 'Unauthorized' }, 403);
    }
    const { handleZolaraWebhook } = await import('../project');
    const update = await c.req.json();
    try {
        await handleZolaraWebhook(update);
    }
    catch (err) {
        webhookLog.unhandledFailed({ context: 'zolara_webhook' }, err);
    }
    return c.json({ ok: true });
});
const port = config.PORT;
serve({ fetch: app.fetch, port }, () => {
    console.log(`✅ Zolara HTTP server on http://0.0.0.0:${port}`);
    console.log('[Zolara] OpenClaw gateway delivers Telegram updates via /webhook/zolara');
});
// In production: also start grammY long polling as a fallback
// (OpenClaw gateway handles updates in development)
if (config.NODE_ENV === 'production') {
    const { startZolaraPolling } = await import('../project');
    startZolaraPolling().catch((err) => {
        roundLog.triggerFailed({ context: 'zolara_bot_startup' }, err);
    });
}
