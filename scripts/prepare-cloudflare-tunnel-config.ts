#!/usr/bin/env tsx
/**
 * Create ~/.cloudflared/config.yml for the Zolara named tunnel after the
 * operator has run `cloudflared tunnel login` and `cloudflared tunnel create`.
 *
 * Safe defaults:
 * - refuses random trycloudflare hosts
 * - dry-run by default unless CONFIRM_WRITE=1
 * - prints paths and hostnames only, never credential contents
 */

import 'dotenv/config';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function fail(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

const home = process.env.HOME;
if (!home) fail('HOME is not set');

const baseUrl = env('WEBHOOK_BASE_URL') ?? env('ZOLARA_STABLE_HOSTNAME');
if (!baseUrl) fail('Set WEBHOOK_BASE_URL or ZOLARA_STABLE_HOSTNAME to the stable HTTPS hostname first');

let hostname: string;
try {
  const normalized = baseUrl.startsWith('http') ? baseUrl : `https://${baseUrl}`;
  const url = new URL(normalized);
  if (url.protocol !== 'https:') fail('stable hostname must use https');
  hostname = url.hostname;
} catch {
  fail('WEBHOOK_BASE_URL/ZOLARA_STABLE_HOSTNAME is not a valid URL or hostname');
}

if (hostname.endsWith('trycloudflare.com')) {
  fail('refusing random trycloudflare.com hostname; use the named-tunnel stable hostname');
}
if (/^(localhost|127\.0\.0\.1)$/.test(hostname) || /\.example$|^example\./.test(hostname)) {
  fail(`refusing non-production/reserved hostname: ${hostname}`);
}

const tunnelName = env('ZOLARA_TUNNEL_NAME') ?? 'zolara-prod';
const cloudflaredDir = join(home, '.cloudflared');
const certPath = join(cloudflaredDir, 'cert.pem');
if (!existsSync(certPath)) fail('~/.cloudflared/cert.pem is missing; run `cloudflared tunnel login` first');

let credentialsFiles: string[] = [];
try {
  credentialsFiles = readdirSync(cloudflaredDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => join(cloudflaredDir, name));
} catch {
  fail('~/.cloudflared is missing or unreadable');
}

if (credentialsFiles.length === 0) {
  fail('no tunnel credentials JSON found; run `cloudflared tunnel create zolara-prod` first');
}

const credentialsFile = env('CLOUDFLARED_CREDENTIALS_FILE') ?? credentialsFiles[0];
const configPath = join(cloudflaredDir, 'config.yml');
const content = `tunnel: ${tunnelName}\ncredentials-file: ${credentialsFile}\n\ningress:\n  - hostname: ${hostname}\n    service: http://localhost:3000\n  - service: http_status:404\n`;

const confirm = env('CONFIRM_WRITE') === '1';
if (existsSync(configPath) && readFileSync(configPath, 'utf8') !== content && !confirm) {
  console.log(`Dry run: ${configPath} already exists and would be replaced.`);
} else if (!confirm) {
  console.log(`Dry run: would write ${configPath}`);
} else {
  writeFileSync(configPath, content, { mode: 0o600 });
  console.log(`Wrote ${configPath}`);
}

console.log(`Tunnel: ${tunnelName}`);
console.log(`Hostname: ${hostname}`);
console.log(`Credentials file: ${credentialsFile}`);
console.log('\nNext:');
console.log(`cloudflared tunnel route dns ${tunnelName} ${hostname}`);
console.log(`ZOLARA_TUNNEL_NAME=${tunnelName} pm2 start ecosystem-tunnel.config.cjs --update-env`);
console.log('pm2 save');
