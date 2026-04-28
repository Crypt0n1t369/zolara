/**
 * Phase 2 — Problem Validation Gate
 *
 * Entry point: validateAndTriggerRound()
 * Replaces triggerRound() when PHASE_PROBLEM_DEF='active'
 *
 * Flow:
 * 1. validateAndTriggerRound(topic) → creates problem_definition (status: voting)
 * 2. Members receive DM with inline vote keyboard
 * 3. Each vote → processVote() records it
 * 4. After threshold reached OR deadline passed → tallyVotes()
 * 5. Result → confirmed / needs_work / rejected
 * 6. If confirmed → transition round to gathering (normal flow)
 * 7. If needs_work → clarifying questions, re-run validation
 * 8. If rejected → admin notified, no round started
 *
 * Phase flag: PHASE_PROBLEM_DEF (default 'disabled')
 */

import { eq, and, desc, lte } from 'drizzle-orm';
import { db } from '../../../data/db';
import {
  rounds,
  projects,
  members,
  users,
  admins,
  problemDefinitions,
  problemDefinitionVotes,
} from '../../../data/schema/projects';
import { isPhaseActive } from '../flags';
import { startScheduledRound, triggerRound } from '../../round-manager';
import { sendValidationDM } from './telegram-ui';
import { sendMessage } from '../../../util/telegram-sender';
import { llm } from '../../llm/minimax';
import { round as roundLog } from '../../../util/logger';

// ── Constants ─────────────────────────────────────────────────────────────────

const VOTE_DEADLINE_HOURS = 24; // hours to wait for votes before tallying
// A topic is confirmed only when Clear has a strict majority of votes.
// 1 clear + 1 unsure/refine is not enough.
const LOW_CONFIDENCE_THRESHOLD = 40; // confidence score below this → flag admin

// ── Types ───────────────────────────────────────────────────────────────────────

export interface ValidationResult {
  status: 'confirmed' | 'needs_work' | 'rejected';
  problemDefinitionId: string;
  roundId?: string;
  confidenceScore: number;
  voteSummary: {
    clear: number;
    refine: number;
    unsure: number;
    total: number;
  };
}

export interface ValidationSession {
  id: string;
  projectId: string;
  topicText: string;
  status: string;
  votesReceived: number;
  totalVoters: number;
}

// ── Main entry point ───────────────────────────────────────────────────────────

/**
 * Phase 2 replacement for triggerRound().
 * Returns the roundId if validation passed and round was started.
 * Returns { roundId: null, problemDefinitionId: '...', status: 'pending' } if still validating.
 */
export async function validateAndTriggerRound(
  projectId: string,
  topic: string,
  options?: {
    anonymity?: 'full' | 'optional' | 'attributed';
  }
): Promise<{
  roundId: string | null;
  problemDefinitionId: string | null;
  validationStatus: string | null;
  message: string;
}> {
  // ── Step 1: Check phase flag ──────────────────────────────────────────────
  if (!isPhaseActive('PHASE_PROBLEM_DEF')) {
    // Fallback to baseline flow (Phase 0/1 behavior)
    const result = await triggerRound(projectId, topic, options);
    return {
      roundId: result.roundId,
      problemDefinitionId: null,
      validationStatus: null,
      message: 'Problem validation disabled — round started directly',
    };
  }

  // ── Step 2: Check for existing validation in progress ───────────────────
  const existingValidation = await db
    .select()
    .from(problemDefinitions)
    .where(
      and(
        eq(problemDefinitions.projectId, projectId),
        eq(problemDefinitions.status, 'pending')
      )
    )
    .limit(1);

  if (existingValidation.length > 0) {
    return {
      roundId: null,
      problemDefinitionId: existingValidation[0].id,
      validationStatus: 'pending',
      message: 'A validation is already in progress for this project',
    };
  }

  // ── Step 3: Create validation session ────────────────────────────────────
  const memberList = await db
    .select()
    .from(members)
    .where(and(eq(members.projectId, projectId), eq(members.onboardingStatus, 'complete')))
    .limit(100);

  if (memberList.length < 2) {
    return {
      roundId: null,
      problemDefinitionId: null,
      validationStatus: null,
      message: 'Need at least 2 fully onboarded members to start validation',
    };
  }

  const voteDeadline = new Date(Date.now() + VOTE_DEADLINE_HOURS * 60 * 60 * 1000);

  // Create the round in 'scheduled' status (not gathering yet)
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  const existingRounds = await db
    .select({ roundNumber: rounds.roundNumber })
    .from(rounds)
    .where(eq(rounds.projectId, projectId))
    .orderBy(desc(rounds.roundNumber))
    .limit(1);

  const nextRoundNumber = (existingRounds[0]?.roundNumber ?? 0) + 1;

  const [problemDefinition] = await db
    .insert(problemDefinitions)
    .values({
      projectId,
      roundId: null, // set after confirmation
      topicText: topic,
      status: 'voting',
      voteDeadline,
      votesReceived: 0,
      totalVoters: memberList.length,
    })
    .returning();

  const [round] = await db
    .insert(rounds)
    .values({
      projectId,
      roundNumber: nextRoundNumber,
      topic,
      status: 'scheduled', // waiting for validation
      startedAt: new Date(),
      deadline: voteDeadline,
      memberCount: memberList.length,
      responseCount: 0,
      problemDefinitionId: problemDefinition.id,
      anonymity: options?.anonymity ?? null,
    })
    .returning();

  // Link round to problem definition
  await db
    .update(problemDefinitions)
    .set({ roundId: round.id })
    .where(eq(problemDefinitions.id, problemDefinition.id));

  // ── Step 4: Send validation DMs to fully onboarded members only ─────────────
  const voterList = await db
    .select({ userId: users.telegramId })
    .from(members)
    .innerJoin(users, eq(members.userId, users.id))
    .where(and(eq(members.projectId, projectId), eq(members.onboardingStatus, 'complete')))
    .limit(100);
  await sendValidationDM(problemDefinition.id, projectId, topic, voterList);

  return {
    roundId: null, // not started yet — waiting for validation
    problemDefinitionId: problemDefinition.id,
    validationStatus: 'voting',
    message: `Validation started for "${topic}". Voting open for ${VOTE_DEADLINE_HOURS}h.`,
  };
}

