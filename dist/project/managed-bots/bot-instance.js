/**
 * Per-project bot instance factory.
 *
 * Creates a grammY Bot instance scoped to a specific project.
 * Each project has its own Telegram bot token, so messages from that bot
 * are routed to the correct project context.
 *
 * The bot handles:
 * - Member claim (/start with deep link)
 * - Onboarding flow
 * - Question answering (DMs from members)
 * - Report reactions
 */
import { Bot } from 'grammy';
import { llm } from '../../engine/llm/minimax';
import { config } from '../../config';
import { db } from '../../data/db';
import { projects, members, users, rounds, responses } from '../../data/schema/projects';
import { eq, and, desc } from 'drizzle-orm';
import { redis } from '../../data/redis';
import { nextOnboardingStep, } from '../flows/onboarding-state';
import { handleOnboardingStep, loadOnboardingState, saveOnboardingState, clearOnboardingState, restartOnboardingState, handleOnboardingCallback, } from '../flows/onboarding-steps';
import { handleClaimWelcome, handleClaimCallback, loadClaimState, saveClaimState, clearClaimState } from '../flows/claim-steps';
// Map: projectId → cached Bot instance
const botCache = new Map();
/**
 * Create or get a cached Bot instance for a project.
 * Bot is created with the project's own token (or fallback to Zolara token for control bot).
 */
export async function createProjectBot(botToken, projectId) {
    const cacheKey = projectId;
    const token = botToken ?? config.ZOLARA_BOT_TOKEN;
    if (botCache.has(cacheKey)) {
        return botCache.get(cacheKey);
    }
    const bot = new Bot(token);
    // Ensure bot is initialized (fetches /getMe so handleUpdate works)
    try {
        await bot.init();
    }
    catch (e) { /* token may be invalid */ }
    // All message handling is per-project — we already know the projectId
    wireProjectBotHandlers(bot, projectId);
    botCache.set(cacheKey, bot);
    return bot;
}
/**
 * Wire up all handlers for a project-specific bot.
 */
