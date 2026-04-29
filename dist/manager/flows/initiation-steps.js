import { nextStep } from './initiation-state';
import { redis } from '../../data/redis';
import { initiation } from '../../util/logger';
// ── Step Renderers ────────────────────────────────────────────────────────────
async function sendGreeting(ctx, state) {
    await ctx.reply('🌀 *Welcome to Zolara!*\n\n' +
        "I'll help you set up a dedicated assistant for your team or community.\n" +
        "It will gather perspectives privately, synthesize what people are saying, and help the group find alignment.\n\n" +
        "Setup takes about 5-10 minutes. At the end, you'll have a project bot ready to invite your team.\n\n" +
        "Ready? Let's start with the basics.", {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '🚀 Let\'s go!', callback_data: 'init:start' }],
                [{ text: '📋 Use a template', callback_data: 'init:template' }],
                [{ text: '❓ Tell me more', callback_data: 'init:info' }],
            ],
        },
    });
}
async function sendProjectName(ctx, state) {
    await ctx.reply("What's the *name* of your project or team?\n\n" +
        'For example: "JCI Vision 2030", "Hackathon Alpha", "Building 42 Community"', { parse_mode: 'Markdown' });
}
async function sendProjectGoal(ctx, state) {
    await ctx.reply("What's the *main goal or purpose* right now?\n\n" +
        "Don't overthink it — just the core of what you're trying to achieve together.", { parse_mode: 'Markdown' });
}
async function sendTeamSize(ctx, state) {
    await ctx.reply('How many active people are involved?\n\n' +
        'This helps me pace the process — a team of 4 works differently from a community of 50.', {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '2-5', callback_data: 'init:size:2-5' },
                    { text: '6-12', callback_data: 'init:size:6-12' },
                    { text: '13-30', callback_data: 'init:size:13-30' },
                    { text: '30+', callback_data: 'init:size:30+' },
                ],
            ],
        },
    });
}
async function sendUseCase(ctx, state) {
    await ctx.reply('What best describes this project?', {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '🏢 Team/Organization', callback_data: 'init:usecase:team' },
                    { text: '🎓 Academic Project', callback_data: 'init:usecase:academic' },
                ],
                [
                    { text: '🎨 Creative Community', callback_data: 'init:usecase:creative' },
                    { text: '🆘 Crisis/Volunteer', callback_data: 'init:usecase:crisis' },
                ],
                [
                    { text: '🔭 Vision Building', callback_data: 'init:usecase:vision' },
                    { text: '🎯 Something else', callback_data: 'init:usecase:other' },
                ],
            ],
        },
    });
}
async function sendCycleFrequency(ctx, state) {
    const type = state.config.projectType;
    let options;
    if (type === 'academic' || type === 'team') {
        options = ['Daily', 'Every few days', 'Weekly', 'Bi-weekly'];
    }
    else if (type === 'creative' || type === 'vision') {
        options = ['Weekly', 'Bi-weekly', 'Monthly', 'Only when triggered'];
    }
    else {
        options = ['Every shift', 'Daily', 'Only when triggered'];
    }
    const rows = chunkArray(options.map(o => ({ text: o, callback_data: `init:cycle:${o.toLowerCase().replace(/\s+/g, '_')}` })), 2);
    await ctx.reply('How often should I check in with everyone?\n\n' +
        'I will send each person a few questions, then synthesize a report for the group.', { reply_markup: { inline_keyboard: rows } });
}
async function sendQuestionDepth(ctx, state) {
    await ctx.reply('How *deep* should the conversations go?\n\n' +
        '💨 *Quick & light* — 1-2 questions, a few minutes\n' +
        '⚖️ *Balanced* — 3-4 questions, 5-8 minutes\n' +
        '🔬 *Deep & thorough* — 4-6 open-ended questions, 10-15 minutes', {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '💨 Quick', callback_data: 'init:depth:shallow' },
                    { text: '⚖️ Balanced', callback_data: 'init:depth:medium' },
                    { text: '🔬 Deep', callback_data: 'init:depth:deep' },
                ],
            ],
        },
    });
}
async function sendAnonymity(ctx, state) {
    await ctx.reply('When reports are generated, should perspectives be *anonymous*?\n\n' +
        'Anonymous input often leads to more honest responses, especially on sensitive topics. Some teams prefer attribution for context.', {
        reply_markup: {
            inline_keyboard: [
                [{ text: '🔒 Always anonymous', callback_data: 'init:anon:full' }],
                [{ text: '🔓 Anonymous by default', callback_data: 'init:anon:optional' }],
                [{ text: '👤 Always attributed', callback_data: 'init:anon:attributed' }],
            ],
        },
    });
}
async function sendActionTracking(ctx, state) {
    await ctx.reply('Should I *track action items* and follow up on commitments?\n\n' +
        'When I detect decisions or commitments in discussions, I can log them and gently remind people.', {
        reply_markup: {
            inline_keyboard: [
                [{ text: '✅ Yes, track actions', callback_data: 'init:actions:true' }],
                [{ text: '❌ No, just alignment', callback_data: 'init:actions:false' }],
            ],
        },
    });
}
async function sendGroupSetup(ctx, state) {
    const size = state.config.teamSizeRange ?? '';
    let forumNote = '';
    if (['6-12', '13-30', '30+'].includes(size)) {
        forumNote = '\n\nFor groups of 6+, I\'ll set up *Forum Topics*:\n📊 Reports · 💬 Discussion · ✅ Decisions';
    }
    await ctx.reply('Almost done! How should the bot connect to your team?\n\n' +
        '1️⃣ *1-on-1 chats* — I\'ll gather perspectives privately.\n' +
        '2️⃣ *Group chat* — I\'ll post reports and help the group discuss them.' +
        forumNote, {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '💬 Group only', callback_data: 'init:contexts:group' }],
                [{ text: '💬 Group + 📢 Stakeholder channel', callback_data: 'init:contexts:group,channel' }],
            ],
        },
    });
}
async function sendConfirmConfig(ctx, state) {
    const c = state.config;
    const depthLabel = { shallow: '💨 Quick & light', medium: '⚖️ Balanced', deep: '🔬 Deep & thorough' };
    const anonLabel = { full: '🔒 Always anonymous', optional: '🔓 Anonymous by default', attributed: '👤 Always attributed' };
    const cycleLabel = {
        daily: '📅 Daily', every_few_days: '📅 Every few days', weekly: '📅 Weekly',
        bi_weekly: '📅 Bi-weekly', monthly: '📅 Monthly', only_when_triggered: '📅 Only when triggered',
    };
    await ctx.reply('📋 *Project setup*\n\n' +
        '```\n' +
        `Name:        ${c.name || '—'}\n` +
        `Goal:        ${c.description || '—'}\n` +
        `Team size:   ${c.teamSizeRange || '—'}\n` +
        `Type:        ${c.projectType || '—'}\n` +
        `Cycle:       ${cycleLabel[c.cycleFrequency ?? ''] || c.cycleFrequency || '—'}\n` +
        `Depth:       ${depthLabel[c.questionDepth ?? 'medium'] || '—'}\n` +
        `Anonymity:   ${anonLabel[c.anonymity ?? 'optional'] || '—'}\n` +
        `Actions:     ${c.actionTracking ? 'Yes' : 'No'}\n` +
        `Channels:    ${(c.telegramContexts ?? ['group']).join(', ')}\n` +
        '```\n\n' +
        'Does this look right?', {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ text: '✅ Create my bot!', callback_data: 'init:confirm' }],
                [
                    { text: 'Name', callback_data: 'init:edit:name' },
                    { text: 'Goal', callback_data: 'init:edit:goal' },
                    { text: 'Size', callback_data: 'init:edit:size' },
                ],
                [
                    { text: 'Depth', callback_data: 'init:edit:depth' },
                    { text: 'Frequency', callback_data: 'init:edit:cycle' },
                    { text: 'Channels', callback_data: 'init:edit:contexts' },
                ],
                [{ text: '❌ Cancel', callback_data: 'init:cancel' }],
            ],
        },
    });
}
async function sendBotCreation(ctx, state) {
    await ctx.reply('⏳ Creating your project bot...');
    try {
        const { createPendingProject, buildProjectCreationLink } = await import('../managed-bots');
        const projectName = state.config.name ?? 'My Project';
        // Create pending project in DB
        const { projectId, pendingKey } = await createPendingProject({
            adminTelegramId: state.telegramId,
            name: projectName,
            description: state.config.description ?? '',
            projectType: state.config.projectType ?? 'team',
            teamSizeRange: state.config.teamSizeRange ?? '2-5',
            cycleFrequency: state.config.cycleFrequency ?? 'weekly',
            questionDepth: state.config.questionDepth ?? 'medium',
            anonymity: state.config.anonymity ?? 'optional',
            actionTracking: state.config.actionTracking ?? false,
            telegramContexts: state.config.telegramContexts ?? ['group'],
            forumTopicsEnabled: ['6-12', '13-30', '30+'].includes(state.config.teamSizeRange ?? ''),
            reportDestination: 'group',
        });
        // Generate bot username for the invite link
        const { suggestedUsername } = buildProjectCreationLink(projectName);
        // Store the pending key in Redis so we can look up the project when bot is created
        await redis.setex(`pending:${state.telegramId}`, 86400, JSON.stringify({
            projectId,
            pendingKey,
            suggestedUsername,
            name: projectName,
            createdAt: new Date().toISOString(),
        }));
        // Import escape utility to handle hyphens and other reserved chars in project name
        const { escapeMarkdownV2 } = await import('../../util/telegram-sender');
        const escapedName = escapeMarkdownV2(projectName);
        await ctx.reply(`🔗 *Project invite ready*\n\n` +
            `Share this link with your team when you are ready for them to join:\n\n` +
            `[Join ${escapedName} Bot](https://t.me/${suggestedUsername}?start=claim_${projectId})\n\n` +
            `Each member clicks the link, taps “Yes, I’m in,” and completes a short onboarding.\n\n` +
            `After that, I can DM them questions when rounds start.\n\n` +
            `_Share this in your group chat so everyone has the same entry point._`, { parse_mode: 'Markdown' });
    }
    catch (err) {
        initiation.botCreationFailed({ telegramId: state.telegramId, step: state.step }, err);
        await ctx.reply('⚠️ I could not create the project bot right now. Please try /create again in a few minutes.');
    }
}
// ── Dispatcher ────────────────────────────────────────────────────────────────
export async function handleInitiationStep(ctx, state) {
    switch (state.step) {
        case 'greeting':
            await sendGreeting(ctx, state);
            break;
        case 'project_name':
            await sendProjectName(ctx, state);
            break;
        case 'project_goal':
            await sendProjectGoal(ctx, state);
            break;
        case 'team_size':
            await sendTeamSize(ctx, state);
            break;
        case 'use_case':
            await sendUseCase(ctx, state);
            break;
        case 'cycle_frequency':
            await sendCycleFrequency(ctx, state);
            break;
        case 'question_depth':
            await sendQuestionDepth(ctx, state);
            break;
        case 'anonymity':
            await sendAnonymity(ctx, state);
            break;
        case 'action_tracking':
            await sendActionTracking(ctx, state);
            break;
        case 'group_setup':
            await sendGroupSetup(ctx, state);
            break;
        case 'confirm_config':
            await sendConfirmConfig(ctx, state);
            break;
        case 'bot_creation':
            await sendBotCreation(ctx, state);
            break;
    }
}
// ── Helpers ──────────────────────────────────────────────────────────────────
function chunkArray(arr, size) {
    const result = [];
    for (let i = 0; i < arr.length; i += size) {
        result.push(arr.slice(i, i + size));
    }
    return result;
}
export async function handleCallback(ctx, state, data) {
    const parts = data.split(':');
    const action = parts[1];
    const payload = parts.slice(2).join(':');
    const newState = { ...state };
    switch (action) {
        case 'start':
            newState.step = nextStep(state.step);
            break;
        case 'info':
            await ctx.answerCallbackQuery();
            await ctx.editMessageText('🌀 *Zolara* helps teams turn scattered perspectives into clear group alignment.\n\n' +
                '• Members answer short questions privately\n' +
                '• Zolara writes a synthesis report for the group\n' +
                '• Follow-up rounds help clarify tensions and decisions\n\n' +
                'Ready to set up your project?', {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [[{ text: '🚀 Let\'s go!', callback_data: 'init:start' }]],
                },
            });
            return null;
        case 'template':
            await ctx.answerCallbackQuery();
            return null;
        case 'size':
            newState.config = { ...newState.config, teamSizeRange: payload };
            newState.step = nextStep(state.step);
            break;
        case 'usecase':
            newState.config = { ...newState.config, projectType: payload };
            newState.step = nextStep(state.step);
            break;
        case 'cycle':
            newState.config = { ...newState.config, cycleFrequency: payload };
            newState.step = nextStep(state.step);
            break;
        case 'depth':
            newState.config = { ...newState.config, questionDepth: payload };
            newState.step = nextStep(state.step);
            break;
        case 'anon':
            newState.config = { ...newState.config, anonymity: payload };
            newState.step = nextStep(state.step);
            break;
        case 'actions':
            newState.config = { ...newState.config, actionTracking: payload === 'true' };
            newState.step = nextStep(state.step);
            break;
        case 'contexts':
            newState.config = { ...newState.config, telegramContexts: payload.split(',') };
            newState.step = nextStep(state.step);
            break;
        case 'confirm':
            newState.step = 'bot_creation';
            break;
        case 'edit': {
            const stepMap = {
                name: 'project_name', goal: 'project_goal', size: 'team_size',
                depth: 'question_depth', cycle: 'cycle_frequency', contexts: 'group_setup',
            };
            const target = stepMap[payload];
            if (target) {
                newState.step = target;
            }
            break;
        }
        case 'cancel':
            await ctx.answerCallbackQuery();
            await ctx.editMessageText('❌ Project creation cancelled. Use /create to start again anytime.');
            return null;
        default:
            await ctx.answerCallbackQuery();
    }
    return newState;
}
