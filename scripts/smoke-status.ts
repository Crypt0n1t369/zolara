#!/usr/bin/env npx tsx
/**
 * Zolara live smoke status helper.
 *
 * Safe diagnostic for the first-tester E2E path. It does not print bot tokens,
 * encrypted token blobs, webhook secrets, or raw environment values.
 */

import { execFileSync } from 'node:child_process';
import { and, desc, eq } from 'drizzle-orm';
import { config } from '../src/config';
import { db } from '../src/data/db';
import { engagementEvents, members, projects, reports, responses, rounds, users } from '../src/data/schema/projects';
import { decrypt } from '../src/util/crypto';
import { summarizeLatestReportReactions } from '../src/project/report-reactions';
import { formatReportReactionSummary } from '../src/project/dashboard';
import { PROJECT_BOT_ALLOWED_UPDATES } from '../src/telegram/managed-bots-api';

type Check = { name: string; ok: boolean; detail: string };

function addAction(actions: string[], message: string): void {
  if (!actions.includes(message)) actions.push(message);
}

function baseHost(): string | null {
  try {
    return new URL(config.WEBHOOK_BASE_URL).hostname;
  } catch {
    return null;
  }
}

function isRandomTryCloudflareHost(host: string | null): boolean {
  return Boolean(host?.endsWith('.trycloudflare.com'));
}

function hostingMode(): 'cloudflare' | 'external' {
  return process.env.ZOLARA_HOSTING_MODE === 'external' ? 'external' : 'cloudflare';
}

function redactedId(value: string): string {
  return value.length <= 8 ? value : `${value.slice(0, 4)}…${value.slice(-4)}`;
}

