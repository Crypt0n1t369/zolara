/**
 * Agent spawner via file-based queue.
 * 
 * Architecture:
 * 
 * 1. Zolara backend → queue file: spawnProjectAgent() writes request to
 *    /tmp/zolara-spawn-queue.json and returns immediately (non-blocking).
 *    No LLM calls, no gateway calls — just a file write.
 * 
 * 2. Queue processor (PM2 cron): every 60s, run spawner-server.ts once.
 *    Reads queue, calls openclaw agent for each pending request.
 *    openclaw agent sends message to zolara-builder → sessions_spawn → result.
 * 
 * 3. Result written back to queue file. Zolara reads on next access.
 * 
 * Why file-based:
 * - No gateway API exposure — uses CLI which has built-in auth
 * - No polling LLM cost — cron only reads a file
 * - Non-blocking — project creation returns immediately
 * - Queue provides retry logic on failure
 * 
 * Data Isolation:
 * - Zolara → queue: only projectId + minimal context (no member data)
 * - Spawner → sessions_spawn: isolated sub-agent per project
 * - No cross-project state in spawner
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { spawn } from 'child_process';

const SPAWNER_AGENT = 'zolara-spawner';
const QUEUE_FILE = '/tmp/zolara-spawn-queue.json';
const COORDINATOR_MODEL = process.env.ZOLARA_COORDINATOR_MODEL ?? 'openai/gpt-5-nano';

/** Result from a spawn operation */
export interface SpawnResult {
  success: boolean;
  sessionKey?: string;
  error?: string;
}

interface SpawnRequest {
  id: string;
  projectId: string;
  projectName: string;
  memberCount: number;
  activeRound: boolean;
  timestamp: number;
}

interface Queue {
  requests: SpawnRequest[];
  results: SpawnResult[];
}

function escapeJson(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
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

/**
 * Spawn a team coordinator for a project — NON-BLOCKING.
 * 
 * Writes spawn request to queue file and returns immediately.
 * The PM2 cron process will pick it up within 60 seconds.
 * 
 * @returns SpawnResult with sessionKey="pending:{id}" if enqueued successfully
 */
export async function spawnTeamCoordinator(
  projectId: string,
  projectName: string,
  memberCount: number,
  activeRound: boolean
): Promise<SpawnResult> {
  const q = readQueue();
  
  const id = `spawn-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  q.requests.push({
    id,
    projectId,
    projectName,
    memberCount,
    activeRound,
    timestamp: Date.now(),
  });
  
  writeQueue(q);
  
  console.log(`[spawner] 📝 Enqueued coordinator spawn for ${projectName} (${projectId})`);
  
  return {
    success: true,
    sessionKey: `pending:${id}`,
  };
}

/**
 * Get spawn result for a specific request.
 * Called by Zolara after project creation to get the actual session key.
 */
export async function getSpawnResult(requestId: string): Promise<SpawnResult | null> {
  const q = readQueue();
  const result = q.results.find(r => (r as any).requestId === requestId);
  
  if (result) {
    // Clean up
    q.results = q.results.filter(r => (r as any).requestId !== requestId);
    writeQueue(q);
    return result;
  }
  
  return null;
}

/**
 * Spawn via openclaw agent CLI — used by the queue processor.
 *
 * Important: the model below is ONLY for the child coordinator passed to
 * sessions_spawn. Do not ask the builder/spawner session itself to switch model;
 * that has caused crashes when the hosting session was moved to MiniMax.
 */
export async function spawnViaCLI(
  projectId: string,
  projectName: string,
  memberCount: number,
  activeRound: boolean,
  customTaskPrompt?: string,
  timeoutMs = 120_000
): Promise<SpawnResult> {
  const coordinatorLabel = `coordinator-${projectId.substring(0, 8)}`;
  const taskPrompt = customTaskPrompt ?? `You are the team coordinator for "${projectName}" (ID: ${projectId}) on Zolara.
Member count: ${memberCount}
Active round: ${activeRound ? 'yes' : 'no'}

Your role: help the team stay engaged and aligned during consensus rounds.
When initialized, reply with ONLY: session_key: coordinator-${projectId.substring(0, 8)}

Never store project data. Stay ephemeral.`;

  const message = `Spawn coordinator for project "${projectName}" (ID: ${projectId}) using sessions_spawn tool.

Use sessions_spawn with these exact parameters:
- label: "${coordinatorLabel}"
- runtime: "subagent"
- mode: "run"
- model: "${COORDINATOR_MODEL}"
- task: "${taskPrompt.replace(/"/g, '\\"')}"

Do not change your own session model. The model above is only the child
coordinator's sessions_spawn parameter.

Reply with ONLY: session_key: <sessionKey from sessions_spawn response>`;

  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout;
    const done = (result: SpawnResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };

    const child = spawn('openclaw', [
      'agent',
      '--agent', SPAWNER_AGENT,
      '--message', message,
      '--timeout', String(Math.max(90, Math.ceil(timeoutMs / 1000) - 10)),
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on('close', (code) => {
      const output = stdout + stderr;

      let sessionKey = '';
      const keyMatch = output.match(/session_key[:\s]+([^\s\n]+)/i) ||
                       output.match(/sessionKey[:\s"]+([^"]+)"/);
      if (keyMatch) sessionKey = keyMatch[1];

      if (sessionKey) {
        done({ success: true, sessionKey });
      } else {
        done({ success: false, error: `spawn command returned no session_key (exit ${code}): ${output.substring(0, 300)}` });
      }
    });

    child.on('error', (err) => done({ success: false, error: err.message }));

    timer = setTimeout(() => {
      child.kill();
      done({ success: false, error: `Spawn timed out after ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);
  });
}
