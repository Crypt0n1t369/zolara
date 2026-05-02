import { describe, expect, it } from 'vitest';
import { extractSimpleReflectionSignal, formatConfirmedSignals, formatPersonalProfileView, formatQuestionPersonalization, mergeConfirmedSignal, normalizeReflectionRefinement } from './individual-profile';
describe('individual profile view', () => {
    it('formats onboarding profile, confirmed signals, and privacy note', () => {
        const text = formatPersonalProfileView({
            projectName: 'Alpha Team',
            role: 'participant',
            onboardingStatus: 'complete',
            activeQuestion: true,
            projectProfile: {
                interests: 'Product strategy and customer discovery',
                communication_style: 'direct',
                availability: 'weekly',
            },
            communicationProfile: {
                individualDiscovery: {
                    confirmedSignals: [
                        { label: 'clarity', type: 'value', confidence: 'high', scope: 'private_to_member' },
                    ],
                },
            },
            latestRound: {
                roundNumber: 3,
                status: 'gathering',
                topic: 'Improve onboarding',
                responseCount: 2,
                memberCount: 4,
            },
        });
        expect(text).toContain('Your Zolara profile');
        expect(text).toContain('Project: Alpha Team');
        expect(text).toContain('Interests / knowledge: Product strategy and customer discovery');
        expect(text).toContain('Clarity (Value, confidence: high, scope: private_to_member)');
        expect(text).toContain('#3 — gathering');
        expect(text).toContain('only you can see this profile');
    });
    it('handles missing confirmed signals safely', () => {
        expect(formatConfirmedSignals({})).toBe('No confirmed personal signals yet.');
    });
    it('extracts simple deterministic reflection signals', () => {
        expect(extractSimpleReflectionSignal('We need clearer ownership before moving fast')).toEqual({
            label: 'clarity',
            type: 'value',
        });
    });
    it('formats light question personalization from confirmed private signals', () => {
        const text = formatQuestionPersonalization({
            individualDiscovery: {
                confirmedSignals: [
                    { label: 'clarity', type: 'value', confidence: 'high', scope: 'private_to_member', projectId: 'project-1' },
                ],
            },
        }, 'project-1');
        expect(text).toContain('clarity');
        expect(text).toContain('ignore it if it doesn’t fit');
    });
    it('normalizes short reflection refinements', () => {
        expect(normalizeReflectionRefinement('  practical next steps\nplease  ')).toBe('practical next steps please');
        expect(normalizeReflectionRefinement('x')).toBeNull();
    });
    it('merges confirmed signals without duplicates', () => {
        const profile = mergeConfirmedSignal({ individualDiscovery: { confirmedSignals: [] } }, {
            label: 'clarity',
            type: 'value',
            projectId: 'project-1',
            confirmedAt: '2026-05-02T00:00:00Z',
        });
        const updated = mergeConfirmedSignal(profile, {
            label: 'clarity',
            type: 'value',
            projectId: 'project-1',
            confirmedAt: '2026-05-02T01:00:00Z',
        });
        const signals = updated.individualDiscovery.confirmedSignals;
        expect(signals).toHaveLength(1);
        expect(signals[0]).toMatchObject({ label: 'clarity', confidence: 'high', scope: 'private_to_member' });
    });
});
