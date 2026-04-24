/**
 * Phase 2 — Problem Validation Gate
 * Tables for the problem definition + validation flow.
 *
 * Flow:
 * 1. triggerRound called with topic → creates problem_definition (status: pending)
 * 2. Bot DMs each member: vote via inline keyboard
 * 3. Async voting — proceeds when threshold reached or deadline passed
 * 4. Tally → confirmed / needs_work / rejected
 * 5. If confirmed → round transitions to gathering
 * 6. If needs_work → clarifying questions → re-validate
 * 7. If rejected → admin notified, round not started
 *
 * Feature flag: PHASE_PROBLEM_DEF (default disabled)
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  serial,
  integer,
  bigint,
  index,
} from 'drizzle-orm/pg-core';
import { projects, members } from './projects';

export type ProblemDefinitionStatus =
  | 'pending'      // waiting for votes
  | 'voting'       // votes coming in
  | 'confirmed'    // problem is clearly defined
  | 'needs_work'    // needs clarification before proceeding
  | 'rejected'     // not a valid problem / out of scope
  | 'abandoned';   // admin cancelled or round cancelled during validation

export type ProblemDefinitionVote = 'clear' | 'refine' | 'unsure';

// ── Problem Definitions ──────────────────────────────────────────────────────

export const problemDefinitions = pgTable('problem_definitions', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  roundId: uuid('round_id').references(() => projects.id), // circular — added to rounds separately
  topicText: text('topic_text').notNull(),           // original topic submitted
  refinedText: text('refined_text'),                  // refined after clarification (if needed)
  status: text('status').default('pending'),         // ProblemDefinitionStatus
  voteDeadline: timestamp('vote_deadline'),           // when to tally votes
  votesReceived: integer('votes_received').default(0),
  totalVoters: integer('total_voters').default(0),   // total members eligible to vote
  confidenceScore: integer('confidence_score'),        // 0-100, computed after tally
  clarificationRound: integer('clarification_round').default(0), // how many times clarified
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => ({
  projectIdx: index('problem_definitions_project_idx').on(table.projectId),
  statusIdx: index('problem_definitions_status_idx').on(table.status),
}));

// ── Problem Definition Votes ─────────────────────────────────────────────────

export const problemDefinitionVotes = pgTable('problem_definition_votes', {
  id: serial('id').primaryKey(),
  problemDefinitionId: uuid('problem_definition_id').references(
    () => problemDefinitions.id,
    { onDelete: 'cascade' }
  ),
  memberId: serial('member_id').references(() => members.id),
  vote: text('vote').notNull(), // ProblemDefinitionVote: 'clear' | 'refine' | 'unsure'
  voteText: text('vote_text'),  // optional: why they voted this way
  votedAt: timestamp('voted_at').defaultNow(),
}, (table) => ({
  // One vote per member per problem definition
  uniqMemberVote: { columns: [table.problemDefinitionId, table.memberId], isUnique: true },
  memberIdx: index('problem_definition_votes_member_idx').on(table.memberId),
}));
