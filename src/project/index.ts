/**
 * Zolara Bot — consolidated single bot handler
 * Handles both admin commands and member interactions on @Zolara_bot
 *
 * Admin flow: /create, /startround, /cancelround, /projects, /members, /invite, /status
 * Member flow: /start claim_xxx → commitment → onboarding → question answering
 */

import { Bot, InlineKeyboard } from 'grammy';
import { config } from '../config';
import { llm } from '../engine/llm/minimax';
import { redis } from '../data/redis';
import { db } from '../data/db';
import { projects, admins, members, rounds } from '../data/schema/projects';
import { eq, desc, and } from 'drizzle-orm';
import { logger, warn, round as roundLog, db as dbLog } from '../util/logger';
import { triggerRound, cancelRound } from '../engine/round-manager';
import { validateAndTriggerRound } from '../engine/phases/phase-2-problem-def';
import { isPhaseActive } from '../engine/phases/flags';
import { setRuntimeFlag, listRuntimeFlags } from '../util/runtime-flags';
import {
  handleAddAdminCommand,
  handleRemoveAdminCommand,
  handleTransferOwnershipCommand,
  handleAdminsCommand,
  handleSettingsCommand,
  handleSettingsCallback,
  handleSettingsReply,
} from '../manager/admin-management';
import { encrypt, hashToken } from '../util/crypto';
import {
  InitiationState,
  nextStep,
  STEP_ORDER,
} from './flows/initiation-state';
import {
  handleInitiationStep,
  handleCallback,
} from './flows/initiation-steps';
import {
  handleClaimWelcome,
  handleClaimCallback,
  loadClaimState,
  saveClaimState,
  clearClaimState,
} from './flows/claim-steps';
import {
  OnboardingState,
  nextOnboardingStep,
} from './flows/onboarding-state';
import {
  handleOnboardingStep,
  loadOnboardingState,
  saveOnboardingState,
  clearOnboardingState,
} from './flows/onboarding-steps';

// ── Bot ───────────────────────────────────────────────────────────────────────

const zolaraBot = new Bot(config.ZOLARA_BOT_TOKEN);

// ── State helpers ─────────────────────────────────────────────────────────────

async function loadInitState(telegramId: number): Promise<InitiationState | null> {
  const raw = await redis.get(`init:${telegramId}`);
  return raw ? JSON.parse(raw) : null;
}

async function saveInitState(state: InitiationState): Promise<void> {
  await redis.setex(`init:${state.telegramId}`, 86400, JSON.stringify(state));
}

async function clearInitState(telegramId: number): Promise<void> {
  await redis.del(`init:${telegramId}`);
}

// ── Commands: Admin ───────────────────────────────────────────────────────────

zolaraBot.command('start', async (ctx) => {
  await ctx.reply(
    '🌀 *Zolara* — AI Consensus Engine\n\n' +
    'I help teams find alignment through structured perspective gathering.\n\n' +
    '/create — Set up a new project\n' +
    '/projects — View your active projects\n' +
    '/startround — Trigger a perspective round\n' +
    '/help — Learn more',
    { parse_mode: 'Markdown' }
  );
});

zolaraBot.command('help', async (ctx) => {
  await ctx.reply(
    '*How Zolara Works*\n\n' +
    '1️⃣ *Create* a project and bot for your team (/create)\n' +
    '2️⃣ *Invite* members via the link from /invite\n' +
    '3️⃣ *Start a round* to gather perspectives (/startround)\n' +
    '4️⃣ *Receive* an AI synthesis report in your group\n' +
    '5️⃣ *Deepen* alignment through follow-up rounds',
    { parse_mode: 'Markdown' }
  );
});

zolaraBot.command('create', async (ctx) => {
  const userId = ctx.from!.id;
  const state: InitiationState = {
    step: 'greeting',
    config: {},
    telegramId: userId,
    createdAt: new Date().toISOString(),
  };
  await saveInitState(state);
  await handleInitiationStep(ctx, state);
});

