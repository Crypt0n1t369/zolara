/**
 * Admin Commands for the Manager Bot
 *
 * Adds the following commands for project admins:
 *   /projects          — List your active projects
 *   /startround        — Trigger a perspective round on a project
 *   /cancelround       — Cancel the active round on a project
 *   /members          — List members of a project
 *   /invite            — Get the invite link for a project
 *
 * Also adds group auto-detection:
 *   When a project bot is added to a group, it detects the group
 *   and asks the admin whether to use it as the report destination.
 */
import { redis } from '../data/redis';
import { db } from '../data/db';
import { projects, members, rounds } from '../data/schema/projects';
import { eq, and } from 'drizzle-orm';
import { triggerRound, cancelRound } from '../engine/round-manager';
import { logger } from '../util/logger';
import { getAdminProjects, buildProjectSelectorText, buildProjectSelectorKeyboard } from './project-selector';
// ── Admin project selection (delegated to project-selector) ───────────────────
/**
 * Get the project the admin is currently focused on.
 * Falls back to the most recent active project if none explicitly selected.
 * Also returns projectId for use in commands that need it.
 */
export async function resolveActiveProject(adminTelegramId) {
    const { getActiveProject } = await import('./project-selector');
    const result = await getActiveProject(adminTelegramId);
    const found = result.projects.find((p) => p.id === result.projectId) ?? null;
    return {
        project: found ? { id: found.id, name: found.name, status: found.status } : null,
        projectId: result.projectId,
        hasMultiple: result.hasMultiple,
        choices: result.projects.map((p) => ({ id: p.id, name: p.name, status: p.status })),
    };
}
// ── Command handlers ─────────────────────────────────────────────────────────
export async function handleProjectsCommand(ctx) {
    const telegramId = ctx.from.id;
    const allProjects = await getAdminProjects(telegramId);
    if (allProjects.length === 0) {
        await ctx.reply("You don't have any projects yet.\n\nUse /create to set one up.", { parse_mode: 'Markdown' });
        return;
    }
    if (allProjects.length === 1) {
        // Single project — show rich summary
        const p = allProjects[0];
        const statusLine = p.status === 'active' ? '🟢 Active' : p.status === 'pending' ? '🟡 Pending' : `⚫ ${p.status ?? 'unknown'}`;
        const roundLine = p.lastRound
            ? `Current round: *${p.lastRound}* (${p.lastRoundStatus ?? 'unknown'})`
            : 'No active round';
        const botLine = p.botUsername
            ? `Bot: @${p.botUsername}`
            : 'Bot: not created yet';
        await ctx.reply(`*${p.name}*\n\n` +
            `${statusLine} | ${botLine}\n` +
            roundLine, { parse_mode: 'Markdown' });
        return;
    }
    // Multiple projects — show selector
    const { projectId } = await resolveActiveProject(telegramId);
    const text = buildProjectSelectorText(allProjects, projectId, 'your projects');
    const keyboard = buildProjectSelectorKeyboard(allProjects, 'projects', 'proj');
    await ctx.reply(text, { parse_mode: 'Markdown', replyMarkup: keyboard });
}
export async function handleStartRoundCommand(ctx, args) {
    const telegramId = ctx.from.id;
    const allProjects = await getAdminProjects(telegramId);
    if (allProjects.length === 0) {
        await ctx.reply("You don't have any projects yet. Use /create to set one up.");
        return;
    }
    if (allProjects.length > 1) {
        const { projectId } = await resolveActiveProject(telegramId);
        const text = buildProjectSelectorText(allProjects, projectId, '/startround — select project');
        const keyboard = buildProjectSelectorKeyboard(allProjects, '/startround', 'round_proj');
        await ctx.reply(text, { parse_mode: 'Markdown', replyMarkup: keyboard });
        return;
    }
    const project = allProjects[0];
    // Parse topic and anonymity flag from args
    // Examples:
    //   /startround Q3 planning
    //   /startround Q3 planning --anonymous
    //   /startround --attributed
    //   /startround --optional
    const trimmed = args.trim();
    const anonMatch = trimmed.match(/--(\w+)$/);
    let topic = trimmed;
    let anonymity;
    if (anonMatch) {
        const flag = anonMatch[1];
        if (['anonymous', 'attributed', 'optional'].includes(flag)) {
            anonymity = flag === 'anonymous' ? 'full' : flag;
            topic = trimmed.replace(/--\w+$/, '').trim();
        }
    }
    topic = topic || 'General check-in';
    try {
        const { roundId, status } = await triggerRound(project.id, topic, { anonymity });
        const anonLabel = anonymity === 'full' ? 'Anonymous' : anonymity === 'attributed' ? 'Attributed' : anonymity === 'optional' ? 'Optional-anonymous' : null;
        const anonLine = anonLabel ? `\n🔒 Privacy: *${anonLabel}*\n` : '';
        const successMsg = `🎯 *Round started!*\n\n` +
            `Project: *${project.name}*\n` +
            `Topic: ${topic}${anonLine}\n` +
            `Members are being sent questions via DM.\n` +
            `The synthesis report will be posted here when the round closes.`;
        await ctx.reply(successMsg, { parse_mode: 'Markdown' });
        logger.info('round', 'TRIGGERED', `Round triggered by admin ${telegramId}`, {
            projectId: project.id,
            roundId,
            topic,
        });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await ctx.reply(`⚠️ Could not start round: ${msg}`);
        logger.error('round', 'TRIGGER_FAILED', `Admin ${telegramId} failed to trigger round`, {
            projectId: project.id,
            telegramId,
        }, err);
    }
}
export async function handleCancelRoundCommand(ctx) {
    const telegramId = ctx.from.id;
    const { project } = await resolveActiveProject(telegramId);
    if (!project) {
        await ctx.reply("You don't have any projects yet.");
        return;
    }
    // Find the active round
    const [round] = await db
        .select()
        .from(rounds)
        .where(and(eq(rounds.projectId, project.id), eq(rounds.status, 'gathering')))
        .limit(1);
    if (!round) {
        await ctx.reply(`No active round on *${project.name}* to cancel.`, { parse_mode: 'Markdown' });
        return;
    }
    try {
        await cancelRound(round.id);
        await ctx.reply(`✅ Round #${round.roundNumber} cancelled.\n\nMembers will no longer receive questions.`, { parse_mode: 'Markdown' });
    }
    catch (err) {
        await ctx.reply(`⚠️ Could not cancel round: ${err instanceof Error ? err.message : String(err)}`);
    }
}
export async function handleMembersCommand(ctx) {
    const telegramId = ctx.from.id;
    const allProjects = await getAdminProjects(telegramId);
    if (allProjects.length === 0) {
        await ctx.reply("You don't have any projects yet.");
        return;
    }
    if (allProjects.length > 1) {
        const { projectId } = await resolveActiveProject(telegramId);
        const text = buildProjectSelectorText(allProjects, projectId, '/members — select project');
        const keyboard = buildProjectSelectorKeyboard(allProjects, '/members', 'members_proj');
        await ctx.reply(text, { parse_mode: 'Markdown', replyMarkup: keyboard });
        return;
    }
    const project = allProjects[0];
    const memberRows = await db
        .select({
        id: members.id,
        role: members.role,
        onboardingStatus: members.onboardingStatus,
    })
        .from(members)
        .where(eq(members.projectId, project.id))
        .limit(50);
    const committed = memberRows.filter((m) => m.onboardingStatus === 'committed');
    const pending = memberRows.filter((m) => m.onboardingStatus !== 'committed');
    const lines = memberRows.slice(0, 20).map((m, i) => {
        const status = m.onboardingStatus === 'committed' ? '✅' : '⏳';
        return `${i + 1}. ${m.role ?? 'participant'} — ${status}`;
    }).join('\n');
    await ctx.reply(`*${project.name} — Members*\n\n` +
        `Total: ${memberRows.length} | Committed: ${committed.length} | Pending: ${pending.length}\n\n` +
        (lines || 'No members yet.'), { parse_mode: 'Markdown' });
}
export async function handleInviteCommand(ctx) {
    const telegramId = ctx.from.id;
    const allProjects = await getAdminProjects(telegramId);
    if (allProjects.length === 0) {
        await ctx.reply("You don't have any projects yet.");
        return;
    }
    if (allProjects.length > 1) {
        const { projectId } = await resolveActiveProject(telegramId);
        const text = buildProjectSelectorText(allProjects, projectId, '/invite — select project');
        const keyboard = buildProjectSelectorKeyboard(allProjects, '/invite', 'invite_proj');
        await ctx.reply(text, { parse_mode: 'Markdown', replyMarkup: keyboard });
        return;
    }
    const project = allProjects[0];
    if (!project.botUsername) {
        await ctx.reply(`*${project.name}*

` +
            `Your project bot hasn't been created yet!\n` +
            `The bot is created when you complete the /create flow.`);
        return;
    }
    const inviteLink = `https://t.me/${project.botUsername}?start=claim_${project.id}`;
    await ctx.reply(`*${project.name} — Invite Link*

` +
        `Share this with your team members:

` +
        `${inviteLink}

` +
        `Members tap the link — "Yes, I'm in" — they receive questions when rounds start.`, { parse_mode: 'Markdown' });
}
// ── Group Auto-Detection (project bot) ──────────────────────────────────────
/**
 * Handle when the project bot is added to a group.
 * Asks the admin whether to set this as the report destination.
 */
