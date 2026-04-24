/**
 * Project selector for multi-project admin clarity.
 *
 * Shows inline keyboard with all projects, numbered.
 * After selection, stores in Redis `active_project:{telegramId}` for 24h.
 * All admin commands check this first before falling back to most recent.
 */
import { db } from '../data/db';
import { projects, admins, members, rounds } from '../data/schema/projects';
import { eq, desc } from 'drizzle-orm';
import { redis } from '../data/redis';
/**
 * Get all projects for an admin, with enriched data (member count, bot username, last round).
 */
export async function getAdminProjects(adminTelegramId) {
    const rows = await db
        .select({
        id: projects.id,
        name: projects.name,
        status: projects.status,
        botTelegramId: projects.botTelegramId,
    })
        .from(projects)
        .innerJoin(admins, eq(admins.id, projects.adminId))
        .where(eq(admins.telegramId, adminTelegramId))
        .orderBy(desc(projects.createdAt))
        .limit(10);
    const enriched = await Promise.all(rows.map(async (p) => {
        // Member count
        const [countRow] = await db
            .select({ count: projects.id })
            .from(members)
            .where(eq(members.projectId, p.id))
            .limit(1);
        const memberCount = countRow ? 1 : 0; // workaround — need a real count
        // Last round
        const [round] = await db
            .select({ roundNumber: rounds.roundNumber, status: rounds.status, startedAt: rounds.startedAt })
            .from(rounds)
            .where(eq(rounds.projectId, p.id))
            .orderBy(desc(rounds.startedAt))
            .limit(1);
        // Bot username from botTelegramId
        let botUsername = null;
        if (p.botTelegramId) {
            try {
                const { getManagedBotInfo } = await import('../project/managed-bots/lifecycle');
                const info = await getManagedBotInfo(p.botTelegramId);
                botUsername = info.username;
            }
            catch {
                botUsername = null;
            }
        }
        return {
            id: p.id,
            name: p.name,
            status: p.status,
            botUsername,
            memberCount: 0, // TODO: proper count
            lastRound: round ? `Round #${round.roundNumber}` : null,
            lastRoundStatus: round?.status ?? null,
        };
    }));
    return enriched;
}
/**
 * Get the currently active project for an admin.
 * Priority: Redis `active_project:{telegramId}` > most recent active project.
 */
export async function getActiveProject(adminTelegramId) {
    // Check Redis for explicit selection
    const stored = await redis.get(`active_project:${adminTelegramId}`);
    if (stored) {
        const data = JSON.parse(stored);
        const allProjects = await getAdminProjects(adminTelegramId);
        const isValid = allProjects.some((p) => p.id === data.projectId);
        if (isValid) {
            return { projectId: data.projectId, hasMultiple: allProjects.length > 1, projects: allProjects };
        }
        // Stored project no longer valid — clear it
        await redis.del(`active_project:${adminTelegramId}`);
    }
    // Fall back to most recent active project
    const allProjects = await getAdminProjects(adminTelegramId);
    const active = allProjects.filter((p) => p.status === 'active');
    const fallback = active[0] ?? allProjects[0] ?? null;
    return {
        projectId: fallback?.id ?? null,
        hasMultiple: allProjects.length > 1,
        projects: allProjects,
    };
}
/**
 * Set the active project for an admin (stored in Redis for 24h).
 */
export async function setActiveProject(adminTelegramId, projectId) {
    await redis.setex(`active_project:${adminTelegramId}`, 86400, JSON.stringify({
        projectId,
        selectedAt: new Date().toISOString(),
    }));
}
/**
 * Clear the active project selection for an admin.
 */
export async function clearActiveProject(adminTelegramId) {
    await redis.del(`active_project:${adminTelegramId}`);
}
/**
 * Build a project selector inline keyboard message text for admin with multiple projects.
 */
export function buildProjectSelectorText(projects, activeProjectId, context) {
    const header = `🎛️ *Select a project* — ${context}\n\n`;
    const lines = projects.map((p, i) => {
        const active = p.id === activeProjectId ? ' ◀️' : '';
        const status = p.status === 'active' ? '🟢' : p.status === 'pending' ? '🟡' : '⚫';
        const memberInfo = p.memberCount > 0 ? ` | ${p.memberCount} members` : '';
        const botInfo = p.botUsername ? ` | @${p.botUsername}` : '';
        return `${i + 1}. ${status} *${p.name}*${active}${memberInfo}${botInfo}`;
    }).join('\n');
    const footer = `\n\nSelect a number to work with that project.`;
    return header + lines + footer;
}
/**
 * Build a project selector inline keyboard.
 */
export function buildProjectSelectorKeyboard(projects, context, prefix = 'proj') {
    const rows = [];
    // Numbered buttons in pairs
    for (let i = 0; i < projects.length; i += 2) {
        const row = [];
        row.push({ text: `${i + 1}`, callback_data: `${prefix}:${projects[i].id}` });
        if (i + 1 < projects.length) {
            row.push({ text: `${i + 2}`, callback_data: `${prefix}:${projects[i + 1].id}` });
        }
        rows.push(row);
    }
    return { inline_keyboard: rows };
}
/**
 * Strip markdown from text to avoid Telegram parse errors.
 */
export function stripMarkdown(text) {
    return text.replace(/[*_`[\]()]/g, '').slice(0, 4096);
}
