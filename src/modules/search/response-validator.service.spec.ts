import { Logger } from '@nestjs/common';
import { ResponseValidatorService, extractReferenceTokens, validateProse } from './response-validator.service';

const RESOLVED = new Set(['{{specialty:psychiatry}}', '{{specialty:psychology}}', '{{concern:sleep}}', '{{concern:anxiety}}']);

describe('extractReferenceTokens', () => {
  it('finds every token in order, duplicates included', () => {
    expect(extractReferenceTokens('see a {{specialty:psychiatry}} about {{concern:sleep}} and {{concern:sleep}}')).toEqual([
      { token: '{{specialty:psychiatry}}', type: 'specialty', code: 'psychiatry' },
      { token: '{{concern:sleep}}', type: 'concern', code: 'sleep' },
      { token: '{{concern:sleep}}', type: 'concern', code: 'sleep' },
    ]);
  });

  it('does not carry regex state between calls', () => {
    const text = 'a {{concern:sleep}} b';
    expect(extractReferenceTokens(text)).toHaveLength(1);
    expect(extractReferenceTokens(text)).toHaveLength(1);
  });

  it('ignores malformed or unknown token types', () => {
    expect(extractReferenceTokens('{{doctor:someone}} {{concern:}} {{ concern:sleep }}')).toEqual([]);
  });
});

describe('validateProse — the compliance guardrail', () => {
  describe('accepts safe navigation prose', () => {
    it.each([
      'You can talk to a {{specialty:psychiatry}} about {{concern:sleep}}.',
      'These professionals help with {{concern:anxiety}}. You can book whoever suits you.',
      'A {{specialty:psychology}} may be a good place to start.',
      'Here are people you can speak to about what you described.',
    ])('accepts %p', (text) => {
      expect(validateProse(text, RESOLVED)).toEqual({ accepted: true });
    });

    it('accepts prose with no tokens at all', () => {
      expect(validateProse('You can browse by concern below.', RESOLVED).accepted).toBe(true);
    });

    it('does not trip the deny-list on a CODE inside a token', () => {
      // A concern code could contain a denied substring; tokens are stripped
      // before the language check, and the label a client substitutes is
      // curated, not model-written.
      const withResolved = new Set(['{{concern:severe_anxiety}}']);
      expect(validateProse('You can talk about {{concern:severe_anxiety}}.', withResolved).accepted).toBe(true);
    });
  });

  describe('rejects each deny-list category', () => {
    const cases: Array<[string, string]> = [
      ['attribution', 'You may have something that a {{specialty:psychiatry}} can help with.'],
      ['attribution (sounds like)', 'It sounds like you have a problem worth discussing.'],
      ['attribution (suggests possible)', 'What you wrote suggests possible difficulties.'],
      ['attribution (consistent with)', 'Your description is consistent with what these professionals see.'],
      ['diagnosis stem', 'We cannot diagnose you, but here are professionals.'],
      ['diagnosis stem (diagnosed)', 'You may be diagnosed after a consultation.'],
      ['diagnosis (your condition)', 'A professional can explain your condition.'],
      ['diagnosis (symptoms suggest)', 'Your symptoms suggest talking to someone.'],
      ['severity (mild)', 'This looks mild and can wait.'],
      ['severity (severe)', 'This appears severe.'],
      ['severity (chronic)', 'This may be a chronic issue.'],
      ['triage (urgent)', 'This is urgent, please book today.'],
      ['triage (high risk)', 'You appear to be high risk.'],
      ['probability (likely)', 'You are likely to benefit from talking to someone.'],
      ['probability (probably)', 'You probably need to see someone.'],
      ['probability (chances are)', 'Chances are this will improve.'],
      ['treatment (medication)', 'You may need medication for this.'],
      ['treatment (prescri* stem)', 'A doctor can prescribe something.'],
      ['treatment (treatment plan)', 'Here is a treatment plan to follow.'],
      ['treatment (cure)', 'Talking will cure this.'],
      ['screening', 'This screening indicates you should see someone.'],
      ['assessment', 'Our assessment shows you need support.'],
      ['based on your symptoms', 'Based on your symptoms, see a {{specialty:psychiatry}}.'],
    ];

    it.each(cases)('rejects %s', (_label, text) => {
      const result = validateProse(text, RESOLVED);
      expect(result.accepted).toBe(false);
      if (!result.accepted) expect(result.rejection.kind).toBe('denied_language');
    });

    it('names the offending construction, so a log line is specific', () => {
      const result = validateProse('You may have trouble.', RESOLVED);
      expect(result.accepted).toBe(false);
      if (!result.accepted && result.rejection.kind === 'denied_language') {
        expect(result.rejection.construction).toBe('you may have');
      }
    });

    it('matches denied language at WORD BOUNDARIES, not as substrings', () => {
      // "mild" is denied; "mildew" must not trip it. "acute" is denied;
      // "acutely" is a continuation and DOES trip, which is the safe
      // direction for a compliance deny-list.
      expect(validateProse('There is mildew on the wall.', RESOLVED).accepted).toBe(true);
    });

    it('is punctuation- and case-insensitive', () => {
      expect(validateProse('YOU MAY HAVE... something.', RESOLVED).accepted).toBe(false);
    });
  });

  describe('rejects unresolvable reference tokens — the hallucination guard', () => {
    it('rejects a token naming a specialty that does not exist', () => {
      const result = validateProse('See a {{specialty:neurosurgery}}.', RESOLVED);
      expect(result.accepted).toBe(false);
      if (!result.accepted) {
        expect(result.rejection.kind).toBe('unresolvable_token');
        if (result.rejection.kind === 'unresolvable_token') expect(result.rejection.token).toBe('{{specialty:neurosurgery}}');
      }
    });

    it('rejects a token naming a concern that does not exist', () => {
      expect(validateProse('About {{concern:bipolar}}.', RESOLVED).accepted).toBe(false);
    });

    it('rejects when ONE of several tokens is unresolvable', () => {
      expect(validateProse('A {{specialty:psychiatry}} about {{concern:invented}}.', RESOLVED).accepted).toBe(false);
    });

    it('checks tokens BEFORE language, so an invented token is reported as such', () => {
      const result = validateProse('You may have {{concern:invented}}.', RESOLVED);
      expect(result.accepted).toBe(false);
      if (!result.accepted) expect(result.rejection.kind).toBe('unresolvable_token');
    });

    it('rejects every token when the resolved set is empty', () => {
      expect(validateProse('See a {{specialty:psychiatry}}.', new Set()).accepted).toBe(false);
    });
  });
});

describe('ResponseValidatorService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('passes safe prose through', () => {
    expect(new ResponseValidatorService().validate('Talk to a {{specialty:psychiatry}}.', RESOLVED)).toEqual({ accepted: true });
  });

  it('LOGS a denied-language rejection so model drift is visible', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const result = new ResponseValidatorService().validate('You may have insomnia.', RESOLVED);

    expect(result.accepted).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('denied construction "you may have"');
  });

  it('LOGS an unresolvable-token rejection with the offending token', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    new ResponseValidatorService().validate('See a {{specialty:invented}}.', RESOLVED);

    expect(warn.mock.calls[0]?.[0]).toContain('unresolvable reference token "{{specialty:invented}}"');
  });

  it('does not log when prose is accepted', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    new ResponseValidatorService().validate('Talk to a {{specialty:psychiatry}}.', RESOLVED);
    expect(warn).not.toHaveBeenCalled();
  });
});
