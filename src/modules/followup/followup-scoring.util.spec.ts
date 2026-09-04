import { BadRequestException } from '@nestjs/common';
import { scoreCheckin, validateAnswers, validateQuestions, validateRedFlagRules } from './followup-scoring.util';
import type { FollowupQuestion, RedFlagRule } from './followup-question.types';

const QUESTIONS: FollowupQuestion[] = [
  { id: 'mood', text: 'How has your mood been?', type: 'scale_1_5', required: true },
  { id: 'self_harm', text: 'Any thoughts of harming yourself?', type: 'yes_no', required: true },
  {
    id: 'sleep',
    text: 'How is your sleep?',
    type: 'choice',
    required: false,
    options: [
      { value: 'better', label: 'Better' },
      { value: 'same', label: 'About the same' },
      { value: 'worse', label: 'Worse' },
    ],
  },
];

const RULES: RedFlagRule[] = [
  { id: 'r1', questionId: 'self_harm', matchValues: ['yes'], severity: 'red', reason: 'Patient reported thoughts of self-harm.' },
  { id: 'r2', questionId: 'sleep', matchValues: ['worse'], severity: 'amber', reason: 'Sleep worsening reported.' },
  { id: 'r3', questionId: 'mood', matchValues: ['1', '2'], severity: 'amber', reason: 'Low mood score reported.' },
];

describe('followup-scoring.util', () => {
  describe('scoreCheckin', () => {
    it('is green when nothing fires', () => {
      const result = scoreCheckin(QUESTIONS, RULES, { mood: '4', self_harm: 'no', sleep: 'better' });
      expect(result.status).toBe('green');
      expect(result.firedRules).toEqual([]);
    });

    it('is amber when only an amber rule fires', () => {
      const result = scoreCheckin(QUESTIONS, RULES, { mood: '4', self_harm: 'no', sleep: 'worse' });
      expect(result.status).toBe('amber');
      expect(result.firedRules.map((r) => r.id)).toEqual(['r2']);
    });

    it('is red when a red rule fires, even alongside amber rules', () => {
      const result = scoreCheckin(QUESTIONS, RULES, { mood: '1', self_harm: 'yes', sleep: 'worse' });
      expect(result.status).toBe('red');
      // Worst-first.
      expect(result.firedRules[0]?.id).toBe('r1');
      expect(result.firedRules.map((r) => r.id).sort()).toEqual(['r1', 'r2', 'r3']);
    });

    it('red wins regardless of which rule is listed first', () => {
      const reordered = [RULES[1]!, RULES[2]!, RULES[0]!];
      const result = scoreCheckin(QUESTIONS, reordered, { mood: '1', self_harm: 'yes', sleep: 'worse' });
      expect(result.status).toBe('red');
    });

    it('ignores a rule whose question was left unanswered', () => {
      const result = scoreCheckin(QUESTIONS, RULES, { mood: '4', self_harm: 'no' });
      expect(result.status).toBe('green');
    });
  });

  describe('validateQuestions', () => {
    it('accepts a well-formed question set', () => {
      expect(validateQuestions(QUESTIONS)).toEqual(QUESTIONS);
    });

    it('rejects an empty array', () => {
      expect(() => validateQuestions([])).toThrow(BadRequestException);
    });

    it('rejects a duplicate question id', () => {
      expect(() => validateQuestions([...QUESTIONS, QUESTIONS[0]])).toThrow(BadRequestException);
    });

    it('rejects a choice question with fewer than two options', () => {
      expect(() =>
        validateQuestions([{ id: 'q', text: 'text', type: 'choice', required: true, options: [{ value: 'a', label: 'A' }] }]),
      ).toThrow(BadRequestException);
    });

    it('rejects an unknown question type', () => {
      expect(() => validateQuestions([{ id: 'q', text: 'text', type: 'essay', required: true }])).toThrow(BadRequestException);
    });
  });

  describe('validateRedFlagRules', () => {
    it('accepts well-formed rules against their question set', () => {
      expect(validateRedFlagRules(RULES, QUESTIONS)).toEqual(RULES);
    });

    it('rejects a rule referencing an unknown question', () => {
      expect(() =>
        validateRedFlagRules([{ id: 'x', questionId: 'nope', matchValues: ['yes'], severity: 'red', reason: 'x' }], QUESTIONS),
      ).toThrow(BadRequestException);
    });

    it('rejects a rule whose matchValue the question cannot produce', () => {
      expect(() =>
        validateRedFlagRules(
          [{ id: 'x', questionId: 'self_harm', matchValues: ['maybe'], severity: 'red', reason: 'x' }],
          QUESTIONS,
        ),
      ).toThrow(BadRequestException);
    });

    it('rejects a rule with an unknown severity', () => {
      expect(() =>
        validateRedFlagRules(
          [{ id: 'x', questionId: 'self_harm', matchValues: ['yes'], severity: 'orange', reason: 'x' }],
          QUESTIONS,
        ),
      ).toThrow(BadRequestException);
    });

    it('rejects a reason over 255 characters', () => {
      expect(() =>
        validateRedFlagRules(
          [{ id: 'x', questionId: 'self_harm', matchValues: ['yes'], severity: 'red', reason: 'a'.repeat(256) }],
          QUESTIONS,
        ),
      ).toThrow(BadRequestException);
    });
  });

  describe('validateAnswers', () => {
    it('accepts a complete, valid answer set', () => {
      expect(validateAnswers({ mood: '3', self_harm: 'no', sleep: 'same' }, QUESTIONS)).toEqual({
        mood: '3',
        self_harm: 'no',
        sleep: 'same',
      });
    });

    it('allows an optional question to be omitted', () => {
      expect(validateAnswers({ mood: '3', self_harm: 'no' }, QUESTIONS)).toEqual({ mood: '3', self_harm: 'no' });
    });

    it('rejects a missing required answer', () => {
      expect(() => validateAnswers({ mood: '3' }, QUESTIONS)).toThrow(BadRequestException);
    });

    it('rejects an answer value the question does not offer', () => {
      expect(() => validateAnswers({ mood: '9', self_harm: 'no' }, QUESTIONS)).toThrow(BadRequestException);
    });

    it('rejects a non-object payload', () => {
      expect(() => validateAnswers('nope', QUESTIONS)).toThrow(BadRequestException);
    });
  });
});
