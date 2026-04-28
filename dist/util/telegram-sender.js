/**
 * Telegram Sender Utility — Multi-bot aware
 *
 * Sends messages via the appropriate bot based on project context.
 * - Admin control plane messages → @Zolara_bot (ZOLARA_BOT_TOKEN)
 * - Project member messages → project's own bot token
 *
 * Multi-bot routing:
 * Each project has its own bot token stored encrypted in projects.botTokenEncrypted.
 * When projectId is provided, we decrypt and use that project's token.
 */
import { Bot } from 'grammy';
import { config } from '../config';
import { db } from '../data/db';
import { projects } from '../data/schema/projects';
import { eq } from 'drizzle-orm';
import { redis } from '../data/redis';
import { decrypt } from './crypto';
import { telegram, redis as redisLog } from './logger';
// Per-project bot instances (cached)
const projectBotCache = new Map();
// Single Zolara control bot instance
let zolaraBot = null;
function getZolaraBot() {
    if (!zolaraBot) {
        zolaraBot = new Bot(config.ZOLARA_BOT_TOKEN);
    }
    return zolaraBot;
}
/**
 * Get a bot instance for a project.
 * Uses project's own bot token if available, otherwise falls back to @Zolara_bot.
 */
async function getProjectBot(projectId) {
    if (projectBotCache.has(projectId)) {
        return projectBotCache.get(projectId);
    }
    const [project] = await db
        .select({ botTokenEncrypted: projects.botTokenEncrypted })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);
    let token = config.ZOLARA_BOT_TOKEN;
    if (project?.botTokenEncrypted) {
        try {
            token = decrypt(project.botTokenEncrypted);
        }
        catch {
            // Fall back to Zolara bot
        }
    }
    const bot = new Bot(token);
    projectBotCache.set(projectId, bot);
    return bot;
}
/**
 * Send a message.
 * @param chatId Target chat or user ID
 * @param text Message text
 * @param options Send options (parse mode, reply markup, etc.)
 * @param projectId Optional project context — uses project's own bot if provided
 */
export async function sendMessage(chatId, text, options, projectId) {
    const bot = projectId ? await getProjectBot(projectId) : getZolaraBot();
    try {
        const sent = await bot.api.sendMessage(chatId, text, {
            parse_mode: options?.parseMode ?? 'Markdown',
            reply_to_message_id: options?.replyToMessageId,
            reply_markup: options?.replyMarkup,
        });
        return sent.message_id;
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('chat not found') || msg.includes('user not found') || msg.includes('Bot was blocked by the user')) {
            telegram.sendFailed(`User has not started bot or blocked it: ${chatId}`, { chatId }, err);
            return null;
        }
        telegram.sendFailed(`Failed to send message to ${chatId}`, { chatId }, err);
        return null;
    }
}
/**
 * Send a question to a member via DM.
 * Uses the project's own bot for multi-bot routing.
 */
