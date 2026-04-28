/**
 * Zolara Bot — admin control plane
 * Handles admin commands via @Zolara_bot (long polling).
 * Member interactions on project bots route through webhook via server/index.ts.
 *
 * Admin flow: /create, /startround, /cancelround, /projects, /members, /invite, /status
 * Member flow: /start claim_xxx → commitment → onboarding → question answering
 */
import { Bot, InlineKeyboard } from 'grammy';
// ── Helpers ─────────────────────────────────────────────────────────────────────
/**
 * Use ctx.api.answerCallbackQuery to avoid grammY internal
 * abort-signal conflicts when answering a callback multiple times.
 */
async function answerCb(ctx, text, showAlert = false) {
    await ctx.api.answerCallbackQuery(ctx.callbackQuery.id, { text, show_alert: showAlert });
}
import { config } from '../config';
import { redis } from '../data/redis';
import { db } from '../data/db';
import { projects, admins, members, rounds, users } from '../data/schema/projects';
import { eq, desc, and, ne } from 'drizzle-orm';
import { db as dbLog } from '../util/logger';
import { triggerRound, cancelRound } from '../engine/round-manager';
import { validateAndTriggerRound } from '../engine/phases/phase-2-problem-def';
import { isPhaseActive } from '../engine/phases/flags';
import { setRuntimeFlag, listRuntimeFlags } from '../util/runtime-flags';
import { handleAddAdminCommand, handleRemoveAdminCommand, handleTransferOwnershipCommand, handleAdminsCommand, handleSettingsCommand, handleSettingsCallback, handleSettingsReply, } from '../manager/admin-management';
import { nextStep, } from './flows/initiation-state';
import { handleInitiationStep, handleCallback, } from './flows/initiation-steps';
import { handleClaimWelcome, handleClaimCallback, loadClaimState, saveClaimState, clearClaimState, } from './flows/claim-steps';
import { handleOnboardingText, loadOnboardingState, saveOnboardingState, clearOnboardingState, } from './flows/onboarding-steps';
import { handleAIHelp } from './ai-help';
import { suspendProjectAgent, restoreProjectAgent, deleteProjectAgent } from './agent/project-agent';
// ── Bot ───────────────────────────────────────────────────────────────────────
const zolaraBot = new Bot(config.ZOLARA_BOT_TOKEN);
// ── State helpers ─────────────────────────────────────────────────────────────
async function loadInitState(telegramId) {
    const raw = await redis.get(`init:${telegramId}`);
    return raw ? JSON.parse(raw) : null;
}
async function saveInitState(state) {
    await redis.setex(`init:${state.telegramId}`, 86400, JSON.stringify(state));
}
async function clearInitState(telegramId) {
    await redis.del(`init:${telegramId}`);
}
// ── Commands: Admin ───────────────────────────────────────────────────────────
zolaraBot.command('start', async (ctx) => {
    const args = ctx.match || '';
    const userId = ctx.from.id;
    // Pattern: /start claim_xxx → member commitment gate
    if (args.startsWith('claim_')) {
        const projectId = args.replace('claim_', '').trim();
        if (projectId) {
            await handleMemberClaim(ctx, userId, projectId);
            return;
        }
    }
    // Pattern: /start join_xxx → legacy, redirect to claim
    if (args.startsWith('join_')) {
        const projectId = args.replace('join_', '').trim();
        if (projectId) {
            await handleMemberClaim(ctx, userId, projectId);
            return;
        }
    }
    // Pattern: /start createbot_xxx → user confirmed bot creation via BotFather
    if (args.startsWith('createbot_')) {
        const projectId = args.replace('createbot_', '').trim();
        if (projectId) {
            const [proj] = await db.select({
                botTelegramId: projects.botTelegramId,
                name: projects.name,
                botUsername: projects.botUsername,
            }).from(projects).where(eq(projects.id, projectId)).limit(1);
            if (proj?.botTelegramId) {
                const username = proj.botUsername ? `@${proj.botUsername}` : 'your project bot';
                await ctx.reply(`✅ Bot already created for *${proj.name}*!\n\n` +
                    `Meet ${username} — your project's assistant is ready.`, { parse_mode: 'Markdown' });
            }
            else {
                await ctx.reply(`🔧 To create your project bot, click the link in the /create flow message.\n\n` +
                    `Once your bot is created, come back here and we'll complete the setup!`);
            }
            return;
        }
    }
    await ctx.reply('🌀 *Zolara* — AI Consensus Engine\n\n' +
        'I help teams find alignment through structured perspective gathering.\n\n' +
        '/create — Set up a new project\n' +
        '/projects — View your active projects\n' +
        '/startround — Trigger a perspective round\n' +
        '/help — Learn more', { parse_mode: 'Markdown' });
});
zolaraBot.command('help', async (ctx) => {
    await ctx.reply('*How Zolara Works*\n\n' +
        '1️⃣ *Create* a project and bot for your team (/create)\n' +
        '2️⃣ *Invite* members via the link from /invite\n' +
        '3️⃣ *Start a round* to gather perspectives (/startround)\n' +
        '4️⃣ *Receive* an AI synthesis report in your group\n' +
        '5️⃣ *Deepen* alignment through follow-up rounds\n\n' +
        '💬 Ask me anything in natural language — type your question below!', { parse_mode: 'Markdown' });
});
zolaraBot.command('helpme', async (ctx) => {
    const raw = ctx.message?.text ?? '';
    const msg = raw.replace('/helpme', '').trim();
    await handleAIHelp(ctx, ctx.from.id, msg || 'What can you help me with?');
});
zolaraBot.command('create', async (ctx) => {
    const userId = ctx.from.id;
    const state = {
        step: 'greeting',
        config: {},
        telegramId: userId,
        createdAt: new Date().toISOString(),
    };
    await saveInitState(state);
    await handleInitiationStep(ctx, state);
});
zolaraBot.command('cancel', async (ctx) => {
    const userId = ctx.from.id;
    const existing = await loadInitState(userId);
    if (existing) {
        await clearInitState(userId);
        await ctx.reply('❌ Cancelled. Use /create to start fresh.');
        return;
    }
    const claim = await loadClaimState(userId);
    if (claim) {
        await clearClaimState(userId);
        await ctx.reply('❌ Cancelled. Use /start to begin again.');
        return;
    }
    const onboard = await loadOnboardingState(userId);
    if (onboard) {
        await clearOnboardingState(userId);
        await ctx.reply('❌ Cancelled. Use /start to begin again.');
        return;
    }
    await ctx.reply('Nothing to cancel.');
});
// ── Admin: Project Management ──────────────────────────────────────────────────
/**
 * Redis key for admin's currently selected project (30min TTL).
 */
