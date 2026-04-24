/**
 * Round Lifecycle Manager
 * Orchestrates the state machine transitions for deliberation rounds.
 *
 * States: SCHEDULED → GATHERING → SYNTHESIZING → COMPLETE
 *                    ↘ CANCELLED    ↘ FAILED → (retry) → SYNTHESIZING
 */
import { eq, desc, and } from 'drizzle-orm';
import { db } from '../data/db';
import { rounds, projects, members, questions, responses } from '../data/schema/projects';
import { runSynthesis, meetsMinimumThreshold } from './synthesis/pipeline';
import { generateQuestions, personalizeQuestion } from './question/generator';
import { sendQuestionDM, postReportToGroupChat, } from '../util/telegram-sender';
import { round as roundLog, db as dbLog, llm as llmLog, telegram as telegramLog, } from '../util/logger';
// ── Public API ─────────────────────────────────────────────────────────────────
/**
 * Trigger a new round for a project.
 * Creates a SCHEDULED round that transitions to GATHERING immediately.
 */
export async function triggerRound(projectId, topic, options) {
    // Check no active round exists
    const activeRound = await db
        .select()
        .from(rounds)
        .where(and(eq(rounds.projectId, projectId), eq(rounds.status, 'gathering')))
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
    const config = project.config;
    const cycleDurationHours = getCycleDuration(config['cycleFrequency'] ?? 'weekly');
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
    await transitionToGathering(round.id, projectId, nextRoundNumber, memberList, config, options?.anonymity ?? null);
    return { roundId: round.id, status: round.status ?? 'unknown' };
}
/**
 * Cancel an active round.
 */
