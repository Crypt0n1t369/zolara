/**
 * Managed Bots API Integration
 * Telegram Bot Management API for creating and managing project bots.
 *
 * References:
 * - https://core.telegram.org/bots/api#managed-bots
 * - https://core.telegram.org/bots/api#getmanagedbottoken
 * - https://core.telegram.org/bots/api#setwebhook
 */

import { config } from '../../config';

const TG_API = `https://api.telegram.org/bot${config.MANAGED_BOTS_TOKEN}`;

export interface ManagedBotInfo {
  userId: number;
  username: string | null;
  canJoinGroups: boolean;
  canReadAllGroupMessages: boolean;
  canBeAddedToGroups: boolean;
}

export interface WebhookResult {
  success: boolean;
  description?: string;
}

/**
 * Get the token for a managed bot created via BotFather's Bot Management.
 * This token is needed to operate the managed bot.
 */
export async function getManagedBotToken(botUserId: number): Promise<string> {
  const response = await fetch(`${TG_API}/getManagedBotToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: botUserId }),
  });

  const data = await response.json() as {
    ok: boolean;
    result?: string;
    description?: string;
  };

  if (!data.ok) {
    throw new Error(`getManagedBotToken failed: ${data.description ?? 'Unknown error'}`);
  }

  return data.result!;
}

/**
 * Set a webhook for a managed bot so it receives updates at our server.
 */
export async function setManagedBotWebhook(
  botToken: string,
  webhookUrl: string,
  secretToken: string
): Promise<WebhookResult> {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: webhookUrl,
      secret_token: secretToken,
      allowed_updates: [
        'message',
        'callback_query',
        'my_chat_member',
        'chat_member',
        'poll_answer',
        'message_reaction',
        'message_reaction_count',
      ],
    }),
  });

  const data = await response.json() as { ok: boolean; description?: string };

  if (!data.ok) {
    return { success: false, description: data.description };
  }

  return { success: true };
}

/**
 * Delete a webhook for a managed bot (e.g., before re-setting it).
 */
export async function deleteManagedBotWebhook(botToken: string): Promise<WebhookResult> {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/deleteWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });

  const data = await response.json() as { ok: boolean; description?: string };

  if (!data.ok) {
    return { success: false, description: data.description };
  }

  return { success: true };
}

/**
 * Get info about a managed bot by its user ID.
 */
export async function getManagedBotInfo(botUserId: number): Promise<ManagedBotInfo> {
  const response = await fetch(`${TG_API}/getManagedBotInfo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: botUserId }),
  });

  const data = await response.json() as {
    ok: boolean;
    result?: {
      user: { id: number; username: string | null; can_join_groups: boolean; can_read_all_group_messages: boolean; can_be_added_to_groups: boolean };
    };
    description?: string;
  };

  if (!data.ok || !data.result) {
    throw new Error(`getManagedBotInfo failed: ${data.description ?? 'Unknown error'}`);
  }

  const u = data.result.user;
  return {
    userId: u.id,
    username: u.username ?? null,
    canJoinGroups: u.can_join_groups,
    canReadAllGroupMessages: u.can_read_all_group_messages,
    canBeAddedToGroups: u.can_be_added_to_groups,
  };
}

/**
 * Generate a suggested bot username from a project name.
 * Format: {project_name_slug}_zolara_bot
 */
export function generateBotUsername(projectName: string): string {
  const slug = projectName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 30); // Telegram limits bot usernames to 64 chars total, leave room for suffix

  return `${slug}_zolara_bot`;
}

/**
 * Build the Telegram BotFather creation link for a new managed bot.
 * The manager bot username is the Zolara manager bot (@Zolara_builder_bot).
 */
export function buildCreationLink(
  managerUsername: string,
  suggestedUsername: string,
  botName: string
): string {
  const encodedName = encodeURIComponent(botName);
  return `https://t.me/newbot/${managerUsername}/${suggestedUsername}?name=${encodedName}`;
}

/**
 * Set the command menu for a managed bot so it shows commands in Telegram's UI.
 */
export async function setBotCommands(botToken: string): Promise<void> {
  const commands = [
    { command: 'start', description: 'Join your team on Zolara' },
    { command: 'help', description: 'Get help with using this bot' },
  ];

  const response = await fetch(`https://api.telegram.org/bot${botToken}/setMyCommands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ commands }),
  });

  const data = await response.json() as { ok: boolean; description?: string };
  if (!data.ok) {
    console.error('[setBotCommands] failed:', data.description);
  } else {
    console.log('[setBotCommands] commands set for bot');
  }
}
