import { Bot } from 'grammy';
import { config } from '../config';
import { llm } from '../engine/llm/minimax';
import { redis } from '../data/redis';
import { nextStep, } from './flows/initiation-state';
import { handleInitiationStep, handleCallback, } from './flows/initiation-steps';
import { warn, managed as managedLog, llm as llmLog } from '../util/logger';
import { handleProjectsCommand, handleStartRoundCommand, handleCancelRoundCommand, handleMembersCommand, handleInviteCommand, handleAdminGroupCallback, resolveActiveProject, } from './admin-commands';
const managerBot = new Bot(config.ZOLARA_BOT_TOKEN);
// ── State helpers ─────────────────────────────────────────────────────────────
async function loadState(telegramId) {
    const raw = await redis.get(`init:${telegramId}`);
    return raw ? JSON.parse(raw) : null;
}
async function saveState(state) {
    await redis.setex(`init:${state.telegramId}`, 86400, JSON.stringify(state));
}
async function clearState(telegramId) {
    await redis.del(`init:${telegramId}`);
}
// ── Commands ─────────────────────────────────────────────────────────────────
managerBot.command('start', async (ctx) => {
    await ctx.reply('🌀 *Zolara* — AI Consensus Engine\n\n' +
        'I help teams find alignment through structured 1-on-1 perspective gathering.\n\n' +
        '/create — Set up a new project bot for your team\n' +
        '/projects — View your active projects\n' +
        '/help — Learn more', { parse_mode: 'Markdown' });
});
managerBot.command('help', async (ctx) => {
    await ctx.reply('*How Zolara Works*\n\n' +
        '1️⃣ *Create* a project bot for your team\n' +
        '2️⃣ *Invite* members to chat with the bot 1-on-1\n' +
        '3️⃣ *Start a round* to gather perspectives\n' +
        '4️⃣ *Receive* an AI synthesis report\n' +
        '5️⃣ *Deepen* alignment through follow-up rounds', { parse_mode: 'Markdown' });
});
managerBot.command('create', async (ctx) => {
    const userId = ctx.from.id;
    const state = {
        step: 'greeting',
        config: {},
        telegramId: userId,
        createdAt: new Date().toISOString(),
    };
    await saveState(state);
    await handleInitiationStep(ctx, state);
});
managerBot.command('cancel', async (ctx) => {
    const userId = ctx.from.id;
    const existing = await loadState(userId);
    if (existing) {
        await clearState(userId);
        await ctx.reply('❌ Cancelled. Use /create to start fresh.');
    }
    else {
        await ctx.reply('Nothing to cancel.');
    }
});
// ── Admin project commands ────────────────────────────────────────────────────
managerBot.command('projects', async (ctx) => {
    await handleProjectsCommand(ctx);
});
managerBot.command('startround', async (ctx) => {
    await handleStartRoundCommand(ctx, ctx.match);
});
managerBot.command('cancelround', async (ctx) => {
    await handleCancelRoundCommand(ctx);
});
managerBot.command('members', async (ctx) => {
    await handleMembersCommand(ctx);
});
managerBot.command('invite', async (ctx) => {
    await handleInviteCommand(ctx);
});
// ── Managed Bot Creation ──────────────────────────────────────────────────────
// Handle when a managed bot is created via the creation link.
// Telegram sends my_chat_member update when the new bot joins the manager's chat.
managerBot.on('my_chat_member', async (ctx) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const update = ctx.update;
    const myChatMember = update.my_chat_member;
    // Only care about bot users being added
    if (!myChatMember?.new_chat_member?.user?.is_bot)
        return;
    // Only care about the new bot being the managed bot (status changed to "member")
    if (myChatMember.new_chat_member.status !== 'member')
        return;
    const botUser = myChatMember.new_chat_member.user;
    const adminTelegramId = myChatMember.from.id;
    console.log(`[Manager] Detected managed bot creation: @${botUser.username} (ID: ${botUser.id}) by admin ${adminTelegramId}`);
    try {
        // Look up the pending project for this admin
        const pendingData = await redis.get(`pending:${adminTelegramId}`);
        if (!pendingData) {
            warn('managed', 'PENDING_NOT_FOUND', `No pending project for admin ${adminTelegramId}`, { telegramId: adminTelegramId });
            return;
        }
        const pending = JSON.parse(pendingData);
        // Finalize the project bot
        const { finalizeProjectBot } = await import('./managed-bots');
        const { botUsername } = await finalizeProjectBot(adminTelegramId, botUser.id);
        // Notify the admin
        await ctx.api.sendMessage(adminTelegramId, `🎉 Your bot is live!\n\n` +
            `Meet @${botUsername} — your project's dedicated assistant.\n\n` +
            `Here's what to do next:\n\n` +
            `1️⃣ Start a chat with @${botUsername} — it'll recognize you as admin\n` +
            `2️⃣ Add it to your group's chat\n` +
            `3️⃣ Share this invitation link with your team members:\n` +
            `👉 https://t.me/${botUsername}?start=claim_${pending.projectId}\n\n` +
            `Have a great deliberation! 🌀`);
        // Clean up pending state
        await redis.del(`pending:${adminTelegramId}`);
        await redis.del(pending.pendingKey);
        console.log(`[Manager] Project ${pending.projectId} finalized with bot @${botUsername}`);
    }
    catch (err) {
        managedLog.botInfoFailed(botUser.id, { telegramId: adminTelegramId }, err);
    }
});
// ── Callback queries ─────────────────────────────────────────────────────────
managerBot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (!data)
        return;
    const userId = ctx.from.id;
    // Project selector callbacks (from /projects, /startround, /invite, /settings, /members)
    if (data.startsWith('proj:') || data.startsWith('round_proj:') || data.startsWith('invite_proj:') || data.startsWith('settings_proj:') || data.startsWith('members_proj:')) {
        const projectId = data.split(':')[1];
        const { setActiveProject } = await import('./project-selector');
        await setActiveProject(userId, projectId);
        // Get project name for feedback
        const { getAdminProjects } = await import('./project-selector');
        const projects = await getAdminProjects(userId);
        const selected = projects.find((p) => p.id === projectId);
        const projectName = selected?.name ?? 'project';
        await ctx.answerCallbackQuery(`Active project set to ${projectName}`);
        // After selection, show confirmation with next steps
        const prefix = data.split(':')[0];
        if (prefix === 'settings_proj') {
            await ctx.answerCallbackQuery(`Settings for ${projectName}`);
            const { handleSettingsCommand } = await import('./admin-management');
            // Call settings for the selected project
            const { setActiveProject } = await import('./project-selector');
            await setActiveProject(userId, projectId);
            await handleSettingsCommand(ctx);
            return;
        }
        if (prefix === 'members_proj') {
            await ctx.answerCallbackQuery(`Members of ${projectName}`);
            const { setActiveProject } = await import('./project-selector');
            await setActiveProject(userId, projectId);
            const { handleMembersCommand } = await import('./admin-commands');
            await handleMembersCommand(ctx);
            return;
        }
        if (prefix === 'round_proj') {
            await ctx.editMessageText(`✅ *${projectName}* selected

` +
                `Now send the round topic as a message, e.g.:
` +
                `/startround Our Q3 strategy planning`);
        }
        else if (prefix === 'invite_proj') {
            const { handleInviteCommand } = await import('./admin-commands');
            // Re-trigger invite command with selected project
            await ctx.answerCallbackQuery(`Invite link for ${projectName} — check the updated message.`);
            // Show the invite
            const link = `https://t.me/${selected?.botUsername ?? 'Zolara_bot'}?start=claim_${projectId}`;
            await ctx.editMessageText(`*${projectName} — Invite Link*

` +
                `Share this with your team members:

` +
                `${link}

` +
                `Members tap the link — "Yes, I'm in" — they receive questions when rounds start.`);
        }
        else {
            await ctx.editMessageText(`✅ *${projectName}* is now your active project.

` +
                `Run /startround, /members, /invite, or /settings to manage it.`);
        }
        return;
    }
    // Admin group confirmation callbacks
    if (data.startsWith('admin:confirm_group:') || data.startsWith('admin:reject_group:')) {
        const { project } = await resolveActiveProject(userId);
        if (!project) {
            await ctx.answerCallbackQuery('No project found.');
            return;
        }
        await handleAdminGroupCallback(ctx, data, userId);
        return;
    }
    // Initiation callbacks
    if (!data.startsWith('init:'))
        return;
    const state = await loadState(userId);
    if (!state) {
        await ctx.answerCallbackQuery('Session expired. Use /create to start again.');
        return;
    }
    const newState = await handleCallback(ctx, state, data);
    if (!newState)
        return; // Cancelled
    await saveState(newState);
    await handleInitiationStep(ctx, newState);
});
// ── Text messages ─────────────────────────────────────────────────────────────
managerBot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    const userId = ctx.from.id;
    if (text.startsWith('/'))
        return;
    const state = await loadState(userId);
    if (!state) {
        // Free chat mode
        await handleFreeChat(ctx);
        return;
    }
    switch (state.step) {
        case 'project_name': {
            const name = text.trim();
            if (name.length < 2) {
                await ctx.reply('Please enter at least 2 characters for the project name.');
                return;
            }
            state.config = { ...state.config, name };
            state.step = nextStep(state.step);
            await saveState(state);
            await handleInitiationStep(ctx, state);
            break;
        }
        case 'project_goal': {
            const goal = text.trim();
            if (goal.length < 10) {
                await ctx.reply('Could you elaborate a bit more? I need to understand this well.');
                return;
            }
            state.config = { ...state.config, description: goal };
            state.step = nextStep(state.step);
            await saveState(state);
            await handleInitiationStep(ctx, state);
            break;
        }
        default:
            await handleInitiationStep(ctx, state);
    }
});
// ── Free chat ─────────────────────────────────────────────────────────────────
async function handleFreeChat(ctx) {
    const text = ctx.message.text;
    const userName = ctx.from?.first_name ?? 'Friend';
    const typingMsgId = await ctx.reply('🌀 Thinking...', {
        reply_to_message_id: ctx.message.message_id,
    });
    try {
        const response = await llm.generate({
            systemPrompt: `You are Zolara, an AI assistant for the Zolara consensus engine on Telegram.
Zolara helps teams build alignment through structured 1-on-1 conversations and AI synthesis.
Be helpful, concise, and friendly. Answer questions about consensus building, group facilitation, and the Zolara platform.
IMPORTANT: Always use plain text in responses. Do NOT use Markdown formatting, asterisks for bold, backticks for code, or brackets for links. Plain text only.`,
            userPrompt: text,
            temperature: 0.7,
            maxTokens: 1024,
        });
        await ctx.api.deleteMessage(ctx.me.id, typingMsgId.message_id).catch(() => { });
        // Strip any markdown that could break Telegram entity parsing
        const safeText = response.text.replace(/[*_`[\]]/g, '').slice(0, 4096);
        await ctx.reply(safeText, {
            reply_to_message_id: ctx.message.message_id,
        });
    }
    catch (err) {
        llmLog.generationFailed({ userId: ctx.from?.id }, err);
        await ctx.api.deleteMessage(ctx.me.id, typingMsgId.message_id).catch(() => { });
        await ctx.reply('⚠️ Sorry, I ran into an issue. Please try again.');
    }
}
// ── Exports ──────────────────────────────────────────────────────────────────
export async function handleManagerWebhook(update) {
    await managerBot.handleUpdate(update);
}
export async function startManagerPolling() {
    console.log('[Manager] Starting polling — Builder Bot is live!');
    await managerBot.start();
}
export { managerBot };