export async function cancelRound(roundId) {
    const [round] = await db
        .select()
        .from(rounds)
        .where(eq(rounds.id, roundId))
        .limit(1);
    if (!round)
        throw new Error('Round not found');
    const currentStatus = round.status ?? 'unknown';
    if (!['gathering', 'synthesizing'].includes(currentStatus)) {
        throw new Error(`Cannot cancel round in ${currentStatus} state`);
    }
    await db
        .update(rounds)
        .set({ status: 'cancelled' })
        .where(eq(rounds.id, roundId));
}
// ── State Transitions ─────────────────────────────────────────────────────────
async function transitionToGathering(roundId, projectId, roundNumber, memberList, config, roundAnonymity) {
    const projectConfig = config;
    // Filter out members with invalid userIds
    const validMembers = memberList.filter((m) => m.userId !== null);
    // Generate questions
    let questionsList;
    try {
        questionsList = await generateQuestions({
            projectId,
            topic: '', // Will be set by admin
            depth: projectConfig.questionDepth ?? 'medium',
            anonymity: roundAnonymity ?? projectConfig.anonymity ?? 'optional',
            teamSizeRange: projectConfig.team_size_range ?? '2-5',
        });
    }
    catch (err) {
        llmLog.generationFailed({ projectId, roundId }, err);
        roundLog.stateTransitionFailed('GATHERING', 'FAILED', { projectId, roundId }, err);
        // Mark as failed
        try {
            await db
                .update(rounds)
                .set({ status: 'failed', errorMessage: 'Question generation failed' })
                .where(eq(rounds.id, roundId));
        }
        catch (dbErr) {
            dbLog.updateFailed('rounds', { roundId }, dbErr);
        }
        return;
    }
    // Store and send questions to each member
    for (const member of validMembers) {
        if (member.userId === null)
            continue;
        const memberProfile = member.projectProfile;
        // Personalize question
        const personalizedQ = await personalizeQuestion(questionsList[0], {
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
        await sendQuestionToMember(projectId, member.userId, personalizedQ.text, roundNumber, storedQuestion.id, roundId);
    }
    // Update round status
    await db
        .update(rounds)
        .set({ status: 'gathering', startedAt: new Date() })
        .where(eq(rounds.id, roundId));
}
async function transitionToSynthesizing(roundId) {
    const [round] = await db
        .select()
        .from(rounds)
        .where(eq(rounds.id, roundId))
        .limit(1);
    if (!round)
        throw new Error('Round not found');
    // Check minimum responses
    const config = round.metadata;
    const teamSizeRange = config['team_size_range'] ?? '2-5';
    const memberCount = round.memberCount ?? 0;
    const responseCount = round.responseCount ?? 0;
    if (responseCount < 2) {
        // Cancel - too few responses
        const message = responseCount === 0
            ? 'Round cancelled — no responses received.'
            : `Only ${responseCount} perspective received. Minimum 2 required.`;
        await db
            .update(rounds)
            .set({ status: 'cancelled' })
            .where(eq(rounds.id, roundId));
        throw new Error(`Round cancelled: ${message}`);
    }
    if (!meetsMinimumThreshold(responseCount, memberCount, teamSizeRange)) {
        // Proceed but flag in metadata
        console.warn(`[RoundManager] Round ${roundId} proceeding with low response rate: ${responseCount}/${memberCount}`);
    }
    await db
        .update(rounds)
        .set({ status: 'synthesizing' })
        .where(eq(rounds.id, roundId));
}
async function transitionToComplete(roundId, reportData) {
    await db
        .update(rounds)
        .set({
        status: 'complete',
        completedAt: new Date(),
        convergenceScore: String(reportData['convergenceScore'] ?? ''),
        convergenceTier: reportData['convergenceTier'],
    })
        .where(eq(rounds.id, roundId));
}
// ── Deadline Checking (called by cron) ────────────────────────────────────────
/**
 * Check all gathering rounds and transition any that are past deadline.
 * To be called by a cron job or background worker.
 */
export async function checkRoundDeadlines() {
    const now = new Date();
    const expiredRounds = await db
        .select()
        .from(rounds)
        .where(eq(rounds.status, 'gathering'))
        .limit(100);
    for (const round of expiredRounds) {
        if (round.deadline && round.deadline <= now && round.projectId !== null) {
            try {
                await processRoundCompletion(round.id, round.projectId);
            }
            catch (err) {
                roundLog.deadlineCheckFailed({ roundId: round.id, projectId: round.projectId ?? undefined }, err);
            }
        }
    }
}
/**
 * Process round completion: transition to synthesizing, run synthesis, post report.
 */
export async function processRoundCompletion(roundId, projectId) {
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
    if (!round || !project)
        throw new Error('Round or project not found');
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
    }
    catch (dbErr) {
        dbLog.updateFailed('rounds', { roundId }, dbErr);
    }
    // Transition to synthesizing
    await transitionToSynthesizing(roundId);
    // Run synthesis
    let reportData;
    try {
        // Use round-level anonymity if set, otherwise fall back to project config
        const effectiveAnonymity = round.anonymity
            ?? project.config['anonymity']
            ?? 'optional';
        const synthesisResult = await runSynthesis({
            roundId,
            projectId,
            topic: round.topic ?? 'General discussion',
            responseCount,
            memberCount: round.memberCount ?? 0,
            anonymity: effectiveAnonymity,
        });
        reportData = synthesisResult;
        // Store report
        const { reports } = await import('../data/schema/projects');
        try {
            await db.insert(reports).values({
                roundId,
                projectId,
                content: JSON.stringify(reportData),
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                structuredData: reportData,
            });
        }
        catch (dbErr) {
            dbLog.insertFailed('reports', { roundId, projectId }, dbErr);
        }
        // Transition to complete
        await transitionToComplete(roundId, reportData);
        // Post to group
        const groupIds = project.groupIds ?? [];
        if (groupIds.length > 0) {
            try {
                await postReportToGroup(projectId, groupIds[0], reportData, round.roundNumber, responseCount, round.memberCount ?? 0);
            }
            catch (tgErr) {
                telegramLog.sendFailed('postReportToGroup failed', { projectId, chatId: groupIds[0], roundId }, tgErr);
            }
        }
    }
    catch (err) {
        roundLog.synthesisFailed(roundId, { projectId }, err);
        try {
            await db
                .update(rounds)
                .set({
                status: 'failed',
                errorMessage: err instanceof Error ? err.message : 'Synthesis failed',
                retryCount: (round.retryCount ?? 0) + 1,
            })
                .where(eq(rounds.id, roundId));
        }
        catch (dbErr) {
            dbLog.updateFailed('rounds', { roundId }, dbErr);
        }
        throw err;
    }
}
// ── Helpers ──────────────────────────────────────────────────────────────────
function getCycleDuration(cycleFrequency) {
    const durations = {
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
async function sendQuestionToMember(projectId, userId, questionText, roundNumber, questionId, roundId) {
    return sendQuestionDM(projectId, userId, questionText, roundNumber, questionId, roundId);
}
async function postReportToGroup(projectId, groupId, reportData, roundNumber, responseCount, memberCount) {
    return postReportToGroupChat(projectId, groupId, reportData, roundNumber, responseCount, memberCount);
}
