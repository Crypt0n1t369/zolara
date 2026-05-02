#!/usr/bin/env tsx
/**
 * Tester readiness preflight.
 *
 * Safe to run before live Telegram smoke tests. It intentionally prints only
 * non-secret operational state and never dumps .env.
 */

import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { desc, eq } from 'drizzle-orm';
import { db } from '../src/data/db';
import { engagementEvents, projects } from '../src/data/schema/projects';
import { decrypt } from '../src/util/crypto';
import { PROJECT_BOT_ALLOWED_UPDATES } from '../src/telegram/managed-bots-api';

const failures: string[] = [];
const warnings: string[] = [];
const nextActions: string[] = [];

function action(message: string): void {
  if (!nextActions.includes(message)) nextActions.push(message);
}

function pass(message: string): void {
  console.log(`✅ ${message}`);
}

function warn(message: string): void {
  warnings.push(message);
  console.log(`⚠️  ${message}`);
}

function fail(message: string): void {
  failures.push(message);
  console.log(`❌ ${message}`);
}

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

type WebhookBaseCheck = { base: string; hostname: string; isTryCloudflare: boolean };

function hostingMode(): 'cloudflare' | 'external' {
  return env('ZOLARA_HOSTING_MODE') === 'external' ? 'external' : 'cloudflare';
}

async function checkWebhookBaseUrl(): Promise<WebhookBaseCheck | null> {
  const base = env('WEBHOOK_BASE_URL');
  if (!base) {
    fail('WEBHOOK_BASE_URL is missing');
    action(hostingMode() === 'external'
      ? 'Set WEBHOOK_BASE_URL to the external HTTPS service URL after deploying the backend (for example Render service/custom domain).'
      : 'Set WEBHOOK_BASE_URL to the stable HTTPS hostname after provisioning the named tunnel.');
    return null;
  }

  let url: URL;
  try {
    url = new URL(base);
  } catch {
    fail('WEBHOOK_BASE_URL is not a valid URL');
    return null;
  }

  if (url.protocol !== 'https:') {
    fail('WEBHOOK_BASE_URL must use https');
  } else {
    pass('WEBHOOK_BASE_URL uses https');
  }

  const isTryCloudflare = url.hostname.endsWith('trycloudflare.com');
  if (isTryCloudflare) {
    fail('WEBHOOK_BASE_URL uses random trycloudflare.com; use a named Cloudflare Tunnel/stable hostname before testers');
    action('Run the stable webhook runbook: cloudflared tunnel login/create/route DNS, then update WEBHOOK_BASE_URL.');
  } else {
    pass(`WEBHOOK_BASE_URL hostname is stable-looking: ${url.hostname}`);
  }

  if (url.pathname !== '/' && url.pathname !== '') {
    warn('WEBHOOK_BASE_URL contains a path; webhook registration expects a clean origin-style base URL');
  }

  return { base: base.replace(/\/$/, ''), hostname: url.hostname, isTryCloudflare };
}

async function checkPublicHealth(base: string): Promise<void> {
  const healthUrl = `${base}/health`;
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) {
      fail(`Public /health returned HTTP ${response.status}`);
      action(hostingMode() === 'external'
      ? 'After the external backend is online, verify the stable URL with: curl <WEBHOOK_BASE_URL>/health'
      : 'After the named tunnel is online, verify the stable URL with: curl <WEBHOOK_BASE_URL>/health');
      return;
    }
    const body = await response.json().catch(() => null) as { status?: string; service?: string } | null;
    if (body?.status === 'ok') {
      pass('Public /health returns ok');
    } else {
      warn('Public /health responded but did not include status=ok');
    }
  } catch (err) {
    fail(`Public /health check failed: ${err instanceof Error ? err.message : String(err)}`);
    action(hostingMode() === 'external'
      ? 'After the external backend is online, verify the stable URL with: curl <WEBHOOK_BASE_URL>/health'
      : 'After the named tunnel is online, verify the stable URL with: curl <WEBHOOK_BASE_URL>/health');
  }
}


