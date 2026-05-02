#!/usr/bin/env tsx
/**
 * Lightweight Render Blueprint safety check.
 *
 * This intentionally avoids a full YAML dependency. It verifies the deployment
 * contract that matters for tester readiness and prevents accidental committed
 * secrets in render.yaml.
 */

import { readFileSync } from 'node:fs';

const blueprint = readFileSync('render.yaml', 'utf8');
const failures: string[] = [];

function requireIncludes(label: string, needle: string): void {
  if (!blueprint.includes(needle)) failures.push(`missing ${label}: ${needle}`);
}

function requireRegex(label: string, pattern: RegExp): void {
  if (!pattern.test(blueprint)) failures.push(`missing ${label}`);
}

requireIncludes('web service', 'name: zolara-web');
requireIncludes('web runtime', 'runtime: docker');
requireIncludes('health check', 'healthCheckPath: /health');
requireIncludes('lifecycle worker', 'name: zolara-lifecycle-worker');
requireIncludes('lifecycle loop command', 'dockerCommand: npm run lifecycle:loop');
requireIncludes('compiled lifecycle worker command', 'value: npm run lifecycle:once:dist');
requireIncludes('Postgres database', 'name: zolara-postgres');
requireIncludes('Redis/Key Value service', 'name: zolara-redis');
requireIncludes('external hosting mode', 'value: external');
requireIncludes('generated webhook secret', 'key: WEBHOOK_SECRET');
requireIncludes('generated encryption key', 'key: ENCRYPTION_KEY');

for (const key of ['WEBHOOK_BASE_URL', 'ZOLARA_BOT_TOKEN', 'MANAGED_BOTS_TOKEN', 'MINIMAX_API_KEY']) {
  requireRegex(`${key} sync:false`, new RegExp(`key:\\s*${key}[\\s\\S]{0,80}sync:\\s*false`));
}

requireRegex('DATABASE_URL from database', /key:\s*DATABASE_URL[\s\S]{0,120}fromDatabase:[\s\S]{0,120}name:\s*zolara-postgres/);
requireRegex('REDIS_URL from service', /key:\s*REDIS_URL[\s\S]{0,140}fromService:[\s\S]{0,140}name:\s*zolara-redis/);

const suspiciousSecretPatterns: Array<[string, RegExp]> = [
  ['Telegram bot token', /\b\d{8,}:[A-Za-z0-9_-]{20,}\b/],
  ['MiniMax/OpenAI-style key', /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ['Render placeholder accidentally replaced', /<rotated-|<render-|replace_me/i],
];

for (const [label, pattern] of suspiciousSecretPatterns) {
  if (pattern.test(blueprint)) failures.push(`render.yaml appears to contain ${label}`);
}

if (failures.length > 0) {
  console.error('Render Blueprint check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('Render Blueprint check passed');
