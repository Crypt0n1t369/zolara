import { describe, expect, it } from 'vitest';
import { isValidReportReaction, summarizeLatestReportReactions } from './report-reactions';

describe('report reaction helpers', () => {
  it('validates report reaction callback values', () => {
    expect(isValidReportReaction('aligned')).toBe(true);
    expect(isValidReportReaction('discuss')).toBe(true);
    expect(isValidReportReaction('disagree')).toBe(true);
    expect(isValidReportReaction('save_actions')).toBe(true);
    expect(isValidReportReaction('unknown')).toBe(false);
    expect(isValidReportReaction(undefined)).toBe(false);
  });

  it('counts only the latest valid reaction per member for the selected round', () => {
    const rows = [
      { memberId: 1, createdAt: new Date('2026-05-01T10:00:00Z'), metadata: { roundNumber: 2, reaction: 'aligned' } },
      { memberId: 1, createdAt: new Date('2026-05-01T10:01:00Z'), metadata: { roundNumber: 2, reaction: 'disagree' } },
      { memberId: 2, createdAt: new Date('2026-05-01T10:02:00Z'), metadata: { roundNumber: 2, reaction: 'discuss' } },
      { memberId: 3, createdAt: new Date('2026-05-01T10:03:00Z'), metadata: { roundNumber: 2, reaction: 'save_actions' } },
      { memberId: 4, createdAt: new Date('2026-05-01T10:04:00Z'), metadata: { roundNumber: 1, reaction: 'aligned' } },
      { memberId: 5, createdAt: new Date('2026-05-01T10:05:00Z'), metadata: { roundNumber: 2, reaction: 'unknown' } },
      { memberId: null, createdAt: new Date('2026-05-01T10:06:00Z'), metadata: { roundNumber: 2, reaction: 'aligned' } },
    ];

    expect(summarizeLatestReportReactions(rows, 2)).toEqual({
      aligned: 0,
      discuss: 1,
      disagree: 1,
      saveActions: 1,
      total: 3,
    });
  });
});
