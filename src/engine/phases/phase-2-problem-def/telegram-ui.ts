/**
 * Phase 2 — Telegram UI for Problem Validation
 *
 * Sends validation DMs with inline keyboard voting.
 * Handles vote callback queries.
 *
 * Keyboards:
 * - Validation: [✅ Clear] [⚠️ Refine] [❓ Not sure]
 * - Vote with reason: (after selecting, optional text input)
 */

import { InlineKeyboard } from 'grammy';
import { db } from '../../../data/db';
import { members } from '../../../data/schema/projects';
import { sendMessage } from '../../../util/telegram-sender';
import { eq } from 'drizzle-orm';
import { processVote } from './index';

/**
 * Send validation DM to each member.
 * Includes: topic, context, and inline vote keyboard.
 */
export async function sendValidationDM(
  roundId: string,
  projectId: string,
  topic: string,
  memberList: { userId: number }[]
): Promise<void> {
  const keyboard = buildValidationKeyboard(roundId);

  const message =
    `🗳 *Topic Validation Required*\n\n` +
    `A round has been proposed for: *${topic}*\n\n` +
    `Before we explore this topic, your team needs to confirm it's clearly defined.\n\n` +
    `Is *"${topic}"* clearly defined?\n\n` +
    `• *✅ Clear* — I understand the problem, let's explore it\n` +
    `• *⚠️ Refine* — Needs clarification or more specificity\n` +
    `• *❓ Not sure* — I need more context before deciding\n\n` +
    `Your vote helps the team start with the right foundation.\n` +
    `Tap your choice below:`;

  for (const member of memberList) {
    try {
      await sendMessage(member.userId, message, {
        parseMode: 'Markdown',
        replyMarkup: keyboard,
      }, projectId);
    } catch (err) {
      // Member may have blocked the bot — skip
      console.warn(`Failed to send validation DM to ${member.userId}:`, err);
    }
  }
}

/**
 * Build the validation vote keyboard.
 * callback_data encodes: vote action + problem_definition_id
 */
function buildValidationKeyboard(problemDefinitionId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text(
      '✅ Clear',
      JSON.stringify({ a: 'vote', id: problemDefinitionId, v: 'clear' })
    )
    .text(
      '⚠️ Refine',
      JSON.stringify({ a: 'vote', id: problemDefinitionId, v: 'refine' })
    )
    .text(
      '❓ Not sure',
      JSON.stringify({ a: 'vote', id: problemDefinitionId, v: 'unsure' })
    )
    .row()
    .text(
      'ℹ️ View topic',
      JSON.stringify({ a: 'view_topic', id: problemDefinitionId })
    );
}

/**
 * Handle a vote callback query from the inline keyboard.
 * Returns the response text to send back to the user.
 */
export async function handleVoteCallback(
  callbackData: string,
  memberId: number
): Promise<{ text: string; alert: boolean }> {
  let payload: { a: string; id: string; v?: string };
  try {
    payload = JSON.parse(callbackData);
  } catch {
    return { text: '❌ Invalid callback data', alert: true };
  }

  switch (payload.a) {
    case 'vote': {
      if (!payload.v) return { text: '❌ Missing vote value', alert: true };
      const vote = payload.v as 'clear' | 'refine' | 'unsure';
      const result = await processVote(payload.id, memberId, vote);

      if (!result.recorded) {
        return { text: '❌ Could not record your vote. Please try again.', alert: true };
      }

      if (result.tallyComplete && result.result) {
        return formatTallyResult(result.result);
      }

      const voteLabel = { clear: '✅ Clear', refine: '⚠️ Refine', unsure: '❓ Not sure' }[vote];
      return {
        text:
          `${voteLabel} recorded ✅\n\n` +
          `Waiting for other team members to vote...\n` +
          `I'll let you know when the vote is complete.`,
        alert: false,
      };
    }

    case 'view_topic': {
      // Return the topic text — gramJS will show this
      return {
        text: '📋 Your view_topic request was received. The topic is visible in the original message.',
        alert: false,
      };
    }

    default:
      return { text: '❌ Unknown action', alert: true };
  }
}

/**
 * Format the tally result for display to the group.
 */
function formatTallyResult(result: {
  status: string;
  confidenceScore: number;
  voteSummary: { clear: number; refine: number; unsure: number; total: number };
}): { text: string; alert: boolean } {
  const { status, confidenceScore, voteSummary } = result;
  const total = voteSummary.total;

  const statusEmoji = {
    confirmed: '✅',
    needs_work: '⚠️',
    rejected: '❌',
  }[status] ?? '❓';

  const statusText = {
    confirmed: 'Problem is clearly defined — round is starting!',
    needs_work: 'Problem needs clarification — clarification round coming.',
    rejected: 'Problem could not be validated — admin notified.',
  }[status] ?? 'Unknown status';

  const text =
    `${statusEmoji} *Validation Complete*\n\n` +
    `Topic: *${voteSummary.total > 0 ? '' : '(topic)'}` +
    `Votes: ${total}\n` +
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
export async function sendClarificationToGroup(
  projectId: string,
  groupId: number,
  topic: string,
  questions: string[]
): Promise<void> {
  const keyboard = new InlineKeyboard().text(
    '✅ Proceed',
    JSON.stringify({ a: 'proceed', id: projectId })
  );

  const questionsText = questions
    .map((q, i) => `${i + 1}. ${q}`)
    .join('\n');

  const message =
    `⚠️ *Problem Needs Clarification*\n\n` +
    `The topic *"${topic}"* needs clarification before we can proceed.\n\n` +
    `Please discuss and refine the problem definition:\n\n` +
    `${questionsText}\n\n` +
    `When you're ready, tap *Proceed* to re-run the validation.`;

  await sendMessage(groupId, message, {
    parseMode: 'Markdown',
    replyMarkup: keyboard,
  }, projectId);
}
