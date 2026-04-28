#!/usr/bin/env npx tsx
/**
 * Zolara Spawner — Queue Processor
 * 
 * Architecture:
 * - File-based queue: /tmp/zolara-spawn-queue.json
 * - PM2 cron triggers this script every 60s
 * - Script reads queue and asks the registered zolara-spawner agent to process each entry
 * - zolara-spawner calls sessions_spawn and writes result back to queue
 * 
 * Queue format:
 * {
 *   "requests": [{ id, projectId, projectName, memberCount, activeRound, timestamp }],
 *   "results": [{ requestId, sessionKey, agentId, timestamp }]
 * }
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { spawnViaCLI } from '../src/util/spawn-agent';
import { db } from '../src/data/db';
import { projectAgents } from '../src/data/schema/agents';
import { eq } from 'drizzle-orm';

const QUEUE_FILE = '/tmp/zolara-spawn-queue.json';
const RESULT_TTL_MS = 300_000; // 5 min

interface SpawnRequest {
  id: string;
  projectId: string;
  projectName: string;
  memberCount: number;
  activeRound: boolean;
  timestamp: number;
}

interface SpawnResult {
  requestId: string;
  sessionKey: string;
  agentId: string;
  timestamp: number;
}

interface Queue {
  requests: SpawnRequest[];
  results: SpawnResult[];
}

function readQueue(): Queue {
  if (!existsSync(QUEUE_FILE)) return { requests: [], results: [] };
  try {
    return JSON.parse(readFileSync(QUEUE_FILE, 'utf8'));
  } catch {
    return { requests: [], results: [] };
  }
}

function writeQueue(q: Queue): void {
  writeFileSync(QUEUE_FILE, JSON.stringify(q, null, 2));
}



async function processQueue(): Promise<number> {
  const q = readQueue();
  if (q.requests.length === 0) return 0;

  // Filter out expired requests
  const now = Date.now();
  const pending = q.requests.filter(r => now - r.timestamp < RESULT_TTL_MS);
  const expired = q.requests.filter(r => now - r.timestamp >= RESULT_TTL_MS);

  // Remove expired
  if (expired.length > 0) {
    console.log(`[spawner] Removing ${expired.length} expired request(s)`);
  }
  q.requests = pending;
  writeQueue(q);

  let processed = 0;
  for (const req of [...pending]) {
    try {
      console.log(`[spawner] Processing: ${req.projectName} (${req.projectId})`);
      // Build task prompt. Model choice is passed only as sessions_spawn parameter in spawnViaCLI.
      const coordinatorLabel = `coordinator-${req.projectId.substring(0, 8)}`;
      const taskPrompt = `You are the team coordinator for "${req.projectName}" (ID: ${req.projectId}) on Zolara.
Member count: ${req.memberCount}
Active round: ${req.activeRound ? 'yes' : 'no'}

Your role: help the team stay engaged and aligned during consensus rounds.
When initialized, reply with ONLY: session_key: ${coordinatorLabel}

Never store project data. Stay ephemeral.`;

      const result = await spawnViaCLI(
        req.projectId,
        req.projectName,
        req.memberCount,
        req.activeRound,
        taskPrompt  // pass taskPrompt as customTaskPrompt
      );

      if (!result.success) {
        throw new Error(result.error ?? 'Unknown error');
      }

      const sessionKey = result.sessionKey ?? `coordinator:${req.projectId}`;
      const agentId = `coordinator-${req.projectId.substring(0, 8)}`;

      q.results.push({
        requestId: req.id,
        sessionKey,
        agentId,
        timestamp: Date.now(),
      });

      // Reconcile the DB row immediately so project_agents does not stay pending
      // if no request-side poll consumes the queue result.
      try {
        await db.update(projectAgents)
          .set({ sessionKey, status: 'active', updatedAt: new Date() })
          .where(eq(projectAgents.projectId, req.projectId));
      } catch (err: any) {
        console.error(`[spawner] ⚠️ Could not update project_agents for ${req.projectId}: ${err.message}`);
      }

      // Remove from pending
      q.requests = q.requests.filter(r => r.id !== req.id);
      writeQueue(q);
      processed++;

      console.log(`[spawner] ✅ ${req.projectName} → ${sessionKey}`);
    } catch (err: any) {
      console.error(`[spawner] ❌ ${req.projectId}: ${err.message}`);
      // Keep in queue for retry
    }
  }

  return processed;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const mode = process.argv[2] || 'once';

  if (mode === 'once' || mode === 'cron') {
    try {
      const n = await processQueue();
      if (n > 0) console.log(`[spawner] ✅ Processed ${n} request(s)`);
      else console.log(`[spawner] ℹ️  No pending requests`);
    } catch (err: any) {
      console.error(`[spawner] ❌ Error: ${err.message}`);
      process.exit(1);
    }
    process.exit(0);
  }

  if (mode === 'daemon') {
    // Daemon: process queue every 30 seconds, forever
    console.log('[spawner] 🚀 Daemon mode started — checking queue every 30s');
    process.on('SIGTERM', () => { console.log('[spawner] Shutting down'); process.exit(0); });
    process.on('SIGINT', () => { console.log('[spawner] Shutting down'); process.exit(0); });
    
    // Process immediately on start
    await processQueue();
    
    // Then every 30s
    setInterval(async () => {
      try {
        await processQueue();
      } catch (err: any) {
        console.error(`[spawner] ❌ Queue error: ${err.message}`);
      }
    }, 30_000);
    
    return; // Daemon runs forever
  }

  if (mode === 'enqueue') {
    // process.argv: [node, tsx, script, enqueue, projectId, projectName, memberCount?, activeRound?]
    const [, , , pProjectId, pProjectName, pMemberCount = '0', pActiveRound = 'false'] = process.argv;
    if (!pProjectId || !pProjectName) {
      console.error('Usage: spawner-server.ts enqueue <projectId> <projectName> [memberCount] [activeRound]');
      process.exit(1);
    }
    const q = readQueue();
    const id = `spawn-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    q.requests.push({
      id,
      projectId: pProjectId,
      projectName: pProjectName,
      memberCount: parseInt(pMemberCount) || 0,
      activeRound: pActiveRound === 'true',
      timestamp: Date.now(),
    });
    writeQueue(q);
    console.log(`[spawner] 📝 Enqueued: ${pProjectName} (${pProjectId}) as ${id}`);
    process.exit(0);
  }

  if (mode === 'status') {
    const q = readQueue();
    const now = Date.now();
    const active = q.requests.filter(r => now - r.timestamp < RESULT_TTL_MS);
    console.log(`Pending: ${active.length}, Results: ${q.results.length}`);
    if (active.length > 0) {
      console.log('Pending requests:');
      active.forEach(r => console.log(`  - ${r.projectName} (${r.id}) — ${Math.round((now - r.timestamp)/1000)}s ago`));
    }
    process.exit(0);
  }

  if (mode === 'clear') {
    writeQueue({ requests: [], results: [] });
    console.log('[spawner] Queue cleared');
    process.exit(0);
  }

  console.log('Usage: spawner-server.ts <once|daemon|enqueue|status|clear>');
  process.exit(1);
}

main();