const PROJECT_SELECTION_TTL = 1800; // 30 minutes
function projectSelectionKey(telegramId) {
    return `selected_project:${telegramId}`;
}
/**
 * Build an inline keyboard for project selection.
 */
function statusIcon(s) {
    if (s === 'active')
        return '🟢';
    if (s === 'archived')
        return '🟠';
    if (s === 'pending')
        return '🟡';
    return '⚪';
}
function buildProjectKeyboard(choices, selectedId) {
    const kb = new InlineKeyboard();
    for (const p of choices) {
        if (p.status === 'deleted')
            continue; // never show deleted in list
        const icon = statusIcon(p.status);
        const check = p.id === selectedId ? ' ✅' : '';
        kb.text(`${icon} ${p.name}${check}`, `project:select:${p.id}`).text('⚙️', `project:manage:${p.id}`).row();
    }
    return kb;
}
/**
 * Build an inline keyboard for project management (⚙️ button → status-aware actions)
 * active   → Archive / Delete
 * archived → Restore / Delete
 * pending  → Delete (nothing to archive yet)
 */
function buildProjectManageKeyboard(projectId, status) {
    const kb = new InlineKeyboard();
    if (status === 'active') {
        kb.text('📦 Archive', `project:archive:${projectId}`).text('🗑 Delete', `project:delete:${projectId}`).row();
    }
    else if (status === 'archived') {
        kb.text('↩️ Restore', `project:restore:${projectId}`).text('🗑 Delete', `project:delete:${projectId}`).row();
    }
    else if (status === 'pending') {
        kb.text('🗑 Delete', `project:delete:${projectId}`).row();
    }
    kb.text('🔙 Back', 'project:back');
    return kb;
}
/**
 * Resolve the admin's currently selected project.
 * Checks Redis cache first → falls back to default (active project or most recent).
 */
