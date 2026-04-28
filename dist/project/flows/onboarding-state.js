// Step definitions for the member onboarding flow.
// Split into two phases:
//   Phase 1 — Commitment (claim): takes 10 seconds, required before bot can DM
//   Phase 2 — Full onboarding: happens before first round starts
export const CLAIM_STEPS = ['claim_welcome'];
export const ONBOARDING_STEP_ORDER = [
    'welcome', 'role', 'interests', 'availability', 'communication_style', 'review', 'complete',
];
const ONBOARDING_STEP_LABELS = {
    welcome: 'Welcome',
    role: 'Role / connection',
    interests: 'Interests / knowledge',
    availability: 'Weekly availability',
    communication_style: 'Communication style',
    review: 'Review your answers',
    complete: 'Complete',
};
export function onboardingStepLabel(step) {
    return ONBOARDING_STEP_LABELS[step];
}
export function currentlyAnsweringLabel(step) {
    return `Currently answering: ${onboardingStepLabel(step)}`;
}
export function nextOnboardingStep(current) {
    const idx = ONBOARDING_STEP_ORDER.indexOf(current);
    return idx < ONBOARDING_STEP_ORDER.length - 1 ? ONBOARDING_STEP_ORDER[idx + 1] : 'complete';
}
export function prevOnboardingStep(current) {
    const idx = ONBOARDING_STEP_ORDER.indexOf(current);
    return idx > 0 ? ONBOARDING_STEP_ORDER[idx - 1] : current;
}
