/**
 * Zolara Bot — consolidated single bot handler
 * Handles both admin commands and member interactions on @Zolara_bot
 *
 * Admin flow: /create, /startround, /cancelround, /projects, /members, /invite, /status
 * Member flow: /start claim_xxx → commitment → onboarding → question answering
 */
import { Bot } from 'grammy';
import { config } from '../config';
import { redis } from '../data/redis';
import { db } from '../data/db';
import { projects, admins, members, rounds } from '../data/schema/projects';
import { eq, desc, and } from 'drizzle-orm';
import { db as dbLog } from '../util/logger';
import { triggerRound, cancelRound } from '../engine/round-manager';
import { nextStep, } from './flows/initiation-state';
import { handleInitiationStep, handleCallback, } from './flows/initiation-steps';
import { handleClaimWelcome, handleClaimCallback, loadClaimState, saveClaimState, clearClaimState, } from './flows/claim-steps';
import { loadOnboardingState, clearOnboardingState, } from './flows/onboarding-steps';
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
        '5️⃣ *Deepen* alignment through follow-up rounds', { parse_mode: 'Markdown' });
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
async function resolveAdminProject(adminTelegramId) {
    const rows = await db
        .select({ id: projects.id, name: projects.name, status: projects.status })
        .from(projects)
        .innerJoin(admins, eq(admins.id, projects.adminId))
        .where(eq(admins.telegramId, adminTelegramId))
        .orderBy(desc(projects.createdAt))
        .limit(10);
    if (rows.length === 0)
        return { project: null, hasMultiple: false, choices: [] };
    const active = rows.filter((r) => r.status === 'active');
    const first = active[0] ?? rows[0];
    const project = {
        id: first.id,
        name: first.name ?? 'Unknown',
        status: first.status ?? 'pending',
    };
    return {
        project,
        hasMultiple: rows.length > 1,
        choices: rows.map((r) => ({ id: r.id, name: r.name ?? 'Unknown', status: r.status ?? 'pending' })),
    };
}
zolaraBot.command('projects', async (ctx) => {
    const { project, hasMultiple, choices } = await resolveAdminProject(ctx.from.id);
    if (!project) {
        await ctx.reply("You don't have any projects yet.\n\nUse /create to set one up.");
        return;
    }
    if (hasMultiple) {
        const lines = choices.map((c, i) => `${i + 1}. *${c.name}* — ${c.status}`).join('\n');
        await ctx.reply(`*Your projects:*\n\n${lines}\n\nCurrently selected: *${project.name}*\n\nUse /startround, /cancelround, or /members on the selected project.`);
        return;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const [round] = await db.select({ id: rounds.id, roundNumber: rounds.roundNumber, status: rounds.status }).from(rounds).where(eq(rounds.projectId, project.id)).limit(1);
    const status = round ? `Round #${round.roundNumber} — *${round.status}*` : 'No active round';
    await ctx.reply(`*${project.name}*\n\nStatus: ${project.status}\nCurrent round: ${status}`, { parse_mode: 'Markdown' });
});
zolaraBot.command('startround', async (ctx) => {
    const telegramId = ctx.from.id;
    const { project, hasMultiple } = await resolveAdminProject(telegramId);
    if (!project) {
        await ctx.reply("You don't have any projects yet. Use /create to set one up.");
        return;
    }
    const topic = ctx.match.trim() || 'General check-in';
    try {
        const { roundId } = await triggerRound(project.id, topic);
        await ctx.reply(`🎯 *Round started!*\n\nProject: *${project.name}*\nTopic: ${topic}\nRound ID: ${roundId.slice(0, 8)}...\n\nCommitted members are being sent questions via DM.`, { parse_mode: 'Markdown' });
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
    const [p] = await db.select({ botTelegramId: projects.botTelegramId }).from(projects).where(eq(projects.id, project.id)).limit(1);
    // Use a placeholder — the invite link uses bot username which we store in DB after creation
    const inviteLink = `https://t.me/Zolara_bot?start=claim_${project.id}`;
    await ctx.reply(`*${project.name} — Invite Link*\n\nShare this with your team:\n\n${inviteLink}\n\nMembers tap → "Yes, I'm in" → they can receive questions when rounds start.`, { parse_mode: 'Markdown' });
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
            await ctx.answerCallbackQuery('No project found.');
            return;
        }
        await handleAdminGroupCallback(ctx, data, userId, project.id);
        return;
    }
    // Initiation flow callbacks (admin /create)
    if (data.startsWith('init:')) {
        const state = await loadInitState(userId);
        if (!state) {
            await ctx.answerCallbackQuery('Session expired. Use /create to start again.');
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
            await ctx.answerCallbackQuery('Session expired. Send /start to begin again.');
            return;
        }
        await handleClaimCallback(ctx, state, data);
        return;
    }
    // Onboarding callbacks (member profile)
    if (data.startsWith('onboard:')) {
        const state = await loadOnboardingState(userId);
        if (!state) {
            await ctx.answerCallbackQuery('Session expired. Send /start to begin again.');
            return;
        }
        await handleOnboardingCallback(ctx, state, data);
        return;
    }
});
async function handleAdminGroupCallback(ctx, data, adminTelegramId, projectId) {
    const action = data.split(':')[1];
    const detectData = await redis.get(`group_detect:${projectId}`);
    if (!detectData) {
        await ctx.answerCallbackQuery('Session expired.');
        return;
    }
    const { groupId, groupTitle } = JSON.parse(detectData);
    if (action === 'confirm') {
        await db.update(projects).set({ groupIds: [groupId] }).where(eq(projects.id, projectId));
        await redis.del(`group_detect:${projectId}`);
        await ctx.answerCallbackQuery(`✅ Reports will go to ${groupTitle}`);
        await ctx.reply(`✅ *Group set!*\n\nRound reports will now be posted to *${groupTitle}*.`, { parse_mode: 'Markdown' });
    }
    else {
        await redis.del(`group_detect:${projectId}`);
        await ctx.answerCallbackQuery('Dismissed.');
        await ctx.reply('No problem. When I\'m added to the correct group, I\'ll ask again.');
    }
}
// ── Member: /start with claim_ routing ───────────────────────────────────────
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
    // Regular /start
    await ctx.reply('🏠 *Welcome to Zolara*\n\n' +
        'Your team\'s AI consensus engine.\n\n' +
        '/help — Learn more\n' +
        '/status — Current round status\n' +
        '/profile — Your member profile', { parse_mode: 'Markdown' });
});
// ── Group Auto-Detection ───────────────────────────────────────────────────────
zolaraBot.on('my_chat_member', async (ctx) => {
    const update = ctx.update;
    const myChatMember = update?.my_chat_member;
    if (!myChatMember)
        return;
    const chat = myChatMember.chat;
    const oldStatus = myChatMember.old_chat_member?.status;
    const newStatus = myChatMember.new_chat_member?.status;
    const chatType = chat?.type;
    const adminTelegramId = myChatMember.from?.id;
    // Only care about groups being added
    if (chatType !== 'group' && chatType !== 'supergroup')
        return;
    if (newStatus === 'kicked' || newStatus === 'left')
        return;
    if (oldStatus === 'member' || oldStatus === 'administrator')
        return;
    const groupTitle = chat.title ?? 'this group';
    // Check if this is a pending project (admin just completed /create)
    let projectId = null;
    let projectName = null;
    if (adminTelegramId) {
        const pending = await redis.get(`project_pending:${adminTelegramId}`);
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
    // Still no project found — just acknowledge the group
    if (!projectId) {
        await ctx.api.sendMessage(chat.id, `👋 Hi everyone! I'm Zolara — AI consensus engine.\n\n` +
            `Your admin needs to set up a project first via DM to @Zolara_bot (/create).`, { parse_mode: 'Markdown' });
        return;
    }
    // Update the project's group ID
    await db.update(projects).set({ groupIds: [chat.id] }).where(eq(projects.id, projectId));
    // Notify admin
    const admin = await db.select({ telegramId: admins.telegramId }).from(admins).limit(1).then(r => r[0]);
    if (admin) {
        await redis.del(`project_pending:${adminTelegramId}`);
        await ctx.api.sendMessage(admin.telegramId, `✅ *${groupTitle}* set as your report group!\n\n` +
            `You can now share the invite with your team:\n` +
            `👉 https://t.me/Zolara_bot?start=claim_${projectId}\n\n` +
            `Members join → you run /startround → synthesis report posts here.`, { parse_mode: 'Markdown' });
    }
    await ctx.api.sendMessage(chat.id, `👋 *${groupTitle}* is now the report destination for *${projectName}*!\n\n` +
        `Round reports will be posted here when your admin starts a round.`, { parse_mode: 'Markdown' });
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
    // Fallback for DMs only — basic help prompt
    // (No free chat; keep Zolara focused on the structured process)
    await ctx.reply('👋 I\'m here to help with the Zolara consensus process.\n\n' +
        '/help — See available commands\n' +
        '/create — Set up a project', { parse_mode: 'Markdown' });
});
// ── Member Claim Flow ──────────────────────────────────────────────────────────
async function handleMemberClaim(ctx, userId, projectId) {
    const [project] = await db.select({ id: projects.id, name: projects.name }).from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!project) {
        await ctx.reply('⚠️ This project link is invalid or has expired. Ask your admin for a new invite link.');
        return;
    }
    // Check if already committed
    const [existing] = await db
        .select({ onboardingStatus: members.onboardingStatus })
        .from(members)
        .where(and(eq(members.projectId, projectId), eq(members.userId, userId)))
        .limit(1);
    if (existing && existing.onboardingStatus === 'committed') {
        await ctx.reply(`✅ You're already committed to *${project.name}*.\n\nA round will start soon. I'll DM you when it does.`, { parse_mode: 'Markdown' });
        return;
    }
    const state = { phase: 'claim', projectId, projectName: project.name ?? 'this project', telegramId: userId, claimStartedAt: new Date().toISOString() };
    await saveClaimState(state);
    await handleClaimWelcome(ctx, state);
}
// ── Initiation text handling ──────────────────────────────────────────────────
async function handleInitiationText(ctx, state, text) {
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
    const { responses } = await import('../data/schema/projects');
    try {
        await db.insert(responses).values({
            questionId: questionId,
            memberId: userId,
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
    await ctx.answerCallbackQuery('Onboarding in progress...');
}
// ── Exports ───────────────────────────────────────────────────────────────────
export async function handleZolaraWebhook(update) {
    await zolaraBot.handleUpdate(update);
}
export async function startZolaraPolling() {
    console.log('[Zolara] Starting polling — @Zolara_bot is live!');
    await zolaraBot.start();
}