async function resolveAdminProject(adminTelegramId) {
    // Check Redis cache first
    const cachedId = await redis.get(projectSelectionKey(adminTelegramId));
    if (cachedId) {
        const [row] = await db
            .select({ id: projects.id, name: projects.name, status: projects.status, botUsername: projects.botUsername })
            .from(projects)
            .where(eq(projects.id, cachedId))
            .limit(1);
        if (row) {
            return {
                project: { id: row.id, name: row.name ?? 'Unknown', status: row.status ?? 'pending', botUsername: row.botUsername },
                hasMultiple: false,
                choices: [],
            };
        }
        // Stale cache entry — delete it
        await redis.del(projectSelectionKey(adminTelegramId));
    }
    const rows = await db
        .select({ id: projects.id, name: projects.name, status: projects.status, botUsername: projects.botUsername })
        .from(projects)
        .innerJoin(admins, eq(admins.id, projects.adminId))
        .where(and(eq(admins.telegramId, adminTelegramId), ne(projects.status, 'deleted')))
        .orderBy(desc(projects.createdAt))
        .limit(10);
    if (rows.length === 0) {
        console.log('[DEBUG resolveAdmin] no rows for telegramId', adminTelegramId);
        return { project: null, hasMultiple: false, choices: [] };
    }
    console.log('[DEBUG resolveAdmin] got', rows.length, 'projects for', adminTelegramId);
    const active = rows.filter((r) => r.status === 'active');
    const first = active[0] ?? rows[0];
    const project = {
        id: first.id,
        name: first.name ?? 'Unknown',
        status: first.status ?? 'pending',
        botUsername: first.botUsername,
    };
    return {
        project,
        hasMultiple: rows.length > 1,
        choices: rows.map((r) => ({ id: r.id, name: r.name ?? 'Unknown', status: r.status ?? 'pending' })),
    };
}
zolaraBot.command('projects', async (ctx) => {
    const { project, hasMultiple, choices } = await resolveAdminProject(ctx.from.id);
    console.log('[DEBUG /projects] telegramId=', ctx.from.id, 'hasMultiple=', hasMultiple, 'choices count=', choices.length, 'project=', project?.name);
    if (!project) {
        await ctx.reply("You don't have any projects yet.\n\nUse /create to set one up.");
        return;
    }
    const allChoices = choices.length > 0 ? choices : (project ? [{ id: project.id, name: project.name, status: project.status }] : []);
    console.log('[DEBUG /projects] allChoices count=', allChoices.length);
    if (allChoices.length === 0) {
        await ctx.reply("You don't have any projects yet.\n\nUse /create to set one up.");
        return;
    }
    const escapeHtml = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const lines = allChoices.map((p) => `${statusIcon(p.status)} ${escapeHtml(p.name)}`).join('\n');
    const selectedId = project?.id;
    await ctx.reply(`<b>Your projects:</b>\n\n${lines}\n\nTap a name to select it. Tap [Settings] to manage.`, {
        parse_mode: 'HTML',
        reply_markup: buildProjectKeyboard(allChoices, selectedId),
    });
    return;
});
zolaraBot.command('startround', async (ctx) => {
    const telegramId = ctx.from.id;
    const { project, hasMultiple } = await resolveAdminProject(telegramId);
    if (!project) {
        await ctx.reply("You don't have any projects yet. Use /create to set one up.");
        return;
    }
    const topic = ctx.match.trim();
    if (!topic || topic.length < 12) {
        await ctx.reply('Please start the round with a clear objective.\n\n' +
            'Example:\n' +
            '/startround Align on the first onboarding experience for new Zolara teams\n\n' +
            'The topic should describe what the team is trying to decide, understand, or improve.');
        return;
    }
    try {
        // Use Phase 2 validation flow if flag is active, otherwise fall back to baseline
        if (isPhaseActive('PHASE_PROBLEM_DEF')) {
            const result = await validateAndTriggerRound(project.id, topic);
            if (result.validationStatus === 'voting') {
                await ctx.reply(`🗳 *Validation started for "${topic}"*

` +
                    `Your team is being asked to confirm the topic is clearly defined before we explore it.
` +
                    `Voting open for 24h. You'll be notified when the vote completes.\n\n` +
                    `Problem Definition ID: ${result.problemDefinitionId?.slice(0, 8)}...`, { parse_mode: 'Markdown' });
            }
            else {
                await ctx.reply(result.message);
            }
        }
        else {
            const { roundId } = await triggerRound(project.id, topic);
            await ctx.reply(`🎯 *Round started!*\n\nProject: *${project.name}*\nTopic: ${topic}\nRound ID: ${roundId.slice(0, 8)}...\n\n` +
                `Committed members are being sent questions via DM.`, { parse_mode: 'Markdown' });
        }
    }
    catch (err) {
        await ctx.reply(`⚠️ Could not start round: ${err instanceof Error ? err.message : String(err)}`);
    }
});
zolaraBot.command('cancelround', async (ctx) => {
    const { project } = await resolveAdminProject(ctx.from.id);
    if (!project) {
        await ctx.reply("You don't have any projects yet.");
        return;
    }
    const [round] = await db
        .select()
        .from(rounds)
        .where(and(eq(rounds.projectId, project.id), eq(rounds.status, 'gathering')))
        .limit(1);
    if (!round) {
        await ctx.reply(`No active round on *${project.name}* to cancel.`, { parse_mode: 'Markdown' });
        return;
    }
    try {
        await cancelRound(round.id);
        await ctx.reply(`✅ Round #${round.roundNumber} cancelled. Members will no longer receive questions.`);
    }
    catch (err) {
        await ctx.reply(`⚠️ Could not cancel round: ${err instanceof Error ? err.message : String(err)}`);
    }
});
zolaraBot.command('members', async (ctx) => {
    const { project } = await resolveAdminProject(ctx.from.id);
    if (!project) {
        await ctx.reply("You don't have any projects yet.");
        return;
    }
    const memberRows = await db
        .select({ role: members.role, onboardingStatus: members.onboardingStatus })
        .from(members)
        .where(eq(members.projectId, project.id))
        .limit(50);
    const committed = memberRows.filter((m) => m.onboardingStatus === 'committed').length;
    const pending = memberRows.length - committed;
    const lines = memberRows.slice(0, 20).map((m, i) => {
        const icon = m.onboardingStatus === 'committed' ? '✅' : '⏳';
        return `${i + 1}. ${m.role ?? 'participant'} ${icon}`;
    }).join('\n');
    await ctx.reply(`*${project.name} — Members*\n\nTotal: ${memberRows.length} | Committed: ${committed} | Pending: ${pending}\n\n${lines || 'No members yet.'}`, { parse_mode: 'Markdown' });
});
zolaraBot.command('invite', async (ctx) => {
    const { project } = await resolveAdminProject(ctx.from.id);
    if (!project) {
        await ctx.reply("You don't have any projects yet.");
        return;
    }
    // Look up the project to get the actual bot username
    const [proj] = await db
        .select({ name: projects.name, botUsername: projects.botUsername })
        .from(projects)
        .where(eq(projects.id, project.id))
        .limit(1);
    const botUsername = proj?.botUsername ?? 'Zolara_bot';
    const inviteLink = `https://t.me/${botUsername}?start=claim_${project.id}`;
    await ctx.reply(`*${project.name} - Invite Link*\n\n` +
        `Share this with your team:\n\n` +
        `${inviteLink}\n\n` +
        `Members tap "Yes, I'm in" to join and receive questions.`, { parse_mode: 'Markdown' });
});
zolaraBot.command('status', async (ctx) => {
    const { project } = await resolveAdminProject(ctx.from.id);
    if (!project) {
        await ctx.reply("You don't have any projects yet.");
        return;
    }
    const [round] = await db.select({ id: rounds.id, roundNumber: rounds.roundNumber, status: rounds.status, responseCount: rounds.responseCount, memberCount: rounds.memberCount, topic: rounds.topic }).from(rounds).where(eq(rounds.projectId, project.id)).limit(1);
    if (!round) {
        await ctx.reply(`*${project.name}*\n\nNo active round. Use /startround to begin.`, { parse_mode: 'Markdown' });
        return;
    }
    const responseCount = round.responseCount ?? 0;
    const memberCount = round.memberCount ?? 0;
    const rstatus = round.status ?? 'unknown';
    await ctx.reply(`*${project.name}*\n\nRound #${round.roundNumber}\nStatus: *${rstatus}*\nResponses: ${responseCount}/${memberCount}\nTopic: ${round.topic ?? '—'}`, { parse_mode: 'Markdown' });
});
// ── Admin management commands ──────────────────────────────────────────────────
zolaraBot.command('addadmin', async (ctx) => {
    await handleAddAdminCommand(ctx);
});
zolaraBot.command('removeadmin', async (ctx) => {
    await handleRemoveAdminCommand(ctx);
});
zolaraBot.command('transferownership', async (ctx) => {
    await handleTransferOwnershipCommand(ctx);
});
zolaraBot.command('admins', async (ctx) => {
    await handleAdminsCommand(ctx);
});
zolaraBot.command('settings', async (ctx) => {
    await handleSettingsCommand(ctx);
});
// ── Phase flag control (admin only) ──────────────────────────────────────────
const VALID_PHASES = [
    'PHASE_SUB_PROBLEMS',
    'PHASE_PROBLEM_DEF',
    'PHASE_CROSS_LINK',
    'PHASE_ITERATION',
    'PHASE_RICH_SYNTHESIS',
    'PHASE_MEETING_PREP',
    'PHASE_MEETING',
    'PHASE_AUTO_UPDATE',
];
const PHASE_SHORT = {
    PHASE_SUB_PROBLEMS: '🗂 Sub-problems',
    PHASE_PROBLEM_DEF: '🗳 Problem Validation',
    PHASE_CROSS_LINK: '🔗 Cross-linking',
    PHASE_ITERATION: '🔄 Iteration',
    PHASE_RICH_SYNTHESIS: '📊 Rich Synthesis',
    PHASE_MEETING_PREP: '📋 Meeting Prep',
    PHASE_MEETING: '🗓 Meeting',
    PHASE_AUTO_UPDATE: '🔁 Auto-update',
};
/**
 * Build the phase status inline keyboard.
 * Each phase: [short name] [🟢 ON] or [⚪ OFF]
 */
