import { describe, expect, it } from 'vitest';
import {
  dashboardNextAction,
  formatOnboardingBreakdown,
  formatValidationHistory,
  missingResponses,
  pickCurrentRound,
  recommendAdminNextAction,
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
    })).toContain('/nudge');
  });

  it('recommends a concrete admin command for each high-friction state', () => {
    expect(recommendAdminNextAction({
      pendingOnboarding: 2,
      missingResponses: 0,
      hasMembers: true,
    }).command).toBe('/nudge');

    expect(recommendAdminNextAction({
      pendingOnboarding: 0,
      validationStatus: 'needs_work',
      missingResponses: 0,
      hasMembers: true,
      suggestedRefinedTopic: 'Decide launch scope for Friday',
    }).command).toBe('/refinetopic Decide launch scope for Friday');

    expect(recommendAdminNextAction({
      pendingOnboarding: 0,
      roundStatus: 'complete',
      missingResponses: 0,
      hasMembers: true,
    }).command).toBe('/startround <topic>');
  });

  it('formats validation history with prior attempts, vote counts, clarification, and refined topic', () => {
    const text = formatValidationHistory([
      {
        topicText: 'Original topic',
        refinedText: 'Clearer topic',
        status: 'needs_work',
        votesReceived: 3,
        totalVoters: 4,
        confidenceScore: 42,
        clarificationRound: 1,
        voteCounts: { clear: 1, refine: 2, unsure: 0 },
      },
    ]);

    expect(text).toContain('needs_work');
    expect(text).toContain('✅ 1 / ⚠️ 2 / ❓ 0');
    expect(text).toContain('c1');
    expect(text).toContain('refined: Clearer topic');
  });
});
