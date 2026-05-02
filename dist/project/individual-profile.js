const SIGNAL_KEYWORDS = [
    { signal: { label: 'clarity', type: 'value' }, words: ['clear', 'clarity', 'confusing', 'confusion', 'ambiguous', 'specific'] },
    { signal: { label: 'speed', type: 'value' }, words: ['speed', 'fast', 'quick', 'slow', 'delay', 'momentum'] },
    { signal: { label: 'trust', type: 'value' }, words: ['trust', 'safe', 'safety', 'honest', 'transparent'] },
    { signal: { label: 'risk', type: 'contribution_style' }, words: ['risk', 'concern', 'worried', 'failure', 'break', 'blocker'] },
    { signal: { label: 'alignment', type: 'value' }, words: ['align', 'alignment', 'agree', 'shared', 'consensus'] },
    { signal: { label: 'autonomy', type: 'value' }, words: ['autonomy', 'ownership', 'independent', 'freedom', 'agency'] },
    { signal: { label: 'practical next steps', type: 'contribution_style' }, words: ['next step', 'action', 'practical', 'execute', 'implementation', 'plan'] },
];
function valueOrDash(value) {
    if (value === null || value === undefined || value === '')
        return '—';
    return String(value);
}
function titleCaseUnderscore(value) {
    return valueOrDash(value)
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (char) => char.toUpperCase());
}
function getConfirmedSignals(profile) {
    const discovery = profile?.individualDiscovery;
    if (!discovery || typeof discovery !== 'object')
        return [];
    const signals = discovery.confirmedSignals;
    if (!Array.isArray(signals))
        return [];
    return signals.filter((signal) => Boolean(signal && typeof signal === 'object'));
}
export function formatConfirmedSignals(profile, max = 5) {
    const signals = getConfirmedSignals(profile).slice(0, max);
    if (signals.length === 0)
        return 'No confirmed personal signals yet.';
    return signals
        .map((signal, index) => {
        const label = titleCaseUnderscore(signal.label);
        const type = titleCaseUnderscore(signal.type);
        const confidence = valueOrDash(signal.confidence);
        const scope = valueOrDash(signal.scope);
        return `${index + 1}. ${label} (${type}, confidence: ${confidence}, scope: ${scope})`;
    })
        .join('\n');
}
export function extractSimpleReflectionSignal(text) {
    const normalized = text.toLowerCase();
    for (const item of SIGNAL_KEYWORDS) {
        if (item.words.some((word) => normalized.includes(word)))
            return item.signal;
    }
    return null;
}
export function formatReflectionPrompt(signal) {
    return `Private reflection: I’m noticing this answer may emphasize ${signal.label}. Is that accurate?`;
}
export function pickQuestionPersonalizationSignal(profile, projectId) {
    const signals = getConfirmedSignals(profile);
    return signals.find((signal) => signal.scope === 'private_to_member' &&
        signal.confidence === 'high' &&
        signal.projectId === projectId &&
        typeof signal.label === 'string') ?? null;
}
export function formatQuestionPersonalization(profile, projectId) {
    const signal = pickQuestionPersonalizationSignal(profile, projectId);
    if (!signal)
        return '';
    return `Private note: last time, you confirmed that ${signal.label} is a useful lens for you. Use that lens if it helps — or ignore it if it doesn’t fit this question.\n\n`;
}
export function normalizeReflectionRefinement(text) {
    const normalized = text
        .trim()
        .replace(/\s+/g, ' ')
        .replace(/[\n\r\t]/g, ' ')
        .slice(0, 80);
    if (normalized.length < 3)
        return null;
    return normalized;
}
export function mergeConfirmedSignal(profile, signal) {
    const base = profile && typeof profile === 'object' ? { ...profile } : {};
    const existingDiscovery = base.individualDiscovery && typeof base.individualDiscovery === 'object'
        ? base.individualDiscovery
        : {};
    const existingSignals = Array.isArray(existingDiscovery.confirmedSignals)
        ? existingDiscovery.confirmedSignals.filter((entry) => entry && typeof entry === 'object')
        : [];
    const nextSignal = {
        type: signal.type,
        label: signal.label,
        confidence: 'high',
        scope: 'private_to_member',
        source: signal.source ?? 'post_answer_reflection',
        projectId: signal.projectId,
        confirmedAt: signal.confirmedAt ?? new Date().toISOString(),
    };
    const deduped = existingSignals.filter((entry) => !(entry.label === nextSignal.label && entry.type === nextSignal.type && entry.projectId === nextSignal.projectId));
    return {
        ...base,
        individualDiscovery: {
            ...existingDiscovery,
            confirmedSignals: [nextSignal, ...deduped].slice(0, 25),
        },
    };
}
export function formatPersonalProfileView(args) {
    const profile = args.projectProfile ?? {};
    const latestRound = args.latestRound;
    const roundText = latestRound
        ? `#${latestRound.roundNumber ?? '—'} — ${latestRound.status ?? 'unknown'}\nTopic: ${latestRound.topic ?? '—'}\nResponses: ${latestRound.responseCount ?? 0}/${latestRound.memberCount ?? 0}`
        : 'No round yet.';
    return `Your Zolara profile\n\n` +
        `Project: ${args.projectName}\n` +
        `Role: ${args.role ?? 'participant'}\n` +
        `Onboarding: ${args.onboardingStatus ?? 'fresh'}\n` +
        `Active question: ${args.activeQuestion ? 'waiting for your answer' : 'none right now'}\n\n` +
        `Onboarding profile\n` +
        `• Interests / knowledge: ${valueOrDash(profile.interests)}\n` +
        `• Communication style: ${titleCaseUnderscore(profile.communication_style)}\n` +
        `• Availability: ${titleCaseUnderscore(profile.availability)}\n\n` +
        `Confirmed personal signals\n` +
        `${formatConfirmedSignals(args.communicationProfile)}\n\n` +
        `Latest round\n${roundText}\n\n` +
        `Privacy note: only you can see this profile here. Group reports use aggregate/anonymized patterns, not your raw private answers.`;
}
