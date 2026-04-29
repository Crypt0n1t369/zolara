const ACTIVE_ROUND_STATUSES = new Set(['scheduled', 'gathering', 'synthesizing']);
export function escapeHtml(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
export function summarizeOnboarding(members) {
    const byStatus = {};
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
export function formatOnboardingBreakdown(summary) {
    const pendingDetails = Object.entries(summary.byStatus)
        .filter(([status]) => status !== 'complete')
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([status, count]) => `${status}: ${count}`)
        .join(' · ');
    return pendingDetails || 'none';
}
export function pickCurrentRound(rounds) {
    return rounds.find((round) => ACTIVE_ROUND_STATUSES.has(round.status ?? '')) ?? rounds[0] ?? null;
}
export function missingResponses(round, fallbackMemberCount) {
    if (!round)
        return 0;
    const responseCount = round.responseCount ?? 0;
    const memberCount = round.memberCount ?? fallbackMemberCount;
    return Math.max(0, memberCount - responseCount);
}
export function formatValidationAttemptLine(attempt, index) {
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
export function formatValidationHistory(attempts, max = 5) {
    if (attempts.length === 0)
        return 'No validation attempts yet.';
    return attempts.slice(0, max).map((attempt, index) => formatValidationAttemptLine(attempt, index)).join('\n');
}
export function recommendAdminNextAction(args) {
    if (!args.hasMembers) {
        return {
            label: 'Invite the team',
            command: '/invite',
            detail: 'No members are connected yet. Share the invite link before starting validation or a round.',
            urgency: 'setup',
        };
    }
    if (args.pendingOnboarding > 0) {
        return {
            label: 'Finish onboarding',
            command: '/nudge',
            detail: `${args.pendingOnboarding} member(s) still need to finish onboarding. Send one reminder instead of chasing people manually.`,
            urgency: 'action',
        };
    }
    if (args.validationStatus === 'needs_work') {
        const command = args.suggestedRefinedTopic
            ? `/refinetopic ${args.suggestedRefinedTopic}`
            : '/adminguide';
        return {
            label: 'Refine the topic',
            command,
            detail: 'The last validation did not reach a clear majority. Refine the wording and rerun validation.',
            urgency: 'action',
        };
    }
    if (args.roundStatus === 'gathering' && args.missingResponses > 0) {
        return {
            label: 'Collect missing responses',
            command: '/nudge',
            detail: `${args.missingResponses} round response(s) are missing. Send a targeted reminder to the people blocking synthesis.`,
            urgency: 'action',
        };
    }
    if (args.validationStatus === 'voting') {
        return {
            label: 'Wait for validation votes',
            command: '/dashboard',
            detail: 'Voting is still open. Check the dashboard for current vote counts before changing the topic.',
            urgency: 'wait',
        };
    }
    if (args.roundStatus === 'scheduled') {
        return {
            label: 'Wait for validation to finish',
            command: '/dashboard',
            detail: 'A round is scheduled and should move forward after validation completes.',
            urgency: 'wait',
        };
    }
    if (args.roundStatus === 'synthesizing') {
        return {
            label: 'Wait for synthesis',
            command: '/dashboard',
            detail: 'Zolara is synthesizing responses. Check again shortly for the report state.',
            urgency: 'wait',
        };
    }
    if (args.roundStatus === 'complete') {
        return {
            label: 'Start the next working round',
            command: '/startround <topic>',
            detail: 'The latest round is complete. Start the next clear topic when the team is ready.',
            urgency: 'action',
        };
    }
    return {
        label: 'Start the first working round',
        command: '/startround <topic>',
        detail: 'Members are ready and no active round is running. Start with one clear decision, question, or tension.',
        urgency: 'action',
    };
}
export function dashboardNextAction(args) {
    const next = recommendAdminNextAction(args);
    return `${next.label}: ${next.command} — ${next.detail}`;
}
