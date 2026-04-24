// Step definitions for the verbal initiation flow
export type InitiationStep =
  | 'greeting'
  | 'project_name'
  | 'project_goal'
  | 'team_size'
  | 'use_case'
  | 'cycle_frequency'
  | 'question_depth'
  | 'anonymity'
  | 'action_tracking'
  | 'group_setup'
  | 'confirm_config'
  | 'bot_creation'
  | 'complete';

export interface InitiationState {
  step: InitiationStep;
  config: Partial<ProjectConfigDraft>;
  telegramId: number;
  messageId?: number;
  createdAt: string;
}

export interface ProjectConfigDraft {
  name: string;
  description: string;
  projectType: string;
  teamSizeRange: string;
  cycleFrequency: string;
  questionDepth: 'shallow' | 'medium' | 'deep';
  anonymity: 'full' | 'optional' | 'attributed';
  actionTracking: boolean;
  telegramContexts: string[];
  forumTopicsEnabled: boolean;
  privacyMode: boolean;
  reportDestination: string;
}

export const STEP_ORDER: InitiationStep[] = [
  'greeting', 'project_name', 'project_goal', 'team_size',
  'use_case', 'cycle_frequency', 'question_depth',
  'anonymity', 'action_tracking', 'group_setup',
  'confirm_config', 'bot_creation', 'complete',
];

export function nextStep(current: InitiationStep): InitiationStep {
  const idx = STEP_ORDER.indexOf(current);
  return idx < STEP_ORDER.length - 1 ? STEP_ORDER[idx + 1] : 'complete';
}

export function prevStep(current: InitiationStep): InitiationStep {
  const idx = STEP_ORDER.indexOf(current);
  return idx > 0 ? STEP_ORDER[idx - 1] : current;
}
