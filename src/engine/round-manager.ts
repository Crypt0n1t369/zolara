/**
 * Round Lifecycle Manager
 * Orchestrates the state machine transitions for deliberation rounds.
 *
 * States: SCHEDULED → GATHERING → SYNTHESIZING → COMPLETE
 *                    ↘ CANCELLED    ↘ FAILED → (retry) → SYNTHESIZING
 */

import { eq, desc, and } from 'drizzle-orm';
import { db } from '../data/db';
import { rounds, projects, members, questions, responses, users } from '../data/schema/projects';
import { runSynthesis, getMinimumResponses, meetsMinimumThreshold } from './synthesis/pipeline';
import { generateQuestions, personalizeQuestion } from './question/generator';
import { llm } from './llm/minimax';
import {
  sendQuestionDM,
  postReportToGroupChat,
} from '../util/telegram-sender';
import {
  logger,
  round as roundLog,
  db as dbLog,
  llm as llmLog,
  telegram as telegramLog,
} from '../util/logger';
import { auditEvent } from '../util/audit';

export interface RoundContext {
  roundId: string;
  projectId: string;
  botToken: string;
  adminTelegramId: number;
  groupId?: number;
  channelId?: number;
}

export type RoundStatus = 'scheduled' | 'gathering' | 'synthesizing' | 'complete' | 'failed' | 'cancelled';

