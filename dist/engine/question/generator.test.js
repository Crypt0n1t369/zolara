import { describe, expect, it } from 'vitest';
import { normalizeGeneratedQuestions } from './generator';
describe('Question Generator parsing', () => {
    it('accepts direct JSON arrays', () => {
        const questions = normalizeGeneratedQuestions([
            { text: 'What matters most?', type: 'open' },
            { text: 'Rate confidence', type: 'scale' },
        ], 3);
        expect(questions).toEqual([
            { text: 'What matters most?', type: 'open', followUp: undefined },
            { text: 'Rate confidence', type: 'scale', followUp: undefined },
        ]);
    });
    it('accepts provider JSON objects with a questions array', () => {
        const questions = normalizeGeneratedQuestions({
            questions: [
                { question: 'Where are we aligned?', type: 'unexpected' },
            ],
        }, 3);
        expect(questions).toEqual([
            { text: 'Where are we aligned?', type: 'open', followUp: undefined },
        ]);
    });
    it('extracts arrays from markdown-fenced text', () => {
        const questions = normalizeGeneratedQuestions('```json\n[{"text":"What is unclear?","type":"open"}]\n```', 3);
        expect(questions).toEqual([
            { text: 'What is unclear?', type: 'open', followUp: undefined },
        ]);
    });
    it('drops malformed items and enforces the requested count', () => {
        const questions = normalizeGeneratedQuestions([
            null,
            { note: 'not a question' },
            'What should happen next?',
            { text: 'What risk should we notice?', type: 'open' },
        ], 1);
        expect(questions).toEqual([
            { text: 'What should happen next?', type: 'open' },
        ]);
    });
});