function buildPhaseKeyboard(flags) {
    const kb = new InlineKeyboard();
    for (const key of VALID_PHASES) {
        const value = flags[key] ?? 'disabled';
        const toggleLabel = value === 'active' ? '🟢 ON' : '⚪ OFF';
        kb.text(PHASE_SHORT[key] ?? key, `phase:detail:${key}`).text(toggleLabel, `phase:toggle:${key}`).row();
    }
    kb.row().text('🔄 Refresh', 'phase:refresh');
    return kb;
}
/**
 * Build detail keyboard for a single phase.
 * Shows: [🔙 Back] [🟢 Enable] / [⚪ Disable]
 */
function buildPhaseDetailKeyboard(key, currentValue) {
    const kb = new InlineKeyboard();
    const descriptions = {
        PHASE_SUB_PROBLEMS: 'Sub-problem infrastructure (tables + round linkage)',
        PHASE_PROBLEM_DEF: 'Problem validation gate before exploration',
        PHASE_CROSS_LINK: 'Cross-linking responses during gathering',
        PHASE_ITERATION: 'Iteration loop post-exploration',
        PHASE_RICH_SYNTHESIS: 'Richer synthesis output',
        PHASE_MEETING_PREP: 'Meeting preparation brief',
        PHASE_MEETING: 'Meeting transcript integration',
        PHASE_AUTO_UPDATE: 'Auto-update project map post-meeting',
    };
    kb.text(`ℹ️ ${descriptions[key] ?? key}`, 'phase:noop').row();
    kb.text('🔙 Back to all phases', 'phase:back').row();
    if (currentValue === 'active') {
        kb.text('⚪ Disable', `phase:toggle:${key}`);
    }
    else {
        kb.text('🟢 Enable', `phase:toggle:${key}`);
    }
    return kb;
}
// /setphase — show phase control panel
zolaraBot.command('setphase', async (ctx) => {
    const { project } = await resolveAdminProject(ctx.from.id);
    if (!project) {
        await ctx.reply('❌ Admin access required.');
        return;
    }
    const flags = listRuntimeFlags();
    const lines = Object.entries(flags).map(([key, value]) => {
        const icon = value === 'active' ? '🟢' : '⚪';
        return `${icon} *${key}* → ${value}`;
    });
    await ctx.reply(`🔧 *Phase Flags*\n\n${lines.join('\n')}\n\n` +
        `Tap a phase to enable/disable it.`, {
        parse_mode: 'Markdown',
        reply_markup: buildPhaseKeyboard(flags),
    });
});
// Alias
zolaraBot.command('phase', async (ctx) => {
    // Just redirect to /setphase
    const { project } = await resolveAdminProject(ctx.from.id);
    if (!project) {
        await ctx.reply('❌ Admin access required.');
        return;
    }
    const flags = listRuntimeFlags();
    await ctx.reply('🔧 *Phase Flags*\n\nSelect a phase to manage:', {
        parse_mode: 'Markdown',
        reply_markup: buildPhaseKeyboard(flags),
    });
});
// ── Callbacks ─────────────────────────────────────────────────────────────────
zolaraBot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (!data)
        return;
    const userId = ctx.from.id;
    // Admin group confirmation callbacks
    if (data.startsWith('admin:confirm_group:') || data.startsWith('admin:reject_group:')) {
        const { project } = await resolveAdminProject(userId);
        if (!project) {
            await answerCb(ctx, '');
            return;
        }
        await handleAdminGroupCallback(ctx, data, userId, project.id);
        return;
    }
    // Settings callbacks (inline keyboard)
    if (data.startsWith('settings:')) {
        await handleSettingsCallback(ctx, data);
        return;
    }
    // Initiation flow callbacks (admin /create)
    if (data.startsWith('init:')) {
        const state = await loadInitState(userId);
        if (!state) {
            await answerCb(ctx, '');
            return;
        }
        const newState = await handleCallback(ctx, state, data);
        if (!newState)
            return;
        await saveInitState(newState);
        await handleInitiationStep(ctx, newState);
        return;
    }
    // Claim flow callbacks (member commitment)
    if (data.startsWith('claim:')) {
        const state = await loadClaimState(userId);
        if (!state) {
            await answerCb(ctx, '');
            return;
        }
        await handleClaimCallback(ctx, state, data);
        return;
    }
    // Onboarding callbacks (member profile)
    if (data.startsWith('onboard:')) {
        const state = await loadOnboardingState(userId);
        if (!state) {
            await answerCb(ctx, '');
            return;
        }
        await handleOnboardingCallback(ctx, state, data);
        return;
    }
    // Report reaction callbacks (group members reacting to synthesis)
    if (data.startsWith('reaction:')) {
        const [, projectId, roundNumber, reaction] = data.split(':');
        await answerCb(ctx, 'Done');
        // Store reaction in DB
        try {
            const { engagementEvents } = await import('../data/schema/projects');
            const { db } = await import('../data/db');
            const { users, members } = await import('../data/schema/projects');
            const { eq, and } = await import('drizzle-orm');
            // Find member by telegram ID scoped to this project
            const [memberRow] = await db
                .select({ memberId: members.id })
                .from(members)
                .innerJoin(users, eq(members.userId, users.id))
                .where(and(eq(users.telegramId, userId), eq(members.projectId, projectId)))
                .limit(1);
            if (memberRow) {
                await db.insert(engagementEvents).values({
                    memberId: memberRow.memberId,
                    projectId,
                    eventType: 'report_reaction',
                    metadata: {
                        roundNumber: parseInt(roundNumber, 10),
                        reaction,
                        chatId: ctx.chat?.id,
                        messageId: ctx.callbackQuery.message?.message_id,
                    },
                });
            }
        }
        catch (err) {
            console.error('[Reaction] Failed to store reaction:', err);
        }
        return;
    }
    // Problem validation callbacks (Phase 2)
    if (data.startsWith('validate:')) {
        try {
            const { parseValidationCallback, handleVoteCallback, handleTopicCallback } = await import('../engine/phases/phase-2-problem-def/telegram-ui');
            const parsed = parseValidationCallback(data);
            if (!parsed) {
                await answerCb(ctx, '');
                return;
            }
            if (parsed.action === 'vote') {
                const result = await handleVoteCallback(parsed.problemDefinitionId, parsed.vote, userId);
                await answerCb(ctx, result.text, result.alert);
            }
            else if (parsed.action === 'topic') {
                const result = await handleTopicCallback(parsed.problemDefinitionId);
                await answerCb(ctx, result.text, result.alert);
            }
        }
        catch (err) {
            console.error('[Validation] Callback error:', err);
            await answerCb(ctx, '');
        }
        return;
    }
    // Phase flag control callbacks
    if (data.startsWith('phase:')) {
        // Verify admin
        const { project } = await resolveAdminProject(userId);
        if (!project) {
            await answerCb(ctx, '');
            return;
        }
        const parts = data.split(':');
        const action = parts[1];
        if (action === 'refresh' || action === 'back') {
            const flags = listRuntimeFlags();
            await ctx.editMessageReplyMarkup({ reply_markup: buildPhaseKeyboard(flags) });
            await answerCb(ctx, '');
            return;
        }
        if (action === 'detail') {
            const key = parts[2];
            if (!key || !VALID_PHASES.includes(key)) {
                await answerCb(ctx, '');
                return;
            }
            const flags = listRuntimeFlags();
            const value = flags[key] ?? 'disabled';
            await ctx.editMessageReplyMarkup({ reply_markup: buildPhaseDetailKeyboard(key, value) });
            await answerCb(ctx, PHASE_SHORT[key] ?? key);
            return;
        }
        if (action === 'toggle') {
            const key = parts[2];
            if (!key || !VALID_PHASES.includes(key)) {
                await answerCb(ctx, '');
                return;
            }
            const flags = listRuntimeFlags();
            const current = flags[key] ?? 'disabled';
            const next = current === 'active' ? 'disabled' : 'active';
            setRuntimeFlag(key, next);
            const updatedFlags = listRuntimeFlags();
            await ctx.editMessageReplyMarkup({ reply_markup: buildPhaseKeyboard(updatedFlags) });
            const label = PHASE_SHORT[key] ?? key;
            await answerCb(ctx, `✅ ${label} → ${next}`, true);
            return;
        }
        if (action === 'noop') {
            await answerCb(ctx, '');
            return;
        }
        await answerCb(ctx, '');
        return;
    }
    // Project selection callbacks
    if (data.startsWith('project:select:')) {
        const projectId = data.split(':')[2];
        if (!projectId) {
            await answerCb(ctx, '❌ Invalid selection');
            return;
        }
        const { choices } = await resolveAdminProject(userId);
        const valid = choices.find((c) => c.id === projectId);
        if (!valid) {
            await answerCb(ctx, '❌ Project not found');
            return;
        }
        await redis.setex(projectSelectionKey(userId), PROJECT_SELECTION_TTL, projectId);
        await answerCb(ctx, `✅ ${valid.name} selected`, true);
        await ctx.editMessageReplyMarkup({ reply_markup: buildProjectKeyboard(choices, projectId) });
        return;
    }
    // Project management: show detail keyboard (⚙️ button)
    if (data.startsWith('project:manage:')) {
        const projectId = data.split(':')[2];
        if (!projectId) {
            await answerCb(ctx, '❌ Invalid');
            return;
        }
        const [proj] = await db.select({ id: projects.id, name: projects.name, status: projects.status }).from(projects).where(eq(projects.id, projectId)).limit(1);
        if (!proj) {
            await answerCb(ctx, '❌ Project not found');
            return;
        }
        const statusLabel = proj.status === 'active' ? '🟢 Active' : proj.status === 'archived' ? '📦 Archived' : `⚪ ${proj.status}`;
        const escapeHtml = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        await ctx.editMessageText(`<b>${escapeHtml(proj.name)}</b>\n\nStatus: ${statusLabel}\n\nWhat do you want to do?`, { parse_mode: 'HTML', reply_markup: buildProjectManageKeyboard(projectId, proj.status ?? 'pending') });
        await answerCb(ctx, ' ');
        return;
    }
    // Archive a project (30-day soft delete, data preserved)
    if (data.startsWith('project:archive:')) {
        const projectId = data.split(':')[2];
        if (!projectId) {
            await answerCb(ctx, '❌ Invalid');
            return;
        }
        await db.update(projects).set({ status: 'archived', updatedAt: new Date() }).where(eq(projects.id, projectId));
        await suspendProjectAgent(projectId);
        await answerCb(ctx, '📦 Project archived — data kept 30 days', true);
        return;
    }
    // Delete a project (30-day soft delete, data preserved)
    if (data.startsWith('project:delete:')) {
        const projectId = data.split(':')[2];
        if (!projectId) {
            await answerCb(ctx, '❌ Invalid');
            return;
        }
        await db.update(projects).set({ status: 'deleted', updatedAt: new Date() }).where(eq(projects.id, projectId));
        await deleteProjectAgent(projectId);
        await answerCb(ctx, '🗑 Project deleted — data kept 30 days', true);
        return;
    }
    // Restore an archived project
    if (data.startsWith('project:restore:')) {
        const projectId = data.split(':')[2];
        if (!projectId) {
            await answerCb(ctx, '❌ Invalid');
            return;
        }
        await db.update(projects).set({ status: 'active', updatedAt: new Date() }).where(eq(projects.id, projectId));
        await restoreProjectAgent(projectId);
        await answerCb(ctx, '↩️ Project restored', true);
        return;
    }
    // Back to project list
    if (data === 'project:back') {
        const { choices } = await resolveAdminProject(userId);
        if (!choices.length) {
            await answerCb(ctx, 'No projects');
            return;
        }
        const escapeHtml = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const lines = choices.map((p) => `${statusIcon(p.status)} ${escapeHtml(p.name)}`).join('\n');
        await ctx.editMessageText(`<b>Your projects:</b>\n\n${lines}\n\nTap a name to select it. Tap [Settings] to manage.`, { parse_mode: 'HTML', reply_markup: buildProjectKeyboard(choices) });
        await answerCb(ctx, ' ');
        return;
    }
});
async function handleAdminGroupCallback(ctx, data, adminTelegramId, projectId) {
    const action = data.split(':')[1];
    const detectData = await redis.get(`group_detect:${projectId}`);
    if (!detectData) {
        await answerCb(ctx, '');
        return;
    }
    const { groupId, groupTitle } = JSON.parse(detectData);
    if (action === 'confirm') {
        await db.update(projects).set({ groupIds: [groupId] }).where(eq(projects.id, projectId));
        await redis.del(`group_detect:${projectId}`);
        await answerCb(ctx, 'Group set!');
        await ctx.reply(`✅ *Group set!*\n\nRound reports will now be posted to *${groupTitle}*.`, { parse_mode: 'Markdown' });
    }
    else {
        await redis.del(`group_detect:${projectId}`);
        await answerCb(ctx, 'Cancelled');
        await ctx.reply('No problem. When I\'m added to the correct group, I\'ll ask again.');
    }
}
// ── Managed Bot Creation & Group Auto-Detection ────────────────────────────────
// Two distinct events come through my_chat_member:
// 1. managed_bot_created: new bot was created via creation link (chat=private, new_member=bot)
// 2. group_added: admin added @Zolara_bot to a group (chat=group/supergroup)
zolaraBot.on('my_chat_member', async (ctx) => {
    const update = ctx.update;
    const myChatMember = update?.my_chat_member;
    if (!myChatMember)
        return;
    const chat = myChatMember.chat;
    const newMember = myChatMember.new_chat_member;
    const oldStatus = myChatMember.old_chat_member?.status;
    const newStatus = newMember?.status;
    const chatType = chat?.type;
    const fromId = myChatMember.from?.id;
    // EVENT 1: Managed bot created — new bot joins the manager's DM chat
    // Detected by: private chat + new member is a bot + status became 'member'
    if (chatType === 'private' && newMember?.user?.is_bot && newStatus === 'member') {
        const botUser = newMember.user;
        console.log(`[Zolara] Managed bot created: @${botUser.username} (ID: ${botUser.id}) by admin ${fromId}`);
        try {
            // Import and call finalizeProjectBot from the project managed-bots module
            const { finalizeProjectBot } = await import('./managed-bots/creation');
            const { botUsername, projectId } = await finalizeProjectBot(fromId, botUser.id);
            // Get project name for messages
            const [proj] = await db.select({ name: projects.name }).from(projects).where(eq(projects.id, projectId)).limit(1);
            const projectName = proj?.name ?? 'your project';
            // Notify admin
            await ctx.api.sendMessage(fromId, `🎉 Your project bot is ready!\n\n` +
                `Meet @${botUsername} — the dedicated bot for *${projectName}*.\n\n` +
                `Next steps:\n` +
                `1️⃣ Add @${botUsername} to your project's group chat\n` +
                `2️⃣ I'll automatically detect the group and set it as the report destination\n` +
                `3️⃣ Share this invite link with your team members:\n` +
                `👉 https://t.me/${botUsername}?start=claim_${projectId}\n\n` +
                `⏳ Your team coordinator is being set up now — this takes up to 60 seconds.\n` +
                `Run /startround when your team is ready for the first round!`, { parse_mode: 'Markdown' });
        }
        catch (err) {
            console.error('[Zolara] Failed to finalize managed bot:', err);
        }
        return;
    }
    // EVENT 2: @Zolara_bot was added to a group (group auto-detection)
    if (chatType !== 'group' && chatType !== 'supergroup')
        return;
    if (newStatus === 'kicked' || newStatus === 'left')
        return;
    if (oldStatus === 'member' || oldStatus === 'administrator')
        return;
    const groupTitle = chat.title ?? 'this group';
    // Look up pending project by admin telegramId
    let projectId = null;
    let projectName = null;
    if (fromId) {
        const pending = await redis.get(`pending:${fromId}`);
        if (pending) {
            const data = JSON.parse(pending);
            projectId = data.projectId;
            projectName = data.name;
        }
    }
    // Fallback: look up by bot's Telegram ID
    if (!projectId) {
        projectId = await resolveProjectIdFromBot(ctx.me.id);
        if (projectId) {
            const [p] = await db.select({ name: projects.name }).from(projects).where(eq(projects.id, projectId)).limit(1);
            projectName = p?.name ?? 'your project';
        }
    }
    // Still no project found — acknowledge the group
    if (!projectId) {
        await ctx.api.sendMessage(chat.id, `👋 Hi everyone! I'm Zolara — AI consensus engine.\n\n` +
            `Your admin needs to set up a project first via DM to @Zolara_bot (/create).`, { parse_mode: 'Markdown' });
        return;
    }
    // Get the project's bot username for the invite link
    const [projRow] = await db.select({
        botTelegramId: projects.botTelegramId,
    }).from(projects).where(eq(projects.id, projectId)).limit(1);
    let inviteBotUsername = 'Zolara_bot'; // fallback
    if (projRow?.botTelegramId) {
        try {
            const { getManagedBotInfo } = await import('./managed-bots/lifecycle');
            const botInfo = await getManagedBotInfo(projRow.botTelegramId);
            if (botInfo.username)
                inviteBotUsername = botInfo.username;
        }
        catch { /* keep fallback */ }
    }
    // Update the project's group ID
    await db.update(projects).set({ groupIds: [chat.id] }).where(eq(projects.id, projectId));
    // Notify admin in DM
    if (fromId) {
        await redis.del(`pending:${fromId}`);
        await ctx.api.sendMessage(fromId, `✅ *${groupTitle}* set as your report group!\n\n` +
            `You can now share the invite with your team:\n` +
            `👉 https://t.me/${inviteBotUsername}?start=claim_${projectId}\n\n` +
            `Members join → you run /startround → synthesis report posts here.`, { parse_mode: 'Markdown' });
    }
    await ctx.api.sendMessage(chat.id, `👋 *${groupTitle}* is now the report destination for *${projectName}*!\n\n` +
        `Round reports will be posted here when your admin starts a round.`, { parse_mode: 'Markdown' });
});
// ── Managed Bot Created (via deep link) ─────────────────────────────────────
// Telegram sends a message with managed_bot_created: true when user approves
// the bot creation in the BotFather UI
zolaraBot.on('message:managed_bot_created', async (ctx) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const msg = ctx.update.message;
    const managed = msg.managed_bot_created;
    if (!managed?.bot?.is_bot)
        return;
    const botUser = managed.bot;
    const adminTelegramId = ctx.from.id;
    console.log(`[Zolara] Managed bot created: @${botUser.username} (ID: ${botUser.id}) by admin ${adminTelegramId}`);
    try {
        const { finalizeProjectBot } = await import('./managed-bots/creation');
        const { botUsername, projectId } = await finalizeProjectBot(adminTelegramId, botUser.id, botUser.username);
        // Get project name
        const { projects } = await import('../data/schema/projects');
        const { eq } = await import('drizzle-orm');
        const { db } = await import('../data/db');
        const [proj] = await db.select({ name: projects.name }).from(projects).where(eq(projects.id, projectId)).limit(1);
        const projectName = proj?.name ?? 'your project';
        await ctx.reply(`🎉 Your project bot is live!\n\n` +
            `Meet @${botUsername} — the dedicated bot for ${projectName}.\n\n` +
            `Next steps:\n` +
            `1️⃣ Add @${botUsername} to your project's group chat\n` +
            `2️⃣ I'll automatically detect the group and set it as the report destination\n` +
            `3️⃣ Share this invite link with your team members:\n` +
            `👉 https://t.me/${botUsername}?start=claim_${projectId}\n\n` +
            `Run /startround when your team is ready!`);
    }
    catch (err) {
        console.error('[Zolara] Failed to finalize managed bot:', err);
        await ctx.reply('⚠️ Bot created but setup failed. Contact support.');
    }
});
// ── Text messages (non-command) ──────────────────────────────────────────────
zolaraBot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    // Skip for commands (let command handler take over)
    if (text.startsWith('/'))
        return;
    // In groups: respond to @mentions, ignore everything else
    const isGroup = ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';
    if (isGroup) {
        const mentions = ctx.message.entities?.filter(e => e.type === 'text_mention' || e.type === 'mention');
        const hasMention = mentions?.some(e => e.type === 'text_mention' ? e.user?.id === ctx.me.id : true);
        if (!hasMention)
            return;
    }
    const userId = ctx.from.id;
    // Private DM: handle initiation flow text input
    const initState = await loadInitState(userId);
    if (initState) {
        await handleInitiationText(ctx, initState, text);
        return;
    }
    // Member onboarding text input (role, interests steps)
    const onboardState = await loadOnboardingState(userId);
    if (onboardState) {
        const updated = await handleOnboardingText(ctx, onboardState, text);
        if (updated) {
            await saveOnboardingState(updated);
        }
        return;
    }
    // Settings reply (admin typing a new value in the interactive settings flow)
    await handleSettingsReply(ctx);
    // Question answering session (member replying to a DM question from a round)
    const qState = await redis.get(`q:${userId}`);
    if (qState) {
        const { questionId, roundId, projectId } = JSON.parse(qState);
        await redis.del(`q:${userId}`);
        await saveResponse(userId, projectId, roundId, questionId, text);
        await ctx.reply('✅ Received! Your perspective has been recorded.\n\n' +
            'The synthesis will be posted to your group when the round closes.', { parse_mode: 'Markdown' });
        return;
    }
    // AI help for non-command messages (interpret natural language)
    console.log('[MessageText] userId=', userId, 'text=', text.substring(0, 100));
    await handleAIHelp(ctx, userId, text);
});
// ── Member Claim Flow ──────────────────────────────────────────────────────────
async function handleMemberClaim(ctx, userId, projectId) {
    const [project] = await db.select({ id: projects.id, name: projects.name, config: projects.config }).from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!project) {
        await ctx.reply('⚠️ This project link is invalid or has expired. Ask your admin for a new invite link.');
        return;
    }
    // Check if already committed
    const [existing] = await db
        .select({ onboardingStatus: members.onboardingStatus })
        .from(members)
        .innerJoin(users, eq(members.userId, users.id))
        .where(and(eq(members.projectId, projectId), eq(users.telegramId, userId)))
        .limit(1);
    if (existing && existing.onboardingStatus === 'committed') {
        await ctx.reply(`✅ You're already committed to *${project.name}*.\n\nA round will start soon. I'll DM you when it does.`, { parse_mode: 'Markdown' });
        return;
    }
    const projectConfig = project.config ?? {};
    const anonymity = projectConfig['anonymity'] ?? 'optional';
    const state = { phase: 'claim', projectId, projectName: project.name ?? 'this project', telegramId: userId, claimStartedAt: new Date().toISOString(), anonymity };
    await saveClaimState(state);
    await handleClaimWelcome(ctx, state);
}
// ── Question detection patterns ─────────────────────────────────────────────────
const question_patterns = ['what', 'how', 'why', 'when', 'where', 'who', 'which', 'should', 'could', 'can ', 'is ', 'do ', 'does ', 'want', 'tell', 'explain', '?'];
// ── Initiation text handling ──────────────────────────────────────────────────
async function handleInitiationText(ctx, state, text) {
    // Detect if user is asking a question vs providing an answer to the flow
    const lower = text.trim().toLowerCase();
    const isQuestion = question_patterns.some((q) => lower.startsWith(q)) || text.trim().endsWith('?');
    if (isQuestion) {
        // Route to AI help — answer the question without advancing the flow
        await handleAIHelp(ctx, state.telegramId, text);
        return;
    }
    switch (state.step) {
        case 'project_name': {
            if (text.trim().length < 2) {
                await ctx.reply('Please enter at least 2 characters.');
                return;
            }
            state.config = { ...state.config, name: text.trim() };
            state.step = nextStep(state.step);
            await saveInitState(state);
            await handleInitiationStep(ctx, state);
            break;
        }
        case 'project_goal': {
            if (text.trim().length < 10) {
                await ctx.reply('Could you elaborate a bit more? I need to understand this well.');
                return;
            }
            state.config = { ...state.config, description: text.trim() };
            state.step = nextStep(state.step);
            await saveInitState(state);
            await handleInitiationStep(ctx, state);
            break;
        }
        default:
            await handleInitiationStep(ctx, state);
    }
}
// ── Response saving ───────────────────────────────────────────────────────────
async function saveResponse(userId, projectId, roundId, questionId, text) {
    const { responses, members, users } = await import('../data/schema/projects');
    try {
        // Look up the actual database member ID from the Telegram user ID
        const [memberRow] = await db
            .select({ memberId: members.id })
            .from(members)
            .innerJoin(users, eq(members.userId, users.id))
            .where(and(eq(users.telegramId, userId), eq(members.projectId, projectId)))
            .limit(1);
        if (!memberRow) {
            dbLog.insertFailed('responses', { userId, projectId, reason: 'member_not_found' }, new Error('Member not found'));
            return;
        }
        await db.insert(responses).values({
            questionId: questionId,
            memberId: memberRow.memberId,
            responseText: text.slice(0, 5000),
            createdAt: new Date(),
        });
    }
    catch (err) {
        dbLog.insertFailed('responses', { userId, projectId }, err);
    }
}
// ── Helpers ───────────────────────────────────────────────────────────────────
async function resolveProjectIdFromBot(botTelegramId) {
    const [p] = await db.select({ id: projects.id }).from(projects).where(eq(projects.botTelegramId, botTelegramId)).limit(1);
    return p?.id ?? null;
}
// ── Onboarding callback stub ──────────────────────────────────────────────────
async function handleOnboardingCallback(ctx, state, data) {
    await answerCb(ctx, '');
}
// ── Exports ───────────────────────────────────────────────────────────────────
export async function handleZolaraWebhook(update) {
    await zolaraBot.handleUpdate(update);
}
/**
 * Handle incoming updates from a managed project bot (via webhook).
 * Creates a scoped Bot instance for the project and processes the update.
 *
 * @param update Raw Telegram update
 * @param projectId Project context for this bot
 * @param botToken Decrypted bot token for this project (null = Zolara control bot)
 */
