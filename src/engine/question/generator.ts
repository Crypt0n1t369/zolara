/**
 * Question Generator
 * Generates questions for a round based on project config and topic.
 */

import { llm } from '../llm/minimax';
import type { ProjectConfig } from '../../data/schema/projects';
import { llm as llmLog } from '../../util/logger';

export interface GeneratedQuestion {
  text: string;
  type: 'open' | 'scale' | 'choice';
  followUp?: string; // Optional follow-up prompt
}

export interface QuestionGenerationParams {
  projectId: string;
  topic: string;
  depth: 'shallow' | 'medium' | 'deep';
  anonymity: 'full' | 'optional' | 'attributed';
  teamSizeRange: string;
}

const DEPTH_CONFIG = {
  shallow: { questionCount: 2, targetMinutes: 2, types: ['scale', 'choice'] as const },
  medium: { questionCount: 3, targetMinutes: 5, types: ['open', 'scale'] as const },
  deep: { questionCount: 5, targetMinutes: 12, types: ['open'] as const },
};

function isAllowedQuestionType(value: unknown): value is GeneratedQuestion['type'] {
  return value === 'open' || value === 'scale' || value === 'choice';
}

function stripJsonFence(text: string): string {
  return text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function parseJsonMaybe(text: string): unknown {
  const trimmed = stripJsonFence(text);
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    const arrayMatch = trimmed.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      try { return JSON.parse(arrayMatch[0]); } catch { /* fall through */ }
    }

    const objectMatch = trimmed.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try { return JSON.parse(objectMatch[0]); } catch { /* fall through */ }
    }
  }

  return null;
}

export function normalizeGeneratedQuestions(raw: unknown, count: number): GeneratedQuestion[] {
  const candidate = typeof raw === 'string'
    ? parseJsonMaybe(raw)
    : raw;

  const questionList = Array.isArray(candidate)
    ? candidate
    : Array.isArray((candidate as { questions?: unknown })?.questions)
    ? (candidate as { questions: unknown[] }).questions
    : Array.isArray((candidate as { items?: unknown })?.items)
    ? (candidate as { items: unknown[] }).items
    : [];

  return questionList
    .map((item): GeneratedQuestion | null => {
      if (typeof item === 'string') {
        const text = item.trim();
        return text ? { text: text.slice(0, 700), type: 'open' } : null;
      }

      if (!item || typeof item !== 'object') return null;
      const q = item as Record<string, unknown>;
      const text = typeof q.text === 'string'
        ? q.text.trim()
        : typeof q.question === 'string'
        ? q.question.trim()
        : '';

      if (!text) return null;

      return {
        text: text.slice(0, 700),
        type: isAllowedQuestionType(q.type) ? q.type : 'open',
        followUp: typeof q.followUp === 'string' ? q.followUp.slice(0, 500) : undefined,
      };
    })
    .filter((q): q is GeneratedQuestion => q !== null)
    .slice(0, count);
}

function fallbackQuestions(topic: string, count: number): GeneratedQuestion[] {
  const templates: GeneratedQuestion[] = [
    { text: `What feels most important for the team to understand about “${topic}” right now, and why?`, type: 'open' },
    { text: `Where do you feel most aligned or concerned about “${topic}”?`, type: 'open' },
    { text: `What would a good next step look like from your perspective?`, type: 'open' },
    { text: `What risk, blind spot, or tradeoff should the group not miss?`, type: 'open' },
    { text: `If you could clarify one thing before the team decides, what would it be?`, type: 'open' },
  ];

  return templates.slice(0, count);
}

/**
 * Generate questions for a round.
 * Returns an array of questions tailored to the project config.
 */
export async function generateQuestions(
  params: QuestionGenerationParams
): Promise<GeneratedQuestion[]> {
  const depth = DEPTH_CONFIG[params.depth];
  const count = Math.min(depth.questionCount, 5); // Cap at 5

  const teamSizeLabel: Record<string, string> = {
    '2-5': 'small team (2-5 people)',
    '6-12': 'medium team (6-12 people)',
    '13-30': 'large team (13-30 people)',
    '30+': 'very large team (30+ people)',
  };

  const anonymityNote = params.anonymity === 'full'
    ? 'All responses are completely anonymous.'
    : params.anonymity === 'attributed'
    ? 'Responses can be attributed to individuals.'
    : 'Responses are anonymous unless the respondent chooses otherwise.';

  const systemPrompt = `You are Zolara's Deliberation Engine. Your role is to generate thoughtful, open-ended questions that help a group understand each other's perspectives.
  
Guidelines:
- Questions should uncover values, reasoning, and concerns — not just opinions
- Avoid yes/no questions; prefer "what" and "how" questions
- Mix breadth questions (overall view) with depth questions (specific reasoning)
- Consider the team size when phrasing questions
- ${anonymityNote}
- Output valid JSON only, no markdown or explanations`;

  const userPrompt = `Generate ${count} questions for a ${teamSizeLabel[params.teamSizeRange] ?? 'team'} perspective-gathering round.

Project topic: "${params.topic}"

Requirements:
- Question depth: ${params.depth} (${depth.targetMinutes} min per person)
- Include a mix of question types but mostly open-ended
- Each question should stand alone (no follow-ups needed to understand it)
- Format as JSON array of {text, type} objects
- Types allowed: "open" (free text), "scale" (1-5 rating), "choice" (A/B/C option)
- Return ONLY the JSON array, no markdown formatting`;

  try {
    const response = await llm.generate({
      systemPrompt,
      userPrompt,
      temperature: 0.7,
      maxTokens: 2048,
      responseFormat: 'json',
    });

    const questions = normalizeGeneratedQuestions(response.parsed ?? response.text, count);
    if (questions.length > 0) {
      return questions;
    }

    const err = new Error('LLM returned invalid question format; using deterministic fallback questions');
    llmLog.generationFailed({ projectId: params.projectId, topic: params.topic }, err);
    return fallbackQuestions(params.topic, count);
  } catch (err) {
    llmLog.generationFailed({ projectId: params.projectId, topic: params.topic }, err);
    return fallbackQuestions(params.topic, count);
  }
}

/**
 * Personalize a question for a specific member.
 * Adds member context to make the question feel more relevant.
 */
export async function personalizeQuestion(
  question: GeneratedQuestion,
  memberContext: {
    role?: string;
    interests?: string;
    communicationStyle?: string;
  }
): Promise<GeneratedQuestion> {
  if (!memberContext.role && !memberContext.interests) {
    return question;
  }

  const context = [
    memberContext.role ? `Role: ${memberContext.role}` : null,
    memberContext.interests ? `Interests: ${memberContext.interests}` : null,
  ]
    .filter(Boolean)
    .join(', ');

  const systemPrompt = `You are Zolara's question personalizer. Rewrite the given question to feel more relevant and natural for this specific person. Keep the same core question, but adjust wording/tone to fit their context.

Person context: ${context}
Communication preference: ${memberContext.communicationStyle ?? 'balanced'}

Output ONLY the personalized question text, no explanations.`;

  try {
    const response = await llm.generate({
      systemPrompt,
      userPrompt: question.text,
      temperature: 0.5,
      maxTokens: 256,
    });

    return {
      ...question,
      text: response.text.trim().slice(0, 500),
    };
  } catch (err) {
    llmLog.generationFailed({ context: 'question_personalization' }, err);
    return question;
  }
}
