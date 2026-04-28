import { describe, expect, it } from 'vitest';
import {
  dashboardNextAction,
  formatOnboardingBreakdown,
  missingResponses,
  pickCurrentRound,
  summarizeOnboarding,
} from './dashboard';

describe('admin dashboard helpers', () => {
  it('summarizes complete and pending onboarding states', () => {
    const summary = summarizeOnboarding([
      { onboardingStatus: 'complete' },
      { onboardingStatus: 'fresh' },
      { onboardingStatus: 'committed' },
      { onboardingStatus: null },
    ]);

    expect(summary.total).toBe(4);
    expect(summary.complete).toBe(1);
    expect(summary.pending).toBe(3);
    expect(formatOnboardingBreakdown(summary)).toBe('committed: 1 · fresh: 2');
  });

  it('prefers active or scheduled rounds over older completed rounds for the dashboard surface', () => {
    const current = pickCurrentRound([
      { roundNumber: 5, status: 'complete', topic: 'done', responseCount: 3, memberCount: 3 },
      { roundNumber: 4, status: 'scheduled', topic: 'validating', responseCount: 0, memberCount: 3 },
    ]);

    expect(current?.roundNumber).toBe(4);
    expect(current?.status).toBe('scheduled');
  });

  it('computes missing responses and recommends the next admin action', () => {
    const round = { roundNumber: 2, status: 'gathering', topic: 'topic', responseCount: 2, memberCount: 5 };

    expect(missingResponses(round, 10)).toBe(3);
    expect(dashboardNextAction({
      pendingOnboarding: 0,
      validationStatus: 'confirmed',
      roundStatus: 'gathering',
      missingResponses: 3,
      hasMembers: true,
    })).toContain('3 missing response');
  });
});
