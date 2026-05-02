export type PersonalProjectProfile = Record<string, unknown> | null | undefined;
export type CommunicationProfile = Record<string, unknown> | null | undefined;

export type PersonalRoundSummary = {
  roundNumber: number | null;
  status: string | null;
  topic: string | null;
  responseCount?: number | null;
  memberCount?: number | null;
} | null;

export type PersonalProfileViewArgs = {
  projectName: string;
  role?: string | null;
  onboardingStatus?: string | null;
  projectProfile?: PersonalProjectProfile;
  communicationProfile?: CommunicationProfile;
  activeQuestion: boolean;
  latestRound?: PersonalRoundSummary;
};

export type ConfirmedSignal = {
  label?: unknown;
  type?: unknown;
  confidence?: unknown;
  scope?: unknown;
  source?: unknown;
  projectId?: unknown;
  confirmedAt?: unknown;
};

export type ExtractedSignal = {
  label: string;
  type: 'value' | 'blocker' | 'communication_style' | 'contribution_style';
};

const SIGNAL_KEYWORDS: Array<{ signal: ExtractedSignal; words: string[] }> = [
  { signal: { label: 'clarity', type: 'value' }, words: ['clear', 'clarity', 'confusing', 'confusion', 'ambiguous', 'specific'] },
  { signal: { label: 'speed', type: 'value' }, words: ['speed', 'fast', 'quick', 'slow', 'delay', 'momentum'] },
  { signal: { label: 'trust', type: 'value' }, words: ['trust', 'safe', 'safety', 'honest', 'transparent'] },
  { signal: { label: 'risk', type: 'contribution_style' }, words: ['risk', 'concern', 'worried', 'failure', 'break', 'blocker'] },
  { signal: { label: 'alignment', type: 'value' }, words: ['align', 'alignment', 'agree', 'shared', 'consensus'] },
  { signal: { label: 'autonomy', type: 'value' }, words: ['autonomy', 'ownership', 'independent', 'freedom', 'agency'] },
  { signal: { label: 'practical next steps', type: 'contribution_style' }, words: ['next step', 'action', 'practical', 'execute', 'implementation', 'plan'] },
];

function valueOrDash(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  return String(value);
}

function titleCaseUnderscore(value: unknown): string {
  return valueOrDash(value)
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function getConfirmedSignals(profile: CommunicationProfile): ConfirmedSignal[] {
  const discovery = profile?.individualDiscovery;
  if (!discovery || typeof discovery !== 'object') return [];
  const signals = (discovery as { confirmedSignals?: unknown }).confirmedSignals;
  if (!Array.isArray(signals)) return [];
  return signals.filter((signal): signal is ConfirmedSignal => Boolean(signal && typeof signal === 'object'));
}

export function formatConfirmedSignals(profile: CommunicationProfile, max = 5): string {
  const signals = getConfirmedSignals(profile).slice(0, max);
  if (signals.length === 0) return 'No confirmed personal signals yet.';

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

export function extractSimpleReflectionSignal(text: string): ExtractedSignal | null {
  const normalized = text.toLowerCase();
  for (const item of SIGNAL_KEYWORDS) {
    if (item.words.some((word) => normalized.includes(word))) return item.signal;
  }
  return null;
}

export function formatReflectionPrompt(signal: ExtractedSignal): string {
  return `Private reflection: I’m noticing this answer may emphasize ${signal.label}. Is that accurate?`;
}

export function pickQuestionPersonalizationSignal(profile: CommunicationProfile, projectId: string): ConfirmedSignal | null {
  const signals = getConfirmedSignals(profile);
  return signals.find((signal) =>
    signal.scope === 'private_to_member' &&
    signal.confidence === 'high' &&
    signal.projectId === projectId &&
    typeof signal.label === 'string'
  ) ?? null;
}

export function formatQuestionPersonalization(profile: CommunicationProfile, projectId: string): string {
  const signal = pickQuestionPersonalizationSignal(profile, projectId);
  if (!signal) return '';
  return `Private note: last time, you confirmed that ${signal.label} is a useful lens for you. Use that lens if it helps — or ignore it if it doesn’t fit this question.\n\n`;
}

export function normalizeReflectionRefinement(text: string): string | null {
  const normalized = text
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[\n\r\t]/g, ' ')
    .slice(0, 80);
  if (normalized.length < 3) return null;
  return normalized;
}

export function mergeConfirmedSignal(
  profile: CommunicationProfile,
  signal: ExtractedSignal & { projectId: string; source?: string; confirmedAt?: string }
): Record<string, unknown> {
  const base = profile && typeof profile === 'object' ? { ...profile } : {};
  const existingDiscovery = base.individualDiscovery && typeof base.individualDiscovery === 'object'
    ? base.individualDiscovery as Record<string, unknown>
    : {};
  const existingSignals = Array.isArray(existingDiscovery.confirmedSignals)
    ? existingDiscovery.confirmedSignals.filter((entry) => entry && typeof entry === 'object') as ConfirmedSignal[]
    : [];

  const nextSignal: ConfirmedSignal = {
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

export function formatPersonalProfileView(args: PersonalProfileViewArgs): string {
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