export async function handleProjectBotUpdate(update, projectId, botToken) {
    // Import the project bot dynamically to avoid circular deps
    // The project bot is created fresh per-project using its own token
    const { createProjectBot } = await import('./managed-bots/bot-instance');
    const botInstance = await createProjectBot(botToken, projectId);
    await botInstance.handleUpdate(update);
}
export async function startZolaraPolling() {
    console.log('[Zolara] Starting polling — @Zolara_bot is live!');
    // Start nudge reminder scheduler — checks every 30 minutes for rounds needing reminders
    scheduleNudgeReminders();
    await zolaraBot.start();
}
/**
 * Periodically check active gathering rounds and send nudge reminders to non-responding members.
 */
async function scheduleNudgeReminders() {
    const CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
    const check = async () => {
        try {
            await checkAndSendNudges();
        }
        catch (err) {
            console.error('[NudgeScheduler] Error:', err);
        }
    };
    // Run immediately on startup, then on interval
    await check();
    setInterval(check, CHECK_INTERVAL_MS);
}
async function checkAndSendNudges() {
    const { rounds, members, users, questions, responses } = await import('../data/schema/projects');
    const { db } = await import('../data/db');
    const { eq } = await import('drizzle-orm');
    const { sendReminderDM } = await import('../util/telegram-sender');
    const { redis } = await import('../data/redis');
    // Find gathering rounds that started more than nudgeAfterHours ago
    const activeRounds = await db
        .select()
        .from(rounds)
        .where(eq(rounds.status, 'gathering'))
        .limit(10);
    for (const round of activeRounds) {
        if (!round.startedAt)
            continue;
        const config = round.metadata;
        const nudgeAfterHours = config['nudgeAfterHours'] ?? 24;
        const nudgeAfterMs = nudgeAfterHours * 60 * 60 * 1000;
        const shouldNudge = Date.now() - new Date(round.startedAt).getTime() > nudgeAfterMs;
        if (!shouldNudge)
            continue;
        // Check if we've already nudged this round (store nudge count in redis)
        const nudgeKey = `nudge:${round.id}`;
        const nudgeCount = parseInt(await redis.get(nudgeKey) ?? '0', 10);
        if (nudgeCount >= 3) {
            // Max nudges reached — cancel the round
            await db.update(rounds).set({ status: 'cancelled' }).where(eq(rounds.id, round.id));
            await redis.del(nudgeKey);
            console.log(`[NudgeScheduler] Round ${round.id} cancelled — max nudges reached`);
            continue;
        }
        // Find members' telegram IDs (join members → users to get telegramId)
        // Only nudge members who have NOT yet responded
        const respondedMemberIds = await db
            .select({ memberId: responses.memberId })
            .from(responses)
            .innerJoin(questions, eq(responses.questionId, questions.id))
            .where(eq(questions.roundId, round.id))
            .limit(500);
        const respondedIds = new Set(respondedMemberIds.map((r) => r.memberId));
        const membersResult = await db
            .select({ telegramId: users.telegramId, memberId: members.id })
            .from(members)
            .innerJoin(users, eq(members.userId, users.id))
            .where(eq(members.projectId, round.projectId))
            .limit(100);
        for (const member of membersResult) {
            // Skip members who have already responded
            if (!member.telegramId || respondedIds.has(member.memberId))
                continue;
            if (!round.projectId)
                continue;
            await sendReminderDM(round.projectId, member.telegramId, round.roundNumber ?? 1, nudgeCount + 1);
        }
        // Increment nudge count
        await redis.setex(nudgeKey, 86400 * 3, String(nudgeCount + 1));
        console.log(`[NudgeScheduler] Sent nudge ${nudgeCount + 1} for round ${round.id}`);
    }
}
