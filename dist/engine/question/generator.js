/**
 * Question Generator
 * Generates questions for a round based on project config and topic.
 */
import { llm } from '../llm/minimax';
import { llm as llmLog } from '../../util/logger';
const DEPTH_CONFIG = {
    shallow: { questionCount: 2, targetMinutes: 2, types: ['scale', 'choice'] },
    medium: { questionCount: 3, targetMinutes: 5, types: ['open', 'scale'] },
    deep: { questionCount: 5, targetMinutes: 12, types: ['open'] },
};
/**
 * Generate questions for a round.
 * Returns an array of questions tailored to the project config.
 */
export async function generateQuestions(params) {
    const depth = DEPTH_CONFIG[params.depth];
    const count = Math.min(depth.questionCount, 5); // Cap at 5
    const teamSizeLabel = {
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
        const questions = response.parsed;
        if (!Array.isArray(questions) || questions.length === 0) {
            throw new Error('LLM returned invalid question format');
        }
        return questions.slice(0, count).map((q) => ({
            text: q.text,
            type: q.type ?? 'open',
            followUp: q.followUp,
        }));
    }
    catch (err) {
        llmLog.generationFailed({ projectId: params.projectId, topic: params.topic }, err);
        throw err;
    }
}
/**
 * Personalize a question for a specific member.
 * Adds member context to make the question feel more relevant.
 */
export async function personalizeQuestion(question, memberContext) {
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
    }
    catch (err) {
        llmLog.generationFailed({ context: 'question_personalization' }, err);
        return question;
    }
}
