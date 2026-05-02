export type ReportReaction = 'aligned' | 'discuss' | 'disagree' | 'save_actions';

export type ReportReactionCounts = {
  aligned: number;
  discuss: number;
  disagree: number;
  saveActions: number;
  total: number;
};

export type ReportReactionEventRow = {
  memberId: number | null;
  createdAt: Date | null;
  metadata: Record<string, unknown> | null;
};

const VALID_REACTIONS = new Set<ReportReaction>(['aligned', 'discuss', 'disagree', 'save_actions']);

export function isValidReportReaction(value: unknown): value is ReportReaction {
  return VALID_REACTIONS.has(String(value ?? '') as ReportReaction);
}

function parseReaction(value: unknown): ReportReaction | null {
  return isValidReportReaction(value) ? value : null;
}

/**
 * Count only each member's latest reaction for a report round.
 *
 * Reaction button taps are stored as immutable engagement events so we retain a
 * lightweight audit trail. Dashboard/report summaries should behave like votes:
 * one current reaction per member per round, with the newest valid tap winning.
 */
export function summarizeLatestReportReactions(
  rows: ReportReactionEventRow[],
  roundNumber: number
): ReportReactionCounts {
  const latestByMember = new Map<number, { reaction: ReportReaction; createdAt: number }>();

  for (const row of rows) {
    if (!row.memberId) continue;
    const metadata = row.metadata ?? {};
    if (Number(metadata.roundNumber) !== roundNumber) continue;

    const reaction = parseReaction(metadata.reaction);
    if (!reaction) continue;

    const createdAt = row.createdAt?.getTime() ?? 0;
    const existing = latestByMember.get(row.memberId);
    if (!existing || createdAt >= existing.createdAt) {
      latestByMember.set(row.memberId, { reaction, createdAt });
    }
  }

  const counts: ReportReactionCounts = { aligned: 0, discuss: 0, disagree: 0, saveActions: 0, total: 0 };
  for (const { reaction } of latestByMember.values()) {
    if (reaction === 'aligned') counts.aligned++;
    else if (reaction === 'discuss') counts.discuss++;
    else if (reaction === 'disagree') counts.disagree++;
    else if (reaction === 'save_actions') counts.saveActions++;
    counts.total++;
  }

  return counts;
}
