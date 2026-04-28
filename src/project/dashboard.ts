export type DashboardMember = {
  onboardingStatus: string | null;
};

export type DashboardRound = {
  roundNumber: number | null;
  status: string | null;
  topic: string | null;
  responseCount: number | null;
  memberCount: number | null;
  deadline?: Date | null;
};

export type OnboardingSummary = {
  total: number;
  complete: number;
  pending: number;
  byStatus: Record<string, number>;
};

export type ValidationVoteCounts = {
  clear: number;
  refine: number;
  unsure: number;
};

export type DashboardValidationAttempt = {
  topicText: string;
  refinedText?: string | null;
  status: string | null;
  votesReceived: number | null;
  totalVoters: number | null;
  confidenceScore?: number | null;
  clarificationRound: number | null;
  voteCounts?: ValidationVoteCounts;
};

const ACTIVE_ROUND_STATUSES = new Set(['scheduled', 'gathering', 'synthesizing']);

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function summarizeOnboarding(members: DashboardMember[]): OnboardingSummary {
  const byStatus: Record<string, number> = {};
  for (const member of members) {
    const status = member.onboardingStatus ?? 'fresh';
    byStatus[status] = (byStatus[status] ?? 0) + 1;
  }

  const complete = byStatus.complete ?? 0;
  return {
    total: members.length,
    complete,
    pending: Math.max(0, members.length - complete),
    byStatus,
  };
}

export function formatOnboardingBreakdown(summary: OnboardingSummary): string {
  const pendingDetails = Object.entries(summary.byStatus)
    .filter(([status]) => status !== 'complete')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([status, count]) => `${status}: ${count}`)
    .join(' · ');

  return pendingDetails || 'none';
}

export function pickCurrentRound(rounds: DashboardRound[]): DashboardRound | null {
  return rounds.find((round) => ACTIVE_ROUND_STATUSES.has(round.status ?? '')) ?? rounds[0] ?? null;
}

export function missingResponses(round: DashboardRound | null, fallbackMemberCount: number): number {
  if (!round) return 0;
  const responseCount = round.responseCount ?? 0;
  const memberCount = round.memberCount ?? fallbackMemberCount;
  return Math.max(0, memberCount - responseCount);
}

export function formatValidationAttemptLine(attempt: DashboardValidationAttempt, index: number): string {
  const counts = attempt.voteCounts;
  const voteText = counts
    ? `✅ ${counts.clear} / ⚠️ ${counts.refine} / ❓ ${counts.unsure}`
    : `${attempt.votesReceived ?? 0}/${attempt.totalVoters ?? 0}`;
  const refined = attempt.refinedText ? ` → refined: ${escapeHtml(attempt.refinedText)}` : '';
  const confidence = attempt.confidenceScore === null || attempt.confidenceScore === undefined
    ? ''
    : ` · conf ${attempt.confidenceScore}/100`;

  return `${index + 1}. <b>${escapeHtml(attempt.status ?? 'unknown')}</b> · votes ${voteText} (${attempt.votesReceived ?? 0}/${attempt.totalVoters ?? 0}) · c${attempt.clarificationRound ?? 0}${confidence}\n` +
    `   ${escapeHtml(attempt.topicText)}${refined}`;
}

export function formatValidationHistory(attempts: DashboardValidationAttempt[], max = 5): string {
  if (attempts.length === 0) return 'No validation attempts yet.';
  return attempts.slice(0, max).map((attempt, index) => formatValidationAttemptLine(attempt, index)).join('\n');
}

export function dashboardNextAction(args: {
  pendingOnboarding: number;
  validationStatus?: string | null;
  roundStatus?: string | null;
  missingResponses: number;
  hasMembers: boolean;
}): string {
  if (!args.hasMembers) return 'Invite members with /invite.';
  if (args.pendingOnboarding > 0) return `Nudge ${args.pendingOnboarding} pending member(s) to finish onboarding.`;
  if (args.validationStatus === 'voting') return 'Wait for validation votes, or clarify the topic if people are unsure.';
  if (args.validationStatus === 'needs_work') return 'Rewrite the topic and run /startround <clearer topic>.';
  if (args.roundStatus === 'scheduled') return 'Round is scheduled and waiting for validation to finish.';
  if (args.roundStatus === 'gathering' && args.missingResponses > 0) return `Wait for ${args.missingResponses} missing response(s), then synthesis can run.`;
  if (args.roundStatus === 'synthesizing') return 'Wait for synthesis to finish, then review the report.';
  if (args.roundStatus === 'complete') return 'Review the report, then start the next round with /startround.';
  return 'Start a round with /startround <topic>.';
}