// ── Process a member's vote ─────────────────────────────────────────────────────

/**
 * Called when a member casts a vote from their DM.
 * Records the vote and checks if threshold reached.
 */
export async function processVote(
  problemDefinitionId: string,
  memberId: number,
  vote: 'clear' | 'refine' | 'unsure',
  voteText?: string
): Promise<{ recorded: boolean; tallyComplete: boolean; result?: ValidationResult }> {
  // Check if already voted
  const existingVote = await db
    .select()
    .from(problemDefinitionVotes)
    .where(
      and(
        eq(problemDefinitionVotes.problemDefinitionId, problemDefinitionId),
        eq(problemDefinitionVotes.memberId, memberId)
      )
    )
    .limit(1);

  if (existingVote.length > 0) {
    // Update existing vote
    await db
      .update(problemDefinitionVotes)
      .set({ vote, voteText: voteText ?? null, votedAt: new Date() })
      .where(eq(problemDefinitionVotes.id, existingVote[0].id));
  } else {
    // Insert new vote
    await db
      .insert(problemDefinitionVotes)
      .values({ problemDefinitionId, memberId, vote, voteText: voteText ?? null });
  }

  // Update votes received count
  const votes = await db
    .select()
    .from(problemDefinitionVotes)
    .where(eq(problemDefinitionVotes.problemDefinitionId, problemDefinitionId))
    .limit(100);

  await db
    .update(problemDefinitions)
    .set({ votesReceived: votes.length, updatedAt: new Date() })
    .where(eq(problemDefinitions.id, problemDefinitionId));

  // Check if we should tally
  const [def] = await db
    .select()
    .from(problemDefinitions)
    .where(eq(problemDefinitions.id, problemDefinitionId))
    .limit(1);

  if (!def) throw new Error('Problem definition not found');

  const totalVoters = def.totalVoters ?? 0;
  const clearVotes = votes.filter((v) => v.vote === 'clear').length;
  const nonClearVotes = votes.length - clearVotes;

  // Tally only when the outcome is decided, all eligible voters answered, or the deadline passed.
  // Do not close early on a 50/50 split — the next vote could still create a Clear majority.
  const deadlineReached = def.voteDeadline && def.voteDeadline <= new Date();
  const allVotesReceived = totalVoters > 0 && votes.length >= totalVoters;
  const clearMajorityReached = totalVoters > 0 && clearVotes > totalVoters / 2;
  const nonClearMajorityReached = totalVoters > 0 && nonClearVotes > totalVoters / 2;

  if (deadlineReached || allVotesReceived || clearMajorityReached || nonClearMajorityReached) {
    const result = await tallyVotes(problemDefinitionId);
    return { recorded: true, tallyComplete: true, result };
  }

  return { recorded: true, tallyComplete: false, result: undefined };
}

