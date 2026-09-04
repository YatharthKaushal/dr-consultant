import { BadRequestException } from '@nestjs/common';
import { COMPLAINT_MAX_MESSAGES } from './feedback.constants';
import type { ComplaintMessage } from './feedback.contract';
import { appendComplaintMessage, parseComplaintMessages, toPatientVisibleMessages } from './complaint-message.util';

const MESSAGE: ComplaintMessage = {
  authorId: '11111111-1111-4111-8111-111111111111',
  authorType: 'patient',
  body: 'The doctor was 20 minutes late.',
  isInternal: false,
  at: '2026-09-01T00:00:00.000Z',
};

const INTERNAL_MESSAGE: ComplaintMessage = {
  authorId: '22222222-2222-4222-8222-222222222222',
  authorType: 'admin',
  body: 'Waiting on the doctor to confirm.',
  isInternal: true,
  at: '2026-09-01T01:00:00.000Z',
};

describe('parseComplaintMessages', () => {
  it('returns [] for null/undefined — the column default', () => {
    expect(parseComplaintMessages(null)).toEqual([]);
    expect(parseComplaintMessages(undefined)).toEqual([]);
  });

  it('round-trips a well-formed array unchanged', () => {
    expect(parseComplaintMessages([MESSAGE, INTERNAL_MESSAGE])).toEqual([MESSAGE, INTERNAL_MESSAGE]);
  });

  it('throws on a row whose messages column is not an array', () => {
    expect(() => parseComplaintMessages('not-an-array')).toThrow();
  });

  it('throws on an entry missing isInternal', () => {
    expect(() => parseComplaintMessages([{ ...MESSAGE, isInternal: undefined }])).toThrow();
  });

  it('throws on an entry with an unrecognised authorType', () => {
    expect(() => parseComplaintMessages([{ ...MESSAGE, authorType: 'doctor' }])).toThrow();
  });
});

describe('appendComplaintMessage', () => {
  it('appends without mutating the original array', () => {
    const existing: ComplaintMessage[] = [];
    const result = appendComplaintMessage(existing, MESSAGE);

    expect(result).toEqual([MESSAGE]);
    expect(existing).toEqual([]);
  });

  it('refuses once the array is already at the cap, rather than silently truncating', () => {
    const full = Array.from({ length: COMPLAINT_MAX_MESSAGES }, () => MESSAGE);

    expect(() => appendComplaintMessage(full, MESSAGE)).toThrow(BadRequestException);
  });
});

describe('toPatientVisibleMessages', () => {
  it('drops every message an admin marked internal', () => {
    expect(toPatientVisibleMessages([MESSAGE, INTERNAL_MESSAGE])).toEqual([MESSAGE]);
  });

  it('keeps every non-internal message, patient- and admin-authored alike', () => {
    const adminPublic: ComplaintMessage = { ...INTERNAL_MESSAGE, isInternal: false };
    expect(toPatientVisibleMessages([MESSAGE, adminPublic])).toEqual([MESSAGE, adminPublic]);
  });
});
