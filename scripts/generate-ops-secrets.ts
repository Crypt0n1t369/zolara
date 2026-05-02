#!/usr/bin/env tsx
/**
 * Generate local-only secret values for Zolara ops handoff.
 *
 * This prints only newly generated random values. It does not read .env and it
 * cannot rotate third-party credentials (Telegram/MiniMax/DB/Redis); rotate
 * those in their provider dashboards, then paste them into the runtime host or
 * hosting provider secret store.
 */

import { randomBytes } from 'node:crypto';

function base64Url(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

const webhookSecret = base64Url(32);
const encryptionKey = base64Url(32);

console.log(`# Generated ${new Date().toISOString()}`);
console.log('# Store these in .env or the hosting provider secret store. Do not commit them.');
console.log(`WEBHOOK_SECRET=${webhookSecret}`);
console.log(`ENCRYPTION_KEY=${encryptionKey}`);
console.log('');
console.log('# Still rotate/fill manually in provider dashboards:');
console.log('# ZOLARA_BOT_TOKEN=<new Telegram manager bot token>');
console.log('# MANAGED_BOTS_TOKEN=<new Telegram managed-bots API token>');
console.log('# MINIMAX_API_KEY=<new MiniMax key>');
console.log('# DATABASE_URL=<new/persistent database credential if exposed>');
console.log('# REDIS_URL=<new/persistent Redis credential if exposed>');
