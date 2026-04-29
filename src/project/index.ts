/**
 * Zolara Bot — admin control plane
 * Handles admin commands via @Zolara_bot (long polling).
 * Member interactions on project bots route through webhook via server/index.ts.
 *
 * Admin flow: /create, /startround, /cancelround, /projects, /members, /invite, /status
 * Member flow: /start claim_xxx → commitment → onboarding → question answering
 */

import { Bot, InlineKeyboard } from 'grammy';

// ── Helpers ─────────────────────────────────────────────────────────────────────

/**
 * Use ctx.api.answerCallbackQuery to avoid grammY internal
 * abort-signal conflicts when answering a callback multiple times.
 */
async function answerCb(ctx: any, text: string, showAlert = false): Promise<void> {
  await ctx.api.answerCallbackQuery(ctx.callbackQuery!.id, { text, show_alert: showAlert });
}

import { config } from '../config';
import { llm } from '../engine/llm/minimax';
import { redis } from '../data/redis';
import { db } from '../data/db';
import { projects, admins, members, rounds, questions, responses, users, problemDefinitions, problemDefinitionVotes } from '../data/schema/projects';
import { eq, desc, and, ne, or, isNull } from 'drizzle-orm';
import { logger, warn, round as roundLog, db as dbLog } from '../util/logger';
import { triggerRound, cancelRound } from '../engine/round-manager';
import { findLatestNeedsWorkValidation, refinedTopicCommandTemplate, startRefinedValidation, validateAndTriggerRound } from '../engine/phases/phase-2-problem-def';
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
} from './flows/onboarding-state';
import {
  handleOnboardingStep,
  handleOnboardingText,
  loadOnboardingState,
  saveOnboardingState,
  clearOnboardingState,
  restartOnboardingState,
  sendOnboardingStaleCallbackHelp,
} from './flows/onboarding-steps';
import { handleAIHelp } from './ai-help';
import { suspendProjectAgent, restoreProjectAgent, deleteProjectAgent } from './agent/project-agent';
import { sendMessage } from '../util/telegram-sender';
import {
  dashboardNextAction,
  escapeHtml,
  formatOnboardingBreakdown,
  formatValidationHistory,
  missingResponses as calculateMissingResponses,
  pickCurrentRound,
  recommendAdminNextAction,
  summarizeOnboarding,
} from './dashboard';

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
  if (args.startsWith('createbot_')) {
    const projectId = args.replace('createbot_', '').trim();
    if (projectId) {
      const [proj] = await db.select({
        botTelegramId: projects.botTelegramId,
        name: projects.name,
        botUsername: projects.botUsername,
      }).from(projects).where(eq(projects.id, projectId)).limit(1);

      if (proj?.botTelegramId) {
        const username = proj.botUsername ? `@${proj.botUsername}` : 'your project bot';
        await ctx.reply(
          `✅ Bot already created for *${proj.name}*!\n\n` +
          `Meet ${username} — your project's assistant is ready.`,
          { parse_mode: 'Markdown' }
        );
      } else {
        await ctx.reply(
          `🔧 To create your project bot, click the link in the /create flow message.\n\n` +
          `Once your bot is created, come back here and we'll complete the setup!`
        );
      }
      return;
    }
  }

  await ctx.reply(
    '🌀 *Zolara* — AI Consensus Engine\n\n' +
    'I help teams find alignment through structured perspective gathering.\n\n' +
    '/create — Set up a new project\n' +
    '/projects — View your active projects\n' +
    '/startround — Trigger a perspective round\n' +
    '/next — See the one best next admin action\n' +
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
    '5️⃣ *Deepen* alignment through follow-up rounds\n\n' +
    '💬 Ask me anything in natural language — type your question below!',
    { parse_mode: 'Markdown' }
  );
});

