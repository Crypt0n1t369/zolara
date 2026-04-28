// Step definitions for the member onboarding flow.
// Split into two phases:
//   Phase 1 — Commitment (claim): takes 10 seconds, required before bot can DM
//   Phase 2 — Full onboarding: happens before first round starts

export type OnboardingPhase = 'claim' | 'onboarding';

// Phase 1: Commitment (required — gate before bot can DM)
export type ClaimStep = 'claim_welcome';

export const CLAIM_STEPS: ClaimStep[] = ['claim_welcome'];

// Phase 2: Full onboarding (runs before first round, optional for experienced members)
export type OnboardingStep =
  | 'welcome'
  | 'role'
  | 'interests'
  | 'availability'
  | 'communication_style'
  | 'review'
  | 'complete';

export const ONBOARDING_STEP_ORDER: OnboardingStep[] = [
  'welcome', 'role', 'interests', 'availability', 'communication_style', 'review', 'complete',
];

const ONBOARDING_STEP_LABELS: Record<OnboardingStep, string> = {
  welcome: 'Welcome',
  role: 'Role / connection',
  interests: 'Interests / knowledge',
  availability: 'Weekly availability',
  communication_style: 'Communication style',
  review: 'Review your answers',
  complete: 'Complete',
};

export function onboardingStepLabel(step: OnboardingStep): string {
  return ONBOARDING_STEP_LABELS[step];
}

export function currentlyAnsweringLabel(step: OnboardingStep): string {
  return `Currently answering: ${onboardingStepLabel(step)}`;
}

export interface ClaimState {
  phase: 'claim';
  projectId: string;
  projectName: string;
  telegramId: number;
  claimStartedAt: string;
  anonymity: 'full' | 'optional' | 'attributed';
}

export interface OnboardingState {
  phase: 'onboarding';
  projectId: string;
  telegramId: number;
  step: OnboardingStep;
  role?: string;
  interests?: string;
  availability?: string;
  communicationStyle?: string;
  createdAt: string;
}

export type MemberState = ClaimState | OnboardingState;

export function nextOnboardingStep(current: OnboardingStep): OnboardingStep {
  const idx = ONBOARDING_STEP_ORDER.indexOf(current);
  return idx < ONBOARDING_STEP_ORDER.length - 1 ? ONBOARDING_STEP_ORDER[idx + 1] : 'complete';
}

export function prevOnboardingStep(current: OnboardingStep): OnboardingStep {
  const idx = ONBOARDING_STEP_ORDER.indexOf(current);
  return idx > 0 ? ONBOARDING_STEP_ORDER[idx - 1] : current;
}
