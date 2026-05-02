/**
 * Project creation service.
 * Handles the business logic of creating a new managed bot project.
 */

import { eq, desc, and } from 'drizzle-orm';
import { db } from '../../data/db';
import { projects, admins } from '../../data/schema/projects';
import { encrypt, hashToken, generateSecret } from '../../util/crypto';
import {
  getManagedBotToken,
  setManagedBotWebhook,
  getManagedBotInfo,
  generateBotUsername,
  buildCreationLink,
} from './lifecycle';
import { config } from '../../config';
import { redis } from '../../data/redis';

// The manager bot's Telegram username (Zolara_bot is the managing bot that creates project bots)
const MANAGER_BOT_USERNAME = 'Zolara_bot';

export interface CreateProjectParams {
  adminTelegramId: number;
  name: string;
  description: string;
  projectType: string;
  teamSizeRange: string;
  cycleFrequency: string;
  questionDepth: 'shallow' | 'medium' | 'deep';
  anonymity: 'full' | 'optional' | 'attributed';
  actionTracking: boolean;
  telegramContexts: string[];
  forumTopicsEnabled: boolean;
  reportDestination: string;
}

export interface CreationLinkResult {
  creationLink: string;
  suggestedUsername: string;
}

/**
 * Build the bot creation link for a new project.
 * The admin clicks this link to create the managed bot in Telegram.
 */
export function buildProjectCreationLink(projectName: string): CreationLinkResult {
  const suggestedUsername = generateBotUsername(projectName);
  const creationLink = buildCreationLink(MANAGER_BOT_USERNAME, suggestedUsername, projectName);
  return { creationLink, suggestedUsername };
}

/**
 * Store a pending project creation (before bot is created).
 * Returns the project ID and pending key.
 */
export async function createPendingProject(
  params: CreateProjectParams
): Promise<{ projectId: string; pendingKey: string }> {
  // Ensure admin exists (telegramId is stored as number in bigint mode)
  const adminTelegramId = params.adminTelegramId;

  const [admin] = await db
    .select()
    .from(admins)
    .where(eq(admins.telegramId, adminTelegramId))
    .limit(1);

  let adminDbId: number;
  if (!admin) {
    const [newAdmin] = await db
      .insert(admins)
      .values({ telegramId: adminTelegramId })
      .returning();
    adminDbId = newAdmin.id;
  } else {
    adminDbId = admin.id;
  }

  // Create project record with pending status
  const [project] = await db
    .insert(projects)
    .values({
      adminId: adminDbId,
      name: params.name,
      description: params.description,
      status: 'pending',
      config: {
        cycleFrequency: params.cycleFrequency,
        questionsPerRound: params.questionDepth === 'shallow' ? 2 : params.questionDepth === 'deep' ? 5 : 3,
        questionDepth: params.questionDepth,
        anonymity: params.anonymity,
        votingMechanism: 'inline_buttons',
        reportFrequency: 'per_cycle',
        actionTracking: params.actionTracking,
        nudgeAfterHours: 24,
        language: 'en',
        timezone: 'UTC',
      },
    })
    .returning();

  // Store pending state in Redis (keyed by admin + timestamp)
  const pendingKey = `pending:${params.adminTelegramId}:${Date.now()}`;
  await redis.setex(pendingKey, 86400, JSON.stringify({
    projectId: project.id,
    pendingKey,
    name: params.name,
    suggestedUsername: generateBotUsername(params.name),
    createdAt: new Date().toISOString(),
  }));

  return { projectId: project.id, pendingKey };
}

/**
 * Finalize project creation after the managed bot is created.
 * Called when we receive the my_chat_member update from Telegram.
 */
export async function finalizeProjectBot(
  adminTelegramId: number,
  botUserId: number,
  suggestedUsername?: string
): Promise<{ projectId: string; botUsername: string }> {
  // First look up the admin by their telegram ID
  const [admin] = await db
    .select()
    .from(admins)
    .where(eq(admins.telegramId, adminTelegramId))
    .limit(1);

  if (!admin) {
    throw new Error('Admin not found for telegram ID: ' + adminTelegramId);
  }

  // Idempotency: Telegram can retry managed_bot_created/my_chat_member updates.
  // If this bot is already attached to one of this admin's projects, return success.
  const [existingProject] = await db
    .select({ id: projects.id, botUsername: projects.botUsername })
    .from(projects)
    .where(and(eq(projects.adminId, admin.id), eq(projects.botTelegramId, botUserId)))
    .limit(1);

  if (existingProject) {
    return {
      projectId: existingProject.id,
      botUsername: existingProject.botUsername ?? suggestedUsername ?? 'unknown',
    };
  }

  // Find the most recent pending project for this admin (by DB admin ID).
  // Do not let a newer active/archived project mask an older pending project.
  const pendingProjects = await db
    .select()
    .from(projects)
    .where(and(eq(projects.adminId, admin.id), eq(projects.status, 'pending')))
    .orderBy(desc(projects.createdAt))
    .limit(1);

  const project = pendingProjects[0];
  if (!project) {
    throw new Error('No pending project found for admin');
  }

  // Get the bot token from Managed Bots API
  const botToken = await getManagedBotToken(botUserId);

  // Encrypt and hash the token
  const encryptedToken = encrypt(botToken);
  const tokenHash = hashToken(botToken);

  // Generate unique webhook secret
  const webhookSecret = generateSecret();

  // Build webhook URL (must match the route registered in src/server/index.ts)
  const webhookUrl = `${config.WEBHOOK_BASE_URL}/webhook/projectbot/${tokenHash}`;

  // Set webhook for the new bot and fail loudly if Telegram rejects it.
  const webhookResult = await setManagedBotWebhook(botToken, webhookUrl, webhookSecret);
  if (!webhookResult.success) {
    throw new Error(`setWebhook failed: ${webhookResult.description ?? 'Unknown error'}`);
  }

  // Update project with bot info
  const updated = await db
    .update(projects)
    .set({
      botTelegramId: botUserId,
      botUsername: suggestedUsername ?? null,
      botTokenHash: tokenHash,
      botTokenEncrypted: encryptedToken,
      webhookSecret,
      status: 'active',
      updatedAt: new Date(),
    })
    .where(eq(projects.id, project.id))
    .returning();

  if (!updated[0]) {
    throw new Error('Failed to update project with bot info');
  }

  // Get bot info for username
  const botInfo = await getManagedBotInfo(botUserId);

  return {
    projectId: project.id,
    botUsername: botInfo.username ?? 'unknown',
  };
}