zolaraBot.command('helpme', async (ctx) => {
  const raw = (ctx.message as any)?.text ?? '';
  const msg = raw.replace('/helpme', '').trim();
  await handleAIHelp(ctx, ctx.from!.id, msg || 'What can you help me with?');
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


zolaraBot.command('restart_onboarding', async (ctx) => {
  const userId = ctx.from!.id;
  const active = await loadOnboardingState(userId);
  let projectId = active?.projectId;

  if (!projectId) {
    const rows = await db
      .select({ projectId: members.projectId, projectName: projects.name })
      .from(members)
      .innerJoin(users, eq(members.userId, users.id))
      .innerJoin(projects, eq(members.projectId, projects.id))
      .where(eq(users.telegramId, userId))
      .limit(2);

    if (rows.length === 0) {
      await ctx.reply('I could not find a project membership to restart. Please use your project invite link first.');
      return;
    }

    if (rows.length > 1) {
      await ctx.reply('You are in more than one project. Please run /restart_onboarding inside the specific project bot you want to reset.');
      return;
    }

    if (!rows[0].projectId) {
      await ctx.reply('I could not resolve that project membership. Please ask your admin for a fresh invite link.');
      return;
    }
    projectId = rows[0].projectId;
  }

  if (!projectId) {
    await ctx.reply('I could not resolve that project membership. Please ask your admin for a fresh invite link.');
    return;
  }

  await clearClaimState(userId);
  const state = await restartOnboardingState(userId, projectId);
  if (!state) {
    await ctx.reply('I could not find your membership for this project yet. Please use your project invite link first.');
    return;
  }

  await ctx.reply('🔄 Restarting onboarding. I cleared your in-progress onboarding answers for this project.');
  await handleOnboardingStep(ctx, state);
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

/**
 * Redis key for admin's currently selected project (30min TTL).
 */
const PROJECT_SELECTION_TTL = 1800; // 30 minutes

function projectSelectionKey(telegramId: number): string {
  return `selected_project:${telegramId}`;
}

/**
 * Build an inline keyboard for project selection.
 */

function statusIcon(s: string): string {
  if (s === 'active') return '🟢';
  if (s === 'archived') return '🟠';
  if (s === 'pending') return '🟡';
  return '⚪';
}

function buildProjectKeyboard(
  choices: Array<{ id: string; name: string; status: string }>,
  selectedId?: string
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const p of choices) {
    if (p.status === 'deleted') continue; // never show deleted in list
    const icon = statusIcon(p.status);
    const check = p.id === selectedId ? ' ✅' : '';
    kb.text(`${icon} ${p.name}${check}`, `project:select:${p.id}`).text('⚙️', `project:manage:${p.id}`).row();
  }
  return kb;
}

/**
 * Build an inline keyboard for project management (⚙️ button → status-aware actions)
 * active   → Archive / Delete
 * archived → Restore / Delete
 * pending  → Delete (nothing to archive yet)
 */
function buildProjectManageKeyboard(projectId: string, status: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (status === 'active') {
    kb.text('📦 Archive', `project:archive:${projectId}`).text('🗑 Delete', `project:delete:${projectId}`).row();
  } else if (status === 'archived') {
    kb.text('↩️ Restore', `project:restore:${projectId}`).text('🗑 Delete', `project:delete:${projectId}`).row();
  } else if (status === 'pending') {
    kb.text('🗑 Delete', `project:delete:${projectId}`).row();
  }
  kb.text('🔙 Back', 'project:back');
  return kb;
}

/**
 * Resolve the admin's currently selected project.
 * Checks Redis cache first → falls back to default (active project or most recent).
 */
async function resolveAdminProject(adminTelegramId: number): Promise<{
  project: { id: string; name: string; status: string; botUsername?: string | null } | null;
  hasMultiple: boolean;
  choices: Array<{ id: string; name: string; status: string }>;
}> {
  // Check Redis cache first
  const cachedId = await redis.get(projectSelectionKey(adminTelegramId));
  if (cachedId) {
    const [row] = await db
      .select({ id: projects.id, name: projects.name, status: projects.status, botUsername: projects.botUsername })
      .from(projects)
      .where(eq(projects.id, cachedId))
      .limit(1);
    if (row) {
      return {
        project: { id: row.id, name: row.name ?? 'Unknown', status: row.status ?? 'pending', botUsername: row.botUsername },
        hasMultiple: false,
        choices: [],
      };
    }
    // Stale cache entry — delete it
    await redis.del(projectSelectionKey(adminTelegramId));
  }

  const rows = await db
    .select({ id: projects.id, name: projects.name, status: projects.status, botUsername: projects.botUsername })
    .from(projects)
    .innerJoin(admins, eq(admins.id, projects.adminId))
    .where(and(
      eq(admins.telegramId, adminTelegramId),
      ne(projects.status, 'deleted')
    ))
    .orderBy(desc(projects.createdAt))
    .limit(10);

  if (rows.length === 0) { console.log('[DEBUG resolveAdmin] no rows for telegramId', adminTelegramId); return { project: null, hasMultiple: false, choices: [] }; }
  console.log('[DEBUG resolveAdmin] got', rows.length, 'projects for', adminTelegramId);
  const active = rows.filter((r) => r.status === 'active');
  const first = active[0] ?? rows[0];
  const project: { id: string; name: string; status: string; botUsername?: string | null } = {
    id: first.id,
    name: first.name ?? 'Unknown',
    status: first.status ?? 'pending',
    botUsername: first.botUsername,
  };
  return {
    project,
    hasMultiple: rows.length > 1,
    choices: rows.map((r) => ({ id: r.id, name: r.name ?? 'Unknown', status: r.status ?? 'pending' })),
  };
}

zolaraBot.command('projects', async (ctx) => {
  const { project, hasMultiple, choices } = await resolveAdminProject(ctx.from!.id);
  console.log('[DEBUG /projects] telegramId=', ctx.from!.id, 'hasMultiple=', hasMultiple, 'choices count=', choices.length, 'project=', project?.name);

  if (!project) {
    await ctx.reply("You don't have any projects yet.\n\nUse /create to set one up.");
    return;
  }

  const allChoices = choices.length > 0 ? choices : (project ? [{ id: project.id, name: project.name, status: project.status }] : []);
  console.log('[DEBUG /projects] allChoices count=', allChoices.length);
  if (allChoices.length === 0) {
    await ctx.reply("You don't have any projects yet.\n\nUse /create to set one up.");
    return;
  }

  const escapeHtml = (t: string) => t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const lines = allChoices.map((p) => `${statusIcon(p.status)} ${escapeHtml(p.name)}`).join('\n');
  const selectedId = project?.id;
  await ctx.reply(
    `<b>Your projects:</b>\n\n${lines}\n\nTap a name to select it. Tap [Settings] to manage.`,
    {
      parse_mode: 'HTML',
      reply_markup: buildProjectKeyboard(allChoices, selectedId),
    }
  );
  return;
});

zolaraBot.command('startround', async (ctx) => {
  const telegramId = ctx.from!.id;
  const { project, hasMultiple } = await resolveAdminProject(telegramId);

  if (!project) {
    await ctx.reply("You don't have any projects yet. Use /create to set one up.");
    return;
  }

  const topic = (ctx.match as string).trim();
  if (!topic || topic.length < 12) {
    await ctx.reply(
      'Please start the round with a clear objective.\n\n' +
      'Example:\n' +
      '/startround Align on the first onboarding experience for new Zolara teams\n\n' +
      'The topic should describe what the team is trying to decide, understand, or improve.'
    );
    return;
  }

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

zolaraBot.command('refinetopic', async (ctx) => {
  const telegramId = ctx.from!.id;
  const { project } = await resolveAdminProject(telegramId);

  if (!project) {
    await ctx.reply("You don't have any projects yet. Use /create to set one up.");
    return;
  }

  const refinedTopic = (ctx.match as string).trim();
  if (!refinedTopic || refinedTopic.length < 12) {
    const latestNeedsWork = await findLatestNeedsWorkValidation(project.id);
    const suggested = latestNeedsWork?.refinedText
      ? `\n\nSuggested rewrite from Zolara:\n${refinedTopicCommandTemplate(latestNeedsWork.refinedText)}`
      : '';
    await ctx.reply(
      'Please send the refined topic after the command.\n\n' +
      'Example:\n' +
      '/refinetopic Decide how we should improve onboarding for the first 50 beta teams' +
      suggested
    );
    return;
  }

  try {
    const latestNeedsWork = await findLatestNeedsWorkValidation(project.id);
    if (!latestNeedsWork) {
      await ctx.reply(
        'No topic is currently waiting for refinement.\n\n' +
        'Use /startround <topic> to start a fresh validation, or /dashboard to see the current state.'
      );
      return;
    }

    const result = await startRefinedValidation(project.id, refinedTopic, latestNeedsWork.id);
    if (result.validationStatus === 'voting') {
      await ctx.reply(
        `🗳 Refined topic submitted.\n\n` +
        `Original: ${latestNeedsWork.topicText}\n\n` +
        `Refined: ${refinedTopic}\n\n` +
        `Zolara has started a new validation with the team. Voting is open for 24h.\n` +
        `New validation ID: ${result.problemDefinitionId?.slice(0, 8)}...`
      );
    } else {
      await ctx.reply(result.message);
    }
  } catch (err) {
    await ctx.reply(`⚠️ Could not submit refined topic: ${err instanceof Error ? err.message : String(err)}`);
  }
});

async function sendAdminGuide(ctx: any): Promise<void> {
  const { project } = await resolveAdminProject(ctx.from!.id);
  if (!project) { await ctx.reply('❌ Admin access required.'); return; }

  const latestNeedsWork = await findLatestNeedsWorkValidation(project.id);
  const refinementLine = latestNeedsWork
    ? `\n\nCurrent refinement needed:\nOriginal: ${latestNeedsWork.topicText}\nTry: ${refinedTopicCommandTemplate(latestNeedsWork.refinedText ?? '<clearer topic>')}`
    : '';

  await ctx.reply(
    `Zolara admin guide\n\n` +
    `/dashboard — see what is blocking progress\n` +
    `/next — show the one best next action\n` +
    `/startround <topic> — start validation for a new topic\n` +
    `/refinetopic <clearer topic> — rerun validation after a needs_work result\n` +
    `/members — see onboarding status\n` +
    `/invite — get the member invite link\n` +
    `/nudge — remind pending members / missing round responses\n` +
    `/cancelround — cancel an active gathering round` +
    refinementLine
  );
}

zolaraBot.command('adminguide', sendAdminGuide);
zolaraBot.command('admin_guide', sendAdminGuide);

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

  const complete = memberRows.filter((m) => m.onboardingStatus === 'complete').length;
  const pending = memberRows.length - complete;
  const lines = memberRows.slice(0, 20).map((m, i) => {
    const icon = m.onboardingStatus === 'complete' ? '✅' : '⏳';
    return `${i + 1}. ${m.role ?? 'participant'} ${icon} ${m.onboardingStatus ?? 'fresh'}`;
  }).join('\n');

  await ctx.reply(
    `*${project.name} — Members*\n\nTotal: ${memberRows.length} | Complete: ${complete} | Pending: ${pending}\n\n${lines || 'No members yet.'}`,
    { parse_mode: 'Markdown' }
  );
});

zolaraBot.command('invite', async (ctx) => {
  const { project } = await resolveAdminProject(ctx.from!.id);
  if (!project) { await ctx.reply("You don't have any projects yet."); return; }

  // Look up the project to get the actual bot username
  const [proj] = await db
    .select({ name: projects.name, botUsername: projects.botUsername })
    .from(projects)
    .where(eq(projects.id, project.id))
    .limit(1);

  const botUsername = proj?.botUsername ?? 'Zolara_bot';
  const inviteLink = `https://t.me/${botUsername}?start=claim_${project.id}`;

  await ctx.reply(
    `*${project.name} - Invite Link*\n\n` +
    `Share this with your team:\n\n` +
    `${inviteLink}\n\n` +
    `Members tap "Yes, I'm in" to join and receive questions.`,
    { parse_mode: 'Markdown' }
  );
});


zolaraBot.command('nudge', async (ctx) => {
  const { project } = await resolveAdminProject(ctx.from!.id);
  if (!project) { await ctx.reply("You don't have any projects yet."); return; }

  const [proj] = await db
    .select({ name: projects.name, botUsername: projects.botUsername })
    .from(projects)
    .where(eq(projects.id, project.id))
    .limit(1);

  const projectName = proj?.name ?? project.name;
  const inviteLink = `https://t.me/${proj?.botUsername ?? 'Zolara_bot'}?start=claim_${project.id}`;
  const messagesByUser = new Map<number, string[]>();

  const pendingOnboarding = await db
    .select({ telegramId: users.telegramId, role: members.role, onboardingStatus: members.onboardingStatus })
    .from(members)
    .innerJoin(users, eq(members.userId, users.id))
    .where(and(
      eq(members.projectId, project.id as any),
      or(ne(members.onboardingStatus, 'complete'), isNull(members.onboardingStatus))
    ))
    .limit(100);

  for (const member of pendingOnboarding) {
    const parts = messagesByUser.get(member.telegramId) ?? [];
    parts.push(
      `• Please finish onboarding for <b>${escapeHtml(projectName)}</b>. ` +
      `It takes about a minute and helps me ask better questions.\n${escapeHtml(inviteLink)}`
    );
    messagesByUser.set(member.telegramId, parts);
  }

  const [activeRound] = await db
    .select({ id: rounds.id, roundNumber: rounds.roundNumber, topic: rounds.topic, status: rounds.status })
    .from(rounds)
    .where(and(eq(rounds.projectId, project.id), eq(rounds.status, 'gathering')))
    .orderBy(desc(rounds.startedAt))
    .limit(1);

  let missingRoundResponses = 0;
  if (activeRound) {
    const roundQuestions = await db
      .select({ questionId: questions.id, telegramId: users.telegramId })
      .from(questions)
      .innerJoin(members, eq(questions.memberId, members.id))
      .innerJoin(users, eq(members.userId, users.id))
      .where(eq(questions.roundId, activeRound.id))
      .limit(200);

    for (const question of roundQuestions) {
      const [answer] = await db
        .select({ id: responses.id })
        .from(responses)
        .where(eq(responses.questionId, question.questionId))
        .limit(1);
      if (answer) continue;

      missingRoundResponses += 1;
      const parts = messagesByUser.get(question.telegramId) ?? [];
      parts.push(
        `• Round #${activeRound.roundNumber} is waiting for your perspective.\n` +
        `Topic: ${escapeHtml(activeRound.topic ?? 'Current project question')}\n` +
        `Open this chat and reply to the question I sent earlier.`
      );
      messagesByUser.set(question.telegramId, parts);
    }
  }

  if (messagesByUser.size === 0) {
    await ctx.reply(
      `✅ Nothing to nudge for *${project.name}* right now.\n\n` +
      `Onboarding is clear and there are no missing active-round responses.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  let sent = 0;
  let failed = 0;
  for (const [telegramId, parts] of messagesByUser.entries()) {
    const messageId = await sendMessage(
      telegramId,
      `🌀 <b>Zolara reminder</b>\n\n${parts.join('\n\n')}\n\nThank you — your input helps the team get a useful synthesis.`,
      { parseMode: 'HTML' },
      project.id
    );
    if (messageId) sent += 1;
    else failed += 1;
  }

  await ctx.reply(
    `🔔 Nudge complete for *${project.name}*.\n\n` +
    `Members messaged: ${sent}\n` +
    `Failed/unreachable: ${failed}\n` +
    `Pending onboarding found: ${pendingOnboarding.length}\n` +
    `Missing active-round responses found: ${missingRoundResponses}`,
    { parse_mode: 'Markdown' }
  );
});

async function loadValidationHistory(projectId: string, limit = 5) {
  const attempts = await db
    .select({
      id: problemDefinitions.id,
      topicText: problemDefinitions.topicText,
      refinedText: problemDefinitions.refinedText,
      status: problemDefinitions.status,
      votesReceived: problemDefinitions.votesReceived,
      totalVoters: problemDefinitions.totalVoters,
      confidenceScore: problemDefinitions.confidenceScore,
      clarificationRound: problemDefinitions.clarificationRound,
      updatedAt: problemDefinitions.updatedAt,
    })
    .from(problemDefinitions)
    .where(eq(problemDefinitions.projectId, projectId))
    .orderBy(desc(problemDefinitions.updatedAt))
    .limit(limit);

  return Promise.all(attempts.map(async (attempt) => {
    const votes = await db
      .select({ vote: problemDefinitionVotes.vote })
      .from(problemDefinitionVotes)
      .where(eq(problemDefinitionVotes.problemDefinitionId, attempt.id))
      .limit(100);

    return {
      ...attempt,
      voteCounts: {
        clear: votes.filter((v) => v.vote === 'clear').length,
        refine: votes.filter((v) => v.vote === 'refine').length,
        unsure: votes.filter((v) => v.vote === 'unsure').length,
      },
    };
  }));
}

zolaraBot.command('status', async (ctx) => {
  const { project } = await resolveAdminProject(ctx.from!.id);
  if (!project) { await ctx.reply("You don't have any projects yet."); return; }

  const [round] = await db
    .select({ id: rounds.id, roundNumber: rounds.roundNumber, status: rounds.status, responseCount: rounds.responseCount, memberCount: rounds.memberCount, topic: rounds.topic } as any)
    .from(rounds)
    .where(eq(rounds.projectId, project.id))
    .orderBy(desc(rounds.roundNumber))
    .limit(1);
  const validationHistory = await loadValidationHistory(project.id, 5);
  const validationText = formatValidationHistory(validationHistory, 5);

  if (!round) {
    await ctx.reply(
      `<b>${escapeHtml(project.name)}</b>\n\nNo active round. Use /startround to begin.\n\n<b>Validation history</b>\n${validationText}`,
      { parse_mode: 'HTML' }
    );
    return;
  }

  const responseCount = round.responseCount ?? 0;
  const memberCount = round.memberCount ?? 0;
  const rstatus = round.status ?? 'unknown';

  await ctx.reply(
    `<b>${escapeHtml(project.name)}</b>\n\n` +
    `Round #${round.roundNumber}\n` +
    `Status: <b>${escapeHtml(rstatus)}</b>\n` +
    `Responses: ${responseCount}/${memberCount}\n` +
    `Topic: ${escapeHtml(round.topic ?? '—')}\n\n` +
    `<b>Validation history</b>\n${validationText}`,
    { parse_mode: 'HTML' }
  );
});


async function loadAdminActionContext(projectId: string) {
  const memberRows = await db
    .select({ id: members.id, onboardingStatus: members.onboardingStatus, role: members.role })
    .from(members)
    .where(eq(members.projectId, projectId));

  const onboarding = summarizeOnboarding(memberRows);
  const validationHistory = await loadValidationHistory(projectId, 5);
  const latestValidation = validationHistory[0];

  const recentRounds = await db
    .select({
      roundNumber: rounds.roundNumber,
      status: rounds.status,
      topic: rounds.topic,
      responseCount: rounds.responseCount,
      memberCount: rounds.memberCount,
      deadline: rounds.deadline,
    })
    .from(rounds)
    .where(eq(rounds.projectId, projectId))
    .orderBy(desc(rounds.roundNumber))
    .limit(10);

  const latestRound = pickCurrentRound(recentRounds);
  const missingResponses = calculateMissingResponses(latestRound, onboarding.complete);

  return { memberRows, onboarding, validationHistory, latestValidation, recentRounds, latestRound, missingResponses };
}

zolaraBot.command('dashboard', async (ctx) => {
  const { project } = await resolveAdminProject(ctx.from!.id);
  if (!project) { await ctx.reply("You don't have any projects yet."); return; }

  const { onboarding, validationHistory, latestValidation, latestRound, missingResponses } = await loadAdminActionContext(project.id);
  const onboardingBreakdown = formatOnboardingBreakdown(onboarding);
  const responseCount = latestRound?.responseCount ?? 0;
  const roundMemberCount = latestRound?.memberCount ?? onboarding.complete;
  const nextAction = dashboardNextAction({
    pendingOnboarding: onboarding.pending,
    validationStatus: latestValidation?.status,
    roundStatus: latestRound?.status,
    missingResponses,
    hasMembers: onboarding.total > 0,
    suggestedRefinedTopic: latestValidation?.refinedText,
  });

  const validationText = formatValidationHistory(validationHistory, 5);

  const roundLabel = latestRound && ['scheduled', 'gathering', 'synthesizing'].includes(latestRound.status ?? '')
    ? 'Current active/scheduled round'
    : 'Latest round';
  const roundDeadline = latestRound?.deadline ? `
Deadline: ${latestRound.deadline.toISOString().slice(0, 16).replace('T', ' ')} UTC` : '';
  const roundText = latestRound
    ? `${roundLabel}: #${latestRound.roundNumber} — <b>${escapeHtml(latestRound.status ?? 'unknown')}</b>
` +
      `Topic: ${escapeHtml(latestRound.topic ?? '—')}
` +
      `Responses: ${responseCount}/${roundMemberCount} (${missingResponses} missing)${roundDeadline}`
    : 'No active, scheduled, or completed round yet.';

  await ctx.reply(
    `<b>${escapeHtml(project.name)} — Dashboard</b>

` +
    `<b>Members</b>
` +
    `Total: ${onboarding.total}
` +
    `Complete: ${onboarding.complete}
` +
    `Pending onboarding: ${onboarding.pending}
` +
    `Pending breakdown: ${escapeHtml(onboardingBreakdown)}

` +
    `<b>Validation history</b>
${validationText}

` +
    `<b>Latest round</b>
${roundText}

` +
    `<b>Recommended next action</b>
${escapeHtml(nextAction)}`,
    { parse_mode: 'HTML' }
  );
});

zolaraBot.command('next', async (ctx) => {
  const { project } = await resolveAdminProject(ctx.from!.id);
  if (!project) { await ctx.reply("You don't have any projects yet."); return; }

  const { onboarding, validationHistory, latestValidation, latestRound, missingResponses } = await loadAdminActionContext(project.id);
  const next = recommendAdminNextAction({
    pendingOnboarding: onboarding.pending,
    validationStatus: latestValidation?.status,
    roundStatus: latestRound?.status,
    missingResponses,
    hasMembers: onboarding.total > 0,
    suggestedRefinedTopic: latestValidation?.refinedText,
  });

  const contextParts = [
    `Members: ${onboarding.complete}/${onboarding.total} onboarded`,
    latestValidation ? `Validation: ${latestValidation.status ?? 'unknown'}` : 'Validation: none yet',
    latestRound ? `Round: #${latestRound.roundNumber} ${latestRound.status ?? 'unknown'} (${missingResponses} missing)` : 'Round: none yet',
  ];

  await ctx.reply(
    `<b>${escapeHtml(project.name)} — Next action</b>\n\n` +
    `<b>${escapeHtml(next.label)}</b>\n` +
    `Run: <code>${escapeHtml(next.command)}</code>\n\n` +
    `${escapeHtml(next.detail)}\n\n` +
    `<b>Context</b>\n${contextParts.map(escapeHtml).join('\n')}`,
    { parse_mode: 'HTML' }
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
    if (!project) { await answerCb(ctx, ''); return; }
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
    if (!state) { await answerCb(ctx, ''); return; }
    const newState = await handleCallback(ctx, state, data);
    if (!newState) return;
    await saveInitState(newState);
    await handleInitiationStep(ctx, newState);
    return;
  }

  // Claim flow callbacks (member commitment)
  if (data.startsWith('claim:')) {
    const state = await loadClaimState(userId);
    if (!state) { await answerCb(ctx, ''); return; }
    await handleClaimCallback(ctx, state, data);
    return;
  }

  // Onboarding callbacks (member profile)
  if (data.startsWith('onboard:')) {
    const state = await loadOnboardingState(userId);
    if (!state) {
      await sendOnboardingStaleCallbackHelp(ctx, userId);
      return;
    }
    await handleOnboardingCallback(ctx, state, data);
    return;
  }

  // Report reaction callbacks (group members reacting to synthesis)
  if (data.startsWith('reaction:')) {
    const [, projectId, roundNumber, reaction] = data.split(':') as [string, string, string, string];
    await answerCb(ctx, 'Done');
    // Store reaction in DB
    try {
      const { engagementEvents } = await import('../data/schema/projects');
      const { db } = await import('../data/db');
      const { users, members } = await import('../data/schema/projects');
      const { eq, and } = await import('drizzle-orm');

      // Find member by telegram ID scoped to this project
      const [memberRow] = await db
        .select({ memberId: members.id })
        .from(members)
        .innerJoin(users, eq(members.userId, users.id))
        .where(and(eq(users.telegramId, userId), eq(members.projectId, projectId as any)))
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
        await answerCb(ctx, '');
        return;
      }

      if (parsed.action === 'vote') {
        const result = await handleVoteCallback(parsed.problemDefinitionId, parsed.vote!, userId);
        await answerCb(ctx, result.text, result.alert);
      } else if (parsed.action === 'topic') {
        const result = await handleTopicCallback(parsed.problemDefinitionId);
        await answerCb(ctx, result.text, result.alert);
      }
    } catch (err) {
      console.error('[Validation] Callback error:', err);
      await answerCb(ctx, '');
    }
    return;
  }

  // Phase flag control callbacks
  if (data.startsWith('phase:')) {
    // Verify admin
    const { project } = await resolveAdminProject(userId);
    if (!project) { await answerCb(ctx, ''); return; }

    const parts = data.split(':');
    const action = parts[1];

    if (action === 'refresh' || action === 'back') {
      const flags = listRuntimeFlags();
      await ctx.editMessageReplyMarkup({ reply_markup: buildPhaseKeyboard(flags) });
      await answerCb(ctx, '');
      return;
    }

    if (action === 'detail') {
      const key = parts[2];
      if (!key || !VALID_PHASES.includes(key)) { await answerCb(ctx, ''); return; }
      const flags = listRuntimeFlags();
      const value = flags[key] ?? 'disabled';
      await ctx.editMessageReplyMarkup({ reply_markup: buildPhaseDetailKeyboard(key, value) });
      await answerCb(ctx, PHASE_SHORT[key] ?? key);
      return;
    }

    if (action === 'toggle') {
      const key = parts[2];
      if (!key || !VALID_PHASES.includes(key)) { await answerCb(ctx, ''); return; }
      const flags = listRuntimeFlags();
      const current = flags[key] ?? 'disabled';
      const next = current === 'active' ? 'disabled' : 'active';
      setRuntimeFlag(key, next);
      const updatedFlags = listRuntimeFlags();
      await ctx.editMessageReplyMarkup({ reply_markup: buildPhaseKeyboard(updatedFlags) });
      const label = PHASE_SHORT[key] ?? key;
      await answerCb(ctx, `✅ ${label} → ${next}`, true);
      return;
    }

    if (action === 'noop') {
      await answerCb(ctx, '');
      return;
    }

    await answerCb(ctx, '');
    return;
  }

  // Project selection callbacks
  if (data.startsWith('project:select:')) {
    const projectId = data.split(':')[2];
    if (!projectId) { await answerCb(ctx, '❌ Invalid selection'); return; }

    const { choices } = await resolveAdminProject(userId);
    const valid = choices.find((c) => c.id === projectId);
    if (!valid) { await answerCb(ctx, '❌ Project not found'); return; }

    await redis.setex(projectSelectionKey(userId), PROJECT_SELECTION_TTL, projectId);
    await answerCb(ctx, `✅ ${valid.name} selected`, true);
    await ctx.editMessageReplyMarkup({ reply_markup: buildProjectKeyboard(choices, projectId) });
    return;
  }

  // Project management: show detail keyboard (⚙️ button)
  if (data.startsWith('project:manage:')) {
    const projectId = data.split(':')[2];
    if (!projectId) { await answerCb(ctx, '❌ Invalid'); return; }

    const [proj] = await db.select({ id: projects.id, name: projects.name, status: projects.status }).from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!proj) { await answerCb(ctx, '❌ Project not found'); return; }

    const statusLabel = proj.status === 'active' ? '🟢 Active' : proj.status === 'archived' ? '📦 Archived' : `⚪ ${proj.status}`;
    const escapeHtml = (t: string) => t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    await ctx.editMessageText(
      `<b>${escapeHtml(proj.name)}</b>\n\nStatus: ${statusLabel}\n\nWhat do you want to do?`,
      { parse_mode: 'HTML', reply_markup: buildProjectManageKeyboard(projectId, proj.status ?? 'pending') }
    );
    await answerCb(ctx, ' ');
    return;
  }

  // Archive a project (30-day soft delete, data preserved)
  if (data.startsWith('project:archive:')) {
    const projectId = data.split(':')[2];
    if (!projectId) { await answerCb(ctx, '❌ Invalid'); return; }
    await db.update(projects).set({ status: 'archived', updatedAt: new Date() }).where(eq(projects.id, projectId));
    await suspendProjectAgent(projectId);
    await answerCb(ctx, '📦 Project archived — data kept 30 days', true);
    return;
  }

  // Delete a project (30-day soft delete, data preserved)
  if (data.startsWith('project:delete:')) {
    const projectId = data.split(':')[2];
    if (!projectId) { await answerCb(ctx, '❌ Invalid'); return; }
    await db.update(projects).set({ status: 'deleted', updatedAt: new Date() }).where(eq(projects.id, projectId));
    await deleteProjectAgent(projectId);
    await answerCb(ctx, '🗑 Project deleted — data kept 30 days', true);
    return;
  }

  // Restore an archived project
  if (data.startsWith('project:restore:')) {
    const projectId = data.split(':')[2];
    if (!projectId) { await answerCb(ctx, '❌ Invalid'); return; }
    await db.update(projects).set({ status: 'active', updatedAt: new Date() }).where(eq(projects.id, projectId));
    await restoreProjectAgent(projectId);
    await answerCb(ctx, '↩️ Project restored', true);
    return;
  }

  // Back to project list
  if (data === 'project:back') {
    const { choices } = await resolveAdminProject(userId);
    if (!choices.length) { await answerCb(ctx, 'No projects'); return; }
    const escapeHtml = (t: string) => t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const lines = choices.map((p) => `${statusIcon(p.status)} ${escapeHtml(p.name)}`).join('\n');
    await ctx.editMessageText(
      `<b>Your projects:</b>\n\n${lines}\n\nTap a name to select it. Tap [Settings] to manage.`,
      { parse_mode: 'HTML', reply_markup: buildProjectKeyboard(choices) }
    );
    await answerCb(ctx, ' ');
    return;
  }
});

async function handleAdminGroupCallback(ctx: any, data: string, adminTelegramId: number, projectId: string): Promise<void> {
  const action = data.split(':')[1];
  const detectData = await redis.get(`group_detect:${projectId}`);
  if (!detectData) { await answerCb(ctx, ''); return; }
  const { groupId, groupTitle } = JSON.parse(detectData) as { groupId: number; groupTitle: string };

  if (action === 'confirm') {
    await db.update(projects).set({ groupIds: [groupId] }).where(eq(projects.id, projectId as any));
    await redis.del(`group_detect:${projectId}`);
    await answerCb(ctx, 'Group set!');
    await ctx.reply(`✅ *Group set!*\n\nRound reports will now be posted to *${groupTitle}*.`, { parse_mode: 'Markdown' });
  } else {
    await redis.del(`group_detect:${projectId}`);
    await answerCb(ctx, 'Cancelled');
    await ctx.reply('No problem. When I\'m added to the correct group, I\'ll ask again.');
  }
}

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
        `⏳ Your team coordinator is being set up now — this takes up to 60 seconds.\n` +
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

  if (text.startsWith('/admin-guide')) {
    await sendAdminGuide(ctx);
    return;
  }

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

  // Member onboarding text input (role, interests steps)
  const onboardState = await loadOnboardingState(userId);
  if (onboardState) {
    const updated = await handleOnboardingText(ctx, onboardState, text);
    if (updated) {
      await saveOnboardingState(updated);
    }
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

  // AI help for non-command messages (interpret natural language)
  console.log('[MessageText] userId=', userId, 'text=', text.substring(0, 100));
  await handleAIHelp(ctx, userId, text);
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
    .innerJoin(users, eq(members.userId, users.id))
    .where(and(eq(members.projectId, projectId as any), eq(users.telegramId, userId)))
    .limit(1);

  if (existing && existing.onboardingStatus === 'committed') {
    await ctx.reply(`✅ You're already committed to *${project.name}*.\n\nA round will start soon. I'll DM you when it does.`, { parse_mode: 'Markdown' });
    return;
  }

  const projectConfig = (project.config as unknown) as Record<string, unknown> ?? {}; const anonymity = (projectConfig['anonymity'] as 'full' | 'optional' | 'attributed') ?? 'optional'; const state = { phase: 'claim' as const, projectId, projectName: project.name ?? 'this project', telegramId: userId, claimStartedAt: new Date().toISOString(), anonymity };
  await saveClaimState(state);
  await handleClaimWelcome(ctx, state);
}

// ── Question detection patterns ─────────────────────────────────────────────────
const question_patterns = ['what', 'how', 'why', 'when', 'where', 'who', 'which', 'should', 'could', 'can ', 'is ', 'do ', 'does ', 'want', 'tell', 'explain', '?'];

// ── Initiation text handling ──────────────────────────────────────────────────

async function handleInitiationText(ctx: any, state: InitiationState, text: string): Promise<void> {
  // Detect if user is asking a question vs providing an answer to the flow
  const lower = text.trim().toLowerCase();
  const isQuestion = question_patterns.some((q) => lower.startsWith(q)) || text.trim().endsWith('?');

  if (isQuestion) {
    // Route to AI help — answer the question without advancing the flow
    await handleAIHelp(ctx, state.telegramId, text);
    return;
  }

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
  const { responses, members, users } = await import('../data/schema/projects');
  try {
    // Look up the actual database member ID from the Telegram user ID
    const [memberRow] = await db
      .select({ memberId: members.id })
      .from(members)
      .innerJoin(users, eq(members.userId, users.id))
      .where(and(eq(users.telegramId, userId), eq(members.projectId, projectId as any)))
      .limit(1);

    if (!memberRow) {
      dbLog.insertFailed('responses', { userId, projectId, reason: 'member_not_found' }, new Error('Member not found'));
      return;
    }

    await db.insert(responses).values({
      questionId: questionId as any,
      memberId: memberRow.memberId,
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
  await answerCb(ctx, '');
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