async function checkLocalHealth(): Promise<void> {
  const port = env('PORT') ?? '3000';
  const healthUrl = `http://127.0.0.1:${port}/health`;
  try {
    const response = await fetch(healthUrl, { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) {
      warn(`Local /health returned HTTP ${response.status}; app may not be running under PM2`);
      return;
    }
    const body = await response.json().catch(() => null) as { status?: string; service?: string } | null;
    if (body?.status === 'ok') {
      pass('Local /health returns ok');
    } else {
      warn('Local /health responded but did not include status=ok');
    }
  } catch (err) {
    warn(`Local /health check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function checkSecretsPresent(): void {
  for (const key of ['WEBHOOK_SECRET', 'ZOLARA_BOT_TOKEN', 'MANAGED_BOTS_TOKEN', 'MINIMAX_API_KEY', 'ENCRYPTION_KEY']) {
    if (env(key)) pass(`${key} is configured`);
    else fail(`${key} is missing`);
  }
}

function checkPm2LifecycleConfig(): void {
  try {
    const raw = execFileSync('node', ['-e', `const cfg=require('./ecosystem.config.cjs'); console.log(JSON.stringify(cfg.apps||[]))`], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const apps = JSON.parse(raw) as Array<Record<string, unknown>>;
    const lifecycle = apps.find((app) => String(app.name ?? '').includes('lifecycle'));
    if (!lifecycle) {
      fail('PM2 lifecycle worker app is missing from ecosystem.config.cjs');
      return;
    }
    if (lifecycle.cron_restart === '* * * * *') pass('PM2 lifecycle worker has every-minute cron_restart');
    else warn(`PM2 lifecycle worker cron_restart is ${String(lifecycle.cron_restart ?? 'not set')}`);
    if (lifecycle.autorestart === false) pass('PM2 lifecycle worker autorestart=false for one-shot execution');
    else warn('PM2 lifecycle worker should use autorestart=false for one-shot execution');
  } catch (err) {
    warn(`Could not inspect PM2 ecosystem config: ${err instanceof Error ? err.message : String(err)}`);
  }
}


function checkPm2TunnelConfig(strict: boolean): void {
  try {
    const raw = execFileSync('node', ['-e', `const cfg=require('./ecosystem-tunnel.config.cjs'); console.log(JSON.stringify(cfg.apps||[]))`], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const apps = JSON.parse(raw) as Array<{ name?: string; args?: string }>;
    const tunnel = apps.find((app) => /cloudflare|cloudflared|tunnel/i.test(app.name ?? ''));
    if (!tunnel) {
      warn('PM2 tunnel app is missing from ecosystem-tunnel.config.cjs');
      return;
    }
    const args = String(tunnel.args ?? '');
    if (args.includes('--url')) {
      const message = 'PM2 tunnel config still uses quick tunnel --url; use named tunnel run <name>';
      if (strict) fail(message);
      else warn(`${message} (ignored in external hosting mode)`);
    }
    else if (/\btunnel\s+run\s+\S+/.test(args)) pass(`PM2 tunnel config uses named tunnel: ${args}`);
    else warn(`PM2 tunnel config args are not recognized as named tunnel: ${args || 'missing'}`);
  } catch (err) {
    warn(`Could not inspect PM2 tunnel config: ${err instanceof Error ? err.message : String(err)}`);
  }
}


function checkCloudflaredFiles(strict: boolean): void {
  if (!strict) {
    pass('Cloudflare named-tunnel host files skipped in external hosting mode');
    return;
  }

  const cloudflaredDir = `${process.env.HOME ?? ''}/.cloudflared`;
  const certPath = join(cloudflaredDir, 'cert.pem');
  const configPath = ['config.yml', 'config.yaml'].map((name) => join(cloudflaredDir, name)).find((path) => existsSync(path));

  if (existsSync(certPath)) pass('Cloudflare origin cert exists for tunnel management');
  else {
    fail('Cloudflare origin cert is missing; run `cloudflared tunnel login` before creating/routing a named tunnel');
    action('Run `cloudflared tunnel login` interactively on the host to create ~/.cloudflared/cert.pem.');
  }

  if (!configPath) {
    fail('Cloudflare named tunnel config is missing at ~/.cloudflared/config.yml');
    action('After Cloudflare login/create, run `CONFIRM_WRITE=1 WEBHOOK_BASE_URL=https://<stable-host> npm run tunnel:prepare-config` to create ~/.cloudflared/config.yml safely.');
  } else {
    try {
      const configText = readFileSync(configPath, 'utf8');
      if (/^tunnel:\s*\S+/m.test(configText)) pass('Cloudflare config declares a named tunnel');
      else fail('Cloudflare config is missing `tunnel: <name-or-id>`');
      if (/credentials-file:\s*\S+/m.test(configText)) pass('Cloudflare config declares credentials-file');
      else fail('Cloudflare config is missing credentials-file for named tunnel runtime');
      if (/service:\s*http:\/\/localhost:3000/m.test(configText) || /service:\s*http:\/\/127\.0\.0\.1:3000/m.test(configText)) pass('Cloudflare config routes ingress to local Zolara port 3000');
      else warn('Cloudflare config does not visibly route ingress to http://localhost:3000');
    } catch (err) {
      warn(`Could not inspect Cloudflare config: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  try {
    const credentialFiles = readdirSync(cloudflaredDir).filter((name) => name.endsWith('.json'));
    if (credentialFiles.length > 0) pass('Cloudflare tunnel credentials JSON exists');
    else {
      fail('Cloudflare tunnel credentials JSON is missing; run `cloudflared tunnel create zolara-prod` after login');
      action('Run `cloudflared tunnel create zolara-prod` after login, then route DNS for the chosen stable hostname.');
    }
  } catch {
    fail('Cloudflare config directory is missing or unreadable');
  }
}

function checkPm2RuntimeStatus(strictTunnel: boolean): void {
  try {
    const raw = execFileSync('pm2', ['jlist'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5_000,
    });
    const apps = JSON.parse(raw) as Array<{ name?: string; pm2_env?: { status?: string; restart_time?: number; unstable_restarts?: number; cron_restart?: string; autorestart?: boolean; pm_exec_path?: string; args?: string[] | string } }>;
    const zolara = apps.find((app) => app.name === 'zolara');
    const lifecycle = apps.find((app) => app.name === 'zolara-lifecycle-worker');

    if (!zolara) warn('PM2 runtime does not currently list zolara');
    else if (zolara.pm2_env?.status === 'online') pass('PM2 zolara process is online');
    else warn(`PM2 zolara process status is ${zolara.pm2_env?.status ?? 'unknown'}`);

    if (!lifecycle) {
      warn('PM2 runtime does not currently list zolara-lifecycle-worker');
    } else {
      const status = lifecycle.pm2_env?.status ?? 'unknown';
      const cron = lifecycle.pm2_env?.cron_restart;
      const autorestart = lifecycle.pm2_env?.autorestart;
      if (cron === '* * * * *') pass('PM2 runtime lifecycle worker has every-minute cron_restart');
      else warn(`PM2 runtime lifecycle worker cron_restart is ${cron ?? 'not set'}`);
      if (autorestart === false) pass('PM2 runtime lifecycle worker autorestart=false');
      else warn('PM2 runtime lifecycle worker autorestart is not false');
      if (status === 'online' || status === 'stopped') pass(`PM2 lifecycle worker status is ${status} (acceptable for one-shot cron)`);
      else warn(`PM2 lifecycle worker status is ${status}`);
    }

    checkCloudflaredPm2Runtime(apps, strictTunnel);
  } catch (err) {
    warn(`Could not inspect PM2 runtime status: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function redactedId(value: string): string {
  return value.length <= 8 ? value : `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function missingAllowedUpdates(actual: string[] | undefined): string[] {
  const actualSet = new Set(actual ?? []);
  return PROJECT_BOT_ALLOWED_UPDATES.filter((update) => !actualSet.has(update));
}

async function checkLifecycleWorkerObservable(): Promise<void> {
  try {
    const rows = await db
      .select({ createdAt: engagementEvents.createdAt, metadata: engagementEvents.metadata })
      .from(engagementEvents)
      .where(eq(engagementEvents.eventType, 'lifecycle_worker_summary'))
      .orderBy(desc(engagementEvents.createdAt))
      .limit(1);

    const latest = rows[0];
    if (!latest?.createdAt) {
      warn('No lifecycle_worker_summary audit event found yet; run `npm run lifecycle:once` after deploy to verify worker execution');
      return;
    }

    const ageMs = Date.now() - latest.createdAt.getTime();
    const metadata = latest.metadata as { locked?: boolean; totals?: { checked?: number; expired?: number; processed?: number; failed?: number }; durationMs?: number } | null;
    const detail = `latest=${latest.createdAt.toISOString()}, ageMin=${Math.round(ageMs / 60_000)}, locked=${String(metadata?.locked ?? 'unknown')}, totals=${JSON.stringify(metadata?.totals ?? {})}, durationMs=${String(metadata?.durationMs ?? 'unknown')}`;
    if (ageMs <= 35 * 60 * 1000) pass(`Lifecycle worker summary audit is recent: ${detail}`);
    else warn(`Lifecycle worker summary audit is stale: ${detail}`);
  } catch (err) {
    warn(`Could not inspect lifecycle worker audit events: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function checkActiveProjectRows(expectedHost: string | null): Promise<void> {
  try {
    const rows = await db
      .select({
        id: projects.id,
        name: projects.name,
        botUsername: projects.botUsername,
        botTokenEncrypted: projects.botTokenEncrypted,
        webhookSecret: projects.webhookSecret,
      })
      .from(projects)
      .where(eq(projects.status, 'active'));

    const usableBots = rows.filter((row) => row.botUsername && row.botTokenEncrypted && row.webhookSecret);
    const legacyIncomplete = rows.filter((row) => !row.botUsername && !row.botTokenEncrypted && !row.webhookSecret);
    const corruptProjectBotRows = rows.filter((row) => row.botUsername && (!row.botTokenEncrypted || !row.webhookSecret));
    const oddPartialRows = rows.filter((row) => !row.botUsername && (row.botTokenEncrypted || row.webhookSecret));

    if (usableBots.length > 0) pass(`Active project bots with credentials: ${usableBots.length}`);
    else fail('No active project bots with usable credentials found');

    if (legacyIncomplete.length === 0) {
      pass('No legacy incomplete active project rows');
    } else {
      fail(`Legacy incomplete active project rows: ${legacyIncomplete.length} (${legacyIncomplete.map((row) => redactedId(row.id)).join(', ')})`);
      action('Review incomplete active rows with `npm run cleanup:incomplete-active-projects`; archive with CONFIRM_ARCHIVE=1 after approval.');
    }

    if (corruptProjectBotRows.length === 0) {
      pass('No active project-bot rows with partial credentials');
    } else {
      fail(`Active project-bot rows with partial credentials: ${corruptProjectBotRows.length} (${corruptProjectBotRows.map((row) => `@${row.botUsername}`).join(', ')})`);
    }

    if (oddPartialRows.length > 0) {
      fail(`Active rows with token/secret but no bot username: ${oddPartialRows.length} (${oddPartialRows.map((row) => redactedId(row.id)).join(', ')})`);
    }

    let webhookFailures = 0;
    for (const row of usableBots) {
      try {
        const token = decrypt(row.botTokenEncrypted!);
        const response = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`, {
          signal: AbortSignal.timeout(8_000),
        });
        const data = await response.json() as {
          ok?: boolean;
          result?: { url?: string; pending_update_count?: number; last_error_message?: string; allowed_updates?: string[] };
          description?: string;
        };
        if (!data.ok || !data.result) {
          fail(`@${row.botUsername} getWebhookInfo failed: ${data.description ?? 'unknown error'}`);
          webhookFailures++;
          continue;
        }
        if (!data.result.url) {
          fail(`@${row.botUsername} webhook URL is not set`);
          action('After WEBHOOK_BASE_URL is stable and public /health passes, run `DRY_RUN=1 WEBHOOK_BASE_URL=https://<stable-host> npm run webhooks:rehook`, then run without DRY_RUN.');
          webhookFailures++;
        } else {
          const host = new URL(data.result.url).hostname;
          if (expectedHost && host !== expectedHost) {
            fail(`@${row.botUsername} webhook host does not match WEBHOOK_BASE_URL (${host})`);
            action('After WEBHOOK_BASE_URL is stable and public /health passes, run `DRY_RUN=1 WEBHOOK_BASE_URL=https://<stable-host> npm run webhooks:rehook`, then run without DRY_RUN.');
            webhookFailures++;
          }
        }
        const missingUpdates = missingAllowedUpdates(data.result.allowed_updates);
        if (missingUpdates.length > 0) {
          fail(`@${row.botUsername} webhook missing allowed_updates: ${missingUpdates.join(', ')}`);
          action('Rehook project bots to refresh secret_token and explicit allowed_updates after stable public /health passes.');
          webhookFailures++;
        }
        if (data.result.last_error_message) {
          warn(`@${row.botUsername} webhook has last_error_message: ${data.result.last_error_message}`);
        }
      } catch (err) {
        fail(`@${row.botUsername} webhook status check failed: ${err instanceof Error ? err.message : String(err)}`);
        webhookFailures++;
      }
    }
    if (usableBots.length > 0 && webhookFailures === 0) pass('Active project bot webhooks are set, host-matched, and subscribed to required updates');
  } catch (err) {
    warn(`Could not inspect active project rows: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function checkCloudflaredPm2Runtime(apps: Array<{ name?: string; pm2_env?: { status?: string; pm_exec_path?: string; args?: string[] | string } }>, strict: boolean): void {
  const tunnelApps = apps.filter((app) => /cloudflare|cloudflared|tunnel/i.test(app.name ?? '') || /cloudflared$/.test(app.pm2_env?.pm_exec_path ?? ''));
  if (tunnelApps.length === 0) {
    warn('PM2 runtime does not list a cloudflared tunnel process');
    return;
  }

  const quickTunnel = tunnelApps.find((app) => {
    const args = Array.isArray(app.pm2_env?.args) ? app.pm2_env?.args : String(app.pm2_env?.args ?? '').split(/\s+/).filter(Boolean);
    return args.includes('--url');
  });
  if (quickTunnel) {
    const message = `PM2 tunnel ${quickTunnel.name ?? 'cloudflared'} uses quick tunnel --url; use named tunnel run <name> before testers`;
    if (strict) {
      fail(message);
      action('Restart the PM2 tunnel with ecosystem-tunnel.config.cjs so runtime uses `cloudflared tunnel run zolara-prod`.');
    }
    else warn(`${message} (ignored in external hosting mode)`);
    return;
  }

  const namedTunnel = tunnelApps.find((app) => {
    const args = Array.isArray(app.pm2_env?.args) ? app.pm2_env?.args : String(app.pm2_env?.args ?? '').split(/\s+/).filter(Boolean);
    const runIndex = args.indexOf('run');
    return runIndex >= 0 && Boolean(args[runIndex + 1]);
  });
  if (namedTunnel?.pm2_env?.status === 'online') pass(`PM2 named Cloudflare tunnel appears online (${namedTunnel.name ?? 'cloudflared'})`);
  else warn('Cloudflare tunnel process found, but it does not look like an online named tunnel run');
}

async function main(): Promise<void> {
  console.log('Zolara tester-readiness preflight\n');
  checkSecretsPresent();
  const mode = hostingMode();
  pass(`Hosting mode: ${mode}`);
  const baseCheck = await checkWebhookBaseUrl();
  await checkLocalHealth();
  if (baseCheck) await checkPublicHealth(baseCheck.base);
  checkPm2LifecycleConfig();
  const strictCloudflare = mode === 'cloudflare';
  checkPm2TunnelConfig(strictCloudflare);
  checkCloudflaredFiles(strictCloudflare);
  checkPm2RuntimeStatus(strictCloudflare);
  await checkLifecycleWorkerObservable();
  await checkActiveProjectRows(baseCheck?.hostname ?? null);

  console.log('\nSummary');
  console.log(`Failures: ${failures.length}`);
  console.log(`Warnings: ${warnings.length}`);
  if (nextActions.length > 0) {
    console.log('\nNext actions');
    for (const item of nextActions) console.log(`- ${item}`);
  }

  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`❌ Preflight crashed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
