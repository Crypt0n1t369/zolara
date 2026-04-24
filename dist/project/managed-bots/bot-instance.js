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
import { config } from '../../config';
import { db } from '../../data/db';
import { projects, members, users, rounds, responses } from '../../data/schema/projects';
import { eq, and } from 'drizzle-orm';
import { redis } from '../../data/redis';
import { nextOnboardingStep, } from '../flows/onboarding-state';
import { loadOnboardingState, saveOnboardingState, handleOnboardingCallback, } from '../flows/onboarding-steps';
import { handleClaimWelcome, handleClaimCallback, loadClaimState, saveClaimState } from '../flows/claim-steps';
// Map: projectId → cached Bot instance
const botCache = new Map();
/**
 * Create or get a cached Bot instance for a project.
 * Bot is created with the project's own token (or fallback to Zolara token for control bot).
 */
export function createProjectBot(botToken, projectId) {
    const cacheKey = projectId;
    const token = botToken ?? config.ZOLARA_BOT_TOKEN;
    if (botCache.has(cacheKey)) {
        return botCache.get(cacheKey);
    }
    const bot = new Bot(token);
    // All message handling is per-project — we already know the projectId
    wireProjectBotHandlers(bot, projectId);
    botCache.set(cacheKey, bot);
    return bot;
}
/**
 * Wire up all handlers for a project-specific bot.
 */
function wireProjectBotHandlers(bot, projectId) {
    // /start — member claim flow (deep link)
    bot.command('start', async (ctx) => {
        const text = ctx.message?.text ?? '';
        const args = text.replace('/start', '').trim();
        if (args.startsWith('claim_')) {
            // Member joining via invite link
            const targetProjectId = args.replace('claim_', '');
            await handleMemberClaimForProject(ctx, targetProjectId);
        }
        else {
            // Regular /start — show welcome
            await ctx.reply('👋 Welcome to Zolara!\\n\\n' +
                'This bot is used by your team to run alignment rounds.\\n' +
                'Use the invite link from your admin to join your project.', { parse_mode: 'Markdown' });
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
    // Text messages (onboarding replies, question answers)
    bot.on('message:text', async (ctx) => {
        const text = ctx.message.text;
        if (text.startsWith('/'))
            return; // Commands handled separately
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
        const qStateRaw = await redis.get(`proj:${projectId}:q:${userId}`);
        if (qStateRaw) {
            const { questionId, roundId } = JSON.parse(qStateRaw);
            await redis.del(`proj:${projectId}:q:${userId}`);
            await saveResponseForProject(userId, projectId, roundId, questionId, text);
            await ctx.reply('✅ Received! Your perspective has been recorded.\\n\\n' +
                'The synthesis will be posted to your group when the round closes.', { parse_mode: 'Markdown' });
            return;
        }
    });
}
// ── Per-project handler implementations ───────────────────────────────────────
async function handleMemberClaimForProject(ctx, targetProjectId) {
    const userId = ctx.from.id;
    // Load project
    const [project] = await db
        .select({ id: projects.id, name: projects.name, status: projects.status })
        .from(projects)
        .where(eq(projects.id, targetProjectId))
        .limit(1);
    if (!project) {
        await ctx.reply('❌ Project not found. This invite link may be expired.');
        return;
    }
    const state = {
        phase: 'claim',
        projectId: targetProjectId,
        projectName: project.name,
        telegramId: userId,
        claimStartedAt: new Date().toISOString(),
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
        const result = await handleOnboardingCallback(ctx, state, data);
        if (result) {
            await saveOnboardingState(result);
        }
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
            .where(eq(users.telegramId, userId))
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
            .where(eq(users.telegramId, userId))
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
