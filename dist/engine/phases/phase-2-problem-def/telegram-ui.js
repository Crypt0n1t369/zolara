/**
 * Phase 2 — Telegram UI for Problem Validation
 *
 * Sends validation DMs with inline keyboard voting.
 * Handles vote callback queries.
 *
 * Keyboard format: validate:vote:{problemDefinitionId}:{vote}|validate:topic:{problemDefinitionId}
 */
import { InlineKeyboard } from 'grammy';
import { db } from '../../../data/db';
import { members, problemDefinitions, problemDefinitionVotes, users } from '../../../data/schema/projects';
import { sendMessage } from '../../../util/telegram-sender';
import { eq, and } from 'drizzle-orm';
import { processVote } from './index';
function escapeHtml(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
export function staleValidationMessage(status) {
    const normalized = status ?? 'unknown';
    if (normalized === 'missing') {
        return ('↪️ This validation button no longer matches an active topic.\n\n' +
            'Use /status to check the current state, or ask the admin to start a fresh validation with /startround.');
    }
    if (normalized === 'voting') {
        return 'This validation is still open. Use the latest validation message buttons, or /status to check progress.';
    }
    const statusText = {
        confirmed: 'This topic has already been confirmed and the round has moved forward.',
        needs_work: 'This topic needs clarification, so the old vote buttons are closed.',
        rejected: 'This validation ended and the topic was not accepted.',
        abandoned: 'This validation was cancelled.',
        pending: 'This validation is not accepting votes yet.',
    };
    return (`↪️ ${statusText[normalized] ?? 'This validation is no longer accepting votes.'}\n\n` +
        'Use “View topic” on the latest message or /status to check the current state. ' +
        'If the team needs to revisit it, the admin can start a fresh validation with /startround.');
}
/**
 * Send validation DM to each member.
 * Includes: topic, context, and inline vote keyboard.
 */
export async function sendValidationDM(problemDefinitionId, projectId, topic, memberList) {
    const safeTopic = escapeHtml(topic);
    const message = `🗳 <b>Topic validation</b>\n\n` +
        `Proposed round topic: <b>${safeTopic}</b>\n\n` +
        `Before we ask everyone deeper questions, please confirm whether this topic is clear enough to explore.\n\n` +
        `• ✅ Clear — I understand the topic and we can proceed\n` +
        `• ⚠️ Refine — It needs clearer wording or more specificity\n` +
        `• ❓ Not sure — I need more context before voting\n\n` +
        `Tap your choice below:`;
    for (const member of memberList) {
        try {
            const kbd = buildValidationKeyboard(problemDefinitionId);
            await sendMessage(member.userId, message, {
                parseMode: 'HTML',
                replyMarkup: kbd,
            }, projectId);
        }
        catch (err) {
            console.warn(`Failed to send validation DM to ${member.userId}:`, err);
        }
    }
}
/**
 * Build the validation vote keyboard.
 * callback_data format: validate:vote:{problemDefinitionId}:{vote}
 */
export function buildValidationKeyboard(problemDefinitionId) {
    return new InlineKeyboard()
        .text('✅ Clear', `validate:vote:${problemDefinitionId}:clear`)
        .text('⚠️ Refine', `validate:vote:${problemDefinitionId}:refine`)
        .text('❓ Not sure', `validate:vote:${problemDefinitionId}:unsure`)
        .row()
        .text('ℹ️ View topic', `validate:topic:${problemDefinitionId}`);
}
/**
 * Parse a validation callback string.
 * Returns null if format is invalid.
 */
export function parseValidationCallback(data) {
    const parts = data.split(':');
    if (parts[0] !== 'validate')
        return null;
    const action = parts[1];
    if (action !== 'vote' && action !== 'topic')
        return null;
    if (action === 'vote') {
        const vote = parts[3];
        if (!['clear', 'refine', 'unsure'].includes(vote))
            return null;
        return { action: 'vote', problemDefinitionId: parts[2], vote };
    }
    return { action: 'topic', problemDefinitionId: parts[2] };
}
/**
 * Handle a vote callback query from the inline keyboard.
 * Called from the bot's callback_query handler.
 */
export async function handleVoteCallback(problemDefinitionId, vote, telegramId) {
    try {
        const [def] = await db
            .select({ projectId: problemDefinitions.projectId, status: problemDefinitions.status })
            .from(problemDefinitions)
            .where(eq(problemDefinitions.id, problemDefinitionId))
            .limit(1);
        if (!def?.projectId) {
            return {
                text: staleValidationMessage('missing'),
                alert: true,
            };
        }
        if (def.status !== 'voting') {
            return { text: staleValidationMessage(def.status), alert: true };
        }
        const [member] = await db
            .select({ id: members.id })
            .from(members)
            .innerJoin(users, eq(members.userId, users.id))
            .where(and(eq(users.telegramId, telegramId), eq(members.projectId, def.projectId)))
            .limit(1);
        if (!member) {
            return {
                text: '❌ You are not registered for this project yet. Use your project invite link to join, or /status to check your connection.',
                alert: true,
            };
        }
        const [existingVote] = await db
            .select({ vote: problemDefinitionVotes.vote })
            .from(problemDefinitionVotes)
            .where(and(eq(problemDefinitionVotes.problemDefinitionId, problemDefinitionId), eq(problemDefinitionVotes.memberId, member.id)))
            .limit(1);
        if (existingVote) {
            const existingLabel = {
                clear: '✅ Clear',
                refine: '⚠️ Refine',
                unsure: '❓ Not sure',
            }[existingVote.vote] ?? existingVote.vote;
            return { text: `Your vote is already recorded as ${existingLabel}.`, alert: true };
        }
        const result = await processVote(problemDefinitionId, member.id, vote);
        if (!result.recorded) {
            return { text: '❌ Could not record your vote. Please try again.', alert: true };
        }
        const voteLabel = { clear: '✅ Clear', refine: '⚠️ Refine', unsure: '❓ Not sure' }[vote];
        if (result.tallyComplete && result.result) {
            return formatTallyResult(result.result);
        }
        return {
            text: `${voteLabel} recorded ✅\n\n` +
                `Waiting for the rest of the team to vote...\n` +
                `I’ll let you know when validation is complete.`,
            alert: false,
        };
    }
    catch (err) {
        return { text: `❌ Error: ${err instanceof Error ? err.message : String(err)}`, alert: true };
    }
}
/**
 * Handle a topic view callback.
 */
export async function handleTopicCallback(problemDefinitionId) {
    const [def] = await db
        .select()
        .from(problemDefinitions)
        .where(eq(problemDefinitions.id, problemDefinitionId))
        .limit(1);
    if (!def) {
        return { text: staleValidationMessage('missing'), alert: true };
    }
    const statusIcon = {
        pending: '⏳',
        voting: '🗳',
        confirmed: '✅',
        needs_work: '⚠️',
        rejected: '❌',
        abandoned: '🚫',
    }[def.status ?? 'pending'] ?? '❓';
    return {
        text: `${statusIcon} *Topic:* ${def.topicText}\n` +
            `Status: ${def.status ?? 'unknown'}\n` +
            `Votes: ${def.votesReceived ?? 0}/${def.totalVoters ?? 0}`,
        alert: false,
    };
}
/**
 * Format the tally result for display to the group.
 */
function formatTallyResult(result) {
    const { status, confidenceScore, voteSummary } = result;
    const total = voteSummary.total;
    const statusEmoji = {
        confirmed: '✅',
        needs_work: '⚠️',
        rejected: '❌',
    }[status] ?? '❓';
    const majorityNeeded = Math.floor(total / 2) + 1;
    const statusText = {
        confirmed: `Confirmed: ✅ Clear reached a strict majority (${voteSummary.clear}/${total}; needed ${majorityNeeded}). The round is starting now.`,
        needs_work: `Needs clarification: ✅ Clear did not reach a strict majority (${voteSummary.clear}/${total}; needed ${majorityNeeded}). I’ll send clarification prompts next.`,
        rejected: 'Problem could not be validated — admin notified.',
    }[status] ?? 'Unknown status';
    const text = `${statusEmoji} *Validation Complete*\n\n` +
        `Votes received: ${total}\n` +
        `• ✅ Clear: ${voteSummary.clear}\n` +
        `• ⚠️ Refine: ${voteSummary.refine}\n` +
        `• ❓ Not sure: ${voteSummary.unsure}\n\n` +
        `Confidence: *${confidenceScore}*/100\n\n` +
        `${statusText}`;
    return { text, alert: true };
}
/**
 * Send clarification questions to the group (after needs_work result).
 */
export async function sendClarificationToGroup(projectId, groupId, topic, questions) {
    const keyboard = new InlineKeyboard().text('✅ Proceed', `validate:proceed:${projectId}`);
    const questionsText = questions
        .map((q, i) => `${i + 1}. ${q}`)
        .join('\n');
    const message = `⚠️ <b>Topic needs clarification</b>\n\n` +
        `The topic <b>"${escapeHtml(topic)}"</b> needs clearer wording before the round can proceed.\n\n` +
        `Discuss these prompts, then restart validation with a refined topic:\n\n` +
        `${questionsText}\n\n` +
        `When you are ready, rewrite the topic and start a new validation with /startround.`;
    await sendMessage(groupId, message, {
        parseMode: 'HTML',
        replyMarkup: keyboard,
    }, projectId);
}
