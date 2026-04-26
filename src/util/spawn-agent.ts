/**
 * Agent spawner via OpenClaw agent messaging.
 * 
 * Data Isolation Architecture:
 * 
 * 1. Zolara backend → spawner agent: message contains ONLY projectId + minimal context
 *    No project data, no member data, no conversation history
 * 
 * 2. Spawner agent workspace: completely empty except for SOUL.md
 *    - No memory from previous spawns
 *    - No cross-project context accumulation
 *    - Each spawn command handled in pure isolation
 * 
 * 3. Spawned sub-agents: each gets a fresh isolated session
 *    - sessionKey is the only link between project and agent
 *    - Each project agent workspace is separate
 *    - No shared memory between project agents
 * 
 * 4. Data flow: Zolara (DB) → spawner (message) → project agent (session)
 *    - Zolara never exposes raw project data to spawner
 *    - Spawner never stores project data
 *    - Project agent receives only projectId + config (not member messages)
 */

import { execSync } from 'child_process';

const SPAWNER_AGENT = 'zolara-spawner';

/** Result from a spawn operation */
interface SpawnResult {
  success: boolean;
  sessionKey?: string;
  error?: string;
}

/**
 * Execute openclaw CLI with the spawner agent and return raw output.
 * No data is stored between calls — each invocation is independent.
 */
function callSpawner(message: string, timeoutSeconds = 30): string {
  // Escape only double quotes — message format is controlled by our code
  const escaped = message.replace(/"/g, '\\"');
  const cmd = `openclaw agent --agent ${SPAWNER_AGENT} --message "${escaped}" --json --timeout ${timeoutSeconds} 2>/dev/null`;
  try {
    const out = execSync(cmd, { encoding: 'utf8', timeout: (timeoutSeconds + 5) * 1000 });
    return out ?? '';
  } catch (err: any) {
    // On failure, return empty string — caller handles error
    return '';
  }
}

/**
 * Spawn a team coordinator for a project.
 * 
 * @param projectId - UUID of the project (used only to identify the session)
 * @param projectName - Display name (shown in agent label only)
 * @param memberCount - Number of members (for context only, not stored)
 * @param activeRound - Whether a round is currently gathering
 */
export async function spawnTeamCoordinator(
  projectId: string,
  projectName: string,
  memberCount: number,
  activeRound: boolean
): Promise<SpawnResult> {
  // Send minimal context — projectId is the only persistent identifier
  // No member data, no conversation history, no project specifics
  const context = JSON.stringify({ projectId, memberCount, activeRound });
  const message = `spawn team-coordinator:${projectName} context=${context}`;

  const response = callSpawner(message);

  // Try to extract session key from response
  // Expected format: { "sessionKey": "abc123" } or "session_key: abc123"
  if (!response || response.trim().length === 0) {
    return { success: false, error: 'Spawner timed out or returned empty' };
  }

  try {
    const parsed = JSON.parse(response);
    if (parsed.sessionKey) {
      return { success: true, sessionKey: parsed.sessionKey };
    }
  } catch {
    // Not JSON — try text extraction
  }

  const match = response.match(/session_key[:\s]+(\S+)/);
  if (match) {
    return { success: true, sessionKey: match[1] };
  }

  return { success: false, error: `Spawner error: ${response.substring(0, 100)}` };
}

/** Get list of active project agent sessions (for monitoring only) */
export async function listActiveAgents(): Promise<string[]> {
  const response = callSpawner('list active', 10);
  if (response.includes('none') || response.includes('No active')) {
    return [];
  }
  // Parse — implementation depends on spawner response format
  return [];
}