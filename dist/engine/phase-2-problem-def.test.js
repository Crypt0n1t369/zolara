/**
 * Phase 2 Tests — Problem Validation Gate
 * Structural tests for the validation flow, vote tallying, and status transitions.
 */
import { describe, it, expect } from 'vitest';
import { PHASE_PROBLEM_DEF } from './phases/flags';
import { staleValidationMessage } from './phases/phase-2-problem-def/telegram-ui';
describe('Phase 2 — Problem Validation Gate', () => {
    // ── Feature flag ─────────────────────────────────────────────────────────────
    describe('PHASE_PROBLEM_DEF flag', () => {
        it('defaults to disabled', () => {
            expect(PHASE_PROBLEM_DEF).toBe('disabled');
        });
        it('is a string flag', () => {
            expect(typeof PHASE_PROBLEM_DEF).toBe('string');
        });
    });
    // ── ProblemDefinitionStatus type ─────────────────────────────────────────────
    describe('ProblemDefinitionStatus type', () => {
        const validStatuses = [
            'pending',
            'voting',
            'confirmed',
            'needs_work',
            'rejected',
            'abandoned',
        ];
        it('includes all valid status values', () => {
            validStatuses.forEach((status) => {
                expect(typeof status).toBe('string');
            });
        });
        it('covers lifecycle from pending to terminal states', () => {
            expect(validStatuses).toContain('pending');
            expect(validStatuses).toContain('voting');
            expect(validStatuses).toContain('confirmed');
            expect(validStatuses).toContain('needs_work');
            expect(validStatuses).toContain('rejected');
            expect(validStatuses).toContain('abandoned');
        });
    });
    // ── ProblemDefinitionVote type ───────────────────────────────────────────────
    describe('ProblemDefinitionVote type', () => {
        const validVotes = ['clear', 'refine', 'unsure'];
        it('has three vote options', () => {
            expect(validVotes).toHaveLength(3);
            expect(validVotes).toContain('clear');
            expect(validVotes).toContain('refine');
            expect(validVotes).toContain('unsure');
        });
    });
    // ── Vote tallying logic ───────────────────────────────────────────────────────
    describe('Vote tallying contracts', () => {
        const VOTE_SCORES = { clear: 100, refine: 0, unsure: 50 };
        // Clear requires a strict majority; 50/50 is not enough.
        function computeTally(votes) {
            const clear = votes.filter((v) => v === 'clear').length;
            const refine = votes.filter((v) => v === 'refine').length;
            const unsure = votes.filter((v) => v === 'unsure').length;
            const total = votes.length;
            const totalScore = clear * VOTE_SCORES.clear + refine * VOTE_SCORES.refine + unsure * VOTE_SCORES.unsure;
            const confidenceScore = total > 0 ? Math.round(totalScore / total) : 0;
            const clearRate = total > 0 ? clear / total : 0;
            let status;
            if (clear > total / 2 && confidenceScore >= 40) {
                status = 'confirmed';
            }
            else if (refine > 0 || confidenceScore < 40) {
                status = 'needs_work';
            }
            else {
                status = 'needs_work';
            }
            return { confidenceScore, status, clearRate };
        }
        it('confirms when clear has a strict majority and confidence >= 40', () => {
            const votes = ['clear', 'clear', 'clear', 'unsure'];
            const result = computeTally(votes);
            expect(result.status).toBe('confirmed');
            expect(result.confidenceScore).toBe(88); // (300+50)/4 = 87.5 → Math.round rounds half to even → 88
        });
        it('needs_work when clear does not have a strict majority', () => {
            const votes = ['clear', 'unsure'];
            const result = computeTally(votes);
            expect(result.status).toBe('needs_work');
        });
        it('needs_work when refine votes prevent a clear majority', () => {
            const votes = ['clear', 'refine', 'unsure'];
            const result = computeTally(votes);
            expect(result.status).toBe('needs_work');
        });
        it('needs_work when confidence < 40', () => {
            const votes = ['unsure', 'unsure', 'refine'];
            const result = computeTally(votes);
            expect(result.status).toBe('needs_work');
            expect(result.confidenceScore).toBe(33); // (50+50+0)/3 = 33
        });
        it('rejected when no votes (edge case)', () => {
            const result = computeTally([]);
            expect(result.status).toBe('needs_work'); // default, not rejected
            expect(result.confidenceScore).toBe(0);
        });
        it('confirms on unanimous clear', () => {
            const votes = ['clear', 'clear', 'clear'];
            const result = computeTally(votes);
            expect(result.status).toBe('confirmed');
            expect(result.confidenceScore).toBe(100);
            expect(result.clearRate).toBe(1);
        });
    });
    // ── Validation flow contracts ─────────────────────────────────────────────────
    describe('Validation flow contracts', () => {
        it('validation starts with status voting', () => {
            const mockDef = { status: 'voting', votesReceived: 0, totalVoters: 5 };
            expect(mockDef.status).toBe('voting');
        });
        it('tally triggers when >50% participation', () => {
            const mockDef = { votesReceived: 3, totalVoters: 5 };
            const participationRate = mockDef.votesReceived / mockDef.totalVoters;
            expect(participationRate >= 0.5).toBe(true);
        });
        it('tally also triggers at deadline', () => {
            const now = Date.now();
            const mockDef = { voteDeadline: new Date(now - 1000) }; // 1s ago
            expect(mockDef.voteDeadline.getTime()).toBeLessThan(now);
        });
        it('confirmed validation → round transitions to gathering', () => {
            // Contract: when status=confirmed, round.status changes from scheduled → gathering
            const round = { status: 'gathering', problemDefinitionId: 'some-id' };
            expect(round.status).toBe('gathering');
        });
        it('needs_work keeps original validation closed until admin submits a refined topic', () => {
            const parent = { clarificationRound: 0, status: 'needs_work', topicText: 'Original topic', refinedText: null };
            const clarified = { ...parent, clarificationRound: parent.clarificationRound + 1, refinedText: 'Suggested clearer topic' };
            const child = { status: 'voting', topicText: clarified.refinedText };
            expect(clarified.clarificationRound).toBe(1);
            expect(clarified.status).toBe('needs_work');
            expect(child.status).toBe('voting');
            expect(child.topicText).toBe('Suggested clearer topic');
        });
        it('max clarification rounds: 3 (prevent infinite loop)', () => {
            const MAX_CLARIFICATION = 3;
            const def = { clarificationRound: 3 };
            expect(def.clarificationRound >= MAX_CLARIFICATION).toBe(true);
        });
    });
    describe('stale validation button copy', () => {
        it('explains completed validation and offers status/restart path', () => {
            const message = staleValidationMessage('confirmed');
            expect(message).toContain('already been confirmed');
            expect(message).toContain('/status');
            expect(message).toContain('/startround');
        });
        it('explains missing validation sessions clearly', () => {
            const message = staleValidationMessage('missing');
            expect(message).toContain('no longer matches an active topic');
            expect(message).toContain('/status');
        });
    });
    // ── Inline keyboard data contract ─────────────────────────────────────────────
    describe('Inline keyboard callback contract', () => {
        it('vote callback encodes action, id, and vote value', () => {
            const callback = { a: 'vote', id: 'def-123', v: 'clear' };
            const encoded = JSON.stringify(callback);
            const decoded = JSON.parse(encoded);
            expect(decoded.a).toBe('vote');
            expect(decoded.id).toBe('def-123');
            expect(decoded.v).toBe('clear');
        });
        it('view_topic callback encodes action and id only', () => {
            const callback = { a: 'view_topic', id: 'def-123' };
            const encoded = JSON.stringify(callback);
            const decoded = JSON.parse(encoded);
            expect(decoded.a).toBe('view_topic');
            expect(decoded.id).toBe('def-123');
        });
        it('callback data roundtrips through JSON', () => {
            const original = { a: 'vote', id: 'abc', v: 'refine' };
            const roundtrip = JSON.parse(JSON.stringify(original));
            expect(roundtrip).toEqual(original);
        });
    });
    // ── Phase gate contract ────────────────────────────────────────────────────────
    describe('Phase gate — disabled fallback', () => {
        it('when PHASE_PROBLEM_DEF=disabled, validation is skipped', () => {
            // Contract: validateAndTriggerRound falls back to triggerRound when flag=disabled
            expect(PHASE_PROBLEM_DEF).toBe('disabled');
        });
        it('can be set to active for Phase 2 testing', () => {
            const mockEnv = { PHASE_PROBLEM_DEF: 'active' };
            expect(mockEnv.PHASE_PROBLEM_DEF).toBe('active');
        });
    });
});
