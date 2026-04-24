/**
 * Telegram Sender Utility
 * Sends messages via project bots using their decrypted tokens.
 */
import { Bot } from 'grammy';
import { db } from '../data/db';
import { projects } from '../data/schema/projects';
import { eq } from 'drizzle-orm';
import { decrypt } from './crypto';
import { redis } from '../data/redis';
import { telegram, redis as redisLog } from './logger';
const botCache = new Map();
/**
 * Get or create a Bot instance for a project.
 * Tokens are cached in memory.
 */
function getProjectBot(projectId) {
    if (botCache.has(projectId)) {
        return botCache.get(projectId);
    }
    return null;
}
/**
 * Load and cache a project bot by its token.
 */
async function loadProjectBot(projectId) {
    const [project] = await db
        .select()
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);
    if (!project?.botTokenEncrypted) {
        return null;
    }
    try {
        const token = decrypt(project.botTokenEncrypted);
        const bot = new Bot(token);
        // Warm up the bot (no-op for Grammy, but ensures API is ready)
        botCache.set(projectId, bot);
        return bot;
    }
    catch (err) {
        telegram.sendFailed(`Failed to load bot for project ${projectId}`, { projectId }, err);
        return null;
    }
}
/**
 * Send a message to a chat (group or DM) using the project bot.
 */
export async function sendMessage(projectId, chatId, text, options) {
    const bot = getProjectBot(projectId) ?? await loadProjectBot(projectId);
    if (!bot)
        return null;
    try {
        const sent = await bot.api.sendMessage(chatId, text, {
            parse_mode: options?.parseMode ?? 'Markdown',
            reply_to_message_id: options?.replyToMessageId,
            reply_markup: options?.replyMarkup,
        });
        return sent.message_id;
    }
    catch (err) {
        // Detect "user hasn't started the bot" error — bot cannot reach them
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('chat not found') || msg.includes('user not found') || msg.includes('Bot was blocked by the user')) {
            telegram.sendFailed(`User has not started bot or has blocked it: ${chatId}`, { projectId, chatId }, err);
            return null;
        }
        telegram.sendFailed(`Failed to send message to ${chatId}`, { projectId, chatId }, err);
        return null;
    }
}
/**
 * Send the report to the group chat.
 * Posts in 2-3 messages as per round_lifecycle spec.
 */
export async function postReportToGroupChat(projectId, groupId, reportData, roundNumber, responseCount, memberCount) {
    const convergenceScore = reportData['convergenceScore'] ?? 50;
    const convergenceTier = reportData['convergenceTier'] ?? 'operational';
    const themes = reportData['themes'] ?? [];
    const commonGround = reportData['commonGround'] ?? [];
    const creativeTensions = reportData['creativeTensions'] ?? [];
    const blindSpots = reportData['blindSpots'] ?? [];
    const actionItems = reportData['actionItems'] ?? [];
    const scoreBar = getConvergenceBar(convergenceScore);
    const messageIds = [];
    // Message 1: Hook/Summary (≤500 chars)
    const hookText = `🌀 *Round ${roundNumber} Synthesis*\n\n📊 ${responseCount}/${memberCount} members shared their perspective\n\n📈 Convergence: ${convergenceScore}% (${convergenceTier}) ${scoreBar}`;
    const msg1Id = await sendMessage(projectId, groupId, hookText, { parseMode: 'Markdown' });
    if (msg1Id)
        messageIds.push(msg1Id);
    // Message 2: Themes and alignment
    let bodyText = '';
    if (themes.length > 0) {
        bodyText += '*Key Themes*\n';
        for (const theme of themes.slice(0, 4)) {
            const emoji = theme.alignment === 'aligned' ? '✅' : theme.alignment === 'tension' ? '⚡' : '💬';
            bodyText += `${emoji} *${theme.name}*: ${theme.summary.slice(0, 200)}\n`;
        }
        bodyText += '\n';
    }
    if (commonGround.length > 0) {
        bodyText += '*Common Ground*\n';
        for (const item of commonGround.slice(0, 3)) {
            bodyText += `• ${item}\n`;
        }
        bodyText += '\n';
    }
    if (creativeTensions.length > 0) {
        bodyText += '*Creative Tensions*\n';
        for (const tension of creativeTensions.slice(0, 3)) {
            bodyText += `⚡ ${tension}\n`;
        }
        bodyText += '\n';
    }
    if (blindSpots.length > 0) {
        bodyText += '*Blind Spots*\n';
        for (const spot of blindSpots.slice(0, 2)) {
            bodyText += `👁️ ${spot}\n`;
        }
    }
    if (bodyText) {
        const msg2Id = await sendMessage(projectId, groupId, bodyText.trim(), { parseMode: 'Markdown' });
        if (msg2Id)
            messageIds.push(msg2Id);
    }
    // Message 3: Action items + reaction keyboard
    let actionText = '';
    if (actionItems.length > 0) {
        actionText += '*📋 Suggested Next Steps*\n';
        for (const item of actionItems.slice(0, 5)) {
            actionText += `• *${item.title}*`;
            if (item.description)
                actionText += `\n  ${item.description}`;
            actionText += '\n';
        }
    }
    actionText += `\n*Convergence:* ${scoreBar} ${convergenceScore}% (${convergenceTier})\n`;
    actionText += '\n_How does this resonate with you?_';
    const keyboard = {
        inline_keyboard: [
            [
                { text: '✅ Aligned', callback_data: `react:aligned:${roundNumber}` },
                { text: '💬 Want to discuss', callback_data: `react:discuss:${roundNumber}` },
                { text: '❌ Disagree', callback_data: `react:disagree:${roundNumber}` },
            ],
        ],
    };
    const msg3Id = await sendMessage(projectId, groupId, actionText.trim(), {
        parseMode: 'Markdown',
        replyMarkup: keyboard,
    });
    if (msg3Id)
        messageIds.push(msg3Id);
    return { messageIds };
}
/**
 * Send a question to a member via DM.
 * Stores the question state in Redis so we can route the response back correctly.
 */
export async function sendQuestionDM(projectId, userId, questionText, roundNumber, questionId) {
    const message = `🌀 *Round ${roundNumber} — Your Perspective*\n\n${questionText}\n\nReply to this message with your answer. All responses are anonymous in the final report.`;
    // Store question state so we can route the response
    try {
        await redis.setex(`q:${userId}`, 86400, JSON.stringify({
            questionId,
            roundId: '',
        }));
    }
    catch (err) {
        redisLog.operationFailed('setex', { projectId, userId }, err);
    }
    return sendMessage(projectId, userId, message, { parseMode: 'Markdown' });
}
/**
 * Update reaction counts on a report message.
 * Note: Telegram reaction updates via API require specific ReactionType objects.
 * This is a placeholder — actual implementation uses callback query handlers.
 */
export async function updateReportReactions(_projectId, _groupId, _messageId, _reactions) {
    // Reactions are tracked via callback queries from the inline keyboard
    // See handleReactionCallback in project bot
}
// ── Helpers ─────────────────────────────────────────────────────────────────
function getConvergenceBar(score) {
    const filled = Math.round(score / 10);
    const empty = 10 - filled;
    return '█'.repeat(filled) + '░'.repeat(empty);
}
