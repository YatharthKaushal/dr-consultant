import { BadRequestException } from '@nestjs/common';
import { CLARIFICATION_MAX_MESSAGES } from './clarification.constants';
import type { ClarificationMessage } from './clarification.contract';
import { appendClarificationMessage, parseClarificationMessages } from './clarification-message.util';

const MESSAGE: ClarificationMessage = {
  authorId: '11111111-1111-4111-8111-111111111111',
  authorType: 'doctor',
  messageType: 'comment',
  body: 'Consider a dose increase first.',
  at: '2026-09-01T00:00:00.000Z',
};

describe('parseClarificationMessages', () => {
  it('returns [] for null/undefined — the column default', () => {
    expect(parseClarificationMessages(null)).toEqual([]);
    expect(parseClarificationMessages(undefined)).toEqual([]);
  });

  it('round-trips a well-formed array unchanged', () => {
    expect(parseClarificationMessages([MESSAGE])).toEqual([MESSAGE]);
  });

  it('throws on a row whose messages column is not an array', () => {
    expect(() => parseClarificationMessages('not-an-array')).toThrow();
  });

  it('throws on an entry missing a required field', () => {
    expect(() => parseClarificationMessages([{ ...MESSAGE, body: undefined }])).toThrow();
  });

  it('throws on an entry with an unrecognised messageType', () => {
    expect(() => parseClarificationMessages([{ ...MESSAGE, messageType: 'diagnosis' }])).toThrow();
  });
});

describe('appendClarificationMessage', () => {
  it('appends without mutating the original array', () => {
    const existing: ClarificationMessage[] = [];
    const result = appendClarificationMessage(existing, MESSAGE);

    expect(result).toEqual([MESSAGE]);
    expect(existing).toEqual([]);
  });

  it('refuses once the array is already at the cap, rather than silently truncating', () => {
    const full = Array.from({ length: CLARIFICATION_MAX_MESSAGES }, () => MESSAGE);

    expect(() => appendClarificationMessage(full, MESSAGE)).toThrow(BadRequestException);
  });
});
