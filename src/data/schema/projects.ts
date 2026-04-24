import {
  pgTable,
  uuid,
  text,
  bigint,
  jsonb,
  timestamp,
  boolean,
  serial,
  integer,
  index,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

export const admins = pgTable('admins', {
  id: serial('id').primaryKey(),
  telegramId: bigint('telegram_id', { mode: 'number' }).unique().notNull(),
  createdAt: timestamp('created_at').defaultNow(),
});

// Project admin roles: supports multiple admins per project with role levels
export const adminRoles = pgTable('admin_roles', {
  id: serial('id').primaryKey(),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  adminId: bigint('admin_id', { mode: 'number' }).references(() => admins.id, { onDelete: 'cascade' }),
  role: text('role').notNull().default('admin'), // 'owner' | 'admin' | 'viewer'
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => [{
  projectAdminUniq: { columns: [table.projectId, table.adminId], isUnique: true },
}]);

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  adminId: bigint('admin_id', { mode: 'number' }).references(() => admins.id),
  botTelegramId: bigint('bot_telegram_id', { mode: 'number' }).unique(),
  botTokenHash: text('bot_token_hash'), // SHA hash of encrypted token for routing
  botTokenEncrypted: text('bot_token_encrypted'),
  webhookSecret: text('webhook_secret'),
  encryptedApiKey: text('encrypted_api_key'), // per-project MiniMax API key
  name: text('name').notNull(),
  description: text('description'),
  config: jsonb('config').$type<ProjectConfig>().notNull().default({
    cycleFrequency: 'weekly',
    questionsPerRound: 3,
    questionDepth: 'medium',
    anonymity: 'optional',
    votingMechanism: 'poll',
    reportFrequency: 'per_cycle',
    actionTracking: true,
    nudgeAfterHours: 24,
    language: 'en',
    timezone: 'UTC',
  } as ProjectConfig),
  masterPrompt: text('master_prompt'),
  status: text('status').default('pending'), // pending, active, paused, archived
  channelId: bigint('channel_id', { mode: 'number' }),
  groupIds: bigint('group_ids', { mode: 'number' }).array(),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
}, (table) => ({
  statusIdx: index('projects_status_idx').on(table.status),
  adminIdx: index('projects_admin_idx').on(table.adminId),
}));

export interface ProjectConfig {
  cycleFrequency: string;
  questionsPerRound: number;
  questionDepth: 'shallow' | 'medium' | 'deep';
  anonymity: 'full' | 'optional' | 'attributed';
  votingMechanism: string;
  reportFrequency: string;
  actionTracking: boolean;
  nudgeAfterHours: number;
  language: string;
  timezone: string;
}

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  telegramId: bigint('telegram_id', { mode: 'number' }).unique().notNull(),
  displayName: text('display_name'),
  language: text('language').default('en'),
  timezone: text('timezone'),
  communicationProfile: jsonb('communication_profile').$type<Record<string, unknown>>().default({}),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const members = pgTable('members', {
  id: serial('id').primaryKey(),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  userId: bigint('user_id', { mode: 'number' }).references(() => users.id),
  role: text('role').default('participant'), // admin, participant, observer
  commitmentLevel: text('commitment_level').default('active'),
  projectProfile: jsonb('project_profile').$type<Record<string, unknown>>().default({}),
  contributionScore: integer('contribution_score').default(0),
  memberLevel: integer('member_level').default(0),
  onboardingStatus: text('onboarding_status').default('fresh'),
  certificateIssued: boolean('certificate_issued').default(false),
  joinedAt: timestamp('joined_at').defaultNow(),
  lastActive: timestamp('last_active'),
}, (table) => ({
  projectUserUniq: { columns: [table.projectId, table.userId], isUnique: true },
}));

export const rounds = pgTable('rounds', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  roundNumber: serial('round_number').notNull(),
  topic: text('topic'),
  status: text('status').default('scheduled'),
  roundType: text('round_type').default('alignment'),
  scope: text('scope').default('group'),
  scopeMemberIds: bigint('scope_member_ids', { mode: 'number' }).array(),
  scheduledFor: timestamp('scheduled_for'),
  startedAt: timestamp('started_at'),
  deadline: timestamp('deadline'),
  deadlineExtendedCount: integer('deadline_extended_count').default(0),
  completedAt: timestamp('completed_at'),
  anonymity: text('anonymity'), // round-level override: 'full'|'optional'|'attributed', null = project default
  convergenceScore: text('convergence_score'),
  convergenceTier: text('convergence_tier'),
  responseCount: integer('response_count').default(0),
  memberCount: integer('member_count'),
  retryCount: integer('retry_count').default(0),
  errorMessage: text('error_message'),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
}, (table) => ({
  projectIdx: index('rounds_project_idx').on(table.projectId),
  statusIdx: index('rounds_status_idx').on(table.status),
}));

export const questions = pgTable('questions', {
  id: uuid('id').primaryKey().defaultRandom(),
  roundId: uuid('round_id').references(() => rounds.id, { onDelete: 'cascade' }),
  memberId: serial('member_id').references(() => members.id),
  questionText: text('question_text').notNull(),
  questionType: text('question_type').default('open'),
  telegramMessageId: bigint('telegram_message_id', { mode: 'number' }),
  sentAt: timestamp('sent_at').defaultNow(),
  answeredAt: timestamp('answered_at'),
  followUpOf: uuid('follow_up_of'),
});

export const responses = pgTable('responses', {
  id: uuid('id').primaryKey().defaultRandom(),
  questionId: uuid('question_id').references(() => questions.id, { onDelete: 'cascade' }),
  memberId: serial('member_id').references(() => members.id),
  responseText: text('response_text'),
  responseData: jsonb('response_data').$type<Record<string, unknown>>(),
  telegramMessageId: bigint('telegram_message_id', { mode: 'number' }),
  createdAt: timestamp('created_at').defaultNow(),
  analyzed: boolean('analyzed').default(false),
  analysis: jsonb('analysis').$type<Record<string, unknown>>(),
});

export const reports = pgTable('reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  roundId: uuid('round_id').references(() => rounds.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  content: text('content').notNull(),
  structuredData: jsonb('structured_data').$type<ReportData>().notNull(),
  telegramMessageId: bigint('telegram_message_id', { mode: 'number' }),
  reactions: jsonb('reactions').$type<Record<string, number>>().default({}),
  createdAt: timestamp('created_at').defaultNow(),
});

export interface ReportData {
  themes: Array<{
    name: string;
    alignment: 'aligned' | 'tension' | 'neutral';
    summary: string;
    quotes?: string[];
  }>;
  commonGround: string[];
  creativeTensions: string[];
  blindSpots: string[];
  actionItems: Array<{ title: string; description: string; assignedTo?: string }>;
  convergenceScore: number;
  convergenceTier: string;
}

export const actionItems = pgTable('action_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  roundId: uuid('round_id').references(() => rounds.id),
  title: text('title').notNull(),
  description: text('description'),
  assignedTo: serial('assigned_to').references(() => members.id),
  status: text('status').default('pending'),
  dueDate: timestamp('due_date'),
  createdAt: timestamp('created_at').defaultNow(),
  completedAt: timestamp('completed_at'),
});

export const engagementEvents = pgTable('engagement_events', {
  id: serial('id').primaryKey(),
  memberId: serial('member_id').references(() => members.id),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
  eventType: text('event_type').notNull(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}),
  createdAt: timestamp('created_at').defaultNow(),
});
