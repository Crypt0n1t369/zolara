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
export function dashboardNextAction(args) {
    if (!args.hasMembers)
        return 'Invite members with /invite.';
    if (args.pendingOnboarding > 0)
        return `Nudge ${args.pendingOnboarding} pending member(s) to finish onboarding.`;
    if (args.validationStatus === 'voting')
        return 'Wait for validation votes, or clarify the topic if people are unsure.';
    if (args.validationStatus === 'needs_work')
        return 'Rewrite the topic and run /startround <clearer topic>.';
    if (args.roundStatus === 'scheduled')
        return 'Round is scheduled and waiting for validation to finish.';
    if (args.roundStatus === 'gathering' && args.missingResponses > 0)
        return `Wait for ${args.missingResponses} missing response(s), then synthesis can run.`;
    if (args.roundStatus === 'synthesizing')
        return 'Wait for synthesis to finish, then review the report.';
    if (args.roundStatus === 'complete')
        return 'Review the report, then start the next round with /startround.';
    return 'Start a round with /startround <topic>.';
}