// ── Tally votes ───────────────────────────────────────────────────────────────

/**
 * Compute vote result for a problem definition.
 * Returns confidence score and final status.
 */
export async function tallyVotes(problemDefinitionId: string): Promise<ValidationResult> {
  const [def] = await db
    .select()
    .from(problemDefinitions)
    .where(eq(problemDefinitions.id, problemDefinitionId))
    .limit(1);

  if (!def) throw new Error('Problem definition not found');

  const votes = await db
    .select()
    .from(problemDefinitionVotes)
    .where(eq(problemDefinitionVotes.problemDefinitionId, problemDefinitionId))
    .limit(100);

  const voteSummary = {
    clear: votes.filter((v) => v.vote === 'clear').length,
    refine: votes.filter((v) => v.vote === 'refine').length,
    unsure: votes.filter((v) => v.vote === 'unsure').length,
    total: votes.length,
  };

  // Confidence: weighted score
  // clear=100, unsure=50, refine=0
  const totalScore =
    voteSummary.clear * 100 + voteSummary.unsure * 50 + voteSummary.refine * 0;
  const confidenceScore =
    voteSummary.total > 0
      ? Math.round(totalScore / voteSummary.total)
      : 0;

  // Determine outcome
  let status: 'confirmed' | 'needs_work' | 'rejected';

  if (voteSummary.clear > voteSummary.total / 2 && confidenceScore >= LOW_CONFIDENCE_THRESHOLD) {
    status = 'confirmed';
  } else if (voteSummary.refine > 0 || confidenceScore < LOW_CONFIDENCE_THRESHOLD) {
    status = 'needs_work';
  } else {
    status = 'needs_work'; // default to needing clarification
  }

  // Update problem definition
  await db
    .update(problemDefinitions)
    .set({
      status,
      confidenceScore,
      updatedAt: new Date(),
    })
    .where(eq(problemDefinitions.id, problemDefinitionId));

  // If confirmed → start the round and send the first questions.
  let roundId: string | undefined;
  if (status === 'confirmed' && def.roundId && def.projectId) {
    await startScheduledRound(def.roundId, def.projectId);
    roundId = def.roundId;
  } else if (status === 'needs_work') {
    try {
      await sendClarificationToStakeholders(problemDefinitionId);
    } catch (err) {
      roundLog.stateTransitionFailed('VALIDATION', 'NEEDS_WORK_NOTIFY', { problemDefinitionId }, err);
    }
  }

  roundLog.validationComplete({
    problemDefinitionId,
    status,
    confidenceScore,
    voteSummary,
  });

  return {
    status,
    problemDefinitionId,
    roundId,
    confidenceScore,
    voteSummary,
  };
}

// ── Handle needs_work → clarification round ──────────────────────────────────

/**
 * Generate clarifying questions for a problem that needs work.
 * Then send them to the group and re-run validation.
 */
export async function runClarification(
  problemDefinitionId: string
): Promise<{ questions: string[]; suggestedTopic: string | null }> {
  const [def] = await db
    .select()
    .from(problemDefinitions)
    .where(eq(problemDefinitions.id, problemDefinitionId))
    .limit(1);

  if (!def) throw new Error('Problem definition not found');

  // Generate clarification questions via LLM
  const clarificationPrompt = `The following topic needs clarification before a team can explore it:
"${def.topicText}"

${voteSummaryText(await db
  .select()
  .from(problemDefinitionVotes)
  .where(eq(problemDefinitionVotes.problemDefinitionId, problemDefinitionId))
  .limit(100))}

Generate 2-3 specific clarifying questions that would help the team define this problem more clearly.
Also suggest 1 clearer rewritten topic the admin could use for a re-run.
Output as JSON: { "questions": ["question 1", "question 2", "question 3"], "suggestedTopic": "clearer topic" }`;

  let questions: string[] = [];
  let suggestedTopic: string | null = null;
  try {
    const result = await llm.generate({
      systemPrompt:
        'You are a helpful assistant that generates clarifying questions. Output JSON only.',
      userPrompt: clarificationPrompt,
      temperature: 0.5,
      maxTokens: 512,
      responseFormat: 'json',
    });
    const parsed = result.parsed as { questions?: string[]; suggestedTopic?: string } | null;
    questions = parsed?.questions ?? [];
    suggestedTopic = parsed?.suggestedTopic?.trim() || null;
  } catch {
    questions = [
      'What is the core issue you are trying to solve?',
      'Who is affected and how?',
      'What would a successful outcome look like?',
    ];
  }

  // Increment clarification round, but keep the validation in needs_work.
  // A new validation should only start after the admin/team rewrites the topic.
  await db
    .update(problemDefinitions)
    .set({
      clarificationRound: (def.clarificationRound ?? 0) + 1,
      refinedText: suggestedTopic,
      updatedAt: new Date(),
    })
    .where(eq(problemDefinitions.id, problemDefinitionId));

  return { questions, suggestedTopic };
}

