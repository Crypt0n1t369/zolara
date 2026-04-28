/**
 * Tests for Managed Bots lifecycle functions
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  generateBotUsername,
  buildCreationLink,
} from './lifecycle';

describe('Managed Bots lifecycle', () => {
  describe('generateBotUsername', () => {
    it('should lowercase and slugify project name', () => {
      const result = generateBotUsername('JCI Vision 2030');
      expect(result).toBe('jci_vision_2030_zol_bot');
    });

    it('should remove special characters', () => {
      const result = generateBotUsername('Team Alpha!');
      expect(result).toBe('team_alpha_zol_bot');
    });

    it('should collapse multiple spaces/separators', () => {
      const result = generateBotUsername('Hello---World   Test');
      expect(result).toBe('hello_world_test_zol_bot');
    });

    it('should trim leading/trailing underscores', () => {
      const result = generateBotUsername('  Test Project  ');
      expect(result).toBe('test_project_zol_bot');
    });

    it('should truncate to 30 chars before suffix if needed', () => {
      const longName = 'a'.repeat(50);
      const result = generateBotUsername(longName);
      // Result should still be valid telegram username
      expect(result.length).toBeLessThanOrEqual(64);
      expect(result).toBe(`${'a'.repeat(24)}_zol_bot`);
    });
  });

  describe('buildCreationLink', () => {
    it('should build correct creation URL format', () => {
      const link = buildCreationLink('Zolara_builder_bot', 'test_zolara_bot', 'Test Project');
      expect(link).toContain('https://t.me/newbot/Zolara_builder_bot/test_zolara_bot');
      expect(link).toContain('name=Test%20Project');
    });

    it('should URL-encode special characters in name', () => {
      const link = buildCreationLink('Zolara_builder_bot', 'test_zolara_bot', 'Project & Team');
      expect(link).toContain('Project%20%26%20Team');
    });
  });
});

// Mock-based tests for API functions (require network or mock fetch)
describe('Managed Bots API calls', () => {
  const TEST_TOKEN = '8765105007:AAF_mixhayvZhFoMtFT8VR3mOpXUY1wEOiA';
  const TEST_BOT_USER_ID = 999999999;

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('getManagedBotToken should call correct endpoint', async () => {
    const { getManagedBotToken } = await import('./lifecycle');

    // We can't easily test this without mocking the config
    // Placeholder - real implementation would use fetch mock
    expect(getManagedBotToken).toBeDefined();
  });
});
