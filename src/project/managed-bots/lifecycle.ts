/**
 * Backwards-compatible exports for managed bot lifecycle helpers.
 *
 * The implementation lives in src/telegram/managed-bots-api.ts so manager and
 * project bot flows share one Telegram API boundary instead of maintaining
 * duplicate lifecycle clients.
 */

export {
  type ManagedBotInfo,
  type WebhookResult,
  getManagedBotToken,
  setManagedBotWebhook,
  deleteManagedBotWebhook,
  getManagedBotInfo,
  generateBotUsername,
  buildCreationLink,
  setBotCommands,
} from '../../telegram/managed-bots-api';
