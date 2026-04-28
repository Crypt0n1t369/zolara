/**
 * Onboarding step renderers — Steps O1 through O6
 * Triggered when a user clicks /start join_{projectId} on the project bot.
 */
import { currentlyAnsweringLabel, nextOnboardingStep, prevOnboardingStep } from './onboarding-state';
import { redis } from '../../data/redis';
import { db } from '../../data/db';
import { members, users } from '../../data/schema/projects';
import { eq, and } from 'drizzle-orm';
// ── Helpers ──────────────────────────────────────────────────────────────────
function controlRow(step) {
    const row = [];
    if (step !== 'role')
        row.push({ text: '← Back', callback_data: 'onboard:back' });
    row.push({ text: 'Skip for now', callback_data: `onboard:skip:${step}` });
    return row;
}
function availabilityLabel(value) {
    return {
        '<_1_hr': '< 1 hour',
        '1-3_hrs': '1–3 hours',
        '3-5_hrs': '3–5 hours',
        '5+_hrs': '5+ hours',
        not_sure: 'Not sure yet',
    }[value ?? ''] ?? 'Not answered';
}
function styleLabel(value) {
    return {
        quick: 'Quick & punchy',
        detailed: 'Thoughtful & detailed',
        surprise: 'Surprise me',
        balanced: 'Balanced',
    }[value ?? ''] ?? 'Not answered';
}
function promptPrefix(step) {
    return `${currentlyAnsweringLabel(step)}\n\n`;
}
// ── Step Renderers ────────────────────────────────────────────────────────────
async function sendWelcome(ctx, state) {
    const { projects } = await import('../../data/schema/projects');
    const { eq } = await import('drizzle-orm');
    const [project] = await db
        .select({ name: projects.name, description: projects.description })
        .from(projects)
        .where(eq(projects.id, state.projectId))
        .limit(1);
    const projectName = project?.name ?? 'the project';
    await ctx.reply(promptPrefix('welcome') +
        `👋 Welcome to ${projectName}!\n\n` +
        "I'm your team's AI assistant. I'll periodically check in with you " +
        "privately to understand your perspective, then share synthesized insights with the whole group.\n\n" +
        "Let me learn a bit about you so I can work with you effectively.");
    state.step = nextOnboardingStep(state.step);
    await saveOnboardingState(state);
    await sendRole(ctx, state);
}
async function sendRole(ctx, state) {
    await ctx.reply(promptPrefix('role') +
        "What's your *role* or connection to this project?\n\n" +
        'For example: "Team lead", "Designer", "Stakeholder", "New member"\n\n' +
        'Reply with a short phrase. If another Zolara message arrives meanwhile, your next typed reply will still be saved here.', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [controlRow('role')] },
    });
}
async function sendInterests(ctx, state) {
    const { projects } = await import('../../data/schema/projects');
    const [project] = await db
        .select({ description: projects.description })
        .from(projects)
        .where(eq(projects.id, state.projectId))
        .limit(1);
    const goalText = project?.description
        ? `\n\nThe project goal is: "${project.description.slice(0, 200)}"`
        : '';
    await ctx.reply(promptPrefix('interests') +
        `What aspects of this project are you most interested in or knowledgeable about?${goalText}\n\n` +
        'Reply in your own words, or skip if you are not sure yet.', { reply_markup: { inline_keyboard: [controlRow('interests')] } });
}
async function sendAvailability(ctx, state) {
    await ctx.reply(promptPrefix('availability') +
        'Roughly how much *time* per week can you dedicate to this?\n\n' +
        'This helps Zolara pace check-ins and avoid overloading you. An estimate is fine.', {
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
                [
                    { text: 'Not sure yet', callback_data: 'onboard:availability:not_sure' },
                ],
                controlRow('availability'),
            ],
        },
    });
}
async function sendCommunicationStyle(ctx, state) {
    await ctx.reply(promptPrefix('communication_style') +
        'Last question — how do you prefer to *interact* with me?', {
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
                controlRow('communication_style'),
            ],
        },
    });
}
async function sendReview(ctx, state) {
    await ctx.reply(promptPrefix('review') +
        'Before I finish onboarding, here is what I saved:\n\n' +
        `Role: ${state.role || 'Participant'}\n` +
        `Interests / knowledge: ${state.interests || 'Not specified'}\n` +
        `Availability: ${availabilityLabel(state.availability)}\n` +
        `Style: ${styleLabel(state.communicationStyle)}\n\n` +
        'Does this look right?', {
        reply_markup: {
            inline_keyboard: [
                [{ text: '✅ Looks right', callback_data: 'onboard:confirm' }],
                [
                    { text: 'Edit role', callback_data: 'onboard:edit:role' },
                    { text: 'Edit interests', callback_data: 'onboard:edit:interests' },
                ],
                [
                    { text: 'Edit availability', callback_data: 'onboard:edit:availability' },
                    { text: 'Edit style', callback_data: 'onboard:edit:communication_style' },
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
        case 'review':
            await sendReview(ctx, state);
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
        case 'back':
            newState.step = prevOnboardingStep(state.step);
            await saveOnboardingState(newState);
            await ctx.answerCallbackQuery('Going back');
            await handleOnboardingStep(ctx, newState);
            return newState;
        case 'skip': {
            const stepToSkip = (payload || state.step);
            if (stepToSkip === 'role')
                newState.role = newState.role ?? 'participant';
            if (stepToSkip === 'interests')
                newState.interests = newState.interests ?? '';
            if (stepToSkip === 'availability')
                newState.availability = newState.availability ?? 'not_sure';
            if (stepToSkip === 'communication_style')
                newState.communicationStyle = newState.communicationStyle ?? 'balanced';
            newState.step = nextOnboardingStep(stepToSkip);
            await saveOnboardingState(newState);
            await ctx.answerCallbackQuery('Skipped for now');
            await handleOnboardingStep(ctx, newState);
            return newState;
        }
        case 'edit':
            if (['role', 'interests', 'availability', 'communication_style'].includes(payload)) {
                newState.step = payload;
                await saveOnboardingState(newState);
                await ctx.answerCallbackQuery('Editing');
                await handleOnboardingStep(ctx, newState);
                return newState;
            }
            await ctx.answerCallbackQuery('Unknown field');
            return null;
        case 'confirm':
            newState.step = 'complete';
            await ctx.answerCallbackQuery('Saved');
            await finalizeOnboarding(newState);
            await clearOnboardingState(state.telegramId);
            await handleOnboardingStep(ctx, newState);
            return newState;
        case 'availability':
            newState.availability = payload;
            newState.step = nextOnboardingStep(state.step);
            await saveOnboardingState(newState);
            await handleOnboardingStep(ctx, newState);
            await ctx.answerCallbackQuery('Got it, thanks!');
            return newState;
        case 'style':
            newState.communicationStyle = payload;
            newState.step = 'review';
            await saveOnboardingState(newState);
            await ctx.answerCallbackQuery('Perfect!');
            await handleOnboardingStep(ctx, newState);
            return newState;
        default:
            await ctx.answerCallbackQuery('Processing...');
    }
    return null;
}
// ── Text Input Handler ─────────────────────────────────────────────────────────
export async function handleOnboardingText(ctx, state, text) {
    const newState = { ...state };
    const trimmed = text.trim();
    if (trimmed.toLowerCase() === '/skip') {
        newState.step = nextOnboardingStep(state.step);
        await saveOnboardingState(newState);
        await ctx.reply('Skipped for now.');
        await handleOnboardingStep(ctx, newState);
        return newState;
    }
    switch (state.step) {
        case 'role':
            newState.role = trimmed.slice(0, 200);
            newState.step = nextOnboardingStep(state.step);
            await saveOnboardingState(newState);
            await ctx.reply('Got it — I saved your role.');
            await handleOnboardingStep(ctx, newState);
            break;
        case 'interests':
            newState.interests = trimmed.slice(0, 500);
            newState.step = nextOnboardingStep(state.step);
            await saveOnboardingState(newState);
            await ctx.reply('Got it — I saved that and will use it to make your questions more relevant.');
            await handleOnboardingStep(ctx, newState);
            break;
        default:
            await ctx.reply('Please use one of the buttons above, or tap Back/Skip if you want to change course.');
            break;
    }
    return newState;
}
// ── Finalize Onboarding ────────────────────────────────────────────────────────
export async function finalizeOnboarding(state) {
    const telegramId = state.telegramId;
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
    const projectId = state.projectId;
    const [member] = await db
        .select()
        .from(members)
        .where(and(eq(members.projectId, projectId), eq(members.userId, userId)))
        .limit(1);
    const projectProfile = {
        interests: state.interests ?? '',
        communication_style: state.communicationStyle ?? 'balanced',
        availability: state.availability ?? 'not_sure',
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
export async function restartOnboardingState(telegramId, projectId) {
    const [member] = await db
        .select({ id: members.id })
        .from(members)
        .innerJoin(users, eq(members.userId, users.id))
        .where(and(eq(users.telegramId, telegramId), eq(members.projectId, projectId)))
        .limit(1);
    if (!member)
        return null;
    const state = {
        phase: 'onboarding',
        projectId,
        telegramId,
        step: 'welcome',
        createdAt: new Date().toISOString(),
    };
    await clearOnboardingState(telegramId);
    await saveOnboardingState(state);
    return state;
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
