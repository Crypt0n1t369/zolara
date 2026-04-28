/**
 * Tests for onboarding state machine
 */

import { describe, it, expect } from 'vitest';
import {
  nextOnboardingStep,
  prevOnboardingStep,
  ONBOARDING_STEP_ORDER,
  type OnboardingStep,
} from './onboarding-state';

describe('Onboarding state machine', () => {
  describe('STEP_ORDER', () => {
    it('should have correct step sequence', () => {
      expect(ONBOARDING_STEP_ORDER).toEqual([
        'welcome', 'role', 'interests', 'availability', 'communication_style', 'review', 'complete',
      ]);
    });
  });

  describe('nextOnboardingStep', () => {
    it('should progress through all steps', () => {
      expect(nextOnboardingStep('welcome')).toBe('role');
      expect(nextOnboardingStep('role')).toBe('interests');
      expect(nextOnboardingStep('interests')).toBe('availability');
      expect(nextOnboardingStep('availability')).toBe('communication_style');
      expect(nextOnboardingStep('communication_style')).toBe('review');
      expect(nextOnboardingStep('review')).toBe('complete');
    });

    it('should stay at complete', () => {
      expect(nextOnboardingStep('complete')).toBe('complete');
    });
  });

  describe('prevOnboardingStep', () => {
    it('should go backwards through steps', () => {
      expect(prevOnboardingStep('role')).toBe('welcome');
      expect(prevOnboardingStep('interests')).toBe('role');
      expect(prevOnboardingStep('availability')).toBe('interests');
      expect(prevOnboardingStep('communication_style')).toBe('availability');
      expect(prevOnboardingStep('review')).toBe('communication_style');
      expect(prevOnboardingStep('complete')).toBe('review');
    });

    it('should stay at welcome', () => {
      expect(prevOnboardingStep('welcome')).toBe('welcome');
    });
  });
});
