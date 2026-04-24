import type { InitiationState, ProjectConfigDraft, InitiationStep } from './initiation-state';
import type { Context } from 'grammy';
import { nextStep, prevStep, STEP_ORDER } from './initiation-state';
import { redis } from '../../data/redis';
import { initiation } from '../../util/logger';

// ── Step Renderers ────────────────────────────────────────────────────────────

async function sendGreeting(ctx: Context, state: InitiationState): Promise<void> {
  await ctx.reply(
    '🌀 *Welcome to Zolara!*\n\n' +
    "I'll help you set up a dedicated AI assistant for your team or community.\n" +
    "It'll learn from everyone's perspectives and help you find alignment.\n\n" +
    "This setup takes about 5 minutes. I'll ask you some questions about your project.\n\n" +
    "Ready? Let's start!",
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🚀 Let\'s go!', callback_data: 'init:start' }],
          [{ text: '❓ Tell me more', callback_data: 'init:info' }],
        ],
      },
    }
  );
}

async function sendProjectName(ctx: Context, state: InitiationState): Promise<void> {
  await ctx.reply(
    "What's the *name* of your project or team?\n\n" +
    'For example: "JCI Vision 2030", "Hackathon Alpha", "Building 42 Community"',
    { parse_mode: 'Markdown' }
  );
}

async function sendProjectGoal(ctx: Context, state: InitiationState): Promise<void> {
  await ctx.reply(
    "What's the *main goal or purpose* right now?\n\n" +
    "Don't overthink it — just the core of what you're trying to achieve together.",
    { parse_mode: 'Markdown' }
  );
}

async function sendTeamSize(ctx: Context, state: InitiationState): Promise<void> {
  await ctx.reply(
    'How many active people are involved?\n\n' +
    'This helps me calibrate the process.',
    {
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
    }
  );
}

async function sendUseCase(ctx: Context, state: InitiationState): Promise<void> {
  await ctx.reply(
    'What best describes your context?',
    {
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
    }
  );
}

async function sendCycleFrequency(ctx: Context, state: InitiationState): Promise<void> {
  const type = state.config.projectType;
  let options: string[];
  if (type === 'academic' || type === 'team') {
    options = ['Daily', 'Every few days', 'Weekly', 'Bi-weekly'];
  } else if (type === 'creative' || type === 'vision') {
    options = ['Weekly', 'Bi-weekly', 'Monthly', 'Only when triggered'];
  } else {
    options = ['Every shift', 'Daily', 'Only when triggered'];
  }

  const rows = chunkArray(options.map(o => ({ text: o, callback_data: `init:cycle:${o.toLowerCase().replace(/\s+/g, '_')}` })), 2);

  await ctx.reply(
    'How often should I check in with everyone to gather perspectives?',
    { reply_markup: { inline_keyboard: rows } }
  );
}

async function sendQuestionDepth(ctx: Context, state: InitiationState): Promise<void> {
  await ctx.reply(
    'How *deep* should the conversations go?\n\n' +
    '💨 *Quick & light* — 1-2 questions, a few minutes\n' +
    '⚖️ *Balanced* — 3-4 questions, 5-8 minutes\n' +
    '🔬 *Deep & thorough* — 4-6 open-ended questions, 10-15 minutes',
    {
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
    }
  );
}

async function sendAnonymity(ctx: Context, state: InitiationState): Promise<void> {
  await ctx.reply(
    'When reports are generated, should perspectives be *anonymous*?\n\n' +
    'Anonymous input often leads to more honest responses, especially on sensitive topics.',
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔒 Always anonymous', callback_data: 'init:anon:full' }],
          [{ text: '🔓 Anonymous by default', callback_data: 'init:anon:optional' }],
          [{ text: '👤 Always attributed', callback_data: 'init:anon:attributed' }],
        ],
      },
    }
  );
}

async function sendActionTracking(ctx: Context, state: InitiationState): Promise<void> {
  await ctx.reply(
    'Should I *track action items* and follow up on commitments?\n\n' +
    'When I detect decisions or commitments in discussions, I can log them and gently remind people.',
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Yes, track actions', callback_data: 'init:actions:true' }],
          [{ text: '❌ No, just alignment', callback_data: 'init:actions:false' }],
        ],
      },
    }
  );
}

async function sendGroupSetup(ctx: Context, state: InitiationState): Promise<void> {
  const size = state.config.teamSizeRange ?? '';
  let forumNote = '';
  if (['6-12', '13-30', '30+'].includes(size)) {
    forumNote = '\n\nFor groups of 6+, I will set up Forum Topics: Reports, Discussion, Decisions';
  }

  await ctx.reply(
    'Almost done! Where should the bot post synthesis reports?\n\n' +
    'Choose how your team will receive reports and discussions.' +
    forumNote,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '💬 Group chat only', callback_data: 'init:contexts:group' }],
          [{ text: '💬 Group + 📢 Stakeholder channel', callback_data: 'init:contexts:group,channel' }],
        ],
      },
    }
  );
}