export async function sendQuestionDM(projectId, userId, questionText, roundNumber, questionId, roundId) {
    const message = `🌀 *Round ${roundNumber} - Your Perspective*\n\n` +
        `${questionText}\n\n` +
        `Reply to this message with your answer. All responses are anonymous in the final report.`;
    // Store question state so we can route the response back
    // Per-project Redis key for multi-bot isolation
    try {
        await redis.setex(`q:${userId}`, 86400, JSON.stringify({
            questionId,
            roundId,
            projectId,
        }));
    }
    catch (err) {
        redisLog.operationFailed('setex', { projectId, userId }, err);
    }
    // Send via project's own bot
    return sendMessage(userId, message, { parseMode: 'Markdown' }, projectId);
}
/**
 * Send the report to the group chat.
 * Uses the project's own bot.
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
    // Message 1: Hook/Summary
    const hookText = `🌀 *Round ${roundNumber} Synthesis*\n\n` +
        `📊 ${responseCount}/${memberCount} members shared their perspective\n\n` +
        `📈 Convergence: ${convergenceScore}% (${convergenceTier}) ${scoreBar}`;
    const msg1Id = await sendMessage(groupId, hookText, { parseMode: 'Markdown' }, projectId);
    if (msg1Id)
        messageIds.push(msg1Id);
    // Message 2: Theme alignments
    const alignments = themes
        .map((t) => {
        const emoji = t.alignment === 'aligned' ? '✅' : t.alignment === 'tension' ? '⚡' : '➖';
        return `${emoji} *${t.name}*\n_${t.summary}_`;
    })
        .join('\n\n');
    if (alignments) {
        const msg2Id = await sendMessage(groupId, `*Theme Alignments*\n\n${alignments}`, {
            parseMode: 'Markdown',
        }, projectId);
        if (msg2Id)
            messageIds.push(msg2Id);
    }
    // Message 3: Details (common ground, tensions, blind spots, action items)
    const detailsParts = [];
    if (commonGround.length > 0) {
        detailsParts.push(`*Common Ground*\n${commonGround.map((g) => `• ${g}`).join('\n')}`);
    }
    if (creativeTensions.length > 0) {
        detailsParts.push(`*Creative Tensions*\n${creativeTensions.map((t) => `⚡ ${t}`).join('\n')}`);
    }
    if (blindSpots.length > 0) {
        detailsParts.push(`*Blind Spots*\n${blindSpots.map((b) => `🔍 ${b}`).join('\n')}`);
    }
    if (actionItems.length > 0) {
        detailsParts.push(`*Action Items*\n${actionItems.map((a) => `→ ${a.title}`).join('\n')}`);
    }
    if (detailsParts.length > 0) {
        const msg3Id = await sendMessage(groupId, detailsParts.join('\n\n'), {
            parseMode: 'Markdown',
        }, projectId);
        if (msg3Id)
            messageIds.push(msg3Id);
    }
    // Message 4: Reaction buttons
    const msg4Id = await sendMessage(groupId, `What do you think of this synthesis?`, {
        parseMode: 'Markdown',
        replyMarkup: {
            inline_keyboard: [
                [
                    { text: '👍 Aligned', callback_data: `reaction:${projectId}:${roundNumber}:aligned` },
                    { text: '🤔 Conditional', callback_data: `reaction:${projectId}:${roundNumber}:conditional` },
                    { text: '❌ Divergent', callback_data: `reaction:${projectId}:${roundNumber}:divergent` },
                ],
                [
                    { text: '📌 Save Actions', callback_data: `reaction:${projectId}:${roundNumber}:save_actions` },
                ],
            ],
        },
    }, projectId);
    if (msg4Id)
        messageIds.push(msg4Id);
    return { messageIds };
}
/**
 * Send a reminder DM to a member.
 * Uses the project's own bot.
 */
export async function sendReminderDM(projectId, userId, roundNumber, nudgeCount) {
    const reminderText = nudgeCount === 1
        ? `⏰ *Round ${roundNumber} reminder*\n\nYou haven't shared your perspective yet.\n\nTap the link from your group invite to answer — takes only a few minutes.`
        : nudgeCount >= 3
            ? `🔴 *Round ${roundNumber} — Last chance*\n\nYour team is waiting for your perspective. The round closes soon — share your view before it ends.`
            : `⏰ *Round ${roundNumber} nudge*\n\nStill time to share your perspective before the round closes.`;
    return sendMessage(userId, reminderText, { parseMode: 'Markdown' }, projectId);
}
function getConvergenceBar(score) {
    const filled = Math.round(score / 10);
    return '█'.repeat(filled) + '░'.repeat(10 - filled);
}
/**
 * Escape special characters for Telegram MarkdownV2 parse mode.
 * Only escapes the characters that Telegram treats as reserved.
 */
export function escapeMarkdownV2(text) {
    const reserved = ['_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!'];
    let result = text;
    for (const char of reserved) {
        result = result.split(char).join(`\\${char}`);
    }
    return result;
}
