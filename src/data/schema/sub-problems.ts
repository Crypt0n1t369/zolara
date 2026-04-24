/**
 * Phase 1 — Sub-problem Infrastructure
 * New tables for problem hierarchy tracking.
 *
 * Schema:
 * - sub_problems: each sub-problem has its own lifecycle
 *   (todo → defined → exploring → synthesizing → meeting_prep → meeting → resolved | abandoned)
 * - rounds.sub_problem_id: links a round to its sub-problem (added to projects.ts schema)
 *
 * Feature flag: PHASE_SUB_PROBLEMS (default disabled)
 * When disabled: all queries return empty, existing round flow unchanged
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  index,
} from 'drizzle-orm/pg-core';
import { projects } from './projects';

export type SubProblemStatus =
  | 'todo'
  | 'defined'
  | 'exploring'
  | 'synthesizing'
  | 'meeting_prep'
  | 'meeting'
  | 'resolved'
  | 'abandoned';

// ── Sub-problems ─────────────────────────────────────────────────────────────

export const subProblems = pgTable('sub_problems', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  problemText: text('problem_text').notNull(),
  status: text('status').default('todo'), // todo | defined | exploring | synthesizing | meeting_prep | meeting | resolved | abandoned
  priority: integer('priority').default(0), // higher = more urgent
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => ({
  projectIdx: index('sub_problems_project_idx').on(table.projectId),
  statusIdx: index('sub_problems_status_idx').on(table.status),
}));
