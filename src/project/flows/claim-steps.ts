/**
 * Claim Steps (Phase 1) — the mandatory commitment gate
 *
 * This is the ONLY step required before the bot can DM a user.
 * Takes ~10 seconds. Member confirms they want to participate.
 * After this: bot can reach them, they can reach the bot.
 */

import type { ClaimState } from './onboarding-state';
import type { Context } from 'grammy';
import { redis } from '../../data/redis';
import { db } from '../../data/db';
import { members, users } from '../../data/schema/projects';
import { eq } from 'drizzle-orm';
import { onboarding } from '../../util/logger';

const CLAIM_TTL = 86400; // 24 hours

// ── Claim Welcome ─────────────────────────────────────────────────────────────

export async function handleClaimWelcome(
  ctx: Context,
  state: ClaimState
): Promise<void> {
  const anonNote = {
    full: '• All responses are anonymized in the group report\n• Your teammates will never know what you personally said',
    optional: '• Responses are anonymous unless you choose to be credited\n• Teammates won' + "'" + 't know who said what unless you opt in',
    attributed: '• Your name is shown in the group report alongside your response\n• Teammates will know what you personally said',
  }[state.anonymity] ?? '';

  await ctx.reply(
    `🏠 *${state.projectName}*\n\n` +
    `You're joining as a team member. Here's what that means:\n\n` +
    `📋 *Your commitment:*\n` +
    `• When a round starts, I'll DM you a question\n` +
    `• You reply with your honest perspective (~2 min)\n` +
    `${anonNote}\n\n` +
    `⚡ *No obligation* — skip a round if you're busy.\n\n` +
    `Ready to commit?`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Yes, I\'m in', callback_data: 'claim:confirm' }],
          [{ text: '❌ Not now', callback_data: 'claim:decline' }],
        ],
      },
    }
  );
}

// ── Claim Callbacks ────────────────────────────────────────────────────────────

export async function handleClaimCallback(
  ctx: Context,
  state: ClaimState,
  data: string
): Promise<void> {
  const action = data.split(':')[1];

  if (action === 'confirm') {
    await ctx.answerCallbackQuery('Welcome aboard! 🎉');
    await finalizeClaim(state);
    await clearClaimState(state.telegramId);
    await ctx.reply(
      `🎉 *You're in!*\n\n` +
      `Your commitment is recorded. Here's what happens next:\n\n` +
      `📅 *When a round starts:*\n` +
      `I'll DM you a question. Reply with your perspective.\n\n` +
      `📊 *After the round:*\n` +
      `A synthesized report goes to your team group.\n` +
      `Your identity stays private.\n\n` +
      `Type /status to check if a round is active.\n` +
      `Type /profile to update your info anytime.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  if (action === 'decline') {
    await ctx.answerCallbackQuery();
    await clearClaimState(state.telegramId);
    await ctx.reply(
      'No worries. You can join anytime using the invite link from your team.\n\n' +
      'Questions? Just send /help.',
      { parse_mode: 'Markdown' }
    );
    return;
  }
}

// ── Finalize ──────────────────────────────────────────────────────────────────

async function finalizeClaim(state: ClaimState): Promise<void> {
  const telegramId = state.telegramId;

  // Upsert user
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.telegramId, telegramId))
    .limit(1);

  let userId: number;
  if (!user) {
    const [newUser] = await db.insert(users).values({ telegramId }).returning();
    userId = newUser.id;
  } else {
    userId = user.id;
  }

  // Upsert member — committed status means bot can now DM them
  const [existing] = await db
    .select()
    .from(members)
    .where(eq(members.projectId, state.projectId as any))
    .limit(1);

  if (existing) {
    await db
      .update(members)
      .set({
        userId,
        onboardingStatus: 'committed',
        joinedAt: new Date(),
      })
      .where(eq(members.id, existing.id));
  } else {
    await db.insert(members).values({
      projectId: state.projectId as any,
      userId,
      role: 'participant',
      onboardingStatus: 'committed',
      joinedAt: new Date(),
    });
  }
}

// ── State ─────────────────────────────────────────────────────────────────────

export async function loadClaimState(telegramId: number): Promise<ClaimState | null> {
  const raw = await redis.get(`claim:${telegramId}`);
  return raw ? JSON.parse(raw) : null;
}

export async function saveClaimState(state: ClaimState): Promise<void> {
  await redis.setex(`claim:${state.telegramId}`, CLAIM_TTL, JSON.stringify(state));
}

export async function clearClaimState(telegramId: number): Promise<void> {
  await redis.del(`claim:${telegramId}`);
}