/**
 * Notify the group/admin when validation ends in needs_work.
 * This turns Refine/Unsure votes into an actionable clarification step.
 */
async function sendClarificationToStakeholders(problemDefinitionId: string): Promise<void> {
  const [def] = await db
    .select()
    .from(problemDefinitions)
    .where(eq(problemDefinitions.id, problemDefinitionId))
    .limit(1);

  if (!def?.projectId) return;

  const [project] = await db
    .select({
      name: projects.name,
      groupIds: projects.groupIds,
      adminId: projects.adminId,
    })
    .from(projects)
    .where(eq(projects.id, def.projectId))
    .limit(1);

  const votes = await db
    .select()
    .from(problemDefinitionVotes)
    .where(eq(problemDefinitionVotes.problemDefinitionId, problemDefinitionId))
    .limit(100);

  const clear = votes.filter((v) => v.vote === 'clear').length;
  const refine = votes.filter((v) => v.vote === 'refine').length;
  const unsure = votes.filter((v) => v.vote === 'unsure').length;
  const clarification = await runClarification(problemDefinitionId);

  const questionsText = clarification.questions.length > 0
    ? clarification.questions.map((q, i) => `${i + 1}. ${q}`).join('\n')
    : '1. What exactly should this round help the team decide or understand?\n2. Who is affected, and what context is missing?';

  const suggested = clarification.suggestedTopic
    ? `\n\nSuggested clearer topic:\n“${clarification.suggestedTopic}”`
    : '';

  const message =
    `⚠️ Topic needs clarification before the round starts.\n\n` +
    `Project: ${project?.name ?? 'Zolara project'}\n` +
    `Original topic: “${def.topicText}”\n\n` +
    `Vote result: ✅ Clear ${clear} / ⚠️ Refine ${refine} / ❓ Unsure ${unsure}.\n` +
    `Clear did not reach a strict majority, so Zolara will not start the round yet.\n\n` +
    `Use these prompts to sharpen the topic:\n${questionsText}${suggested}\n\n` +
    `Next step: rewrite the topic and start a new validation with /startround <clearer topic>.`;

  const targets = new Set<number>();
  for (const groupId of project?.groupIds ?? []) {
    if (typeof groupId === 'number') targets.add(groupId);
  }

  if (project?.adminId) {
    const [admin] = await db
      .select({ telegramId: admins.telegramId })
      .from(admins)
      .where(eq(admins.id, project.adminId as number))
      .limit(1);
    if (admin?.telegramId) targets.add(admin.telegramId);
  }

  for (const target of targets) {
    await sendMessage(target, message, { parseMode: 'Markdown' }, def.projectId);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

async function voteSummaryText(votes: { vote: string }[]): Promise<string> {
  const clear = votes.filter((v) => v.vote === 'clear').length;
  const refine = votes.filter((v) => v.vote === 'refine').length;
  const unsure = votes.filter((v) => v.vote === 'unsure').length;
  return `Vote summary: ${clear} clear, ${refine} refine, ${unsure} unsure`;
}

/**
 * Check all problem definitions with voting status and tally those past deadline.
 * Called by cron job.
 */
export async function checkValidationDeadlines(): Promise<void> {
  const now = new Date();

  const expiredValidations = await db
    .select()
    .from(problemDefinitions)
    .where(
      and(
        eq(problemDefinitions.status, 'voting'),
        lte(problemDefinitions.voteDeadline, now)
      )
    )
    .limit(100);

  // Filter for actually expired ones
  for (const def of expiredValidations) {
    if (def.voteDeadline && def.voteDeadline <= now) {
      try {
        await tallyVotes(def.id);
      } catch (err) {
        roundLog.deadlineCheckFailed({ problemDefinitionId: def.id }, err);
      }
    }
  }
}
