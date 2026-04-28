/**
 * Project Agent Management
 *
 * Handles lifecycle of OpenClaw sub-agents per project bot.
 * Uses sessions_spawn() to create a persistent agent per project.
 *
 * NOTE: The actual session spawn uses the OpenClaw internal RPC (not a public REST API).
 * The spawnProjectAgent() function below is the integration point — it should be
 * wired to call the OpenClaw gateway's sessions_spawn RPC once that API is available.
 * For now, agent lifecycle is tracked in the DB and spawn is called via OpenClaw CLI
 * or the agent's own tooling when the gateway RPC is accessible.
 */
import { db } from '../../data/db';
import { projectAgents } from '../../data/schema/agents';
import { projects } from '../../data/schema/projects';
import { members } from '../../data/schema/projects';
import { rounds } from '../../data/schema/projects';
import { eq, and, lt } from 'drizzle-orm';
const RESTORE_DAYS = 30;
/** Build the system prompt for a team coordinator agent */
function buildAgentPrompt(ctx) {
    return `You are the team coordinator for the "${ctx.projectName}" project on Zolara.

Your role is to help the team stay engaged, aligned, and productive. You coordinate consensus rounds, monitor participation, and surface the most important context at any given moment.

**Current project state:**
- Name: ${ctx.projectName}
- Status: ${ctx.projectStatus}
- Members: ${ctx.memberCount}
- Active round: ${ctx.activeRound ? 'YES' : 'No round currently running'}

**Your responsibilities:**
1. When a round is active — help members stay on track, send reminders to non-responders, surface emerging themes
2. Between rounds — maintain team awareness, surface relevant past insights, keep energy up
3. When engagement drops — identify quiet members and reach out with targeted nudges
4. During synthesis — help frame the consensus report clearly

**How you operate:**
- You receive Telegram DMs from team members and respond contextually
- You can consult the project history to give informed guidance
- You NEVER make decisions FOR the team — you facilitate and surface
- You use the methodology stack to pick the right intervention at the right time

**Methodology library (use appropriately):**
- orientation_rounds: for new members joining
- question_pacing: during active rounds
- attention_spark: when <50% of members have responded
- synthesis_preview: when round completes, before report
- reflection_prompt: after report is posted
- reactivation_sequence: when team has been dormant 7+ days
- context_rollup: monthly coherence check

Be concise, warm, and action-oriented. The team should feel like you're a helpful co-pilot, not a top-down manager.`;
}
/** Collect project context for the agent */
async function getProjectContext(projectId) {
    const [proj] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!proj)
        return null;
    const memberCount = await db.select().from(members).where(eq(members.projectId, projectId));
    const [activeRound] = await db.select().from(rounds)
        .where(and(eq(rounds.projectId, projectId), eq(rounds.status, 'gathering'))).limit(1);
    return {
        projectId,
        projectName: proj.name ?? 'Unknown Project',
        projectStatus: proj.status ?? 'pending',
        memberCount: memberCount.length,
        activeRound: !!activeRound,
        config: proj.config ?? {},
    };
}
/**
 * Spawn a new team coordinator agent for a project.
 *
 * Uses the OpenClaw agent messaging approach: sends a spawn command to the
 * zolara-spawner agent (via openclaw CLI), which internally calls sessions_spawn.
 * This ensures no direct RPC API exposure — the spawner is a clean intermediary.
 *
 * Each spawned sub-agent is fully isolated (separate workspace, no cross-project memory).
 * The spawner agent itself holds no project data — it's a pure function orchestrator.
 */
export async function spawnProjectAgent(projectId) {
    const existing = await db.select().from(projectAgents).where(eq(projectAgents.projectId, projectId)).limit(1);
    if (existing[0]?.status === 'active') {
        return { success: false, error: 'Agent already active for this project' };
    }
    if (existing[0]?.status === 'pending' && existing[0].sessionKey?.startsWith('pending:')) {
        return { success: true, sessionKey: existing[0].sessionKey };
    }
    const ctx = await getProjectContext(projectId);
    if (!ctx)
        return { success: false, error: 'Project not found' };
    // Write spawn request to queue (non-blocking)
    // PM2 cron process will pick it up within 60s
    const { spawnTeamCoordinator } = await import('../../util/spawn-agent');
    const result = await spawnTeamCoordinator(projectId, ctx.projectName, ctx.memberCount, ctx.activeRound);
    // Store with pending session key — the spawner reconciles this row to active
    // after sessions_spawn returns a real session key.
    const pendingRow = {
        sessionKey: result.sessionKey ?? `pending:${projectId}`,
        agentType: 'team_coordinator',
        displayName: `${ctx.projectName} Coordinator`,
        config: JSON.stringify({ ...ctx, spawnResult: result }),
        status: 'pending',
        updatedAt: new Date(),
    };
    if (existing[0]) {
        await db.update(projectAgents)
            .set(pendingRow)
            .where(eq(projectAgents.projectId, projectId));
    }
    else {
        await db.insert(projectAgents).values({
            projectId,
            ...pendingRow,
        });
    }
    if (result.success) {
        console.log(`[Agent] Spawned team coordinator for project ${projectId}, session=${result.sessionKey}`);
    }
    else {
        console.error(`[Agent] Failed to spawn agent for project ${projectId}: ${result.error}`);
    }
    return result;
}
/** Suspend the agent for an archived project */
export async function suspendProjectAgent(projectId) {
    await db.update(projectAgents)
        .set({ status: 'suspended', updatedAt: new Date() })
        .where(eq(projectAgents.projectId, projectId));
    console.log(`[Agent] Suspended agent for project ${projectId}`);
}
/** Restore a suspended agent when project is restored */
export async function restoreProjectAgent(projectId) {
    await db.update(projectAgents)
        .set({ status: 'active', updatedAt: new Date() })
        .where(eq(projectAgents.projectId, projectId));
    console.log(`[Agent] Restored agent for project ${projectId}`);
}
/** Soft-delete an agent when project is deleted (30-day restore window) */
export async function deleteProjectAgent(projectId) {
    const deletedAt = new Date();
    const restoreUntil = new Date(deletedAt.getTime() + RESTORE_DAYS * 24 * 60 * 60 * 1000);
    await db.update(projectAgents)
        .set({ status: 'deleted', deletedAt, restoreUntil, updatedAt: deletedAt })
        .where(eq(projectAgents.projectId, projectId));
    console.log(`[Agent] Soft-deleted agent for project ${projectId}, restore until ${restoreUntil.toISOString()}`);
}
/** Permanently purge agents whose restore window has passed */
export async function purgeStaleAgents() {
    const now = new Date();
    const stale = await db.select({ id: projectAgents.id })
        .from(projectAgents)
        .where(and(eq(projectAgents.status, 'deleted'), lt(projectAgents.restoreUntil, now)));
    if (!stale.length)
        return 0;
    await db.delete(projectAgents)
        .where(and(eq(projectAgents.status, 'deleted'), lt(projectAgents.restoreUntil, now)));
    console.log(`[Agent] Purged ${stale.length} stale agents`);
    return stale.length;
}
/** Get agent info for a project */
export async function getProjectAgent(projectId) {
    const [agent] = await db.select().from(projectAgents).where(eq(projectAgents.projectId, projectId)).limit(1);
    return agent ?? null;
}