async function updateRoundStatus(
  roundId: string,
  projectId: string | null | undefined,
  fromStatus: string | null | undefined,
  toStatus: RoundStatus,
  extra: Partial<typeof rounds.$inferInsert> = {},
  context: Record<string, unknown> = {}
): Promise<void> {
  try {
    await db
      .update(rounds)
      .set({ ...extra, status: toStatus })
      .where(eq(rounds.id, roundId));

    await auditEvent('round_state_transition', {
      roundId,
      fromStatus: fromStatus ?? 'unknown',
      toStatus,
      ...context,
    }, projectId ?? null);

    logger.info({
      msg: '[RoundManager] state transition',
      roundId,
      projectId,
      fromStatus: fromStatus ?? 'unknown',
      toStatus,
      ...context,
    });
  } catch (err) {
    roundLog.stateTransitionFailed(fromStatus ?? 'unknown', toStatus, { roundId, projectId: projectId ?? undefined, ...context }, err);
    throw err;
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Trigger a new round for a project.
 * Creates a SCHEDULED round that transitions to GATHERING immediately.
 */
export async function triggerRound(
  projectId: string,
  topic: string,
  options?: {
    /** Override anonymity mode for this specific round. Defaults to project config. */
    anonymity?: 'full' | 'optional' | 'attributed';
  }
): Promise<{ roundId: string; status: string }> {
  // Check no active round exists
  const activeRound = await db
    .select()
    .from(rounds)
    .where(
      and(
        eq(rounds.projectId, projectId),
        eq(rounds.status, 'gathering')
      )
    )
    .limit(1);

  if (activeRound.length > 0) {
    throw new Error('A round is already in progress for this project');
  }

  // Get project config
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!project) {
    throw new Error('Project not found');
  }

  // Get member count
  const memberList = await db
    .select()
    .from(members)
    .where(eq(members.projectId, projectId))
    .limit(100);

  if (memberList.length < 2) {
    throw new Error('Need at least 2 members to start a round');
  }

  // Get next round number
  const existingRounds = await db
    .select({ roundNumber: rounds.roundNumber })
    .from(rounds)
    .where(eq(rounds.projectId, projectId))
    .orderBy(desc(rounds.roundNumber))
    .limit(1);

  const nextRoundNumber = (existingRounds[0]?.roundNumber ?? 0) + 1;

  // Create round
  const config = project.config as unknown as Record<string, unknown>;
  const cycleDurationHours = getCycleDuration(config['cycleFrequency'] as string ?? 'weekly');
  const deadline = new Date(Date.now() + cycleDurationHours * 60 * 60 * 1000);

  const [round] = await db
    .insert(rounds)
    .values({
      projectId,
      roundNumber: nextRoundNumber,
      topic,
      status: 'gathering',
      roundType: 'alignment',
      scope: 'group',
      startedAt: new Date(),
      deadline,
      memberCount: memberList.length,
      responseCount: 0,
      anonymity: options?.anonymity ?? null,
    })
    .returning();

  // Transition to gathering (generate and send questions)
  await transitionToGathering(round.id, projectId, nextRoundNumber, topic, memberList, config, options?.anonymity ?? null);

  return { roundId: round.id, status: round.status ?? 'unknown' };
}

/**
 * Cancel an active round.
 */
export async function cancelRound(roundId: string): Promise<void> {
  const [round] = await db
    .select()
    .from(rounds)
    .where(eq(rounds.id, roundId))
    .limit(1);

  if (!round) throw new Error('Round not found');
  const currentStatus = round.status ?? 'unknown';
  if (!['gathering', 'synthesizing'].includes(currentStatus)) {
    throw new Error(`Cannot cancel round in ${currentStatus} state`);
  }

  await updateRoundStatus(roundId, round.projectId, currentStatus, 'cancelled', {}, { reason: 'admin_cancel' });
}

// ── State Transitions ─────────────────────────────────────────────────────────

async function transitionToGathering(
  roundId: string,
  projectId: string,
  roundNumber: number,
  topic: string,
  memberList: Array<{
    id: number;
    userId: number | null;
    role: string | null;
    projectProfile: Record<string, unknown> | null;
  }>,
  config: Record<string, unknown>,
  roundAnonymity: 'full' | 'optional' | 'attributed' | null
): Promise<void> {
  const projectConfig = config as {
    questionDepth?: string;
    anonymity?: string;
    team_size_range?: string;
  };

  // Filter out members with invalid userIds
  const validMembers = memberList.filter((m) => m.userId !== null);

  // Generate questions
  let questionsList;
  try {
    questionsList = await generateQuestions({
      projectId,
      topic,
      depth: (projectConfig.questionDepth as 'shallow' | 'medium' | 'deep') ?? 'medium',
      anonymity: roundAnonymity ?? (projectConfig.anonymity as 'full' | 'optional' | 'attributed') ?? 'optional',
      teamSizeRange: projectConfig.team_size_range ?? '2-5',
    });
  } catch (err) {
    llmLog.generationFailed({ projectId, roundId }, err);
    roundLog.stateTransitionFailed('GATHERING', 'FAILED', { projectId, roundId }, err);
    // Mark as failed
    try {
      await updateRoundStatus(roundId, projectId, 'gathering', 'failed', { errorMessage: 'Question generation failed' }, { phase: 'question_generation' });
    } catch (dbErr) {
      dbLog.updateFailed('rounds', { roundId }, dbErr);
    }
    return;
  }

  // Store and send questions to each member
  const unreachableMemberIds: number[] = [];
  for (const member of validMembers) {
    if (member.userId === null) continue;

    const memberProfile = member.projectProfile as Record<string, string> | undefined;

    // Personalize question
    const personalizedQ = await personalizeQuestion(questionsList[0]!, {
      role: member.role ?? undefined,
      interests: memberProfile?.interests,
      communicationStyle: memberProfile?.communication_style,
    });

    // Store question
    const [storedQuestion] = await db
      .insert(questions)
      .values({
        roundId,
        memberId: member.id,
        questionText: personalizedQ.text,
        questionType: personalizedQ.type,
      })
      .returning();

    // Send to member via Telegram
    const telegramMessageId = await sendQuestionToMember(projectId, member.userId, personalizedQ.text, roundNumber, storedQuestion.id, roundId, topic);
    if (telegramMessageId) {
      await db
        .update(questions)
        .set({ telegramMessageId })
        .where(eq(questions.id, storedQuestion.id));
    } else {
      unreachableMemberIds.push(member.id);
    }
  }

  if (unreachableMemberIds.length > 0) {
    roundLog.memberUnreachable(roundId, unreachableMemberIds.length, unreachableMemberIds.join(','), { projectId, roundId });
    await auditEvent('round_member_unreachable', { roundId, memberIds: unreachableMemberIds }, projectId);
  }

  // Update round status
  await updateRoundStatus(roundId, projectId, 'scheduled', 'gathering', { startedAt: new Date() }, { sentQuestions: validMembers.length - unreachableMemberIds.length, unreachableMembers: unreachableMemberIds.length });
}

/**
 * Start a round that was created in `scheduled` status by the problem validation gate.
 * Generates and sends the first question to members, same as the normal trigger flow.
 */
export async function startScheduledRound(roundId: string, projectId: string): Promise<void> {
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!project) throw new Error('Project not found');

  const [round] = await db
    .select()
    .from(rounds)
    .where(eq(rounds.id, roundId))
    .limit(1);

  if (!round) throw new Error('Round not found');

  if (round.status !== 'scheduled') {
    return;
  }

  const memberList = await db
    .select()
    .from(members)
    .where(eq(members.projectId, projectId))
    .limit(100);

  await transitionToGathering(
    round.id,
    projectId,
    round.roundNumber,
    round.topic ?? 'General discussion',
    memberList,
    project.config as unknown as Record<string, unknown>,
    round.anonymity as 'full' | 'optional' | 'attributed' | null
  );
}

