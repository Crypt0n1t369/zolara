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
import { auditEvent } from './audit';
import { withRetry } from './resilience';

// Per-project bot instances (cached)
const projectBotCache = new Map<string, Bot>();

// Single Zolara control bot instance
let zolaraBot: Bot | null = null;

function getZolaraBot(): Bot {
  if (!zolaraBot) {
    zolaraBot = new Bot(config.ZOLARA_BOT_TOKEN);
  }
  return zolaraBot;
}

/**
 * Get a bot instance for a project.
 * Uses project's own bot token if available, otherwise falls back to @Zolara_bot.
 */
async function getProjectBot(projectId: string): Promise<Bot> {
  if (projectBotCache.has(projectId)) {
    return projectBotCache.get(projectId)!;
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
    } catch {
      // Fall back to Zolara bot
    }
  }

  const bot = new Bot(token);
  projectBotCache.set(projectId, bot);
  return bot;
}

// ── Public API ─────────────────────────────────────────────────────────────────

export type ParseMode = 'Markdown' | 'HTML';

export interface SendOptions {
  parseMode?: ParseMode;
  replyToMessageId?: number;
  replyMarkup?: unknown;
}

/**
 * Send a message.
 * @param chatId Target chat or user ID
 * @param text Message text
 * @param options Send options (parse mode, reply markup, etc.)
 * @param projectId Optional project context — uses project's own bot if provided
 */
export async function sendMessage(
  chatId: number,
  text: string,
  options?: SendOptions,
  projectId?: string
): Promise<number | null> {
  const bot = projectId ? await getProjectBot(projectId) : getZolaraBot();
  try {
    const sent = await withRetry(
      'telegram.sendMessage',
      () => bot.api.sendMessage(chatId, text, {
        parse_mode: options?.parseMode ?? 'Markdown',
        reply_to_message_id: options?.replyToMessageId,
        reply_markup: options?.replyMarkup as never,
      }),
      {
        attempts: 3,
        baseDelayMs: 700,
        maxDelayMs: 8_000,
        context: { chatId, projectId },
        retryAfterMs: (err) => {
          const retryAfter = (err as { parameters?: { retry_after?: number } })?.parameters?.retry_after;
          return retryAfter ? retryAfter * 1000 : undefined;
        },
        shouldRetry: (err) => {
          const errorCode = (err as { error_code?: number })?.error_code;
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('chat not found') || msg.includes('user not found') || msg.includes('Bot was blocked by the user')) return false;
          return errorCode === 429 || errorCode === 408 || (typeof errorCode === 'number' && errorCode >= 500) || msg.toLowerCase().includes('timeout');
        },
        onRetry: (err, attempt) => telegram.apiError(`sendMessage attempt ${attempt} failed; retrying`, { chatId, projectId }, err),
      }
    );
    return sent.message_id;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('chat not found') || msg.includes('user not found') || msg.includes('Bot was blocked by the user')) {
      telegram.sendFailed(`User has not started bot or blocked it: ${chatId}`, { chatId, projectId }, err);
    } else {
      telegram.sendFailed(`Failed to send message to ${chatId}`, { chatId, projectId }, err);
    }
    await auditEvent('telegram_send_failed', { chatId, error: msg, textLength: text.length }, projectId);
    return null;
  }
}

/**
 * Send a question to a member via DM.
 * Uses the project's own bot for multi-bot routing.
 */
export async function sendQuestionDM(
  projectId: string,
  userId: number,
  questionText: string,
  roundNumber: number,
  questionId: string,
  roundId: string,
  topic?: string | null
): Promise<number | null> {
  const topicText = topic ? `Topic: *${topic}*\n\n` : '';
  const message =
    `🌀 *Round ${roundNumber} — your perspective*\n\n` +
    topicText +
    `${questionText}\n\n` +
    `Reply in your own words. A few sentences is enough unless you want to go deeper.\n\n` +
    `Your response helps Zolara write a balanced synthesis for the group. Reports follow the project’s anonymity settings.`;

  // Store question state so we can route the response back
  // Per-project Redis key for multi-bot isolation
  try {
    await redis.setex(`q:${userId}`, 86400, JSON.stringify({
      questionId,
      roundId,
      projectId,
    }));
  } catch (err) {
    redisLog.operationFailed('setex', { projectId, userId }, err);
  }

  // Send via project's own bot
  return sendMessage(userId, message, { parseMode: 'Markdown' }, projectId);
}

/**
 * Send the report to the group chat.
 * Uses the project's own bot.
 */
