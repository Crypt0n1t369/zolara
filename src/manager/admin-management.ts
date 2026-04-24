/**
 * Admin Management: add/remove admins, transfer ownership, project settings.
 */

import { db } from '../data/db';
import { admins, adminRoles, projects } from '../data/schema/projects';
import { eq, and } from 'drizzle-orm';
import { resolveActiveProject } from './admin-commands';
import { redis } from '../data/redis';
import { sendMessage } from '../util/telegram-sender';
import { logger } from '../util/logger';

const SETTINGS_KEY_PREFIX = 'settings_edit:';

/**
 * Handle /addadmin command.
 * Usage: /addadmin @username
 */
export async function handleAddAdminCommand(ctx: any): Promise<void> {
  const adminTelegramId = ctx.from!.id;
  const mention = (ctx.message?.text ?? '').replace('/addadmin', '').trim();

  if (!mention) {
    await ctx.reply(
      '👥 *Add Admin*\n\n' +
      'Usage: /addadmin @username\n\n' +
      'Adds someone as an admin to your active project.',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // Extract username (remove @)
  const targetUsername = mention.replace('@', '').toLowerCase();

  const { project } = await resolveActiveProject(adminTelegramId);
  if (!project) {
    await ctx.reply('❌ No active project. Use /projects to select one.');
    return;
  }

  // Check if this admin is owner (only owners can add admins)
  const isOwner = await checkIsOwner(adminTelegramId, project.id);
  if (!isOwner) {
    await ctx.reply('❌ Only the project owner can add admins.');
    return;
  }

  // Find target user by username (we need their telegramId)
  // We store only telegramId in admins table, not username
  // So we need another approach: ask the target to /start the bot first
  // For now, we'll use a simpler approach: accept telegramId directly
  const targetTelegramId = extractTelegramId(mention);
  if (!targetTelegramId) {
    await ctx.reply(
      `❌ Could not resolve @${targetUsername}.\n\n` +
      'They must first send /start to @Zolara_bot so we have their Telegram ID on record.',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  if (targetTelegramId === adminTelegramId) {
    await ctx.reply('❌ You cannot add yourself as an admin.');
    return;
  }

  // Find or create the admin record
  let [targetAdmin] = await db
    .select()
    .from(admins)
    .where(eq(admins.telegramId, targetTelegramId))
    .limit(1);

  if (!targetAdmin) {
    [targetAdmin] = await db
      .insert(admins)
      .values({ telegramId: targetTelegramId })
      .returning();
  }

  // Check if already an admin
  const existing = await db
    .select()
    .from(adminRoles)
    .where(and(
      eq(adminRoles.projectId, project.id),
      eq(adminRoles.adminId, targetAdmin.id)
    ))
    .limit(1);

  if (existing.length > 0) {
    await ctx.reply(`❌ @${targetUsername} is already an admin of this project.`);
    return;
  }

  // Add as admin
  await db.insert(adminRoles).values({
    projectId: project.id,
    adminId: targetAdmin.id,
    role: 'admin',
  });

  (logger.info as Function)('admin', 'ADMIN_ADDED', `@${targetUsername} added as admin to project ${project.id}`, {
    projectId: project.id,
    telegramId: adminTelegramId,
  });

  await ctx.reply(
    `✅ @${targetUsername} is now an admin of *${project.name}*.\n\n` +
    'They can use /projects, /startround, /members and other admin commands.',
    { parse_mode: 'Markdown' }
  );
}

/**
 * Handle /removeadmin command.
 * Usage: /removeadmin @username
 */
export async function handleRemoveAdminCommand(ctx: any): Promise<void> {
  const adminTelegramId = ctx.from!.id;
  const mention = (ctx.message?.text ?? '').replace('/removeadmin', '').trim();

  if (!mention) {
    await ctx.reply(
      '👥 *Remove Admin*\n\n' +
      'Usage: /removeadmin @username\n\n' +
      'Removes someone from the admin team (owner cannot be removed).',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  const targetUsername = mention.replace('@', '').toLowerCase();
  const targetTelegramId = extractTelegramId(mention);

  const { project } = await resolveActiveProject(adminTelegramId);
  if (!project) {
    await ctx.reply('❌ No active project. Use /projects to select one.');
    return;
  }

  const isOwner = await checkIsOwner(adminTelegramId, project.id);
  if (!isOwner) {
    await ctx.reply('❌ Only the project owner can remove admins.');
    return;
  }

  if (!targetTelegramId) {
    await ctx.reply(`❌ Could not resolve @${targetUsername}.`);
    return;
  }

  // Find target admin
  const [targetAdmin] = await db
    .select()
    .from(admins)
    .where(eq(admins.telegramId, targetTelegramId))
    .limit(1);

  if (!targetAdmin) {
    await ctx.reply(`❌ @${targetUsername} is not an admin of this project.`);
    return;
  }

  // Find their role entry
  const [roleEntry] = await db
    .select()
    .from(adminRoles)
    .where(and(
      eq(adminRoles.projectId, project.id),
      eq(adminRoles.adminId, targetAdmin.id)
    ))
    .limit(1);

  if (!roleEntry) {
    await ctx.reply(`❌ @${targetUsername} is not an admin of this project.`);
    return;
  }

  // Cannot remove owner
  if (roleEntry.role === 'owner') {
    await ctx.reply('❌ The owner cannot be removed. Use /transferownership first.');
    return;
  }

  await db.delete(adminRoles).where(eq(adminRoles.id, roleEntry.id));

  (logger.info as Function)('admin', 'ADMIN_REMOVED', `@${targetUsername} removed from project ${project.id}`, {
    projectId: project.id,
    telegramId: adminTelegramId,
  });

  await ctx.reply(`✅ @${targetUsername} is no longer an admin of *${project.name}*.`, {
    parse_mode: 'Markdown',
  });
}

/**
 * Handle /transferownership command.
 * Usage: /transferownership @username
 */
export async function handleTransferOwnershipCommand(ctx: any): Promise<void> {
  const adminTelegramId = ctx.from!.id;
  const mention = (ctx.message?.text ?? '').replace('/transferownership', '').trim();

  if (!mention) {
    await ctx.reply(
      '🔄 *Transfer Ownership*\n\n' +
      'Usage: /transferownership @username\n\n' +
      'Transfers project ownership to another admin. You will become an admin.\n' +
      '⚠️ This cannot be undone.',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  const targetUsername = mention.replace('@', '').toLowerCase();
  const targetTelegramId = extractTelegramId(mention);

  const { project } = await resolveActiveProject(adminTelegramId);
  if (!project) {
    await ctx.reply('❌ No active project. Use /projects to select one.');
    return;
  }

  const isOwner = await checkIsOwner(adminTelegramId, project.id);
  if (!isOwner) {
    await ctx.reply('❌ Only the current owner can transfer ownership.');
    return;
  }

  if (!targetTelegramId) {
    await ctx.reply(
      `❌ Could not resolve @${targetUsername}.\n\n` +
      'They must first send /start to @Zolara_bot.',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  if (targetTelegramId === adminTelegramId) {
    await ctx.reply('❌ You already own this project.');
    return;
  }

  // Find or create target admin
  let [targetAdmin] = await db
    .select()
    .from(admins)
    .where(eq(admins.telegramId, targetTelegramId))
    .limit(1);

  if (!targetAdmin) {
    [targetAdmin] = await db
      .insert(admins)
      .values({ telegramId: targetTelegramId })
      .returning();
  }

  // Get current owner admin id
  const [currentAdmin] = await db
    .select()
    .from(admins)
    .where(eq(admins.telegramId, adminTelegramId))
    .limit(1);

  if (!currentAdmin) {
    await ctx.reply('❌ Your admin record not found.');
    return;
  }

  // Update project's adminId to new owner
  await db.update(projects)
    .set({ updatedAt: new Date() })
    .where(eq(projects.id, project.id));

  // Upsert admin role for target as owner
  await db.insert(adminRoles)
    .values({ projectId: project.id, adminId: targetAdmin.id, role: 'owner' })
    .onConflictDoUpdate({
      target: [adminRoles.projectId, adminRoles.adminId],
      set: { role: 'owner' },
    });

  // Update current owner to admin
  await db.insert(adminRoles)
    .values({ projectId: project.id, adminId: currentAdmin.id, role: 'admin' })
    .onConflictDoUpdate({
      target: [adminRoles.projectId, adminRoles.adminId],
      set: { role: 'admin' },
    });

  (logger.info as Function)('admin', 'OWNERSHIP_TRANSFERRED', `Ownership transferred to @${targetUsername}`, {
    projectId: project.id,
    fromTelegramId: adminTelegramId,
    toTelegramId: targetTelegramId,
  });

  await ctx.reply(
    `✅ Ownership of *${project.name}* transferred to @${targetUsername}.\n\n` +
    'They are now the owner. You remain as admin.',
    { parse_mode: 'Markdown' }
  );
}

/**
 * Handle /admins command — list admins of the active project.
 */
export async function handleAdminsCommand(ctx: any): Promise<void> {
  const adminTelegramId = ctx.from!.id;

  const { project } = await resolveActiveProject(adminTelegramId);
  if (!project) {
    await ctx.reply('❌ No active project. Use /projects to select one.');
    return;
  }

  const adminRows = await db
    .select({ telegramId: admins.telegramId, role: adminRoles.role })
    .from(adminRoles)
    .innerJoin(admins, eq(adminRoles.adminId, admins.id))
    .where(eq(adminRoles.projectId, project.id))
    .limit(50);

  if (adminRows.length === 0) {
    await ctx.reply(`*${project.name}*\n\nNo admins found.`);
    return;
  }

  const lines = adminRows.map((r) => {
    const tag = r.telegramId === adminTelegramId ? ' (you)' : '';
    const roleLabel = r.role === 'owner' ? '👑' : r.role === 'admin' ? '🛡️' : '👤';
    return `${roleLabel} ${r.telegramId}${tag} (${r.role})`;
  });

  await ctx.reply(
    `👥 *Admins of ${project.name}*\n\n` +
    lines.join('\n'),
    { parse_mode: 'Markdown' }
  );
}

/**
 * Handle /settings command — interactive project configuration.
 * Shows current settings and allows changing them.
 */
export async function handleSettingsCommand(ctx: any): Promise<void> {
  const adminTelegramId = ctx.from!.id;
  const { getAdminProjects, buildProjectSelectorText, buildProjectSelectorKeyboard } = await import('./project-selector');
  const { resolveActiveProject } = await import('./admin-commands');

  const allProjects = await getAdminProjects(adminTelegramId);
  if (allProjects.length === 0) {
    await ctx.reply('❌ No active project. Use /create to set one up.');
    return;
  }

  if (allProjects.length > 1) {
    const { projectId } = await resolveActiveProject(adminTelegramId);
    const text = buildProjectSelectorText(allProjects, projectId, '/settings — select project');
    const keyboard = buildProjectSelectorKeyboard(allProjects, '/settings', 'settings_proj');
    await ctx.reply(text, { parse_mode: 'Markdown', replyMarkup: keyboard });
    return;
  }

  const project = allProjects[0];
  const isOwner = await checkIsOwner(adminTelegramId, project.id);
  if (!isOwner) {
    await ctx.reply('❌ Only the project owner can change settings.');
    return;
  }

  // Fetch full project with config
  const [fullProject] = await db
    .select({ config: projects.config })
    .from(projects)
    .where(eq(projects.id, project.id))
    .limit(1);

  const config = (fullProject?.config ?? {}) as unknown as Record<string, unknown>;

  const keyboard = {
    inline_keyboard: [
      [
        { text: `📅 Cycle: ${config['cycleFrequency'] ?? 'weekly'}`, callback_data: `settings:cycle` },
        { text: `⏰ Nudge: ${config['nudgeAfterHours'] ?? 24}h`, callback_data: `settings:nudge` },
      ],
      [
        { text: `🌐 Language: ${config['language'] ?? 'en'}`, callback_data: `settings:language` },
        { text: `🗳️ Voting: ${config['votingMechanism'] ?? 'poll'}`, callback_data: 'settings:voting' },
      ],
      [
        { text: `🔒 Anonymity: ${config['anonymity'] ?? 'optional'}`, callback_data: 'settings:anonymity' },
        { text: `🔢 Questions/round: ${config['questionsPerRound'] ?? 3}`, callback_data: 'settings:questions' },
      ],
    ],
  };

  await ctx.reply(
    `⚙️ *Settings — ${project.name}*\n\n` +
    'Select a setting to change:',
    { parse_mode: 'Markdown', replyMarkup: keyboard }
  );
}

/**
 * Handle settings callback from inline keyboard.
 */
export async function handleSettingsCallback(ctx: any, data: string): Promise<void> {
  const adminTelegramId = ctx.from!.id;
  const parts = data.split(':');
  const setting = parts[1];

  const { project } = await resolveActiveProject(adminTelegramId);
  if (!project) {
    await ctx.answerCallbackQuery('No project found.');
    return;
  }

  const isOwner = await checkIsOwner(adminTelegramId, project.id);
  if (!isOwner) {
    await ctx.answerCallbackQuery('Only the owner can change settings.');
    return;
  }

  const settingLabels: Record<string, string> = {
    cycle: 'Cycle Frequency',
    nudge: 'Nudge After Hours',
    language: 'Language',
    voting: 'Voting Mechanism',
    anonymity: 'Anonymity',
    questions: 'Questions Per Round',
  };

  const label = settingLabels[setting] ?? setting;

  // Store pending setting edit in Redis
  await redis.setex(`${SETTINGS_KEY_PREFIX}${adminTelegramId}`, 300, JSON.stringify({
    projectId: project.id,
    setting,
  }));

  const prompts: Record<string, string> = {
    cycle: 'Enter cycle frequency:\n• daily\n• weekly\n• biweekly\n• monthly',
    nudge: 'Enter nudge reminder delay (hours):\n• e.g. 12, 24, 48',
    language: 'Enter language code:\n• en, es, fr, de, lv, ru',
    voting: 'Enter voting mechanism:\n• poll\n• reaction\n• none',
    anonymity: 'Enter anonymity level:\n• full\n• optional\n• attributed',
    questions: 'Enter number of questions per round (1-10):',
  };

  await ctx.answerCallbackQuery('');
  await ctx.reply(
    `⚙️ *${label}*\n\n${prompts[setting] ?? 'Enter new value:'}`,
    { parse_mode: 'Markdown' }
  );
}

/**
 * Handle a settings value reply (from the interactive conversation).
 */
export async function handleSettingsReply(ctx: any): Promise<void> {
  const adminTelegramId = ctx.from!.id;
  const text = ctx.message?.text?.trim();
  if (!text) return;

  // Check if we're waiting for a settings value
  const editData = await redis.get(`${SETTINGS_KEY_PREFIX}${adminTelegramId}`);
  if (!editData) return; // Not a settings reply

  await redis.del(`${SETTINGS_KEY_PREFIX}${adminTelegramId}`);

  let parsed: { projectId: string; setting: string };
  try {
    parsed = JSON.parse(editData);
  } catch {
    return;
  }

  const { projectId, setting } = parsed;

  // Verify still owner
  const isOwner = await checkIsOwner(adminTelegramId, projectId);
  if (!isOwner) {
    await ctx.reply('❌ Permission denied.');
    return;
  }

  // Get current project
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  if (!project) return;

  const config = (project.config ?? {}) as unknown as Record<string, unknown>;

  let newValue: unknown = text;

  // Parse and validate
  switch (setting) {
    case 'cycle':
      if (!['daily', 'weekly', 'biweekly', 'monthly'].includes(text)) {
        await ctx.reply('❌ Invalid. Use: daily, weekly, biweekly, or monthly.');
        return;
      }
      newValue = text;
      break;
    case 'nudge': {
      const hours = parseInt(text, 10);
      if (isNaN(hours) || hours < 1 || hours > 168) {
        await ctx.reply('❌ Nudge hours must be between 1 and 168.');
        return;
      }
      newValue = hours;
      break;
    }
    case 'language':
      if (!['en', 'es', 'fr', 'de', 'lv', 'ru', 'ar'].includes(text)) {
        await ctx.reply('❌ Unsupported language. Use: en, es, fr, de, lv, ru, ar');
        return;
      }
      newValue = text;
      break;
    case 'voting':
      if (!['poll', 'reaction', 'none'].includes(text)) {
        await ctx.reply('❌ Invalid. Use: poll, reaction, or none.');
        return;
      }
      newValue = text;
      break;
    case 'anonymity':
      if (!['full', 'optional', 'attributed'].includes(text)) {
        await ctx.reply('❌ Invalid. Use: full, optional, or attributed.');
        return;
      }
      newValue = text;
      break;
    case 'questions': {
      const num = parseInt(text, 10);
      if (isNaN(num) || num < 1 || num > 10) {
        await ctx.reply('❌ Must be between 1 and 10.');
        return;
      }
      newValue = num;
      break;
    }
    default:
      await ctx.reply('❌ Unknown setting.');
      return;
  }

  // Update config
  const newConfig = { ...config, [setting]: newValue };
  await db.update(projects)
    .set({ config: newConfig as any, updatedAt: new Date() })
    .where(eq(projects.id, projectId));

  (logger.info as Function)('admin', 'SETTINGS_CHANGED', `Setting ${setting} changed to ${newValue}`, {
    projectId,
    telegramId: adminTelegramId,
  });

  await ctx.reply(
    `✅ *${setting}* updated to *${newValue}*.`,
    { parse_mode: 'Markdown' }
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export async function checkIsOwner(telegramId: number, projectId: string): Promise<boolean> {
  const [admin] = await db
    .select()
    .from(admins)
    .where(eq(admins.telegramId, telegramId))
    .limit(1);

  if (!admin) return false;

  const [role] = await db
    .select()
    .from(adminRoles)
    .where(and(
      eq(adminRoles.projectId, projectId),
      eq(adminRoles.adminId, admin.id)
    ))
    .limit(1);

  return role?.role === 'owner';
}

/**
 * Check if a telegram user is an admin (owner or admin) of a project.
 */
export async function checkIsAdmin(telegramId: number, projectId: string): Promise<boolean> {
  const [admin] = await db
    .select()
    .from(admins)
    .where(eq(admins.telegramId, telegramId))
    .limit(1);

  if (!admin) return false;

  const [role] = await db
    .select()
    .from(adminRoles)
    .where(and(
      eq(adminRoles.projectId, projectId),
      eq(adminRoles.adminId, admin.id)
    ))
    .limit(1);

  return role !== undefined;
}

/**
 * Extract a Telegram numeric ID from a string like "@username" or "123456789".
 * Returns null if cannot determine.
 */
function extractTelegramId(input: string): number | null {
  // If it's a numeric string, treat as telegramId
  const num = parseInt(input.replace('@', '').trim(), 10);
  if (!isNaN(num) && num > 1000) {
    return num;
  }
  // Otherwise we can't resolve a username to a telegramId without the Bot API
  // For now return null — the user must provide their numeric ID
  return null;
}
