/**
 * Project creation service.
 * Handles the business logic of creating a new managed bot project.
 */
import { eq, desc, and } from 'drizzle-orm';
import { db } from '../../data/db';
import { projects, admins, adminRoles, users, members } from '../../data/schema/projects';
import { encrypt, hashToken, generateSecret } from '../../util/crypto';
import { getManagedBotToken, setManagedBotWebhook, getManagedBotInfo, setBotCommands, generateBotUsername, buildCreationLink, } from './lifecycle';
import { config } from '../../config';
import { spawnProjectAgent } from '../agent/project-agent';
import { redis } from '../../data/redis';
// The Zolara bot's Telegram username (for creation links via BotFather)
const MANAGER_BOT_USERNAME = 'Zolara_bot';
/**
 * Build the bot creation link for a new project.
 * The admin clicks this link to create the managed bot in Telegram.
 */
export function buildProjectCreationLink(projectName) {
    const suggestedUsername = generateBotUsername(projectName);
    const creationLink = buildCreationLink(MANAGER_BOT_USERNAME, suggestedUsername, projectName);
    return { creationLink, suggestedUsername };
}
/**
 * Store a pending project creation (before bot is created).
 * Returns the project ID, pending key, suggested username, and creation link.
 */
export async function createPendingProject(params) {
    const adminTelegramId = params.adminTelegramId;
    const [admin] = await db
        .select()
        .from(admins)
        .where(eq(admins.telegramId, adminTelegramId))
        .limit(1);
    let adminDbId;
    if (!admin) {
        const [newAdmin] = await db
            .insert(admins)
            .values({ telegramId: adminTelegramId })
            .returning();
        adminDbId = newAdmin.id;
    }
    else {
        adminDbId = admin.id;
    }
    const suggestedUsername = generateBotUsername(params.name);
    const creationLink = buildCreationLink(MANAGER_BOT_USERNAME, suggestedUsername, params.name);
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
    const pendingKey = `pending:${params.adminTelegramId}:${Date.now()}`;
    await redis.setex(pendingKey, 86400, JSON.stringify({
        projectId: project.id,
        pendingKey,
        name: params.name,
        suggestedUsername,
        createdAt: new Date().toISOString(),
    }));
    // Also store a simple admin → projectId mapping for my_chat_member lookups
    await redis.setex(`pending_admin:${params.adminTelegramId}`, 86400, JSON.stringify({
        projectId: project.id,
        suggestedUsername,
        name: params.name,
        createdAt: new Date().toISOString(),
    }));
    return { projectId: project.id, pendingKey, suggestedUsername, creationLink };
}
/**
 * Finalize project creation after the managed bot is created.
 * Called when we receive the my_chat_member update from Telegram.
 */
export async function finalizeProjectBot(adminTelegramId, botUserId, suggestedUsername) {
    // First look up the admin by their telegram ID
    const [admin] = await db
        .select()
        .from(admins)
        .where(eq(admins.telegramId, adminTelegramId))
        .limit(1);
    if (!admin) {
        throw new Error('Admin not found for telegram ID: ' + adminTelegramId);
    }
    // Find the most recent pending project for this admin
    const pendingProjects = await db
        .select()
        .from(projects)
        .where(eq(projects.adminId, admin.id))
        .orderBy(desc(projects.createdAt))
        .limit(1);
    const project = pendingProjects[0];
    if (!project || project.status !== 'pending') {
        throw new Error('No pending project found for admin');
    }
    // Get the bot token from Managed Bots API
    const botToken = await getManagedBotToken(botUserId);
    // Encrypt and hash the token
    const encryptedToken = encrypt(botToken);
    const tokenHash = hashToken(botToken);
    // Generate unique webhook secret
    const webhookSecret = generateSecret();
    // Build webhook URL — server uses /webhook/projectbot/:tokenHash
    const webhookUrl = `${config.WEBHOOK_BASE_URL}/webhook/projectbot/${tokenHash}`;
    // Set webhook for the new bot and fail loudly if Telegram rejects it.
    const webhookResult = await setManagedBotWebhook(botToken, webhookUrl, webhookSecret);
    if (!webhookResult.success) {
        throw new Error(`setWebhook failed: ${webhookResult.description ?? 'Unknown error'}`);
    }
    // Set bot commands (shows in Telegram's command menu)
    await setBotCommands(botToken);
    // Prefer the actual Telegram username from the event/API over our suggestion.
    let actualUsername = suggestedUsername ?? null;
    try {
        const botInfo = await getManagedBotInfo(botUserId);
        actualUsername = botInfo.username ?? actualUsername;
    }
    catch (err) {
        console.warn('[ManagedBot] Could not fetch bot username, using event/suggestion fallback:', err);
    }
    // Update project with bot info
    const updated = await db
        .update(projects)
        .set({
        botTelegramId: botUserId,
        botUsername: actualUsername,
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
    // Register the creator as an owner/member of their new project so /start,
    // /members and the first collaboration round have a clear connected admin.
    const [adminUser] = await db.insert(users)
        .values({ telegramId: adminTelegramId })
        .onConflictDoUpdate({
        target: users.telegramId,
        set: { updatedAt: new Date() },
    })
        .returning();
    const [existingMember] = await db
        .select({ id: members.id })
        .from(members)
        .where(and(eq(members.projectId, project.id), eq(members.userId, adminUser.id)))
        .limit(1);
    if (!existingMember) {
        await db.insert(members).values({
            projectId: project.id,
            userId: adminUser.id,
            role: 'admin',
            onboardingStatus: 'complete',
            commitmentLevel: 'active',
            lastActive: new Date(),
        });
    }
    const [existingAdminRole] = await db
        .select({ id: adminRoles.id })
        .from(adminRoles)
        .where(and(eq(adminRoles.projectId, project.id), eq(adminRoles.adminId, admin.id)))
        .limit(1);
    if (existingAdminRole) {
        await db.update(adminRoles)
            .set({ role: 'owner' })
            .where(eq(adminRoles.id, existingAdminRole.id));
    }
    else {
        await db.insert(adminRoles).values({ projectId: project.id, adminId: admin.id, role: 'owner' });
    }
    // Clear creation/initiation Redis state so the admin is not kept in bot creation flow.
    await redis.del(`init:${adminTelegramId}`);
    await redis.del(`pending:${adminTelegramId}`);
    await redis.del(`pending_admin:${adminTelegramId}`);
    // Spawn team coordinator agent for this project (non-blocking)
    spawnProjectAgent(project.id).catch((err) => console.error('[Agent] Failed to spawn agent:', err));
    return {
        projectId: project.id,
        botUsername: actualUsername ?? 'unknown',
    };
}