async function transitionToSynthesizing(roundId: string): Promise<void> {
  const [round] = await db
    .select()
    .from(rounds)
    .where(eq(rounds.id, roundId))
    .limit(1);

  if (!round) throw new Error('Round not found');

  // Check minimum responses
  const config = round.metadata as Record<string, unknown>;
  const teamSizeRange = (config['team_size_range'] as string) ?? '2-5';
  const memberCount = round.memberCount ?? 0;
  const responseCount = round.responseCount ?? 0;

  if (responseCount < 2) {
    // Cancel - too few responses
    const message = responseCount === 0
      ? 'Round cancelled — no responses received.'
      : `Only ${responseCount} perspective received. Minimum 2 required.`;

    await updateRoundStatus(roundId, round.projectId, round.status, 'cancelled', {}, { reason: 'insufficient_responses', responseCount });

    throw new Error(`Round cancelled: ${message}`);
  }

  if (!meetsMinimumThreshold(responseCount, memberCount, teamSizeRange)) {
    // Proceed but flag in metadata
    console.warn(`[RoundManager] Round ${roundId} proceeding with low response rate: ${responseCount}/${memberCount}`);
  }

  await updateRoundStatus(roundId, round.projectId, round.status, 'synthesizing', {}, { responseCount, memberCount });
}

async function transitionToComplete(
  roundId: string,
  reportData: Record<string, unknown>
): Promise<void> {
  const [round] = await db
    .select({ projectId: rounds.projectId, status: rounds.status })
    .from(rounds)
    .where(eq(rounds.id, roundId))
    .limit(1);

  await updateRoundStatus(roundId, round?.projectId, round?.status, 'complete', {
    completedAt: new Date(),
    convergenceScore: String(reportData['convergenceScore'] ?? ''),
    convergenceTier: reportData['convergenceTier'] as string,
  }, { convergenceScore: reportData['convergenceScore'], convergenceTier: reportData['convergenceTier'] });
}

// ── Deadline Checking (called by cron) ────────────────────────────────────────

/**
 * Check all gathering rounds and transition any that are past deadline.
 * To be called by a cron job or background worker.
 */
export async function checkRoundDeadlines(): Promise<{ checked: number; expired: number; processed: number; failed: number }> {
  const now = new Date();

  const candidateRounds = await db
    .select()
    .from(rounds)
    .where(eq(rounds.status, 'gathering'))
    .limit(100);

  let expired = 0;
  let processed = 0;
  let failed = 0;

  for (const round of candidateRounds) {
    if (round.deadline && round.deadline <= now && round.projectId !== null) {
      expired++;
      try {
        await processRoundCompletion(round.id, round.projectId);
        processed++;
      } catch (err) {
        failed++;
        roundLog.deadlineCheckFailed({ roundId: round.id, projectId: round.projectId ?? undefined }, err);
      }
    }
  }

  const summary = { checked: candidateRounds.length, expired, processed, failed };
  logger.info({ msg: '[RoundManager] deadline check complete', ...summary });
  return summary;
}

/**
 * Process round completion: transition to synthesizing, run synthesis, post report.
 */