async function publicHealthCheck(): Promise<Check> {
  try {
    const response = await fetch(`${config.WEBHOOK_BASE_URL.replace(/\/+$/, '')}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      return { name: 'public_health', ok: false, detail: `HTTP ${response.status}` };
    }
    const data = await response.json() as { status?: string; service?: string };
    return {
      name: 'public_health',
      ok: data.status === 'ok',
      detail: `${data.service ?? 'unknown'} status=${data.status ?? 'missing'}`,
    };
  } catch (err) {
    return { name: 'public_health', ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}


async function localHealthCheck(): Promise<Check> {
  const port = process.env.PORT?.trim() || '3000';
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) {
      return { name: 'local_health', ok: false, detail: `HTTP ${response.status}` };
    }
    const data = await response.json() as { status?: string; service?: string };
    return {
      name: 'local_health',
      ok: data.status === 'ok',
      detail: `${data.service ?? 'unknown'} status=${data.status ?? 'missing'}`,
    };
  } catch (err) {
    return { name: 'local_health', ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

function pm2RuntimeCheck(strictTunnel: boolean): Check {
  try {
    const raw = execFileSync('pm2', ['jlist'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 });
    const apps = JSON.parse(raw) as Array<{ name?: string; pm2_env?: { status?: string; cron_restart?: string; autorestart?: boolean; pm_exec_path?: string; args?: string[] | string } }>;
    const app = apps.find((item) => item.name === 'zolara');
    const lifecycle = apps.find((item) => item.name === 'zolara-lifecycle-worker');
    const tunnel = apps.find((item) => /cloudflare|cloudflared|tunnel/i.test(item.name ?? '') || /cloudflared$/.test(item.pm2_env?.pm_exec_path ?? ''));
    const tunnelArgs = Array.isArray(tunnel?.pm2_env?.args)
      ? tunnel?.pm2_env?.args.join(' ')
      : String(tunnel?.pm2_env?.args ?? 'missing');
    const appOk = app?.pm2_env?.status === 'online';
    const lifecycleOk = lifecycle?.pm2_env?.cron_restart === '* * * * *' && lifecycle?.pm2_env?.autorestart === false;
    const tunnelOk = Boolean(tunnel && tunnel.pm2_env?.status === 'online' && !tunnelArgs.includes('--url') && /\btunnel\s+run\s+\S+/.test(tunnelArgs));
    const pm2Ok = strictTunnel ? Boolean(appOk && lifecycleOk && tunnelOk) : true;
    const externalSuffix = strictTunnel ? '' : ' (PM2 tunnel ignored in external hosting mode)';
    return {
      name: 'pm2_runtime',
      ok: pm2Ok,
      detail: `zolara=${app?.pm2_env?.status ?? 'missing'}, lifecycleCron=${lifecycle?.pm2_env?.cron_restart ?? 'missing'}, lifecycleAutorestart=${String(lifecycle?.pm2_env?.autorestart ?? 'missing')}, tunnel=${tunnel?.pm2_env?.status ?? 'missing'} ${tunnelArgs}${externalSuffix}`,
    };
  } catch (err) {
    return { name: 'pm2_runtime', ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

function missingAllowedUpdates(actual: string[] | undefined): string[] {
  const actualSet = new Set(actual ?? []);
  return PROJECT_BOT_ALLOWED_UPDATES.filter((update) => !actualSet.has(update));
}

async function getWebhookStatus(project: {
  botUsername: string | null;
  botTokenEncrypted: string | null;
}): Promise<{ urlSet: boolean; host: string | null; pendingUpdates: number | null; lastError: string | null; matchesBaseHost: boolean | null; allowedUpdatesOk: boolean | null; missingAllowedUpdates: string[] }> {
  if (!project.botTokenEncrypted) {
    return { urlSet: false, host: null, pendingUpdates: null, lastError: 'missing encrypted bot token', matchesBaseHost: null, allowedUpdatesOk: null, missingAllowedUpdates: [] };
  }

  const token = decrypt(project.botTokenEncrypted);
  const response = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`, {
    signal: AbortSignal.timeout(8000),
  });
  const data = await response.json() as {
    ok?: boolean;
    result?: { url?: string; pending_update_count?: number; last_error_message?: string; allowed_updates?: string[] };
    description?: string;
  };

  if (!data.ok || !data.result) {
    return { urlSet: false, host: null, pendingUpdates: null, lastError: data.description ?? 'getWebhookInfo failed', matchesBaseHost: null, allowedUpdatesOk: null, missingAllowedUpdates: [] };
  }

  const host = data.result.url ? new URL(data.result.url).hostname : null;
  const expectedHost = baseHost();
  const missing = missingAllowedUpdates(data.result.allowed_updates);
  return {
    urlSet: Boolean(data.result.url),
    host,
    pendingUpdates: data.result.pending_update_count ?? null,
    lastError: data.result.last_error_message ?? null,
    matchesBaseHost: host && expectedHost ? host === expectedHost : null,
    allowedUpdatesOk: missing.length === 0,
    missingAllowedUpdates: missing,
  };
}

async function main(): Promise<void> {
  const host = baseHost();
  const mode = hostingMode();
  const strictCloudflareTunnel = mode === 'cloudflare';
  const nextActions: string[] = [];
  const checks: Check[] = [
    {
      name: 'hosting_mode',
      ok: true,
      detail: mode,
    },
    {
      name: 'webhook_base_https',
      ok: config.WEBHOOK_BASE_URL.startsWith('https://'),
      detail: host ?? 'invalid WEBHOOK_BASE_URL',
    },
    {
      name: 'stable_webhook_host',
      ok: !isRandomTryCloudflareHost(host),
      detail: host ?? 'invalid WEBHOOK_BASE_URL',
    },
    await localHealthCheck(),
    await publicHealthCheck(),
    pm2RuntimeCheck(strictCloudflareTunnel),
  ];

  const activeProjectRows = await db
    .select({
      id: projects.id,
      name: projects.name,
      botUsername: projects.botUsername,
      botTokenEncrypted: projects.botTokenEncrypted,
      webhookSecret: projects.webhookSecret,
    })
    .from(projects)
    .where(eq(projects.status, 'active'));

  const activeProjectBots = activeProjectRows.filter((project) => project.botUsername && project.botTokenEncrypted && project.webhookSecret);
  const legacyIncompleteActiveRows = activeProjectRows.filter((project) => !project.botUsername && !project.botTokenEncrypted && !project.webhookSecret);
  const corruptProjectBotRows = activeProjectRows.filter((project) => project.botUsername && (!project.botTokenEncrypted || !project.webhookSecret));
  const oddPartialRows = activeProjectRows.filter((project) => !project.botUsername && (project.botTokenEncrypted || project.webhookSecret));
  const activeRowsMissingBotCredentials = [...legacyIncompleteActiveRows, ...corruptProjectBotRows, ...oddPartialRows];
  const activeProjectBotWebhooks = [];
  for (const project of activeProjectBots) {
    try {
      activeProjectBotWebhooks.push({
        id: project.id,
        botUsername: project.botUsername,
        webhook: await getWebhookStatus(project),
      });
    } catch (err) {
      activeProjectBotWebhooks.push({
        id: project.id,
        botUsername: project.botUsername,
        webhook: {
          urlSet: false,
          host: null,
          pendingUpdates: null,
          lastError: err instanceof Error ? err.message : String(err),
          matchesBaseHost: null,
          allowedUpdatesOk: null,
          missingAllowedUpdates: [],
        },
      });
    }
  }

  const recentProjects = await db
    .select({
      id: projects.id,
      name: projects.name,
      status: projects.status,
      botUsername: projects.botUsername,
      botTokenEncrypted: projects.botTokenEncrypted,
      groupIds: projects.groupIds,
      createdAt: projects.createdAt,
    })
    .from(projects)
    .orderBy(desc(projects.createdAt))
    .limit(5);

  const projectSummaries = [];
  for (const project of recentProjects) {
    const memberRows = await db
      .select({ onboardingStatus: members.onboardingStatus, telegramId: users.telegramId })
      .from(members)
      .innerJoin(users, eq(members.userId, users.id))
      .where(eq(members.projectId, project.id));

    const roundRows = await db
      .select({ id: rounds.id, status: rounds.status, roundNumber: rounds.roundNumber, responseCount: rounds.responseCount, memberCount: rounds.memberCount, deadline: rounds.deadline, errorMessage: rounds.errorMessage })
      .from(rounds)
      .where(eq(rounds.projectId, project.id))
      .orderBy(desc(rounds.roundNumber))
      .limit(3);

    const reportRows = await db
      .select({ id: reports.id, roundId: reports.roundId, telegramMessageId: reports.telegramMessageId, createdAt: reports.createdAt })
      .from(reports)
      .where(eq(reports.projectId, project.id))
      .orderBy(desc(reports.createdAt))
      .limit(3);

    const latestReportRoundId = reportRows[0]?.roundId ?? null;
    const latestReportRoundRows = latestReportRoundId === null ? [] : await db
      .select({ roundNumber: rounds.roundNumber })
      .from(rounds)
      .where(eq(rounds.id, latestReportRoundId))
      .limit(1);
    const latestReportRoundNumber = latestReportRoundRows[0]?.roundNumber ?? null;
    const reactionRows = latestReportRoundNumber === null ? [] : await db
      .select({ memberId: engagementEvents.memberId, createdAt: engagementEvents.createdAt, metadata: engagementEvents.metadata })
      .from(engagementEvents)
      .where(and(eq(engagementEvents.projectId, project.id), eq(engagementEvents.eventType, 'report_reaction')))
      .limit(500);
    const reactionCounts = latestReportRoundNumber === null
      ? null
      : summarizeLatestReportReactions(reactionRows, latestReportRoundNumber);

    const responseRows = await db
      .select({ id: responses.id })
      .from(responses)
      .innerJoin(members, eq(responses.memberId, members.id))
      .where(eq(members.projectId, project.id));

    let webhook: Awaited<ReturnType<typeof getWebhookStatus>> | null = null;
    if (project.status === 'active') {
      try {
        webhook = await getWebhookStatus(project);
      } catch (err) {
        webhook = {
          urlSet: false,
          host: null,
          pendingUpdates: null,
          lastError: err instanceof Error ? err.message : String(err),
          matchesBaseHost: null,
          allowedUpdatesOk: null,
          missingAllowedUpdates: [],
        };
      }
    }

    projectSummaries.push({
      id: redactedId(project.id),
      name: project.name,
      status: project.status,
      botUsername: project.botUsername,
      groupConfigured: Boolean(project.groupIds?.length),
      members: {
        total: memberRows.length,
        onboarded: memberRows.filter((m) => m.onboardingStatus === 'complete').length,
        openedBot: memberRows.filter((m) => Boolean(m.telegramId)).length,
      },
      rounds: roundRows.map((round) => ({
        roundNumber: round.roundNumber,
        status: round.status,
        responses: round.responseCount,
        members: round.memberCount,
        deadline: round.deadline?.toISOString() ?? null,
        error: round.errorMessage ?? null,
      })),
      responseRows: responseRows.length,
      reports: reportRows.map((report) => ({
        id: redactedId(report.id),
        roundId: report.roundId ? redactedId(report.roundId) : null,
        postedToTelegram: Boolean(report.telegramMessageId),
        createdAt: report.createdAt?.toISOString() ?? null,
      })),
      latestReportReactions: reactionCounts ? {
        roundNumber: latestReportRoundNumber,
        counts: reactionCounts,
        summary: formatReportReactionSummary(reactionCounts),
      } : null,
      webhook,
    });
  }

  const activeProjects = recentProjects.filter((p) => p.status === 'active');
  checks.push({
    name: 'active_project_available',
    ok: activeProjectBots.length > 0,
    detail: `${activeProjectBots.length} active project bot(s); ${activeProjects.length} active project(s) in latest ${recentProjects.length}`,
  });

  checks.push({
    name: 'active_rows_without_bot_credentials',
    ok: activeRowsMissingBotCredentials.length === 0,
    detail: activeRowsMissingBotCredentials.length === 0
      ? 'all active project rows have project-bot credentials'
      : `${legacyIncompleteActiveRows.length} legacy incomplete row(s), ${corruptProjectBotRows.length} project-bot row(s) with partial credentials, ${oddPartialRows.length} odd partial row(s): ${activeRowsMissingBotCredentials.map((p) => p.botUsername ? `@${p.botUsername}` : redactedId(p.id)).join(', ')}`,
  });

  const webhooksUnset = activeProjectBotWebhooks.filter((p) => p.webhook.urlSet === false);
  checks.push({
    name: 'active_webhooks_set',
    ok: webhooksUnset.length === 0,
    detail: webhooksUnset.length > 0
      ? `${webhooksUnset.length} active project bot webhook(s) unset: ${webhooksUnset.map((p) => `@${p.botUsername}`).join(', ')}`
      : 'all active project bot webhooks are set',
  });

  const webhookMismatch = activeProjectBotWebhooks.find((p) => p.webhook.matchesBaseHost === false);
  checks.push({
    name: 'active_webhooks_match_base_host',
    ok: !webhookMismatch,
    detail: webhookMismatch ? `@${webhookMismatch.botUsername} points at ${webhookMismatch.webhook.host}` : 'all active project bot webhooks match base host',
  });

  const allowedUpdatesMismatch = activeProjectBotWebhooks.find((p) => p.webhook.allowedUpdatesOk === false);
  checks.push({
    name: 'active_webhooks_allowed_updates',
    ok: !allowedUpdatesMismatch,
    detail: allowedUpdatesMismatch
      ? `@${allowedUpdatesMismatch.botUsername} missing ${allowedUpdatesMismatch.webhook.missingAllowedUpdates.join(', ')}`
      : 'all active project bot webhooks include required updates',
  });

  const latestLifecycleRows = await db
    .select({ createdAt: engagementEvents.createdAt, metadata: engagementEvents.metadata })
    .from(engagementEvents)
    .where(eq(engagementEvents.eventType, 'lifecycle_worker_summary'))
    .orderBy(desc(engagementEvents.createdAt))
    .limit(1);
  const latestLifecycle = latestLifecycleRows[0] ?? null;
  const latestLifecycleAgeMs = latestLifecycle?.createdAt ? Date.now() - latestLifecycle.createdAt.getTime() : null;
  const lifecycleMetadata = latestLifecycle?.metadata as { locked?: boolean; totals?: { checked?: number; expired?: number; processed?: number; failed?: number }; durationMs?: number } | undefined;
  checks.push({
    name: 'lifecycle_worker_observable',
    ok: latestLifecycleAgeMs !== null && latestLifecycleAgeMs < 10 * 60 * 1000,
    detail: latestLifecycle
      ? `latest=${latestLifecycle.createdAt?.toISOString() ?? 'unknown'}, ageMs=${latestLifecycleAgeMs}, locked=${String(lifecycleMetadata?.locked ?? 'unknown')}, totals=${JSON.stringify(lifecycleMetadata?.totals ?? {})}, durationMs=${String(lifecycleMetadata?.durationMs ?? 'unknown')}`
      : 'no lifecycle_worker_summary audit event found',
  });

  for (const check of checks) {
    if (check.ok) continue;
    if (check.name === 'stable_webhook_host') {
      addAction(nextActions, 'Provision a stable HTTPS hostname; random trycloudflare.com is not acceptable for testers.');
      addAction(nextActions, 'Run the stable webhook runbook: cloudflared login/create/route DNS, then `npm run tunnel:prepare-config`.');
    } else if (check.name === 'public_health') {
      addAction(nextActions, 'After the named tunnel is online, verify `curl <WEBHOOK_BASE_URL>/health` returns status=ok.');
    } else if (check.name === 'pm2_runtime') {
      addAction(nextActions, 'Restart the PM2 tunnel from ecosystem-tunnel.config.cjs so runtime uses `cloudflared tunnel run zolara-prod`, not quick `--url`.');
    } else if (check.name === 'active_rows_without_bot_credentials') {
      addAction(nextActions, 'Dry-run legacy cleanup with `npm run cleanup:incomplete-active-projects`; archive only after approval with CONFIRM_ARCHIVE=1.');
    } else if (check.name === 'active_webhooks_set' || check.name === 'active_webhooks_match_base_host' || check.name === 'active_webhooks_allowed_updates') {
      addAction(nextActions, 'After stable public /health passes, run `DRY_RUN=1 WEBHOOK_BASE_URL=https://<stable-host> npm run webhooks:rehook`, then run without DRY_RUN.');
    } else if (check.name === 'lifecycle_worker_observable') {
      addAction(nextActions, 'Run `npm run lifecycle:once` and confirm a fresh lifecycle_worker_summary audit appears.');
    }
  }

  const output = {
    generatedAt: new Date().toISOString(),
    checks,
    projects: projectSummaries,
    latestLifecycleWorker: latestLifecycle ? {
      createdAt: latestLifecycle.createdAt?.toISOString() ?? null,
      metadata: latestLifecycle.metadata,
    } : null,
    next: checks.every((check) => check.ok)
      ? 'Run live Telegram E2E smoke: create/activate bot, onboard members, start round, answer, wait for lifecycle, verify report/reactions.'
      : 'Fix failing checks before inviting testers or relying on live Telegram E2E smoke.',
    nextActions,
  };

  console.log(JSON.stringify(output, null, 2));

  if (checks.some((check) => !check.ok)) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