export async function postReportToGroupChat(
  projectId: string,
  groupId: number,
  reportData: Record<string, unknown>,
  roundNumber: number,
  responseCount: number,
  memberCount: number
): Promise<{ messageIds: number[] }> {
  const convergenceScore = (reportData['convergenceScore'] as number) ?? 50;
  const convergenceTier = (reportData['convergenceTier'] as string) ?? 'operational';
  const themes = (reportData['themes'] as Array<{
    name: string;
    alignment: string;
    summary: string;
    quotes?: string[];
  }>) ?? [];
  const commonGround = (reportData['commonGround'] as string[]) ?? [];
  const creativeTensions = (reportData['creativeTensions'] as string[]) ?? [];
  const blindSpots = (reportData['blindSpots'] as string[]) ?? [];
  const actionItems = (reportData['actionItems'] as Array<{
    title: string;
    description?: string;
  }>) ?? [];

  const scoreBar = getConvergenceBar(convergenceScore);

  const messageIds: number[] = [];

  // Message 1: Hook/Summary
  const hookText =
    `🌀 *Round ${roundNumber} synthesis*\n\n` +
    `📊 ${responseCount}/${memberCount} members responded\n\n` +
    `📈 Convergence: ${convergenceScore}% (${convergenceTier}) ${scoreBar}`;

  const msg1Id = await sendMessage(groupId, hookText, { parseMode: 'Markdown' }, projectId);
  if (msg1Id) messageIds.push(msg1Id);

  // Message 2: Theme alignments
  const alignments = themes
    .map((t) => {
      const emoji = t.alignment === 'aligned' ? '✅' : t.alignment === 'tension' ? '⚡' : '➖';
      return `${emoji} *${t.name}*\n_${t.summary}_`;
    })
    .join('\n\n');

  if (alignments) {
    const msg2Id = await sendMessage(groupId, `*Theme alignment*\n\n${alignments}`, {
      parseMode: 'Markdown',
    }, projectId);
    if (msg2Id) messageIds.push(msg2Id);
  }

  // Message 3: Details (common ground, tensions, blind spots, action items)
  const detailsParts: string[] = [];

  if (commonGround.length > 0) {
    detailsParts.push(
      `*Common ground*\n${commonGround.map((g) => `• ${g}`).join('\n')}`
    );
  }
  if (creativeTensions.length > 0) {
    detailsParts.push(
      `*Creative tensions*\n${creativeTensions.map((t) => `⚡ ${t}`).join('\n')}`
    );
  }
  if (blindSpots.length > 0) {
    detailsParts.push(
      `*Blind spots*\n${blindSpots.map((b) => `🔍 ${b}`).join('\n')}`
    );
  }
  if (actionItems.length > 0) {
    detailsParts.push(
      `*Action items*\n${actionItems.map((a) => `→ ${a.title}`).join('\n')}`
    );
  }

  if (detailsParts.length > 0) {
    const msg3Id = await sendMessage(groupId, detailsParts.join('\n\n'), {
      parseMode: 'Markdown',
    }, projectId);
    if (msg3Id) messageIds.push(msg3Id);
  }

  // Message 4: Reaction buttons
  const msg4Id = await sendMessage(
    groupId,
    `How does this synthesis land with you?`,
    {
      parseMode: 'Markdown',
      replyMarkup: {
        inline_keyboard: [
          [
            { text: '✅ Aligned', callback_data: `reaction:${projectId}:${roundNumber}:aligned` },
            { text: '💬 Want to discuss', callback_data: `reaction:${projectId}:${roundNumber}:discuss` },
            { text: '❌ Disagree', callback_data: `reaction:${projectId}:${roundNumber}:disagree` },
          ],
          [
            { text: '📌 Save actions', callback_data: `reaction:${projectId}:${roundNumber}:save_actions` },
          ],
        ],
      },
    },
    projectId
  );
  if (msg4Id) messageIds.push(msg4Id);

  return { messageIds };
}

/**
 * Send a reminder DM to a member.
 * Uses the project's own bot.
 */
export async function sendReminderDM(
  projectId: string,
  userId: number,
  roundNumber: number,
  nudgeCount: number
): Promise<number | null> {
  const reminderText =
    nudgeCount === 1
      ? `⏰ *Round ${roundNumber} reminder*\n\nThis round is waiting for your perspective. Open this chat and reply to the question I sent earlier — a short answer is enough.`
      : nudgeCount >= 3
      ? `🔴 *Round ${roundNumber} closes soon*\n\nLast reminder: share your perspective before this round closes.`
      : `⏰ *Round ${roundNumber} reminder*\n\nThere is still time to share your perspective before the round closes.`;

  return sendMessage(userId, reminderText, { parseMode: 'Markdown' }, projectId);
}

function getConvergenceBar(score: number): string {
  const filled = Math.round(score / 10);
  return '█'.repeat(filled) + '░'.repeat(10 - filled);
}
/**
 * Escape special characters for Telegram MarkdownV2 parse mode.
 * Only escapes the characters that Telegram treats as reserved.
 */
export function escapeMarkdownV2(text: string): string {
  const reserved = ['_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!'];
  let result = text;
  for (const char of reserved) {
    result = result.split(char).join(`\\${char}`);
  }
  return result;
}
