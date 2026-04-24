/**
 * Phase Feature Flags
 * Each phase is gated behind an environment variable.
 * Default: 'disabled' — existing behavior unchanged.
 * To enable: /setphase PHASE_PROBLEM_DEF=active (no restart needed)
 *
 * Phase order: 0=baseline (always on), then 1-8 follow spec phases P2-P9
 *
 * Current baseline (Phase 0): triggerRound → GATHERING → SYNTHESIZING → COMPLETE
 * This baseline is always active — no flag needed.
 *
 * ⚠️ Always use getPhaseFlag() or isPhaseActive() — not the raw const values.
 * Raw const values are loaded once at import time; getter functions check runtime.
 */

import { getRuntimeFlag } from '../../util/runtime-flags';

// ── Phase flags ──────────────────────────────────────────────────────────────

export const PHASE_SUB_PROBLEMS = 'disabled'; // loaded at startup via getPhaseFlag()
export const PHASE_PROBLEM_DEF = 'disabled';
export const PHASE_CROSS_LINK = 'disabled';
export const PHASE_ITERATION = 'disabled';
export const PHASE_RICH_SYNTHESIS = 'disabled';
export const PHASE_MEETING_PREP = 'disabled';
export const PHASE_MEETING = 'disabled';
export const PHASE_AUTO_UPDATE = 'disabled';

// ── Dynamic access ──────────────────────────────────────────────────────────

/** Lookup a phase flag value at runtime (checks overrides). */
export function getPhaseFlag(flag: string): string {
  return getRuntimeFlag(flag, 'disabled');
}

/**
 * Check if a phase flag is active.
 * Use this instead of comparing flag constants directly.
 */
export function isPhaseActive(flag: string): boolean {
  return getRuntimeFlag(flag, 'disabled') === 'active';
}

export function isPhaseDisabled(flag: string): boolean {
  return getRuntimeFlag(flag, 'disabled') === 'disabled';
}

/**
 * Get all phase flags as an object — useful for diagnostics/debug.
 */
export function getAllPhaseFlags(): Record<string, string> {
  return {
    PHASE_SUB_PROBLEMS: getPhaseFlag('PHASE_SUB_PROBLEMS'),
    PHASE_PROBLEM_DEF: getPhaseFlag('PHASE_PROBLEM_DEF'),
    PHASE_CROSS_LINK: getPhaseFlag('PHASE_CROSS_LINK'),
    PHASE_ITERATION: getPhaseFlag('PHASE_ITERATION'),
    PHASE_RICH_SYNTHESIS: getPhaseFlag('PHASE_RICH_SYNTHESIS'),
    PHASE_MEETING_PREP: getPhaseFlag('PHASE_MEETING_PREP'),
    PHASE_MEETING: getPhaseFlag('PHASE_MEETING'),
    PHASE_AUTO_UPDATE: getPhaseFlag('PHASE_AUTO_UPDATE'),
  };
}