zolaraBot.command('cancel', async (ctx) => {
  const userId = ctx.from!.id;
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

async function resolveAdminProject(adminTelegramId: number): Promise<{
  project: { id: string; name: string; status: string } | null;
  hasMultiple: boolean;
  choices: Array<{ id: string; name: string; status: string }>;
}> {
  const rows = await db
    .select({ id: projects.id, name: projects.name, status: projects.status })
    .from(projects)
    .innerJoin(admins, eq(admins.id, projects.adminId))
    .where(eq(admins.telegramId, adminTelegramId))
    .orderBy(desc(projects.createdAt))
    .limit(10);

  if (rows.length === 0) return { project: null, hasMultiple: false, choices: [] };
  const active = rows.filter((r) => r.status === 'active');
  const first = active[0] ?? rows[0];
  const project: { id: string; name: string; status: string } = {
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
  const { project, hasMultiple, choices } = await resolveAdminProject(ctx.from!.id);

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
  const [round] = await db.select({ id: rounds.id, roundNumber: rounds.roundNumber, status: rounds.status } as any).from(rounds).where(eq(rounds.projectId, project.id)).limit(1);
  const status = round ? `Round #${round.roundNumber} — *${round.status}*` : 'No active round';

  await ctx.reply(`*${project.name}*\n\nStatus: ${project.status}\nCurrent round: ${status}`, { parse_mode: 'Markdown' });
});

zolaraBot.command('startround', async (ctx) => {
  const telegramId = ctx.from!.id;
  const { project, hasMultiple } = await resolveAdminProject(telegramId);

  if (!project) {
    await ctx.reply("You don't have any projects yet. Use /create to set one up.");
    return;
  }

  const topic = (ctx.match as string).trim() || 'General check-in';

  try {
    // Use Phase 2 validation flow if flag is active, otherwise fall back to baseline
    if (isPhaseActive('PHASE_PROBLEM_DEF')) {
      const result = await validateAndTriggerRound(project.id, topic);
      if (result.validationStatus === 'voting') {
        await ctx.reply(
          `🗳 *Validation started for "${topic}"*

` +
          `Your team is being asked to confirm the topic is clearly defined before we explore it.
` +
          `Voting open for 24h. You'll be notified when the vote completes.\n\n` +
          `Problem Definition ID: ${result.problemDefinitionId?.slice(0, 8)}...`,
          { parse_mode: 'Markdown' }
        );
      } else {
        await ctx.reply(result.message);
      }
    } else {
      const { roundId } = await triggerRound(project.id, topic);
      await ctx.reply(
        `🎯 *Round started!*\n\nProject: *${project.name}*\nTopic: ${topic}\nRound ID: ${roundId.slice(0, 8)}...\n\n` +
        `Committed members are being sent questions via DM.`,
        { parse_mode: 'Markdown' }
      );
    }
  } catch (err) {
    await ctx.reply(`⚠️ Could not start round: ${err instanceof Error ? err.message : String(err)}`);
  }
});

zolaraBot.command('cancelround', async (ctx) => {
  const { project } = await resolveAdminProject(ctx.from!.id);
  if (!project) { await ctx.reply("You don't have any projects yet."); return; }

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
  } catch (err) {
    await ctx.reply(`⚠️ Could not cancel round: ${err instanceof Error ? err.message : String(err)}`);
  }
});

zolaraBot.command('members', async (ctx) => {
  const { project } = await resolveAdminProject(ctx.from!.id);
  if (!project) { await ctx.reply("You don't have any projects yet."); return; }

  const memberRows = await db
    .select({ role: members.role, onboardingStatus: members.onboardingStatus })
    .from(members)
    .where(eq(members.projectId, project.id as any))
    .limit(50);

  const committed = memberRows.filter((m) => m.onboardingStatus === 'committed').length;
  const pending = memberRows.length - committed;
  const lines = memberRows.slice(0, 20).map((m, i) => {
    const icon = m.onboardingStatus === 'committed' ? '✅' : '⏳';
    return `${i + 1}. ${m.role ?? 'participant'} ${icon}`;
  }).join('\n');

  await ctx.reply(
    `*${project.name} — Members*\n\nTotal: ${memberRows.length} | Committed: ${committed} | Pending: ${pending}\n\n${lines || 'No members yet.'}`,
    { parse_mode: 'Markdown' }
  );
});

zolaraBot.command('invite', async (ctx) => {
  const { project } = await resolveAdminProject(ctx.from!.id);
  if (!project) { await ctx.reply("You don't have any projects yet."); return; }

  // Always use @Zolara_bot for invite links (single-bot mode)
  const inviteLink = `https://t.me/Zolara_bot?start=claim_${project.id}`;

  await ctx.reply(
    `*${project.name} - Invite Link*\n\nShare this with your team:\n\n${inviteLink}\n\nMembers tap "Yes, I'm in" to join and receive questions.`,
    { parse_mode: 'Markdown' }
  );
});

zolaraBot.command('status', async (ctx) => {
  const { project } = await resolveAdminProject(ctx.from!.id);
  if (!project) { await ctx.reply("You don't have any projects yet."); return; }

  const [round] = await db.select({ id: rounds.id, roundNumber: rounds.roundNumber, status: rounds.status, responseCount: rounds.responseCount, memberCount: rounds.memberCount, topic: rounds.topic } as any).from(rounds).where(eq(rounds.projectId, project.id)).limit(1);

  if (!round) {
    await ctx.reply(`*${project.name}*\n\nNo active round. Use /startround to begin.`, { parse_mode: 'Markdown' });
    return;
  }

  const responseCount = round.responseCount ?? 0;
  const memberCount = round.memberCount ?? 0;
  const rstatus = round.status ?? 'unknown';

  await ctx.reply(
    `*${project.name}*\n\nRound #${round.roundNumber}\nStatus: *${rstatus}*\nResponses: ${responseCount}/${memberCount}\nTopic: ${round.topic ?? '—'}`,
    { parse_mode: 'Markdown' }
  );
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

const PHASE_SHORT: Record<string, string> = {
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
function buildPhaseKeyboard(flags: Record<string, string>): InlineKeyboard {
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
function buildPhaseDetailKeyboard(key: string, currentValue: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  const descriptions: Record<string, string> = {
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
  } else {
    kb.text('🟢 Enable', `phase:toggle:${key}`);
  }
  return kb;
}

// /setphase — show phase control panel
zolaraBot.command('setphase', async (ctx) => {
  const { project } = await resolveAdminProject(ctx.from!.id);
  if (!project) { await ctx.reply('❌ Admin access required.'); return; }

  const flags = listRuntimeFlags();
  const lines = Object.entries(flags).map(([key, value]) => {
    const icon = value === 'active' ? '🟢' : '⚪';
    return `${icon} *${key}* → ${value}`;
  });

  await ctx.reply(
    `🔧 *Phase Flags*\n\n${lines.join('\n')}\n\n` +
    `Tap a phase to enable/disable it.`,
    {
      parse_mode: 'Markdown' as const,
      reply_markup: buildPhaseKeyboard(flags),
    }
  );
});

// Alias
zolaraBot.command('phase', async (ctx) => {
  // Just redirect to /setphase
  const { project } = await resolveAdminProject(ctx.from!.id);
  if (!project) { await ctx.reply('❌ Admin access required.'); return; }
  const flags = listRuntimeFlags();
  await ctx.reply('🔧 *Phase Flags*\n\nSelect a phase to manage:', {
    parse_mode: 'Markdown',
    reply_markup: buildPhaseKeyboard(flags),
  });
});

// ── Callbacks ─────────────────────────────────────────────────────────────────

zolaraBot.on('callback_query:data', async (ctx) => {
  const data = ctx.callbackQuery.data;
  if (!data) return;
  const userId = ctx.from!.id;

  // Admin group confirmation callbacks
  if (data.startsWith('admin:confirm_group:') || data.startsWith('admin:reject_group:')) {
    const { project } = await resolveAdminProject(userId);
    if (!project) { await ctx.answerCallbackQuery('No project found.'); return; }
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
    if (!state) { await ctx.answerCallbackQuery('Session expired. Use /create to start again.'); return; }
    const newState = await handleCallback(ctx, state, data);
    if (!newState) return;
    await saveInitState(newState);
    await handleInitiationStep(ctx, newState);
    return;
  }

  // Claim flow callbacks (member commitment)
  if (data.startsWith('claim:')) {
    const state = await loadClaimState(userId);
    if (!state) { await ctx.answerCallbackQuery('Session expired. Send /start to begin again.'); return; }
    await handleClaimCallback(ctx, state, data);
    return;
  }

  // Onboarding callbacks (member profile)
  if (data.startsWith('onboard:')) {
    const state = await loadOnboardingState(userId);
    if (!state) { await ctx.answerCallbackQuery('Session expired. Send /start to begin again.'); return; }
    await handleOnboardingCallback(ctx, state, data);
    return;
  }

  // Report reaction callbacks (group members reacting to synthesis)
  if (data.startsWith('reaction:')) {
    const [, projectId, roundNumber, reaction] = data.split(':') as [string, string, string, string];
    await ctx.answerCallbackQuery(`You reacted: ${reaction}`);
    // Store reaction in DB
    try {
      const { engagementEvents } = await import('../data/schema/projects');
      const { db } = await import('../data/db');
      const { users, members } = await import('../data/schema/projects');
      const { eq } = await import('drizzle-orm');

      // Find member by telegram ID
      const [memberRow] = await db
        .select({ memberId: members.id })
        .from(members)
        .innerJoin(users, eq(members.userId, users.id))
        .where(eq(users.telegramId, userId))
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
          } as Record<string, unknown>,
        });
      }
    } catch (err) {
      console.error('[Reaction] Failed to store reaction:', err);
    }
    return;
  }

  // Problem validation callbacks (Phase 2)
  if (data.startsWith('validate:')) {
    try {
      const { parseValidationCallback, handleVoteCallback, handleTopicCallback } =
        await import('../engine/phases/phase-2-problem-def/telegram-ui');

      const parsed = parseValidationCallback(data);
      if (!parsed) {
        await ctx.answerCallbackQuery('❌ Invalid callback');
        return;
      }

      if (parsed.action === 'vote') {
        const result = await handleVoteCallback(parsed.problemDefinitionId, parsed.vote!, userId);
        await ctx.answerCallbackQuery(result.text, { show_alert: result.alert } as any);
      } else if (parsed.action === 'topic') {
        const result = await handleTopicCallback(parsed.problemDefinitionId);
        await ctx.answerCallbackQuery(result.text, { show_alert: result.alert } as any);
      }
    } catch (err) {
      console.error('[Validation] Callback error:', err);
      await ctx.answerCallbackQuery('❌ Error processing vote');
    }
    return;
  }

  // Phase flag control callbacks
  if (data.startsWith('phase:')) {
    // Verify admin
    const { project } = await resolveAdminProject(userId);
    if (!project) { await ctx.answerCallbackQuery('❌ Admin access required.'); return; }

    const parts = data.split(':');
    const action = parts[1];

    if (action === 'refresh' || action === 'back') {
      const flags = listRuntimeFlags();
      await ctx.editMessageReplyMarkup({ reply_markup: buildPhaseKeyboard(flags) });
      await ctx.answerCallbackQuery('🔄 Refreshed');
      return;
    }

    if (action === 'detail') {
      const key = parts[2];
      if (!key || !VALID_PHASES.includes(key)) { await ctx.answerCallbackQuery('❌ Unknown phase'); return; }
      const flags = listRuntimeFlags();
      const value = flags[key] ?? 'disabled';
      await ctx.editMessageReplyMarkup({ reply_markup: buildPhaseDetailKeyboard(key, value) });
      await ctx.answerCallbackQuery(PHASE_SHORT[key] ?? key);
      return;
    }

    if (action === 'toggle') {
      const key = parts[2];
      if (!key || !VALID_PHASES.includes(key)) { await ctx.answerCallbackQuery('❌ Unknown phase'); return; }
      const flags = listRuntimeFlags();
      const current = flags[key] ?? 'disabled';
      const next = current === 'active' ? 'disabled' : 'active';
      setRuntimeFlag(key, next);
      const updatedFlags = listRuntimeFlags();
      await ctx.editMessageReplyMarkup({ reply_markup: buildPhaseKeyboard(updatedFlags) });
      const label = PHASE_SHORT[key] ?? key;
      await ctx.answerCallbackQuery(`✅ ${label} → ${next}`, { show_alert: true } as any);
      return;
    }

    if (action === 'noop') {
      await ctx.answerCallbackQuery(' ');
      return;
    }

    await ctx.answerCallbackQuery(' ');
    return;
  }
});

async function handleAdminGroupCallback(ctx: any, data: string, adminTelegramId: number, projectId: string): Promise<void> {
  const action = data.split(':')[1];
  const detectData = await redis.get(`group_detect:${projectId}`);
  if (!detectData) { await ctx.answerCallbackQuery('Session expired.'); return; }
  const { groupId, groupTitle } = JSON.parse(detectData) as { groupId: number; groupTitle: string };

  if (action === 'confirm') {
    await db.update(projects).set({ groupIds: [groupId] }).where(eq(projects.id, projectId as any));
    await redis.del(`group_detect:${projectId}`);
    await ctx.answerCallbackQuery(`✅ Reports will go to ${groupTitle}`);
    await ctx.reply(`✅ *Group set!*\n\nRound reports will now be posted to *${groupTitle}*.`, { parse_mode: 'Markdown' });
  } else {
    await redis.del(`group_detect:${projectId}`);
    await ctx.answerCallbackQuery('Dismissed.');
    await ctx.reply('No problem. When I\'m added to the correct group, I\'ll ask again.');
  }
}

// ── Member: /start with claim_ routing ───────────────────────────────────────

zolaraBot.command('start', async (ctx) => {
  const args = (ctx.match as string) || '';
  const userId = ctx.from!.id;

  // Pattern: /start claim_xxx → member commitment gate
  if (args.startsWith('claim_')) {
    const projectId = args.replace('claim_', '').trim();
    if (projectId) { await handleMemberClaim(ctx, userId, projectId); return; }
  }

  // Pattern: /start join_xxx → legacy, redirect to claim
  if (args.startsWith('join_')) {
    const projectId = args.replace('join_', '').trim();
    if (projectId) { await handleMemberClaim(ctx, userId, projectId); return; }
  }

  // Pattern: /start createbot_xxx → user confirmed bot creation via BotFather
  // This is sent after the user clicks the creation link in the creation flow
  if (args.startsWith('createbot_')) {
    const projectId = args.replace('createbot_', '').trim();
    if (projectId) {
      // Look up project and check if bot is already finalized
      const [proj] = await db.select({
        botTelegramId: projects.botTelegramId,
        name: projects.name,
      }).from(projects).where(eq(projects.id, projectId)).limit(1);
      if (proj?.botTelegramId) {
        // Bot already created and finalized
        await ctx.reply(
          `✅ Bot already created for *${proj.name}*!\n\n` +
          `Meet @Zolara_bot — your project's assistant is ready.`,
          { parse_mode: 'Markdown' }
        );
      } else {
        // Bot not yet created — guide user
        await ctx.reply(
          `🔧 To create your project bot, click the link in the /create flow message.\n\n` +
          `Once your bot is created, come back here and we'll complete the setup!`
        );
      }
      return;
    }
  }

  // Regular /start
  await ctx.reply(
    '🏠 *Welcome to Zolara*\n\n' +
    'Your team\'s AI consensus engine.\n\n' +
    '/help — Learn more\n' +
    '/status — Current round status\n' +
    '/profile — Your member profile',
    { parse_mode: 'Markdown' }
  );
});

// ── Managed Bot Creation & Group Auto-Detection ────────────────────────────────
// Two distinct events come through my_chat_member:
// 1. managed_bot_created: new bot was created via creation link (chat=private, new_member=bot)
// 2. group_added: admin added @Zolara_bot to a group (chat=group/supergroup)

zolaraBot.on('my_chat_member', async (ctx) => {
  const update = ctx.update as any;
  const myChatMember = update?.my_chat_member;
  if (!myChatMember) return;

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
      await ctx.api.sendMessage(
        fromId,
        `🎉 Your project bot is ready!\n\n` +
        `Meet @${botUsername} — the dedicated bot for *${projectName}*.\n\n` +
        `Next steps:\n` +
        `1️⃣ Add @${botUsername} to your project's group chat\n` +
        `2️⃣ I'll automatically detect the group and set it as the report destination\n` +
        `3️⃣ Share this invite link with your team members:\n` +
        `👉 https://t.me/${botUsername}?start=claim_${projectId}\n\n` +
        `Run /startround when your team is ready for the first round!`,
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      console.error('[Zolara] Failed to finalize managed bot:', err);
    }
    return;
  }

  // EVENT 2: @Zolara_bot was added to a group (group auto-detection)
  if (chatType !== 'group' && chatType !== 'supergroup') return;
  if (newStatus === 'kicked' || newStatus === 'left') return;
  if (oldStatus === 'member' || oldStatus === 'administrator') return;

  const groupTitle = chat.title ?? 'this group';

  // Look up pending project by admin telegramId
  let projectId: string | null = null;
  let projectName: string | null = null;

  if (fromId) {
    const pending = await redis.get(`pending:${fromId}`);
    if (pending) {
      const data = JSON.parse(pending) as { projectId: string; name: string };
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
    await ctx.api.sendMessage(chat.id,
      `👋 Hi everyone! I'm Zolara — AI consensus engine.\n\n` +
      `Your admin needs to set up a project first via DM to @Zolara_bot (/create).`,
      { parse_mode: 'Markdown' }
    );
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
      if (botInfo.username) inviteBotUsername = botInfo.username;
    } catch { /* keep fallback */ }
  }

  // Update the project's group ID
  await db.update(projects).set({ groupIds: [chat.id] }).where(eq(projects.id, projectId as any));

  // Notify admin in DM
  if (fromId) {
    await redis.del(`pending:${fromId}`);
    await ctx.api.sendMessage(fromId,
      `✅ *${groupTitle}* set as your report group!\n\n` +
      `You can now share the invite with your team:\n` +
      `👉 https://t.me/${inviteBotUsername}?start=claim_${projectId}\n\n` +
      `Members join → you run /startround → synthesis report posts here.`,
      { parse_mode: 'Markdown' }
    );
  }

  await ctx.api.sendMessage(chat.id,
    `👋 *${groupTitle}* is now the report destination for *${projectName}*!\n\n` +
    `Round reports will be posted here when your admin starts a round.`,
    { parse_mode: 'Markdown' }
  );
});


