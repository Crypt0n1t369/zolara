export const STEP_ORDER = [
    'greeting', 'project_name', 'project_goal', 'team_size',
    'use_case', 'cycle_frequency', 'question_depth',
    'anonymity', 'action_tracking', 'group_setup',
    'confirm_config', 'bot_creation', 'complete',
];
export function nextStep(current) {
    const idx = STEP_ORDER.indexOf(current);
    return idx < STEP_ORDER.length - 1 ? STEP_ORDER[idx + 1] : 'complete';
}
export function prevStep(current) {
    const idx = STEP_ORDER.indexOf(current);
    return idx > 0 ? STEP_ORDER[idx - 1] : current;
}