export async function handleProjectBotAddedToGroup(ctx, projectId, adminTelegramId, groupId, groupTitle) {
    // Store the detected group temporarily
    await redis.setex(`group_detect:${projectId}`, 3600, JSON.stringify({
        groupId,
        groupTitle,
        detectedAt: new Date().toISOString(),
    }));
    await ctx.api.sendMessage(adminTelegramId, `👋 *${groupTitle}* added me to a group!\n\n` +
        `Should I post round reports to *${groupTitle}*?\n\n` +
        `This is where your team's synthesis reports will appear after each round.`, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '✅ Yes, use this group', callback_data: `admin:confirm_group:${projectId}` },
                    { text: '❌ Not this one', callback_data: `admin:reject_group:${projectId}` },
                ],
            ],
        },
    });
}
export async function handleAdminGroupCallback(ctx, data, adminTelegramId) {
    const parts = data.split(':');
    const action = parts[1]; // confirm | reject
    const projectId = parts[2];
    const detectData = await redis.get(`group_detect:${projectId}`);
    if (!detectData) {
        await ctx.answerCallbackQuery('Session expired. Please try again.');
        return;
    }
    const { groupId, groupTitle } = JSON.parse(detectData);
    if (action === 'confirm') {
        // Save group ID to project
        await db
            .update(projects)
            .set({ groupIds: [groupId] })
            .where(eq(projects.id, projectId));
        await redis.del(`group_detect:${projectId}`);
        await ctx.answerCallbackQuery(`✅ Reports will go to ${groupTitle}`);
        await ctx.reply(`✅ *Group set!*\n\n` +
            `Round reports will now be posted to *${groupTitle}*.`, { parse_mode: 'Markdown' });
    }
    else {
        await redis.del(`group_detect:${projectId}`);
        await ctx.answerCallbackQuery('Group dismissed. Add me to the right group and share the invite link again.');
        await ctx.reply(`No problem. When I'm added to the correct group, I'll ask again.\n\n` +
            `You can also set the report group manually using /settings.`);
    }
}
