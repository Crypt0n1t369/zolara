/**
 * Phase Feature Flags
 * Each phase is gated behind an environment variable.
 * Default: 'disabled' — existing behavior unchanged.
 * To enable: set to 'active' in .env or docker-compose.yml
 *
 * Phase order: 0=baseline (always on), then 1-8 follow spec phases P2-P9
 *
 * Current baseline (Phase 0): triggerRound → GATHERING → SYNTHESIZING → COMPLETE
 * This baseline is always active — no flag needed.
 */

// ── Phase flags ──────────────────────────────────────────────────────────────

/**
 * Phase 1 — Sub-problem infrastructure
 * New tables: sub_problems, project_map
 * No behavior change until Phase 2+ is enabled
 */
export const PHASE_SUB_PROBLEMS = process.env.PHASE_SUB_PROBLEMS ?? 'disabled';

/**
 * Phase 2 — Problem validation gate
 * Before exploration: validate problem is clearly defined
 * Confidence check → flag low confidence before proceeding
 */
export const PHASE_PROBLEM_DEF = process.env.PHASE_PROBLEM_DEF ?? 'disabled';

/**
 * Phase 3 — Exploration with cross-linking
 * During GATHERING: cross-link responses as they come in
 * Send targeted follow-up questions for contradictions/overlaps
 * Non-responder tracking + nudge
 */
export const PHASE_CROSS_LINK = process.env.PHASE_CROSS_LINK ?? 'disabled';

/**
 * Phase 4 — Iteration loop
 * Post-exploration confidence check
 * If misalignment high → trigger second targeted round before synthesis
 */
export const PHASE_ITERATION = process.env.PHASE_ITERATION ?? 'disabled';

/**
 * Phase 5 — Richer synthesis with mergedPath
 * creativeTensions include mergedPath: how to move forward
 * Blind spots surfaced more deliberately
 * Confidence score attached to report
 */
export const PHASE_RICH_SYNTHESIS = process.env.PHASE_RICH_SYNTHESIS ?? 'disabled';

/**
 * Phase 6 — Meeting preparation
 * Pre-meeting brief generated before group report
 * Posted to group: where the team stands + what needs sync resolution
 */
export const PHASE_MEETING_PREP = process.env.PHASE_MEETING_PREP ?? 'disabled';

/**
 * Phase 7 — Meeting integration
 * Bot accepts meeting transcript upload
 * Agenda items checked: resolved / partial / open
 * Decision log updated with full reasoning chain
 */
export const PHASE_MEETING = process.env.PHASE_MEETING ?? 'disabled';

/**
 * Phase 8 — Auto-update project map
 * Post-meeting: sub-problem statuses updated
 * Unresolved → to-do, new sub-problems added
 * Outer loop: if more sub-problems → trigger next exploration
 */
export const PHASE_AUTO_UPDATE = process.env.PHASE_AUTO_UPDATE ?? 'disabled';

// ── Helpers ───────────────────────────────────────────────────────────────────

export type PhaseFlag = 'disabled' | 'active';

export function isPhaseActive(flag: string): flag is 'active' {
  return flag === 'active';
}

export function isPhaseDisabled(flag: string): boolean {
  return flag === 'disabled';
}

/**
 * Returns all phase flags as an object — useful for diagnostics/debug.
 */
export function getAllPhaseFlags(): Record<string, string> {
  return {
    PHASE_SUB_PROBLEMS,
    PHASE_PROBLEM_DEF,
    PHASE_CROSS_LINK,
    PHASE_ITERATION,
    PHASE_RICH_SYNTHESIS,
    PHASE_MEETING_PREP,
    PHASE_MEETING,
    PHASE_AUTO_UPDATE,
  };
}
