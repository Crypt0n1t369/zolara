/**
 * Synthesis Pipeline
 * Transforms collected responses into a structured alignment report.
 *
 * Pipeline: Theme Extraction → Alignment Mapping → Report Synthesis → Validation
 */

import { llm } from '../llm/minimax';
import type { ReportData } from '../../data/schema/projects';
import { db } from '../../data/db';
import { responses, questions, members, rounds } from '../../data/schema/projects';
import { eq, sql } from 'drizzle-orm';
import { llm as llmLog, db as dbLog, round as roundLog } from '../../util/logger';

export interface SynthesisInput {
  roundId: string;
  projectId: string;
  topic: string;
  responseCount: number;
  memberCount: number;
  anonymity: 'full' | 'optional' | 'attributed';
}

interface ThemeExtraction {
  themes: Array<{
    name: string;
    summary: string;
    quotes: string[];
    sentiment: 'positive' | 'neutral' | 'mixed' | 'negative';
  }>;
  commonGround: string[];
  creativeTensions: string[];
  blindSpots: string[];
}

interface AlignmentMapping {
  alignments: Array<{
    theme: string;
    level: 'aligned' | 'tension' | 'neutral';
    summary: string;
  }>;
  convergenceScore: number; // 0-100
  convergenceTier: 'strong' | 'conditional' | 'operational' | 'divergent';
}

/**
 * Run the full synthesis pipeline for a round.
 */
export async function runSynthesis(input: SynthesisInput): Promise<ReportData> {
  // Step 1: Collect and anonymize responses
  const responsesData = await collectResponses(input.roundId, input.anonymity);

  if (responsesData.length < 2) {
    throw new Error('Minimum 2 responses required for synthesis');
  }

  // Step 2: Theme extraction
  const themes = await extractThemes(responsesData, input.topic);

  // Step 3: Alignment mapping
  const alignment = await mapAlignment(themes, responsesData.length);

  // Step 4: Report synthesis
  const report = await synthesizeReport(input, themes, alignment, input.anonymity);

  // Step 5: Validation
  const validated = validateReport(report);

  return validated;
}

async function collectResponses(
  roundId: string,
  _anonymity: 'full' | 'optional' | 'attributed'
): Promise<Array<{ text: string; questionType: string }>> {
  const rows = await db
    .select({
      responseText: responses.responseText,
      questionType: questions.questionType,
    })
    .from(responses)
    .innerJoin(questions, eq(questions.id, responses.questionId))
    .innerJoin(members, eq(members.id, responses.memberId))
    .where(eq(questions.roundId, roundId))
    .limit(100);

  // Always pass actual response text to LLM for theme extraction.
  // Anonymization is applied only in the final report presentation, not during analysis.
  return rows.map((r) => ({
    text: r.responseText ?? '',
    questionType: r.questionType ?? 'open',
  }));
}

async function extractThemes(
  responses: Array<{ text: string; questionType: string }>,
  topic: string
): Promise<ThemeExtraction> {
  const responseTexts = responses.map((r) => `- ${r.text}`).join('\n');

  const systemPrompt = `You are Zolara's theme extraction engine. Analyze the collected responses and identify the main themes, areas of agreement, and tensions.

Output a JSON object with:
{
  "themes": [
    {
      "name": "theme name",
      "summary": "2-3 sentence summary of what perspectives emerged on this theme",
      "quotes": ["notable quote 1", "notable quote 2"],
      "sentiment": "positive|neutral|mixed|negative"
    }
  ],
  "commonGround": ["shared understanding or agreement point 1", "..."],
  "creativeTensions": ["productive disagreement or tension point 1", "..."],
  "blindSpots": ["topic not addressed or overlooked area 1", "..."]
}

Extract 3-7 major themes. Be specific and insightful.`;

  try {
    const response = await llm.generate({
      systemPrompt,
      userPrompt: `Topic: ${topic}\n\nResponses:\n${responseTexts}`,
      temperature: 0.5,
      maxTokens: 2048,
      responseFormat: 'json',
    });

    return response.parsed as ThemeExtraction;
  } catch (err) {
    llmLog.generationFailed({ topic }, err);
    // Return minimal structure on failure
    return {
      themes: [{
        name: 'General',
        summary: 'Perspectives were shared on the topic.',
        quotes: [],
        sentiment: 'neutral',
      }],
      commonGround: [],
      creativeTensions: [],
      blindSpots: [],
    };
  }
}

async function mapAlignment(
  themes: ThemeExtraction,
  responseCount: number
): Promise<AlignmentMapping> {
  const themeList = themes.themes.map((t) => `- ${t.name}: ${t.summary}`).join('\n');

  const systemPrompt = `You are Zolara's alignment mapper. Given extracted themes, assess the level of alignment/tension in each.

Output a JSON object:
{
  "alignments": [
    {
      "theme": "theme name",
      "level": "aligned|tension|neutral",
      "summary": "why this level of alignment exists"
    }
  ],
  "convergenceScore": 0-100,
  "convergenceTier": "strong (80+)|conditional (60-79)|operational (40-59)|divergent (<40)"
}

Convergence score formula: % of responses that show agreement on major themes.`;

  try {
    const response = await llm.generate({
      systemPrompt,
      userPrompt: `Themes:\n${themeList}`,
      temperature: 0.3,
      maxTokens: 1536,
      responseFormat: 'json',
    });

    const result = response.parsed as AlignmentMapping;

    // Ensure convergence score is within bounds
    result.convergenceScore = Math.max(0, Math.min(100, result.convergenceScore));

    return result;
  } catch (err) {
    llmLog.generationFailed({ context: 'alignment_mapping' }, err);
    return {
      alignments: themes.themes.map((t) => ({
        theme: t.name,
        level: 'neutral' as const,
        summary: t.summary,
      })),
      convergenceScore: 50,
      convergenceTier: 'operational',
    };
  }
}