export async function processRoundCompletion(roundId: string, projectId: string): Promise<void> {
  // Get round and project info
  const [round] = await db
    .select()
    .from(rounds)
    .where(eq(rounds.id, roundId))
    .limit(1);

  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!round || !project) throw new Error('Round or project not found');

  // Idempotency guard: deadline workers only complete rounds that are still gathering.
  if (round.status !== 'gathering') {
    logger.info({ msg: '[RoundManager] skipped completion for non-gathering round', roundId, projectId, status: round.status });
    return;
  }

  // Get response count
  const responseRows = await db
    .select()
    .from(responses)
    .innerJoin(questions, eq(questions.id, responses.questionId))
    .where(eq(questions.roundId, roundId))
    .limit(1000);

  const responseCount = responseRows.length;

  // Update response count
  try {
    await db
      .update(rounds)
      .set({ responseCount })
      .where(eq(rounds.id, roundId));
  } catch (dbErr) {
    dbLog.updateFailed('rounds', { roundId }, dbErr);
  }

  // Transition to synthesizing
  await transitionToSynthesizing(roundId);

  // Run synthesis
  let reportData: Record<string, unknown>;
  try {
    // Use round-level anonymity if set, otherwise fall back to project config
    const effectiveAnonymity = (round as any).anonymity
      ?? ((project.config as unknown) as Record<string, unknown>)['anonymity'] as 'full' | 'optional' | 'attributed'
      ?? 'optional';

    const synthesisResult = await runSynthesis({
      roundId,
      projectId,
      topic: (round.topic as string | null) ?? 'General discussion',
      responseCount,
      memberCount: round.memberCount ?? 0,
      anonymity: effectiveAnonymity,
    });

    reportData = synthesisResult as unknown as Record<string, unknown>;

    // Store report
    const { reports } = await import('../data/schema/projects');
    try {
      await db.insert(reports).values({
        roundId,
        projectId,
        content: JSON.stringify(reportData),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        structuredData: reportData as any,
      });
    } catch (dbErr) {
      dbLog.insertFailed('reports', { roundId, projectId }, dbErr);
    }

    // Transition to complete
    await transitionToComplete(roundId, reportData);

    // Post to group
    const groupIds = project.groupIds ?? [];
    if (groupIds.length > 0) {
      try {
        await postReportToGroup(projectId, groupIds[0], reportData, round.roundNumber, responseCount, round.memberCount ?? 0);
      } catch (tgErr) {
        telegramLog.sendFailed('postReportToGroup failed', { projectId, chatId: groupIds[0], roundId }, tgErr);
      }
    }
  } catch (err) {
    roundLog.synthesisFailed(roundId, { projectId }, err);

    try {
      await updateRoundStatus(roundId, projectId, round.status, 'failed', {
        errorMessage: err instanceof Error ? err.message : 'Synthesis failed',
        retryCount: (round.retryCount ?? 0) + 1,
      }, { phase: 'synthesis', retryCount: (round.retryCount ?? 0) + 1 });
    } catch (dbErr) {
      dbLog.updateFailed('rounds', { roundId }, dbErr);
    }

    throw err;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getCycleDuration(cycleFrequency: string): number {
  const durations: Record<string, number> = {
    daily: 24,
    every_few_days: 48,
    weekly: 168,
    bi_weekly: 336,
    monthly: 720,
    only_when_triggered: 72,
    per_shift: 8,
  };
  return durations[cycleFrequency] ?? 48;
}

async function sendQuestionToMember(
  projectId: string,
  userId: number,
  questionText: string,
  roundNumber: number,
  questionId: string,
  roundId: string,
  topic?: string | null
): Promise<number | null> {
  // members.userId is the internal DB users.id; Telegram DMs need users.telegramId.
  const [user] = await db
    .select({ telegramId: users.telegramId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user?.telegramId) {
    telegramLog.sendFailed('Cannot send question: member has no Telegram ID', { projectId, userId });
    return null;
  }

  return sendQuestionDM(projectId, user.telegramId, questionText, roundNumber, questionId, roundId, topic);
}

async function postReportToGroup(
  projectId: string,
  groupId: number,
  reportData: Record<string, unknown>,
  roundNumber: number,
  responseCount: number,
  memberCount: number
): Promise<{ messageIds: number[] }> {
  return postReportToGroupChat(projectId, groupId, reportData, roundNumber, responseCount, memberCount);
}
