/**
 * Multi-bot webhook router.
 *
 * Receives updates from ALL managed project bots (each has its own webhook).
 * Routes every update to the correct project context using URL param + secret token.
 *
 * Architecture:
 * - Each project bot registers webhook at /webhook/projectbot/{botTokenHash}
 * - Telegram sends X-Telegram-Bot-Api-Secret-Token header (=webhookSecret)
 * - URL param (tokenHash) + header (webhookSecret) → unique project match
 * - Project's botTokenEncrypted is decrypted to create a scoped Bot instance
 */
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { logger as honoLogger } from 'hono/logger';
import { createHash } from 'crypto';
import { config } from '../config';
import { webhook as webhookLog } from '../util/logger';
import { db } from '../data/db';
import { projects } from '../data/schema/projects';
import { eq } from 'drizzle-orm';
import { decrypt } from '../util/crypto';
import { setManagedBotWebhook } from '../project/managed-bots/lifecycle';
import { landingPageHtml } from './landing-page';
// ── Self-Healing Agent Setup ───────────────────────────────────────────────────
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
}
catch (err) {
    console.log('[SelfHealing] Not available — running without it');
}
const app = new Hono();
app.use('*', honoLogger());
// Health check
app.get('/health', (c) => c.json({ status: 'ok', service: 'zolara', timestamp: new Date().toISOString() }));
// Static landing page
app.get('/', (c) => c.html(landingPageHtml()));
app.get('/landing-page', (c) => c.html(landingPageHtml()));
// Webhook endpoint for managed project bots
// URL: /webhook/projectbot/{tokenHash}
// Header: X-Telegram-Bot-Api-Secret-Token = webhookSecret (per-project)
// Telegram sends both so we verify both to ensure authenticity
app.post('/webhook/projectbot/:tokenHash', async (c) => {
    const tokenHash = c.req.param('tokenHash');
    const secret = c.req.header('X-Telegram-Bot-Api-Secret-Token');
    if (!secret) {
        return c.json({ error: 'Missing secret token' }, 400);
    }
    try {
        // Look up project by botTokenHash (URL param) + webhookSecret (header)
        // Both must match for the project to be valid — prevents token hijacking
        const [project] = await db
            .select({
            id: projects.id,
            name: projects.name,
            botTokenEncrypted: projects.botTokenEncrypted,
            webhookSecret: projects.webhookSecret,
            status: projects.status,
        })
            .from(projects)
            .where(eq(projects.botTokenHash, tokenHash))
            .limit(1);
        if (!project) {
            return c.json({ error: 'Unknown bot' }, 403);
        }
        // Verify the secret token matches this project's webhookSecret
        if (project.webhookSecret !== secret) {
            return c.json({ error: 'Invalid secret' }, 403);
        }
        if (project.status === 'archived' || project.status === 'paused') {
            return c.json({ ok: true, message: 'Project paused' });
        }
        // Decrypt bot token for this project
        let botToken = null;
        if (project.botTokenEncrypted) {
            try {
                botToken = decrypt(project.botTokenEncrypted);
            }
            catch (decryptErr) {
                webhookLog.unhandledFailed({ projectId: project.id, context: 'token_decrypt' }, decryptErr);
                return c.json({ error: 'Bot token error' }, 500);
            }
        }
        const update = await c.req.json();
        // Route to the project-specific handler with project context + bot token
        const { handleProjectBotUpdate } = await import('../project');
        await handleProjectBotUpdate(update, project.id, botToken);
        return c.json({ ok: true });
    }
    catch (err) {
        webhookLog.unhandledFailed({ context: 'project_webhook' }, err);
        return c.json({ ok: true }); // Always return 200 to Telegram to avoid retries
    }
});
// Legacy @Zolara_bot webhook (managed by OpenClaw gateway, not our server)
// OpenClaw polls @Zolara_bot and forwards updates here
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
/** Re-register webhooks for all active project bots on startup (self-heal after tunnel URL change) */
async function reRegisterWebhooks() {
    const BASE = config.WEBHOOK_BASE_URL;
    if (!BASE || !BASE.startsWith('http')) {
        console.log('[Webhook] No WEBHOOK_BASE_URL configured — skipping auto-rehack');
        return;
    }
    const rows = await db.select({
        id: projects.id,
        name: projects.name,
        botUsername: projects.botUsername,
        botTokenEncrypted: projects.botTokenEncrypted,
        webhookSecret: projects.webhookSecret,
    }).from(projects).where(eq(projects.status, 'active'));
    let ok = 0;
    for (const row of rows) {
        if (!row.botTokenEncrypted || !row.webhookSecret)
            continue;
        try {
            const token = decrypt(row.botTokenEncrypted);
            const hash = createHash('sha256').update(token).digest('hex');
            const url = `${BASE}/webhook/projectbot/${hash}`;
            await setManagedBotWebhook(token, url, row.webhookSecret);
            console.log(`[Webhook] ✅ @${row.botUsername} rehacked → ${url}`);
            ok++;
        }
        catch (e) {
            console.error(`[Webhook] ❌ ${row.name}: ${e.message}`);
        }
    }
    console.log(`[Webhook] Auto-rehack complete: ${ok}/${rows.length} bots registered`);
}
serve({ fetch: app.fetch, port }, () => {
    console.log(`✅ Zolara HTTP server on http://0.0.0.0:${port}`);
    console.log('[Zolara] Multi-bot webhook router active on /webhook/projectbot/:tokenHash');
    reRegisterWebhooks().catch((err) => console.error('[Webhook] Auto-rehack failed:', err));
});
// Start grammY long polling for @Zolara_bot (control plane bot)
// Managed project bots use webhooks only (polling would require one process per bot)
{
    const { startZolaraPolling } = await import('../project');
    startZolaraPolling().catch((err) => {
        console.error('[Zolara] Failed to start @Zolara_bot polling:', err);
    });
}
