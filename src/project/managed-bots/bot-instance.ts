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

import { Bot, InlineKeyboard } from 'grammy';
import { llm } from '../../engine/llm/minimax';
import { config } from '../../config';
import { db } from '../../data/db';
import { projects, members, users, rounds, questions, responses, engagementEvents } from '../../data/schema/projects';
import { eq, and, desc } from 'drizzle-orm';
import { redis } from '../../data/redis';
import { sendMessage, sendQuestionDM } from '../../util/telegram-sender';
import { triggerRound, cancelRound } from '../../engine/round-manager';
import {
  OnboardingState,
  ClaimState,
} from '../flows/onboarding-state';
import {
  handleOnboardingStep,
  loadOnboardingState,
  saveOnboardingState,
  clearOnboardingState,
  restartOnboardingState,
  sendOnboardingStaleCallbackHelp,
  handleOnboardingCallback,
} from '../flows/onboarding-steps';
import { handleClaimWelcome, handleClaimCallback, loadClaimState, saveClaimState, clearClaimState } from '../flows/claim-steps';
import { extractSimpleReflectionSignal, formatPersonalProfileView, formatReflectionPrompt, mergeConfirmedSignal, normalizeReflectionRefinement } from '../individual-profile';
import { isValidReportReaction } from '../report-reactions';

// Map: projectId → cached Bot instance
const botCache = new Map<string, Bot>();

type ProjectConfigRecord = Record<string, unknown> & {
  groupIntroPostedGroupIds?: number[];
  groupInviteDistributedGroupIds?: number[];
};

