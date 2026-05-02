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
import { pendingWebProfiles, projects } from '../data/schema/projects';
import { and, eq } from 'drizzle-orm';
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
function normalizeTelegramUsername(value) {
    return value.trim().replace(/^@+/, '').toLowerCase();
}
function escapeHtml(value) {
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
// Static landing page + lightweight web intake
app.get('/', (c) => c.html(landingPageHtml()));
app.get('/landing-page', (c) => c.html(landingPageHtml()));
app.post('/intake', async (c) => {
    const body = await c.req.parseBody();
    const email = String(body.email ?? '').trim().toLowerCase();
    const telegramUsername = String(body.telegramUsername ?? '').trim();
    const normalized = normalizeTelegramUsername(telegramUsername);
    const role = String(body.role ?? 'lead') === 'member' ? 'member' : 'lead';
    if (!/^\S+@\S+\.\S+$/.test(email) || !/^[a-z0-9_]{5,32}$/.test(normalized)) {
        return c.html(`<p>That email or Telegram username does not look valid.</p>` +
            `<p><a href="/#connect">Go back</a></p>`, 400);
    }
    const [existing] = await db
        .select({ id: pendingWebProfiles.id })
        .from(pendingWebProfiles)
        .where(and(eq(pendingWebProfiles.telegramUsernameNormalized, normalized), eq(pendingWebProfiles.status, 'pending')))
        .limit(1);
    if (existing) {
        await db.update(pendingWebProfiles).set({
            email,
            telegramUsername,
            role,
            source: 'landing_page',
            metadata: { updatedFrom: 'landing_page' },
        }).where(eq(pendingWebProfiles.id, existing.id));
    }
    else {
        await db.insert(pendingWebProfiles).values({
            email,
            telegramUsername,
            telegramUsernameNormalized: normalized,
            role,
            source: 'landing_page',
            metadata: { userAgent: c.req.header('User-Agent') ?? null },
        });
    }
    return c.html(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Zolara profile saved</title></head>` +
        `<body style="font-family:system-ui,sans-serif;max-width:680px;margin:48px auto;padding:0 20px;line-height:1.55">` +
        `<h1>Profile saved.</h1>` +
        `<p>Now open Telegram and send <strong>hi</strong> to <strong>@Zolara_bot</strong>. That lets Zolara bind this temporary profile for <strong>@${escapeHtml(normalized)}</strong> to your stable Telegram account ID.</p>` +
        `<p><a style="display:inline-block;padding:12px 16px;border-radius:999px;background:#4f46e5;color:white;text-decoration:none;font-weight:800" href="https://t.me/Zolara_bot">Open @Zolara_bot</a></p>` +
        `</body></html>`);
});
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
function isRandomTryCloudflareUrl(value) {
    try {
        const host = new URL(value).hostname;
        return host.endsWith('.trycloudflare.com');
    }
    catch {
        return false;
    }
}
/** Re-register webhooks for all active project bots on startup (self-heal after tunnel URL change) */
async function reRegisterWebhooks() {
    const BASE = config.WEBHOOK_BASE_URL;
    if (!BASE || !BASE.startsWith('https://')) {
        console.log('[Webhook] No HTTPS WEBHOOK_BASE_URL configured — skipping auto-rehook');
        return;
    }
    if (isRandomTryCloudflareUrl(BASE) && process.env.ALLOW_EPHEMERAL_TUNNEL !== '1') {
        console.warn('[Webhook] Refusing auto-rehook to random trycloudflare.com URL. Configure a named Cloudflare Tunnel/stable hostname, or set ALLOW_EPHEMERAL_TUNNEL=1 for local dev only.');
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
    let skipped = 0;
    let failed = 0;
    const host = new URL(BASE).hostname;
    for (const row of rows) {
        if (!row.botTokenEncrypted || !row.webhookSecret) {
            if (!row.botUsername) {
                skipped++;
                continue;
            }
            console.error(`[Webhook] ❌ @${row.botUsername}: missing bot token or webhook secret; cannot auto-rehook`);
            failed++;
            continue;
        }
        try {
            const token = decrypt(row.botTokenEncrypted);
            const hash = createHash('sha256').update(token).digest('hex');
            const url = `${BASE}/webhook/projectbot/${hash}`;
            const result = await setManagedBotWebhook(token, url, row.webhookSecret);
            if (!result.success) {
                throw new Error(`setWebhook failed: ${result.description ?? 'Unknown error'}`);
            }
            console.log(`[Webhook] ✅ @${row.botUsername} rehooked on ${host}`);
            ok++;
        }
        catch (e) {
            console.error(`[Webhook] ❌ ${row.name}: ${e.message}`);
            failed++;
        }
    }
    console.log(`[Webhook] Auto-rehook complete: registered=${ok}, skipped=${skipped}, failed=${failed}, activeRows=${rows.length}`);
}
serve({ fetch: app.fetch, port }, () => {
    console.log(`✅ Zolara HTTP server on http://0.0.0.0:${port}`);
    console.log('[Zolara] Multi-bot webhook router active on /webhook/projectbot/:tokenHash');
    reRegisterWebhooks().catch((err) => console.error('[Webhook] Auto-rehook failed:', err));
});
// Start grammY long polling for @Zolara_bot (control plane bot)
// Managed project bots use webhooks only (polling would require one process per bot)
{
    const { startZolaraPolling } = await import('../project');
    startZolaraPolling().catch((err) => {
        console.error('[Zolara] Failed to start @Zolara_bot polling:', err);
    });
}
