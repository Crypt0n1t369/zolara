/**
 * Tests for onboarding state machine
 */

import { describe, it, expect } from 'vitest';
import {
  nextOnboardingStep,
  prevOnboardingStep,
  ONBOARDING_STEP_ORDER,
  type OnboardingStep,
  onboardingStepLabel,
  currentlyAnsweringLabel,
} from './onboarding-state';
import { getOnboardingCallbackStaleReason } from './onboarding-steps';

describe('Onboarding state machine', () => {
  describe('STEP_ORDER', () => {
    it('should have correct step sequence', () => {
      expect(ONBOARDING_STEP_ORDER).toEqual([
        'welcome', 'role', 'interests', 'availability', 'communication_style', 'review', 'complete',
      ]);
    });
  });


  describe('prompt labels', () => {
    it('renders explicit Currently answering labels for prompts', () => {
      expect(onboardingStepLabel('role')).toBe('Role / connection');
      expect(currentlyAnsweringLabel('role')).toBe('Currently answering: Role / connection');
      expect(currentlyAnsweringLabel('communication_style')).toBe('Currently answering: Communication style');
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

  describe('stale callback detection', () => {
    const state = {
      phase: 'onboarding' as const,
      projectId: 'project-1',
      telegramId: 123,
      step: 'interests' as OnboardingStep,
      createdAt: '2026-04-28T00:00:00.000Z',
    };

    it('flags skip buttons from an older step', () => {
      expect(getOnboardingCallbackStaleReason(state, 'onboard:skip:role')).toContain('Role / connection');
    });

    it('allows buttons for the current step', () => {
      expect(getOnboardingCallbackStaleReason(state, 'onboard:skip:interests')).toBeNull();
    });

    it('flags confirm when the user is no longer on review', () => {
      expect(getOnboardingCallbackStaleReason(state, 'onboard:confirm:review')).toContain('Review your answers');
    });
  });

});
