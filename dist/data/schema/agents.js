/**
 * Project Agent — OpenClaw sub-agent per project bot.
 *
 * Each active project bot gets a persistent OpenClaw sub-agent (team coordinator).
 * Agent lifecycle is tied to project lifecycle:
 *   - Bot created → agent spawned
 *   - Bot archived → agent suspended (can restore)
 *   - Bot deleted → agent soft-deleted (30-day restore window)
 *   - Restore window passed → agent permanently deleted
 *
 * Agent type: 'team_coordinator' — manages engagement, runs methodology,
 * coordinates rounds, and provides contextual guidance to the team.
 */
import { pgTable, serial, text, timestamp, index, unique, uuid } from 'drizzle-orm/pg-core';
import { projects } from './projects';
export const projectAgents = pgTable('project_agents', {
    id: serial('id').primaryKey(),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }).unique(),
    /** OpenClaw session key for this agent's session */
    sessionKey: text('session_key'),
    /** Agent role type — 'team_coordinator' for now */
    agentType: text('agent_type').notNull().default('team_coordinator'),
    /** Prompt/config passed to the agent on spawn */
    config: text('config').default('{}'), // JSON stored as text
    /** Human-readable name for the agent */
    displayName: text('display_name'),
    /** 'active' | 'suspended' | 'deleted' */
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow(),
    deletedAt: timestamp('deleted_at'),
    restoreUntil: timestamp('restore_until'), // deletedAt + 30 days
}, (table) => ({
    projectIdx: unique('project_agents_project_idx').on(table.projectId),
    statusIdx: index('project_agents_status_idx').on(table.status),
}));