function wireProjectBotHandlers(bot, projectId) {
    // /help command for project bots
    bot.command('help', async (ctx) => {
        await ctx.reply('*Zolara Project Bot*\n\n' +
            'Use this bot to join your team\'s consensus rounds.\n\n' +
            '1. Tap *Start* or send /start to join\n' +
            '2. Complete onboarding\n' +
            '3. Answer questions when a round is active\n' +
            '4. React to synthesis reports in your group\n\n' +
            'Questions? Ask your admin or type them here.', { parse_mode: 'Markdown' });
    });
    // /restart_onboarding — safe reset for members who want to redo their profile
    bot.command('restart_onboarding', async (ctx) => {
        const userId = ctx.from.id;
        const state = await restartOnboardingState(userId, projectId);
        await clearClaimState(userId);
        if (!state) {
            await ctx.reply('I could not find your membership for this project yet. Please use your project invite link first.');
            return;
        }
        await ctx.reply('🔄 Restarting onboarding. I cleared your in-progress onboarding answers for this project.');
        await handleOnboardingStep(ctx, state);
    });
    // /my_status — concise personal state for members
    bot.command('my_status', async (ctx) => {
        const userId = ctx.from.id;
        const [user] = await db
            .select({ id: users.id })
            .from(users)
            .where(eq(users.telegramId, userId))
            .limit(1);
        const [member] = user
            ? await db
                .select({ onboardingStatus: members.onboardingStatus, role: members.role, projectProfile: members.projectProfile })
                .from(members)
                .where(and(eq(members.projectId, projectId), eq(members.userId, user.id)))
                .limit(1)
            : [];
        const qStateRaw = await redis.get(`q:${userId}`);
        const [round] = await db
            .select({ roundNumber: rounds.roundNumber, status: rounds.status, topic: rounds.topic, responseCount: rounds.responseCount, memberCount: rounds.memberCount })
            .from(rounds)
            .where(eq(rounds.projectId, projectId))
            .orderBy(desc(rounds.startedAt))
            .limit(1);
        const onboarding = member?.onboardingStatus === 'complete' ? '✅ Complete' : '⏳ Not complete';
        const activeQuestion = qStateRaw ? '✅ Waiting for your answer' : '— None right now';
        const roundText = round
            ? `#${round.roundNumber} — ${round.status ?? 'unknown'}\nTopic: ${round.topic ?? '—'}\nResponses: ${round.responseCount ?? 0}/${round.memberCount ?? 0}`
            : 'No round yet';
        await ctx.reply(`*Your Zolara status*\n\n` +
            `Onboarding: ${onboarding}\n` +
            `Role: ${member?.role ?? '—'}\n` +
            `Active question: ${activeQuestion}\n\n` +
            `*Latest round*\n${roundText}`, { parse_mode: 'Markdown' });
    });
    // /start — member claim flow (deep link)
    // Use message:text with explicit check instead of bot.command() because:
    // - Telegram deep-link args don't always include bot_command entity
    // - bot.command() silently drops messages without entity, breaking claim flow
    bot.on('message:text', async (ctx) => {
        const text = ctx.message?.text ?? '';
        if (!text)
            return;
        if (text.startsWith('/start')) {
            const args = text.replace(/^\/start\s*/, '').trim();
            if (args.startsWith('claim_')) {
                const targetProjectId = args.replace('claim_', '');
                await handleMemberClaimForProject(ctx, targetProjectId);
                return;
            }
            else {
                await handlePlainStartForProject(ctx, projectId);
                return;
            }
        }
        // Text messages (onboarding replies, question answers)
        const userId = ctx.from.id;
        // Check for ongoing onboarding
        const onboardState = await loadOnboardingState(userId);
        if (onboardState && onboardState.projectId === projectId) {
            await handleOnboardingTextForProject(ctx, onboardState, text, projectId);
            return;
        }
        // Check for claim in progress
        const claimState = await loadClaimState(userId);
        if (claimState && claimState.projectId === projectId) {
            await handleClaimTextForProject(ctx, claimState, text, projectId);
            return;
        }
        // Question answering — check Redis for active question
        // Key must match what telegram-sender.ts uses (q:{userId})
        const qStateRaw = await redis.get(`q:${userId}`);
        if (qStateRaw) {
            const { questionId, roundId } = JSON.parse(qStateRaw);
            await redis.del(`q:${userId}`);
            await saveResponseForProject(userId, projectId, roundId, questionId, text);
            await ctx.reply('✅ Received! Your perspective has been recorded.\n\n' +
                'The synthesis will be posted to your group when the round closes.', { parse_mode: 'Markdown' });
            return;
        }
        // AI conversational fallback — answer natural language questions about the project
        if (text.trim().length >= 3) {
            try {
                const projectName = (await db.select({ name: projects.name }).from(projects).where(eq(projects.id, projectId)).limit(1))[0]?.name ?? 'the project';
                const systemPrompt = `You are a helpful assistant for the Zolara project bot. The project is called "${projectName}". Members use this bot to join rounds and submit their perspectives. Be brief and helpful.`;
                const response = await llm.generate({ systemPrompt, userPrompt: text, temperature: 0.7, maxTokens: 400 });
                if (response.text) {
                    await ctx.reply(response.text.trim(), { parse_mode: 'Markdown' });
                }
            }
            catch (err) {
                console.error('[ProjectBot AI] error:', err);
            }
        }
    });
    // Callback queries (inline button presses)
    bot.on('callback_query:data', async (ctx) => {
        const data = ctx.callbackQuery.data;
        if (!data)
            return;
        const userId = ctx.from.id;
        // Onboarding callbacks
        if (data.startsWith('onboard:')) {
            const state = await loadOnboardingState(userId);
            if (!state) {
                await ctx.answerCallbackQuery('Session expired. Send /start to begin again.');
                return;
            }
            await handleOnboardingCallbackForProject(ctx, state, data, projectId);
            return;
        }
        // Claim callbacks
        if (data.startsWith('claim:')) {
            const state = await loadClaimState(userId);
            if (!state) {
                await ctx.answerCallbackQuery('Session expired. Send /start to begin again.');
                return;
            }
            await handleClaimCallbackForProject(ctx, state, data, projectId);
            return;
        }
        // Problem validation callbacks (sent by project bot DMs)
        if (data.startsWith('validate:')) {
            const { parseValidationCallback, handleVoteCallback, handleTopicCallback } = await import('../../engine/phases/phase-2-problem-def/telegram-ui');
            const parsed = parseValidationCallback(data);
            if (!parsed) {
                await ctx.answerCallbackQuery('');
                return;
            }
            const result = parsed.action === 'vote'
                ? await handleVoteCallback(parsed.problemDefinitionId, parsed.vote, userId)
                : await handleTopicCallback(parsed.problemDefinitionId);
            await ctx.answerCallbackQuery({ text: result.text, show_alert: result.alert });
            return;
        }
        // Report reaction callbacks
        if (data.startsWith('reaction:')) {
            await handleReactionCallbackForProject(ctx, data, projectId);
            return;
        }
        await ctx.answerCallbackQuery('');
    });
    // Handle direct reactions (long-press emoji reactions on messages)
    bot.on('message_reaction', async (ctx) => {
        const update = ctx.update;
        const reactionEvent = update.message_reaction;
        if (!reactionEvent?.message_id || !reactionEvent.new_reaction)
            return;
        const chatId = reactionEvent.chat?.id;
        const messageId = reactionEvent.message_id;
        const userTelegramId = reactionEvent.user?.id;
        if (!chatId || !messageId || !userTelegramId)
            return;
        // Get the emoji reactions
        const emojis = [];
        for (const reaction of reactionEvent.new_reaction) {
            if (reaction.type === 'emoji') {
                emojis.push(reaction.emoji);
            }
        }
        if (emojis.length === 0)
            return;
        const reactionKey = `reaction:${chatId}:${messageId}`;
        await redis.setex(reactionKey, 86400 * 7, JSON.stringify({
            projectId,
            userTelegramId,
            reactions: emojis,
            updatedAt: Date.now(),
        }));
        // Log to engagement_events if DB is available
        try {
            const { engagementEvents, members, users } = await import('../../data/schema/projects');
            const { db } = await import('../../data/db');
            // Look up member by telegram ID (via users table)
            const [user] = await db
                .select({ id: users.id })
                .from(users)
                .where(eq(users.telegramId, userTelegramId))
                .limit(1);
            if (!user)
                return;
            const [member] = await db
                .select({ id: members.id })
                .from(members)
                .where(and(eq(members.userId, user.id), eq(members.projectId, projectId)))
                .limit(1);
            if (member) {
                await db.insert(engagementEvents).values({
                    memberId: member.id,
                    projectId,
                    eventType: 'message_reaction',
                    metadata: { chatId, messageId: String(messageId), reactions: emojis, source: 'webhook' },
                });
            }
        }
        catch (err) {
            console.error('[MessageReaction] Failed to store reaction:', err);
        }
    });
}
// ── Per-project handler implementations ───────────────────────────────────────
async function handlePlainStartForProject(ctx, projectId) {
    const userId = ctx.from.id;
    const [project] = await db
        .select({ id: projects.id, name: projects.name, botUsername: projects.botUsername })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);
    if (!project) {
        await ctx.reply('❌ Project not found. Ask your admin for a fresh invite link.');
        return;
    }
    const activeOnboarding = await loadOnboardingState(userId);
    if (activeOnboarding && activeOnboarding.projectId === projectId) {
        if (activeOnboarding.step === 'complete') {
            await clearOnboardingState(userId);
        }
        else {
            await handleOnboardingStep(ctx, activeOnboarding);
            return;
        }
    }
    const [member] = await db
        .select({ role: members.role, onboardingStatus: members.onboardingStatus })
        .from(members)
        .innerJoin(users, eq(members.userId, users.id))
        .where(and(eq(users.telegramId, userId), eq(members.projectId, projectId)))
        .limit(1);
    if (member && member.onboardingStatus !== 'complete') {
        const onboardingState = {
            phase: 'onboarding',
            projectId,
            telegramId: userId,
            step: 'welcome',
            createdAt: new Date().toISOString(),
        };
        await saveOnboardingState(onboardingState);
        await handleOnboardingStep(ctx, onboardingState);
        return;
    }
    if (member) {
        await ctx.reply(`✅ You're connected to ${project.name}.\n\n` +
            `Role: ${member.role ?? 'participant'}\n` +
            `Onboarding: ${member.onboardingStatus ?? 'fresh'}\n\n` +
            `When your admin starts a round, I'll DM you the questions here.`);
        return;
    }
    const botUsername = project.botUsername ?? ctx.me?.username;
    const inviteLink = botUsername ? `https://t.me/${botUsername}?start=claim_${projectId}` : null;
    await ctx.reply(`👋 Welcome to ${project.name}.\n\n` +
        `To join this project, use the project invite link${inviteLink ? `:\n${inviteLink}` : ' from your admin'}.`);
}
async function handleMemberClaimForProject(ctx, targetProjectId) {
    const userId = ctx.from.id;
    // Load project config for anonymity setting
    const [project] = await db
        .select({ id: projects.id, name: projects.name, status: projects.status, config: projects.config })
        .from(projects)
        .where(eq(projects.id, targetProjectId))
        .limit(1);
    if (!project) {
        await ctx.reply('❌ Project not found. This invite link may be expired.');
        return;
    }
    const [existingMember] = await db
        .select({ onboardingStatus: members.onboardingStatus, role: members.role })
        .from(members)
        .innerJoin(users, eq(members.userId, users.id))
        .where(and(eq(users.telegramId, userId), eq(members.projectId, targetProjectId)))
        .limit(1);
    if (existingMember) {
        if (existingMember.onboardingStatus === 'complete') {
            await clearClaimState(userId);
            await clearOnboardingState(userId);
            await ctx.reply(`✅ You're already connected to ${project.name}.

` +
                `Role: ${existingMember.role ?? 'participant'}
` +
                `When a round starts, I'll message you here.`);
            return;
        }
        const onboardingState = {
            phase: 'onboarding',
            projectId: targetProjectId,
            telegramId: userId,
            step: 'welcome',
            createdAt: new Date().toISOString(),
        };
        await clearClaimState(userId);
        await saveOnboardingState(onboardingState);
        await handleOnboardingStep(ctx, onboardingState);
        return;
    }
    const projectConfig = project.config ?? {};
    const anonymity = projectConfig['anonymity'] ?? 'optional';
    const state = {
        phase: 'claim',
        projectId: targetProjectId,
        projectName: project.name,
        telegramId: userId,
        claimStartedAt: new Date().toISOString(),
        anonymity,
    };
    await saveClaimState(state);
    await handleClaimWelcome(ctx, state);
}
async function handleOnboardingCallbackForProject(ctx, state, data, projectId) {
    const parts = data.split(':');
    const action = parts[1];
    // Handle skip inline — no need to call handleOnboardingStep for this
    if (action === 'skip') {
        state.step = nextOnboardingStep(state.step);
        await saveOnboardingState(state);
        const { handleOnboardingStep } = await import('../flows/onboarding-steps');
        await handleOnboardingStep(ctx, state);
    }
    else {
        // handleOnboardingCallback persists intermediate state itself and clears
        // state on completion. Do not re-save the returned completed state here,
        // or post-onboarding messages get swallowed by a stale onboard:* key.
        await handleOnboardingCallback(ctx, state, data);
    }
}
async function handleOnboardingTextForProject(ctx, state, text, projectId) {
    const { handleOnboardingText } = await import('../flows/onboarding-steps');
    const newState = await handleOnboardingText(ctx, state, text);
    if (newState) {
        await saveOnboardingState(newState);
    }
}
async function handleClaimCallbackForProject(ctx, state, data, projectId) {
    await handleClaimCallback(ctx, state, data);
}
async function handleClaimTextForProject(ctx, state, text, projectId) {
    // Claim flow is callback-driven, text input is handled by claim-steps
}
async function handleReactionCallbackForProject(ctx, data, projectId) {
    const userId = ctx.from.id;
    const parts = data.split(':');
    // data format: reaction:{projectId}:{roundNumber}:{reaction}
    const reaction = parts[3] ?? 'unknown';
    await ctx.answerCallbackQuery(`You reacted: ${reaction}`);
    // Store reaction in DB
    try {
        const { engagementEvents, members, users } = await import('../../data/schema/projects');
        const [member] = await db
            .select({ id: members.id })
            .from(members)
            .innerJoin(users, eq(members.userId, users.id))
            .where(and(eq(users.telegramId, userId), eq(members.projectId, projectId)))
            .limit(1);
        if (member) {
            await db.insert(engagementEvents).values({
                memberId: member.id,
                projectId,
                eventType: 'report_reaction',
                metadata: {
                    reaction,
                    chatId: ctx.chat?.id,
                    messageId: ctx.callbackQuery.message?.message_id,
                },
            }).onConflictDoNothing();
        }
    }
    catch (err) {
        console.error('[Reaction] Failed to store reaction:', err);
    }
}
async function saveResponseForProject(userId, projectId, roundId, questionId, text) {
    try {
        // Find member by telegramId
        const [member] = await db
            .select({ id: members.id })
            .from(members)
            .innerJoin(users, eq(members.userId, users.id))
            .where(and(eq(users.telegramId, userId), eq(members.projectId, projectId)))
            .limit(1);
        if (!member) {
            console.warn(`[saveResponse] Member not found for user ${userId}`);
            return;
        }
        // Store response
        await db.insert(responses).values({
            questionId,
            memberId: member.id,
            responseText: text,
        });
        // Update round response count
        const [round] = await db
            .select({ responseCount: rounds.responseCount })
            .from(rounds)
            .where(eq(rounds.id, roundId))
            .limit(1);
        if (round) {
            await db.update(rounds)
                .set({ responseCount: (round.responseCount ?? 0) + 1 })
                .where(eq(rounds.id, roundId));
        }
    }
    catch (err) {
        console.error('[saveResponse] Failed:', err);
    }
}
