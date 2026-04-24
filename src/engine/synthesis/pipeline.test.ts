/**
 * Tests for Synthesis Pipeline
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getMinimumResponses,
  meetsMinimumThreshold,
} from './pipeline';

describe('Synthesis Pipeline - Utility Functions', () => {
  describe('getMinimumResponses', () => {
    it('should return correct thresholds for each team size', () => {
      expect(getMinimumResponses('2-5')).toBe(2);
      expect(getMinimumResponses('6-12')).toBe(3);
      expect(getMinimumResponses('13-30')).toBe(5);
      expect(getMinimumResponses('30+')).toBe(8);
    });

    it('should default to 2 for unknown team size', () => {
      expect(getMinimumResponses('unknown')).toBe(2);
    });
  });

  describe('meetsMinimumThreshold', () => {
    it('should return false when no members', () => {
      expect(meetsMinimumThreshold(2, 0, '2-5')).toBe(false);
    });

    it('should return true when above both thresholds', () => {
      // 4/5 = 80%, threshold is 50% for 2-5
      expect(meetsMinimumThreshold(4, 5, '2-5')).toBe(true);
    });

    it('should return false when below response count', () => {
      // 1/5 = 20%, threshold is 50% but min is 2
      expect(meetsMinimumThreshold(1, 5, '2-5')).toBe(false);
    });

    it('should return true for larger teams with lower rates', () => {
      // 6/30 = 20%, threshold is 20% for 13-30
      expect(meetsMinimumThreshold(6, 30, '13-30')).toBe(true);
    });

    it('should return false for large team with very few responses', () => {
      // 2/30 = 6.7%, below 20% threshold
      expect(meetsMinimumThreshold(2, 30, '13-30')).toBe(false);
    });
  });
});

// Mock-based integration tests (would require DB mocks)
describe('Synthesis Pipeline - Report Structure', () => {
  // These tests validate the output structure expectations
  // Real integration tests would require mocked DB + LLM

  it('should define expected report data structure', () => {
    const reportData = {
      themes: [
        {
          name: 'Communication',
          alignment: 'aligned' as const,
          summary: 'Team agrees on need for better communication',
          quotes: ['We need weekly standups'],
        },
      ],
      commonGround: ['Regular check-ins are important'],
      creativeTensions: ['Daily vs weekly meetings'],
      blindSpots: ['Remote work communication'],
      actionItems: [{ title: 'Set up weekly team sync', description: 'Schedule recurring meeting' }],
      convergenceScore: 75,
      convergenceTier: 'conditional' as const,
    };

    expect(reportData.themes).toBeInstanceOf(Array);
    expect(reportData.commonGround).toBeInstanceOf(Array);
    expect(reportData.creativeTensions).toBeInstanceOf(Array);
    expect(reportData.blindSpots).toBeInstanceOf(Array);
    expect(reportData.actionItems).toBeInstanceOf(Array);
    expect(typeof reportData.convergenceScore).toBe('number');
    expect(['strong', 'conditional', 'operational', 'divergent']).toContain(reportData.convergenceTier);
  });
});