// ── Managed Bot Created (via deep link) ─────────────────────────────────────
// Telegram sends a message with managed_bot_created: true when user approves
// the bot creation in the BotFather UI

zolaraBot.on('message:managed_bot_created', async (ctx) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const msg = ctx.update.message as any;
  const managed = msg.managed_bot_created;
  if (!managed?.bot?.is_bot) return;

  const botUser = managed.bot;
  const adminTelegramId = ctx.from!.id;

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

    await ctx.reply(
      `🎉 Your project bot is live!\n\n` +
      `Meet @${botUsername} — the dedicated bot for ${projectName}.\n\n` +
      `Next steps:\n` +
      `1️⃣ Add @${botUsername} to your project's group chat\n` +
      `2️⃣ I'll automatically detect the group and set it as the report destination\n` +
      `3️⃣ Share this invite link with your team members:\n` +
      `👉 https://t.me/${botUsername}?start=claim_${projectId}\n\n` +
      `Run /startround when your team is ready!`
    );
  } catch (err) {
    console.error('[Zolara] Failed to finalize managed bot:', err);
    await ctx.reply('⚠️ Bot created but setup failed. Contact support.');
  }
});

// ── Text messages (non-command) ──────────────────────────────────────────────

zolaraBot.on('message:text', async (ctx) => {
  const text = ctx.message.text;

  // Skip for commands (let command handler take over)
  if (text.startsWith('/')) return;

  // In groups: respond to @mentions, ignore everything else
  const isGroup = ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';
  if (isGroup) {
    const mentions = ctx.message.entities?.filter(e => e.type === 'text_mention' || e.type === 'mention');
    const hasMention = mentions?.some(e => e.type === 'text_mention' ? e.user?.id === ctx.me.id : true);
    if (!hasMention) return;
  }

  const userId = ctx.from!.id;

  // Private DM: handle initiation flow text input
  const initState = await loadInitState(userId);
  if (initState) {
    await handleInitiationText(ctx, initState, text);
    return;
  }

  // Settings reply (admin typing a new value in the interactive settings flow)
  await handleSettingsReply(ctx);

  // Question answering session (member replying to a DM question from a round)
  const qState = await redis.get(`q:${userId}`);
  if (qState) {
    const { questionId, roundId, projectId } = JSON.parse(qState) as { questionId: string; roundId: string; projectId: string };
    await redis.del(`q:${userId}`);
    await saveResponse(userId, projectId, roundId, questionId, text);
    await ctx.reply(
      '✅ Received! Your perspective has been recorded.\n\n' +
      'The synthesis will be posted to your group when the round closes.',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // Fallback for DMs only — basic help prompt
  // (No free chat; keep Zolara focused on the structured process)
  await ctx.reply(
    '👋 I\'m here to help with the Zolara consensus process.\n\n' +
    '/help — See available commands\n' +
    '/create — Set up a project',
    { parse_mode: 'Markdown' }
  );
});

// ── Member Claim Flow ──────────────────────────────────────────────────────────

async function handleMemberClaim(ctx: any, userId: number, projectId: string): Promise<void> {
  const [project] = await db.select({ id: projects.id, name: projects.name, config: projects.config }).from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) {
    await ctx.reply('⚠️ This project link is invalid or has expired. Ask your admin for a new invite link.');
    return;
  }

  // Check if already committed
  const [existing] = await db
    .select({ onboardingStatus: members.onboardingStatus })
    .from(members)
    .where(and(eq(members.projectId, projectId as any), eq(members.userId, userId as any)))
    .limit(1);

  if (existing && existing.onboardingStatus === 'committed') {
    await ctx.reply(`✅ You're already committed to *${project.name}*.\n\nA round will start soon. I'll DM you when it does.`, { parse_mode: 'Markdown' });
    return;
  }

  const projectConfig = (project.config as unknown) as Record<string, unknown> ?? {}; const anonymity = (projectConfig['anonymity'] as 'full' | 'optional' | 'attributed') ?? 'optional'; const state = { phase: 'claim' as const, projectId, projectName: project.name ?? 'this project', telegramId: userId, claimStartedAt: new Date().toISOString(), anonymity };
  await saveClaimState(state);
  await handleClaimWelcome(ctx, state);
}

// ── Initiation text handling ──────────────────────────────────────────────────

async function handleInitiationText(ctx: any, state: InitiationState, text: string): Promise<void> {
  switch (state.step) {
    case 'project_name': {
      if (text.trim().length < 2) { await ctx.reply('Please enter at least 2 characters.'); return; }
      state.config = { ...state.config, name: text.trim() };
      state.step = nextStep(state.step);
      await saveInitState(state);
      await handleInitiationStep(ctx, state);
      break;
    }
    case 'project_goal': {
      if (text.trim().length < 10) { await ctx.reply('Could you elaborate a bit more? I need to understand this well.'); return; }
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

async function saveResponse(userId: number, projectId: string, roundId: string, questionId: string, text: string): Promise<void> {
  const { responses } = await import('../data/schema/projects');
  try {
    await db.insert(responses).values({
      questionId: questionId as any,
      memberId: userId as any,
      responseText: text.slice(0, 5000),
      createdAt: new Date(),
    });
  } catch (err) {
    dbLog.insertFailed('responses', { userId, projectId }, err);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function resolveProjectIdFromBot(botTelegramId: number): Promise<string | null> {
  const [p] = await db.select({ id: projects.id }).from(projects).where(eq(projects.botTelegramId, botTelegramId)).limit(1);
  return p?.id ?? null;
}

// ── Onboarding callback stub ──────────────────────────────────────────────────

async function handleOnboardingCallback(ctx: any, state: OnboardingState, data: string): Promise<void> {
  await ctx.answerCallbackQuery('Onboarding in progress...');
}

// ── Exports ───────────────────────────────────────────────────────────────────

export async function handleZolaraWebhook(update: unknown): Promise<void> {
  await zolaraBot.handleUpdate(update as any);
}

/**
 * Handle incoming updates from a managed project bot (via webhook).
 * Creates a scoped Bot instance for the project and processes the update.
 *
 * @param update Raw Telegram update
 * @param projectId Project context for this bot
 * @param botToken Decrypted bot token for this project (null = Zolara control bot)
 */
export async function handleProjectBotUpdate(
  update: unknown,
  projectId: string,
  botToken: string | null
): Promise<void> {
  // Import the project bot dynamically to avoid circular deps
  // The project bot is created fresh per-project using its own token
  const { createProjectBot } = await import('./managed-bots/bot-instance');
  const botInstance = await createProjectBot(botToken, projectId);
  await botInstance.handleUpdate(update as any);
}

export async function startZolaraPolling(): Promise<void> {
  console.log('[Zolara] Starting polling — @Zolara_bot is live!');

  // Start nudge reminder scheduler — checks every 30 minutes for rounds needing reminders
  scheduleNudgeReminders();

  await zolaraBot.start();
}

/**
 * Periodically check active gathering rounds and send nudge reminders to non-responding members.
 */
async function scheduleNudgeReminders(): Promise<void> {
  const CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

  const check = async () => {
    try {
      await checkAndSendNudges();
    } catch (err) {
      console.error('[NudgeScheduler] Error:', err);
    }
  };

  // Run immediately on startup, then on interval
  await check();
  setInterval(check, CHECK_INTERVAL_MS);
}

async function checkAndSendNudges(): Promise<void> {
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
    if (!round.startedAt) continue;

    const config = round.metadata as Record<string, unknown>;
    const nudgeAfterHours = (config['nudgeAfterHours'] as number) ?? 24;
    const nudgeAfterMs = nudgeAfterHours * 60 * 60 * 1000;
    const shouldNudge = Date.now() - new Date(round.startedAt).getTime() > nudgeAfterMs;

    if (!shouldNudge) continue;

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
      .where(eq(members.projectId, round.projectId as any))
      .limit(100);

    for (const member of membersResult) {
      // Skip members who have already responded
      if (!member.telegramId || respondedIds.has(member.memberId)) continue;
      if (!round.projectId) continue;
      await sendReminderDM(round.projectId, member.telegramId, round.roundNumber ?? 1, nudgeCount + 1);
    }

    // Increment nudge count
    await redis.setex(nudgeKey, 86400 * 3, String(nudgeCount + 1));
    console.log(`[NudgeScheduler] Sent nudge ${nudgeCount + 1} for round ${round.id}`);
  }
}