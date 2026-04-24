/**
 * Onboarding step renderers — Steps O1 through O6
 * Triggered when a user clicks /start join_{projectId} on the project bot.
 */
import { nextOnboardingStep } from './onboarding-state';
import { redis } from '../../data/redis';
import { db } from '../../data/db';
import { members, users } from '../../data/schema/projects';
import { eq } from 'drizzle-orm';
// ── Step Renderers ────────────────────────────────────────────────────────────
async function sendWelcome(ctx, state) {
    // Look up project name from DB
    const { projects } = await import('../../data/schema/projects');
    const { eq } = await import('drizzle-orm');
    const [project] = await db
        .select({ name: projects.name, description: projects.description })
        .from(projects)
        .where(eq(projects.id, state.projectId))
        .limit(1);
    const projectName = project?.name ?? 'the project';
    const projectGoal = project?.description ?? '';
    await ctx.reply(`👋 Welcome to *${projectName}*!\n\n` +
        "I'm your team's AI assistant. I'll periodically check in with you " +
        "privately to understand your perspective, then share synthesized insights with the whole group.\n\n" +
        "Let me learn a bit about you so I can work with you effectively.", { parse_mode: 'Markdown' });
    // Move to next step after a short delay
    state.step = nextOnboardingStep(state.step);
    await saveOnboardingState(state);
    await sendRole(ctx, state);
}
async function sendRole(ctx, state) {
    await ctx.reply("What's your *role* or connection to this project?\n\n" +
        'For example: "Team lead", "Designer", "Stakeholder", "New member"', { parse_mode: 'Markdown' });
}
async function sendInterests(ctx, state) {
    // Look up project goal for contextual question
    const { projects } = await import('../../data/schema/projects');
    const [project] = await db
        .select({ description: projects.description })
        .from(projects)
        .where(eq(projects.id, state.projectId))
        .limit(1);
    const goalText = project?.description
        ? `\n\nThe project goal is: "${project.description.slice(0, 200)}"`
        : '';
    await ctx.reply(`What aspects of this project are you most *interested* in or knowledgeable about?${goalText}`, { parse_mode: 'Markdown' });
}
async function sendAvailability(ctx, state) {
    await ctx.reply('How much *time* per week can you dedicate to this?', {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '< 1 hour', callback_data: 'onboard:availability:<_1_hr' },
                    { text: '1-3 hours', callback_data: 'onboard:availability:1-3_hrs' },
                ],
                [
                    { text: '3-5 hours', callback_data: 'onboard:availability:3-5_hrs' },
                    { text: '5+ hours', callback_data: 'onboard:availability:5+_hrs' },
                ],
            ],
        },
    });
}
async function sendCommunicationStyle(ctx, state) {
    await ctx.reply('Last question — how do you prefer to *interact* with me?', {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '💨 Quick & punchy', callback_data: 'onboard:style:quick' },
                    { text: '📝 Thoughtful & detailed', callback_data: 'onboard:style:detailed' },
                ],
                [
                    { text: '🎲 Surprise me', callback_data: 'onboard:style:surprise' },
                ],
            ],
        },
    });
}
async function sendComplete(ctx, state) {
    await ctx.reply("🎉 *You're all set!*\n\n" +
        "I'll reach out when it's time for the next check-in. In the meantime, " +
        "feel free to message me anytime with questions or thoughts about the project.\n\n" +
        'Commands:\n' +
        '/status — See current project status\n' +
        '/perspective — Review your past contributions\n' +
        '/help — See all available commands', { parse_mode: 'Markdown' });
}
// ── Dispatcher ────────────────────────────────────────────────────────────────
export async function handleOnboardingStep(ctx, state) {
    switch (state.step) {
        case 'welcome':
            await sendWelcome(ctx, state);
            break;
        case 'role':
            await sendRole(ctx, state);
            break;
        case 'interests':
            await sendInterests(ctx, state);
            break;
        case 'availability':
            await sendAvailability(ctx, state);
            break;
        case 'communication_style':
            await sendCommunicationStyle(ctx, state);
            break;
        case 'complete':
            await sendComplete(ctx, state);
            break;
    }
}
// ── Callback Handler ───────────────────────────────────────────────────────────
export async function handleOnboardingCallback(ctx, state, data) {
    const parts = data.split(':');
    const action = parts[1];
    const payload = parts.slice(2).join(':');
    const newState = { ...state };
    switch (action) {
        case 'availability':
            newState.availability = payload;
            newState.step = nextOnboardingStep(state.step);
            await saveOnboardingState(newState);
            await handleOnboardingStep(ctx, newState);
            break;
        case 'style':
            newState.communicationStyle = payload;
            newState.step = nextOnboardingStep(state.step);
            await clearOnboardingState(state.telegramId);
            await handleOnboardingStep(ctx, newState);
            break;
        default:
            await ctx.answerCallbackQuery();
    }
    return null;
}
// ── Text Input Handler ─────────────────────────────────────────────────────────
export async function handleOnboardingText(ctx, state, text) {
    const newState = { ...state };
    switch (state.step) {
        case 'role':
            newState.role = text.trim().slice(0, 200);
            newState.step = nextOnboardingStep(state.step);
            await saveOnboardingState(newState);
            await handleOnboardingStep(ctx, newState);
            break;
        case 'interests':
            newState.interests = text.trim().slice(0, 500);
            newState.step = nextOnboardingStep(state.step);
            await saveOnboardingState(newState);
            await handleOnboardingStep(ctx, newState);
            break;
        default:
            // Fall through to free chat or ignore
            break;
    }
    return newState;
}
// ── Finalize Onboarding ────────────────────────────────────────────────────────
export async function finalizeOnboarding(state) {
    const telegramId = state.telegramId;
    // Upsert user
    const [user] = await db
        .select()
        .from(users)
        .where(eq(users.telegramId, telegramId))
        .limit(1);
    let userId;
    if (!user) {
        const [newUser] = await db
            .insert(users)
            .values({ telegramId })
            .returning();
        userId = newUser.id;
    }
    else {
        userId = user.id;
    }
    // Upsert member record
    const projectId = state.projectId;
    const [member] = await db
        .select()
        .from(members)
        .where(eq(members.projectId, projectId))
        .limit(1);
    const projectProfile = {
        interests: state.interests ?? '',
        communication_style: state.communicationStyle ?? 'balanced',
    };
    if (!member) {
        await db.insert(members).values({
            projectId: projectId,
            userId,
            role: state.role ?? 'participant',
            projectProfile,
            onboardingStatus: 'complete',
        });
    }
    else {
        await db
            .update(members)
            .set({
            role: state.role ?? member.role,
            projectProfile,
            onboardingStatus: 'complete',
        })
            .where(eq(members.id, member.id));
    }
}
// ── State Persistence ─────────────────────────────────────────────────────────
const ONBOARDING_TTL = 86400; // 24 hours
export async function loadOnboardingState(telegramId) {
    const raw = await redis.get(`onboard:${telegramId}`);
    return raw ? JSON.parse(raw) : null;
}
export async function saveOnboardingState(state) {
    await redis.setex(`onboard:${state.telegramId}`, ONBOARDING_TTL, JSON.stringify(state));
}
export async function clearOnboardingState(telegramId) {
    await redis.del(`onboard:${telegramId}`);
}