async function sendConfirmConfig(ctx: Context, state: InitiationState): Promise<void> {
  const c = state.config;
  const depthLabel: Record<string, string> = { shallow: '💨 Quick & light', medium: '⚖️ Balanced', deep: '🔬 Deep & thorough' };
  const anonLabel: Record<string, string> = { full: '🔒 Always anonymous', optional: '🔓 Anonymous by default', attributed: '👤 Always attributed' };
  const cycleLabel: Record<string, string> = {
    daily: '📅 Daily', every_few_days: '📅 Every few days', weekly: '📅 Weekly',
    bi_weekly: '📅 Bi-weekly', monthly: '📅 Monthly', only_when_triggered: '📅 Only when triggered',
  };
  const channels = (c.telegramContexts ?? ['group']).map(ch =>
    ch === 'group' ? '💬 Group' : ch === 'dm' ? '1-on-1 DMs' : '📢 Channel'
  ).join(' + ');

  const lines = [
    '📋 Your Project Configuration\n',
    `Name: ${c.name || '—'}`,
    `Goal: ${c.description ? c.description.slice(0, 60) + (c.description.length > 60 ? '...' : '') : '—'}`,
    `Team size: ${c.teamSizeRange || '—'}`,
    `Type: ${c.projectType || '—'}`,
    `Cycle: ${cycleLabel[c.cycleFrequency ?? ''] || c.cycleFrequency || '—'}`,
    `Depth: ${depthLabel[c.questionDepth ?? 'medium'] || '—'}`,
    `Anonymity: ${anonLabel[c.anonymity ?? 'optional'] || '—'}`,
    `Actions: ${c.actionTracking ? '✅ Track' : '❌ Off'}`,
    `Channels: ${channels}`,
  ].join('\n');

  await ctx.reply(lines + '\n\nDoes everything look right?', {
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ Create project!', callback_data: 'init:confirm' }],
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

async function sendBotCreation(ctx: Context, state: InitiationState): Promise<void> {
  await ctx.reply('⏳ Creating your project bot...');

  const { createPendingProject, buildProjectCreationLink } = await import('../../manager/managed-bots/creation');
  const projectName = state.config.name ?? 'My Project';

  try {
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

    const { creationLink, suggestedUsername } = buildProjectCreationLink(projectName);

    await redis.setex(`pending:${state.telegramId}`, 86400, JSON.stringify({
      projectId,
      pendingKey,
      suggestedUsername,
      name: projectName,
      createdAt: new Date().toISOString(),
    }));

    const { escapeMarkdownV2 } = await import('../../util/telegram-sender');
    const escapedName = escapeMarkdownV2(projectName);

    await ctx.reply(
      `🔗 *Your project bot is almost ready!*\n\n` +
      `Tap the link below to create your project's bot in Telegram:\n\n` +
      `[Create ${escapedName} Bot](${creationLink})\n\n` +
      `This opens BotFather — just tap "Yes" to approve.\n` +
      `I'll automatically finish setup once it's created.`,
      { parse_mode: 'Markdown' }
    );

  } catch (err) {
    initiation.botCreationFailed({ telegramId: state.telegramId, step: state.step }, err);
    await ctx.reply(
      '⚠️ Something went wrong. Please try again.\n' +
      'You can start over with /create'
    );
  }
}



// ── Dispatcher ────────────────────────────────────────────────────────────────

export async function handleInitiationStep(
  ctx: Context,
  state: InitiationState
): Promise<void> {
  switch (state.step) {
    case 'greeting':        await sendGreeting(ctx, state); break;
    case 'project_name':    await sendProjectName(ctx, state); break;
    case 'project_goal':   await sendProjectGoal(ctx, state); break;
    case 'team_size':       await sendTeamSize(ctx, state); break;
    case 'use_case':        await sendUseCase(ctx, state); break;
    case 'cycle_frequency': await sendCycleFrequency(ctx, state); break;
    case 'question_depth':  await sendQuestionDepth(ctx, state); break;
    case 'anonymity':       await sendAnonymity(ctx, state); break;
    case 'action_tracking': await sendActionTracking(ctx, state); break;
    case 'group_setup':     await sendGroupSetup(ctx, state); break;
    case 'confirm_config':  await sendConfirmConfig(ctx, state); break;
    case 'bot_creation':    await sendBotCreation(ctx, state); break;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function chunkArray<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}

export async function handleCallback(
  ctx: Context,
  state: InitiationState,
  data: string
): Promise<InitiationState | null> {
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
      await ctx.editMessageText(
        '🌀 *Zolara* helps teams find alignment through structured 1-on-1 conversations and AI synthesis.\n\n' +
        '• Each team member answers questions privately\n' +
        '• An AI synthesizes perspectives into a group report\n' +
        '• The process deepens alignment over time\n\n' +
        'Ready to set up your project?',
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[{ text: '🚀 Let\'s go!', callback_data: 'init:start' }]],
          },
        }
      );
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
      newState.config = { ...newState.config, questionDepth: payload as 'shallow' | 'medium' | 'deep' };
      newState.step = nextStep(state.step);
      break;

    case 'anon':
      newState.config = { ...newState.config, anonymity: payload as 'full' | 'optional' | 'attributed' };
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
      const stepMap: Record<string, InitiationStep> = {
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