function escapeMarkdown(value: string): string {
  return value.replace(/([_*`\[])/g, '\\$1');
}

async function recordProjectGroupAndIntro(projectId: string, chatId: number, groupTitle: string, api: any): Promise<void> {
  const [project] = await db
    .select({ name: projects.name, description: projects.description, groupIds: projects.groupIds, config: projects.config })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!project) return;

  const existingGroupIds = project.groupIds ?? [];
  const groupIds = existingGroupIds.includes(chatId) ? existingGroupIds : [...existingGroupIds, chatId];
  const configRecord = ((project.config ?? {}) as unknown) as ProjectConfigRecord;
  const posted = Array.isArray(configRecord.groupIntroPostedGroupIds)
    ? configRecord.groupIntroPostedGroupIds
    : [];
  const distributed = Array.isArray(configRecord.groupInviteDistributedGroupIds)
    ? configRecord.groupInviteDistributedGroupIds
    : [];
  const alreadyPosted = posted.includes(chatId);
  const alreadyDistributed = distributed.includes(chatId);

  let inviteLink: string | null = null;
  let inviteError: string | null = null;
  try {
    const created = await api.createChatInviteLink(chatId, {
      name: `${project.name ?? 'Zolara'} team`.slice(0, 32),
      creates_join_request: false,
    });
    inviteLink = created.invite_link;
  } catch (err) {
    inviteError = err instanceof Error ? err.message : String(err);
  }

  const nextConfig: ProjectConfigRecord = {
    ...configRecord,
    groupIntroPostedGroupIds: alreadyPosted ? posted : [...posted, chatId],
    groupInviteDistributedGroupIds: inviteLink && !alreadyDistributed ? [...distributed, chatId] : distributed,
  };

  await db.update(projects).set({
    groupIds,
    config: nextConfig as any,
    updatedAt: new Date(),
  }).where(eq(projects.id, projectId as any));

  const projectName = project.name ?? 'this project';
  const description = project.description?.trim()
    ? `\n\n*Focus:* ${escapeMarkdown(project.description.trim()).slice(0, 600)}`
    : '';

  if (!alreadyPosted) {
    const inviteLine = inviteLink
      ? `\n\nGroup invite is ready. Your lead can also run /invite any time.\n${inviteLink}`
      : `\n\nI could not create a group invite link yet. Please make me a group admin with invite-link permission, then run /invite.`;

    await api.sendMessage(
      chatId,
      `👋 *Zolara is connected to ${escapeMarkdown(groupTitle)}*\n\n` +
      `I’m the private listening and synthesis bot for *${escapeMarkdown(projectName)}*.${description}\n\n` +
      `How this works:\n` +
      `1️⃣ Members join and complete onboarding in private DM.\n` +
      `2️⃣ Your lead starts a round when the team is ready.\n` +
      `3️⃣ I ask members questions privately so answers are thoughtful and low-pressure.\n` +
      `4️⃣ I post the synthesis report, next steps, and reaction buttons back here.` +
      inviteLine,
      { parse_mode: 'Markdown' }
    );
  } else if (!inviteLink && inviteError) {
    await api.sendMessage(
      chatId,
      `Zolara is connected, but I still cannot create a group invite link. ` +
      `Please grant invite-link permission and run /invite.`,
      { parse_mode: 'Markdown' }
    );
  }

  if (!inviteLink || alreadyDistributed) return;

  const rows = await db
    .select({ telegramId: users.telegramId, onboardingStatus: members.onboardingStatus })
    .from(members)
    .innerJoin(users, eq(members.userId, users.id))
    .where(and(eq(members.projectId, projectId), eq(members.onboardingStatus, 'complete')))
    .limit(200);

  let sent = 0;
  for (const row of rows) {
    try {
      await api.sendMessage(
        row.telegramId,
        `🏠 The group for *${escapeMarkdown(projectName)}* is ready.\n\nJoin here:\n${inviteLink}`,
        { parse_mode: 'Markdown' }
      );
      sent++;
    } catch { /* member may not have opened/kept the project bot */ }
  }

  if (sent > 0) {
    await api.sendMessage(chatId, `Sent the group invite to ${sent} onboarded member${sent === 1 ? '' : 's'} in DM.`);
  }
}

/**
 * Create or get a cached Bot instance for a project.
 * Bot is created with the project's own token (or fallback to Zolara token for control bot).
 */
export async function createProjectBot(botToken: string | null, projectId: string): Promise<Bot> {
  const cacheKey = projectId;
  const token = botToken ?? config.ZOLARA_BOT_TOKEN;

  if (botCache.has(cacheKey)) {
    return botCache.get(cacheKey)!;
  }

  const bot = new Bot(token);

  // Ensure bot is initialized (fetches /getMe so handleUpdate works)
  try { await bot.init(); } catch (e) { /* token may be invalid */ }

  // All message handling is per-project — we already know the projectId
  wireProjectBotHandlers(bot, projectId);

  botCache.set(cacheKey, bot);
  return bot;
}

/**
 * Wire up all handlers for a project-specific bot.
 */
function wireProjectBotHandlers(bot: Bot, projectId: string): void {
  // Group setup: when the project bot is added to a Telegram group, record it
  // as the report destination and post a one-time orientation message.
  bot.on('my_chat_member', async (ctx) => {
    const update = ctx.update as any;
    const event = update?.my_chat_member;
    const chat = event?.chat;
    const oldStatus = event?.old_chat_member?.status;
    const newStatus = event?.new_chat_member?.status;
    const chatType = chat?.type;

    if (chatType !== 'group' && chatType !== 'supergroup') return;
    if (newStatus === 'kicked' || newStatus === 'left') return;
    if (oldStatus === 'member' || oldStatus === 'administrator') return;

    await recordProjectGroupAndIntro(projectId, chat.id, chat.title ?? 'this group', ctx.api);
  });

  // /help command for project bots
  bot.command('help', async (ctx) => {
    await ctx.reply(
      '*Zolara Project Bot*\n\n' +
      'Use this bot to join your team\'s consensus rounds.\n\n' +
      '1. Tap *Start* or send /start to join\n' +
      '2. Complete onboarding\n' +
      '3. Answer questions when a round is active\n' +
      '4. Use /me to see your private discovery profile\n' +
      '5. React to synthesis reports in your group\n\n' +
      'Questions? Ask your admin, or type here and I’ll help if I can.',
      { parse_mode: 'Markdown' }
    );
  });


  // /restart_onboarding — safe reset for members who want to redo their profile
  bot.command('restart_onboarding', async (ctx) => {
    const userId = ctx.from!.id;
    const state = await restartOnboardingState(userId, projectId);
    await clearClaimState(userId);

    if (!state) {
      await ctx.reply('I could not find your membership for this project yet. Please use your project invite link first.');
      return;
    }

    await ctx.reply('🔄 Restarting onboarding. I cleared your in-progress answers for this project.');
    await handleOnboardingStep(ctx, state);
  });

  // /me — private individual discovery/profile view for members
  bot.command('me', async (ctx) => {
    const userId = ctx.from!.id;

    const [user] = await db
      .select({ id: users.id, communicationProfile: users.communicationProfile })
      .from(users)
      .where(eq(users.telegramId, userId))
      .limit(1);

    const [project] = await db
      .select({ name: projects.name })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);

    const [member] = user
      ? await db
        .select({ onboardingStatus: members.onboardingStatus, role: members.role, projectProfile: members.projectProfile })
        .from(members)
        .where(and(eq(members.projectId, projectId), eq(members.userId, user.id)))
        .limit(1)
      : [];

    if (!user || !member) {
      await ctx.reply('I could not find your profile for this project yet. Send /start or use your project invite link first.');
      return;
    }

    const qStateRaw = await redis.get(`q:${userId}`);
    const [round] = await db
      .select({ roundNumber: rounds.roundNumber, status: rounds.status, topic: rounds.topic, responseCount: rounds.responseCount, memberCount: rounds.memberCount })
      .from(rounds)
      .where(eq(rounds.projectId, projectId))
      .orderBy(desc(rounds.startedAt))
      .limit(1);

    await ctx.reply(formatPersonalProfileView({
      projectName: project?.name ?? 'this project',
      role: member.role,
      onboardingStatus: member.onboardingStatus,
      projectProfile: member.projectProfile,
      communicationProfile: user.communicationProfile,
      activeQuestion: Boolean(qStateRaw),
      latestRound: round ?? null,
    }));
  });

  // /my_status — concise personal state for members
  bot.command('my_status', async (ctx) => {
    const userId = ctx.from!.id;

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

    await ctx.reply(
      `*Your Zolara status*\n\n` +
      `Onboarding: ${onboarding}\n` +
      `Role: ${member?.role ?? '—'}\n` +
      `Active question: ${activeQuestion}\n\n` +
      `*Latest round*\n${roundText}`,
      { parse_mode: 'Markdown' }
    );
  });

  // /start — member claim flow (deep link)
  // Use message:text with explicit check instead of bot.command() because:
  // - Telegram deep-link args don't always include bot_command entity
  // - bot.command() silently drops messages without entity, breaking claim flow
  bot.on('message:text', async (ctx) => {
    const text = (ctx.message as any)?.text ?? '';
    if (!text) return;

    if (text.startsWith('/start')) {
      const args = text.replace(/^\/start\s*/, '').trim();
      if (args.startsWith('claim_')) {
        const targetProjectId = args.replace('claim_', '');
        await handleMemberClaimForProject(ctx, targetProjectId);
        return;
      } else {
        await handlePlainStartForProject(ctx, projectId);
        return;
      }
    }

    // Text messages (onboarding replies, question answers)
    const userId = ctx.from!.id;

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

    // Individual-discovery reflection refinement — user tapped “Not quite” and then typed a correction.
    const reflectionRefineRaw = await redis.get(`reflect_refine:${userId}`);
    if (reflectionRefineRaw) {
      await redis.del(`reflect_refine:${userId}`);
      await saveReflectionRefinementForProject(ctx, reflectionRefineRaw, text, projectId);
      return;
    }

    // Question answering — check Redis for active question
    // Key must match what telegram-sender.ts uses (q:{userId})
    const qStateRaw = await redis.get(`q:${userId}`);
    if (qStateRaw) {
      const { questionId, roundId } = JSON.parse(qStateRaw) as {
        questionId: string; roundId: string;
      };
      await redis.del(`q:${userId}`);
      await saveResponseForProject(userId, projectId, roundId, questionId, text);
      await ctx.reply(
        '✅ Received! Your perspective has been recorded.\n\n' +
        'The synthesis will be posted to your group when the round closes.',
        { parse_mode: 'Markdown' }
      );

      const signal = extractSimpleReflectionSignal(text);
      if (signal) {
        await ctx.reply(
          formatReflectionPrompt(signal),
          {
            reply_markup: new InlineKeyboard()
              .text('✅ Accurate — remember privately', `reflect:accurate:${signal.type}:${signal.label}`)
              .text('✏️ Not quite', `reflect:refine:${signal.type}:${signal.label}`)
              .row()
              .text('🚫 Don’t remember', `reflect:skip:${signal.type}:${signal.label}`),
          }
        );
      }
      return;
    }

    // Unknown private users may have found the project bot via search and sent "hi"
    // without a deep-link payload. Since this bot is project-scoped, offer the same
    // commitment gate as /start claim_<projectId> instead of dropping them into AI help.
    if (ctx.chat?.type === 'private') {
      const [knownMember] = await db
        .select({ id: members.id })
        .from(members)
        .innerJoin(users, eq(members.userId, users.id))
        .where(and(eq(users.telegramId, userId), eq(members.projectId, projectId)))
        .limit(1);

      if (!knownMember) {
        await handlePlainStartForProject(ctx, projectId);
        return;
      }
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
      } catch (err) {
        console.error('[ProjectBot AI] error:', err);
      }
    }
  });

  // Callback queries (inline button presses)
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (!data) return;
    const userId = ctx.from!.id;

    // Onboarding callbacks
    if (data.startsWith('onboard:')) {
      const state = await loadOnboardingState(userId);
      if (!state) {
        await sendOnboardingStaleCallbackHelp(ctx, userId, projectId);
        return;
      }
      if (state.projectId !== projectId) {
        await sendOnboardingStaleCallbackHelp(
          ctx,
          userId,
          projectId,
          'That button belongs to a different onboarding session.'
        );
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
      const { parseValidationCallback, handleVoteCallback, handleTopicCallback } =
        await import('../../engine/phases/phase-2-problem-def/telegram-ui');
      const parsed = parseValidationCallback(data);
      if (!parsed) {
        await ctx.answerCallbackQuery('');
        return;
      }
      const result = parsed.action === 'vote'
        ? await handleVoteCallback(parsed.problemDefinitionId, parsed.vote!, userId)
        : await handleTopicCallback(parsed.problemDefinitionId);
      await ctx.answerCallbackQuery({ text: result.text, show_alert: result.alert });
      return;
    }

    // Individual discovery reflection callbacks
    if (data.startsWith('reflect:')) {
      await handleReflectionCallbackForProject(ctx, data, projectId);
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
    const update = ctx.update as any;
    const reactionEvent = update.message_reaction;

    if (!reactionEvent?.message_id || !reactionEvent.new_reaction) return;

    const chatId = reactionEvent.chat?.id;
    const messageId = reactionEvent.message_id;
    const userTelegramId = reactionEvent.user?.id;

    if (!chatId || !messageId || !userTelegramId) return;

    // Get the emoji reactions
    const emojis: string[] = [];
    for (const reaction of reactionEvent.new_reaction) {
      if (reaction.type === 'emoji') {
        emojis.push(reaction.emoji);
      }
    }

    if (emojis.length === 0) return;

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

      if (!user) return;

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
    } catch (err) {
      console.error('[MessageReaction] Failed to store reaction:', err);
    }
  });
}

// ── Per-project handler implementations ───────────────────────────────────────

async function handlePlainStartForProject(ctx: any, projectId: string): Promise<void> {
  const userId = ctx.from!.id;

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
    } else {
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
    const onboardingState: OnboardingState = {
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
    await ctx.reply(
      `✅ You're connected to ${project.name}.\n\n` +
      `Role: ${member.role ?? 'participant'}\n` +
      `Onboarding: ${member.onboardingStatus ?? 'fresh'}\n\n` +
      `When your admin starts a round, I'll DM you the questions here.`
    );
    return;
  }

  const botUsername = project.botUsername ?? ctx.me?.username;
  const inviteLink = botUsername ? `https://t.me/${botUsername}?start=claim_${projectId}` : null;

  await ctx.reply(
    `👋 Welcome to ${project.name}.\n\n` +
    `You can join this project from here. I’ll first confirm you want to participate, then ask a few onboarding questions.\n\n` +
    (inviteLink ? `If you need the direct invite later, it is:\n${inviteLink}\n\n` : '') +
    `Let’s start.`
  );
  await handleMemberClaimForProject(ctx, projectId);
}

async function handleMemberClaimForProject(ctx: any, targetProjectId: string): Promise<void> {
  const userId = ctx.from!.id;

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
      await ctx.reply(
        `✅ You're already connected to ${project.name}.

` +
        `Role: ${existingMember.role ?? 'participant'}
` +
        `When a round starts, I'll message you here.`
      );
      return;
    }

    const onboardingState: OnboardingState = {
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

  const projectConfig = (project.config as unknown) as Record<string, unknown> ?? {};
  const anonymity = (projectConfig['anonymity'] as 'full' | 'optional' | 'attributed') ?? 'optional';

  const state: ClaimState = {
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

async function handleOnboardingCallbackForProject(
  ctx: any,
  state: OnboardingState,
  data: string,
  projectId: string
): Promise<void> {
  // handleOnboardingCallback persists intermediate state itself and clears
  // state on completion. Do not re-save the returned completed state here,
  // or post-onboarding messages get swallowed by a stale onboard:* key.
  await handleOnboardingCallback(ctx, state, data);
}

async function handleOnboardingTextForProject(
  ctx: any,
  state: OnboardingState,
  text: string,
  projectId: string
): Promise<void> {
  const { handleOnboardingText } = await import('../flows/onboarding-steps');
  const newState = await handleOnboardingText(ctx, state, text);
  if (newState) {
    await saveOnboardingState(newState);
  }
}

async function handleClaimCallbackForProject(
  ctx: any,
  state: any,
  data: string,
  projectId: string
): Promise<void> {
  await handleClaimCallback(ctx, state, data);
}

async function handleClaimTextForProject(
  ctx: any,
  state: any,
  text: string,
  projectId: string
): Promise<void> {
  // Claim flow is callback-driven, text input is handled by claim-steps
}

async function saveReflectionRefinementForProject(
  ctx: any,
  stateRaw: string,
  text: string,
  projectId: string
): Promise<void> {
  const userTelegramId = ctx.from!.id;
  if (/^(skip|cancel|no)$/i.test(text.trim())) {
    await ctx.reply('No problem — I will not remember that reflection.');
    return;
  }

  let state: { type?: string; suggestedLabel?: string; projectId?: string } = {};
  try {
    state = JSON.parse(stateRaw) as typeof state;
  } catch {
    // Ignore malformed state and continue with safe defaults.
  }

  if (state.projectId && state.projectId !== projectId) {
    await ctx.reply('That reflection belongs to another project, so I did not save it.');
    return;
  }

  const label = normalizeReflectionRefinement(text);
  if (!label) {
    await ctx.reply('That was too short to remember. I did not save this reflection.');
    return;
  }

  const type = state.type === 'blocker' || state.type === 'communication_style' || state.type === 'contribution_style'
    ? state.type
    : 'value';

  const [user] = await db
    .select({ id: users.id, communicationProfile: users.communicationProfile })
    .from(users)
    .where(eq(users.telegramId, userTelegramId))
    .limit(1);

  if (!user) {
    await ctx.reply('I could not find your profile yet, so I did not save this reflection.');
    return;
  }

  const updatedProfile = mergeConfirmedSignal(user.communicationProfile, {
    label,
    type,
    projectId,
    source: 'post_answer_reflection_refined',
  });

  await db.update(users)
    .set({ communicationProfile: updatedProfile, updatedAt: new Date() })
    .where(eq(users.id, user.id));

  try {
    const [member] = await db
      .select({ id: members.id })
      .from(members)
      .where(and(eq(members.projectId, projectId), eq(members.userId, user.id)))
      .limit(1);
    if (member) {
      await db.insert(engagementEvents).values({
        memberId: member.id,
        projectId,
        eventType: 'individual_signal_refined',
        metadata: { label, type, suggestedLabel: state.suggestedLabel ?? null, source: 'post_answer_reflection_refined' } as Record<string, unknown>,
      });
    }
  } catch (err) {
    console.error('[Reflection] Failed to audit refined signal:', err);
  }

  await ctx.reply(`Remembered privately: “${label}”. Use /me to review it.`);
}

async function handleReflectionCallbackForProject(
  ctx: any,
  data: string,
  projectId: string
): Promise<void> {
  const userTelegramId = ctx.from!.id;
  const [, action, type, ...labelParts] = data.split(':');
  const label = labelParts.join(':');

  if (!label || !type) {
    await ctx.answerCallbackQuery('This reflection is stale.');
    return;
  }

  if (action === 'skip') {
    await ctx.answerCallbackQuery('Got it — I will not remember this.');
    return;
  }

  if (action === 'refine') {
    await redis.setex(`reflect_refine:${userTelegramId}`, 1800, JSON.stringify({
      type,
      suggestedLabel: label,
      projectId,
      createdAt: new Date().toISOString(),
    }));
    await ctx.answerCallbackQuery('Send the better word or phrase in this chat.');
    await ctx.reply(
      `Got it — I won’t remember “${label}”.\n\n` +
      `Reply with the better word or short phrase you want Zolara to remember privately, or send “skip”.`
    );
    return;
  }

  if (action !== 'accurate') {
    await ctx.answerCallbackQuery('Unknown reflection action.');
    return;
  }

  const [user] = await db
    .select({ id: users.id, communicationProfile: users.communicationProfile })
    .from(users)
    .where(eq(users.telegramId, userTelegramId))
    .limit(1);

  if (!user) {
    await ctx.answerCallbackQuery('I could not find your profile yet.');
    return;
  }

  const updatedProfile = mergeConfirmedSignal(user.communicationProfile, {
    label,
    type: type as any,
    projectId,
    source: 'post_answer_reflection',
  });

  await db.update(users)
    .set({ communicationProfile: updatedProfile, updatedAt: new Date() })
    .where(eq(users.id, user.id));

  try {
    const [member] = await db
      .select({ id: members.id })
      .from(members)
      .where(and(eq(members.projectId, projectId), eq(members.userId, user.id)))
      .limit(1);
    if (member) {
      await db.insert(engagementEvents).values({
        memberId: member.id,
        projectId,
        eventType: 'individual_signal_confirmed',
        metadata: { label, type, source: 'post_answer_reflection' } as Record<string, unknown>,
      });
    }
  } catch (err) {
    console.error('[Reflection] Failed to audit confirmed signal:', err);
  }

  await ctx.answerCallbackQuery('Remembered privately. Use /me to review it.');
}

async function handleReactionCallbackForProject(
  ctx: any,
  data: string,
  projectId: string
): Promise<void> {
  const userId = ctx.from!.id;
  const parts = data.split(':');
  // data format: reaction:{projectId}:{roundNumber}:{reaction}
  const roundNumber = Number.parseInt(parts[2] ?? '', 10);
  const reaction = parts[3] ?? 'unknown';

  if (!Number.isFinite(roundNumber) || !isValidReportReaction(reaction)) {
    await ctx.answerCallbackQuery('This report reaction is stale.', { show_alert: true });
    return;
  }

  // Store reaction in DB
  try {
    const { engagementEvents, members, users } = await import('../../data/schema/projects');
    const [member] = await db
      .select({ id: members.id })
      .from(members)
      .innerJoin(users, eq(members.userId, users.id))
      .where(and(eq(users.telegramId, userId), eq(members.projectId, projectId)))
      .limit(1);

    if (!member) {
      await ctx.answerCallbackQuery('Open the project bot invite first so I can connect your reaction.', { show_alert: true });
      return;
    }

    await db.insert(engagementEvents).values({
      memberId: member.id,
      projectId,
      eventType: 'report_reaction',
      metadata: {
        roundNumber,
        reaction,
        chatId: ctx.chat?.id,
        messageId: ctx.callbackQuery.message?.message_id,
      } as Record<string, unknown>,
    });
    await ctx.answerCallbackQuery('Reaction saved.');
  } catch (err) {
    console.error('[Reaction] Failed to store reaction:', err);
  }
}

async function saveResponseForProject(
  userId: number,
  projectId: string,
  roundId: string,
  questionId: string,
  text: string
): Promise<void> {
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
  } catch (err) {
    console.error('[saveResponse] Failed:', err);
  }
}