async function synthesizeReport(
  input: SynthesisInput,
  themes: ThemeExtraction,
  alignment: AlignmentMapping,
  anonymity: 'full' | 'optional' | 'attributed'
): Promise<ReportData> {
  const participationRate = Math.round((input.responseCount / input.memberCount) * 100);

  const systemPrompt = `You are Zolara's report synthesis engine. Write a clear, actionable synthesis report from the collected perspectives.

Tone: Professional, constructive, non-judgmental. Like a skilled facilitator summarizing a workshop.

Structure:
1. Brief overview (2-3 sentences)
2. Key themes with alignment levels
3. Common ground
4. Creative tensions (productive disagreements)
5. Blind spots / overlooked areas
6. Suggested next steps (action items)

Important:
- Use "some members" or "a few participants" rather than naming individuals
- Highlight actionable insights
- Frame tensions as opportunities for deeper dialogue
- End with clear suggested next steps`;

  const alignmentSummary = alignment.alignments
    .map((a) => `${a.theme}: ${a.level} — ${a.summary}`)
    .join('\n');

  const themesSummary = themes.themes
    .map((t) => `${t.name} (${t.sentiment}): ${t.summary}`)
    .join('\n');

  try {
    const response = await llm.generate({
      systemPrompt,
      userPrompt: `Topic: ${input.topic}
Response count: ${input.responseCount}/${input.memberCount} (${participationRate}%)

Themes:
${themesSummary}

Alignment Analysis:
${alignmentSummary}

Common Ground: ${themes.commonGround.join('; ') || 'None identified'}
Creative Tensions: ${themes.creativeTensions.join('; ') || 'None identified'}
Blind Spots: ${themes.blindSpots.join('; ') || 'None identified'}
Convergence Score: ${alignment.convergenceScore}% (${alignment.convergenceTier})`,
      temperature: 0.5,
      maxTokens: 3072,
    });

    const reportText = response.text.trim();

    // Anonymize quotes if full anonymity is configured
    const anonymizeQuote = (quote: string): string => {
      if (anonymity === 'full') return '[Anonymous]';
      if (anonymity === 'optional') return '[Team member]';
      return quote; // 'attributed' — keep as-is
    };

    return {
      themes: themes.themes.map((t) => ({
        name: t.name,
        alignment: alignment.alignments.find((a) => a.theme === t.name)?.level ?? 'neutral',
        summary: t.summary,
        quotes: t.quotes?.map(anonymizeQuote),
      })),
      commonGround: themes.commonGround,
      creativeTensions: themes.creativeTensions,
      blindSpots: themes.blindSpots,
      actionItems: extractActionItems(reportText),
      convergenceScore: alignment.convergenceScore,
      convergenceTier: alignment.convergenceTier,
    };
  } catch (err) {
    llmLog.generationFailed({ context: 'report_synthesis' }, err);
    throw err;
  }
}

function extractActionItems(reportText: string): ReportData['actionItems'] {
  // Simple regex-based extraction of action items from report text
  // Format: "- [ ] Action item" or "- Action item"
  const actionItemRegex = /[-•]\s*(.+)/g;
  const matches = reportText.matchAll(actionItemRegex);
  const items: ReportData['actionItems'] = [];

  for (const match of matches) {
    const title = match[1].trim();
    if (title.length > 10 && title.length < 200) {
      items.push({ title, description: '' });
    }
  }

  return items.slice(0, 5); // Max 5 action items
}

function validateReport(report: ReportData): ReportData {
  // Ensure all required fields exist and are valid

  if (!Array.isArray(report.themes)) {
    report.themes = [];
  }

  if (!Array.isArray(report.commonGround)) {
    report.commonGround = [];
  }

  if (!Array.isArray(report.creativeTensions)) {
    report.creativeTensions = [];
  }

  if (!Array.isArray(report.blindSpots)) {
    report.blindSpots = [];
  }

  if (!Array.isArray(report.actionItems)) {
    report.actionItems = [];
  }

  // Ensure convergence score is valid
  if (typeof report.convergenceScore !== 'number') {
    report.convergenceScore = 50;
  }
  report.convergenceScore = Math.max(0, Math.min(100, report.convergenceScore));

  // Ensure convergence tier is valid
  const validTiers = ['strong', 'conditional', 'operational', 'divergent'];
  if (!validTiers.includes(report.convergenceTier)) {
    report.convergenceTier = 'operational';
  }

  return report;
}

/**
 * Calculate minimum viable responses for a team size.
 */
export function getMinimumResponses(teamSizeRange: string): number {
  const thresholds: Record<string, number> = {
    '2-5': 2,
    '6-12': 3,
    '13-30': 5,
    '30+': 8,
  };
  return thresholds[teamSizeRange] ?? 2;
}

/**
 * Check if response rate meets minimum threshold.
 */
export function meetsMinimumThreshold(
  responseCount: number,
  memberCount: number,
  teamSizeRange: string
): boolean {
  if (memberCount === 0) return false;
  const minResponses = getMinimumResponses(teamSizeRange);
  const rate = responseCount / memberCount;

  const minRates: Record<string, number> = {
    '2-5': 0.5,
    '6-12': 0.3,
    '13-30': 0.2,
    '30+': 0.15,
  };

  const minRate = minRates[teamSizeRange] ?? 0.5;
  return responseCount >= minResponses && rate >= minRate;
}
