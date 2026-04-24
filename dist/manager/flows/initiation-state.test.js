/**
 * Tests for initiation state machine
 */
import { describe, it, expect } from 'vitest';
import { nextStep, prevStep, STEP_ORDER, } from './initiation-state';
describe('Initiation state machine', () => {
    describe('STEP_ORDER', () => {
        it('should have all 13 steps in correct order', () => {
            expect(STEP_ORDER).toEqual([
                'greeting', 'project_name', 'project_goal', 'team_size',
                'use_case', 'cycle_frequency', 'question_depth',
                'anonymity', 'action_tracking', 'group_setup',
                'confirm_config', 'bot_creation', 'complete',
            ]);
        });
    });
    describe('nextStep', () => {
        it('should progress through all steps', () => {
            expect(nextStep('greeting')).toBe('project_name');
            expect(nextStep('project_name')).toBe('project_goal');
            expect(nextStep('project_goal')).toBe('team_size');
            expect(nextStep('team_size')).toBe('use_case');
            expect(nextStep('use_case')).toBe('cycle_frequency');
            expect(nextStep('cycle_frequency')).toBe('question_depth');
            expect(nextStep('question_depth')).toBe('anonymity');
            expect(nextStep('anonymity')).toBe('action_tracking');
            expect(nextStep('action_tracking')).toBe('group_setup');
            expect(nextStep('group_setup')).toBe('confirm_config');
            expect(nextStep('confirm_config')).toBe('bot_creation');
            expect(nextStep('bot_creation')).toBe('complete');
        });
        it('should stay at complete', () => {
            expect(nextStep('complete')).toBe('complete');
        });
    });
    describe('prevStep', () => {
        it('should go backwards through steps', () => {
            expect(prevStep('project_name')).toBe('greeting');
            expect(prevStep('project_goal')).toBe('project_name');
            expect(prevStep('team_size')).toBe('project_goal');
            expect(prevStep('use_case')).toBe('team_size');
            expect(prevStep('cycle_frequency')).toBe('use_case');
            expect(prevStep('question_depth')).toBe('cycle_frequency');
            expect(prevStep('anonymity')).toBe('question_depth');
            expect(prevStep('action_tracking')).toBe('anonymity');
            expect(prevStep('group_setup')).toBe('action_tracking');
            expect(prevStep('confirm_config')).toBe('group_setup');
            expect(prevStep('bot_creation')).toBe('confirm_config');
            expect(prevStep('complete')).toBe('bot_creation');
        });
        it('should stay at greeting', () => {
            expect(prevStep('greeting')).toBe('greeting');
        });
    });
});
