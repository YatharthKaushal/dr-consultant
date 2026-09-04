import { BadRequestException } from '@nestjs/common';
import type { ComplaintMessage } from './feedback.contract';
import { COMPLAINT_ERROR_CODES, COMPLAINT_MAX_MESSAGES } from './feedback.constants';

const VALID_AUTHOR_TYPES: readonly ComplaintMessage['authorType'][] = ['patient', 'admin'];

/**
 * `complaints.messages` is `jsonb().$type<unknown[]>()` — what comes back
 * from Postgres is genuinely unknown at the type level, exactly
 * `clarification-message.util.ts#parseClarificationMessages`'s situation.
 * Re-parsed on every read rather than cast, so a row written before this
 * shape was pinned down is exactly the case that gets caught instead of
 * silently trusted.
 */
export function parseComplaintMessages(raw: unknown): ComplaintMessage[] {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error('complaints.messages was not an array — should be unreachable, the column defaults to [].');
  }
  return raw.map((entry, index) => parseOne(entry, index));
}

function parseOne(entry: unknown, index: number): ComplaintMessage {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new Error(`complaints.messages[${index}] was not an object — should be unreachable.`);
  }
  const record = entry as Record<string, unknown>;
  if (typeof record.authorId !== 'string' || record.authorId.length === 0) {
    throw new Error(`complaints.messages[${index}].authorId was missing or not a string.`);
  }
  if (!VALID_AUTHOR_TYPES.includes(record.authorType as ComplaintMessage['authorType'])) {
    throw new Error(`complaints.messages[${index}].authorType was not a recognised author type.`);
  }
  if (typeof record.body !== 'string') {
    throw new Error(`complaints.messages[${index}].body was missing or not a string.`);
  }
  if (typeof record.isInternal !== 'boolean') {
    throw new Error(`complaints.messages[${index}].isInternal was missing or not a boolean.`);
  }
  if (typeof record.at !== 'string') {
    throw new Error(`complaints.messages[${index}].at was missing or not a string.`);
  }
  return {
    authorId: record.authorId,
    authorType: record.authorType as ComplaintMessage['authorType'],
    body: record.body,
    isInternal: record.isInternal,
    at: record.at,
  };
}

/**
 * Appends one message to an existing, already-parsed array — a plain JS
 * array operation, not SQL, `clarification-message.util.ts
 * #appendClarificationMessage`'s shape: the service reads the row under the
 * row lock, appends here, and writes the whole array back in the same
 * guarded `UPDATE`.
 *
 * Refuses past `COMPLAINT_MAX_MESSAGES` rather than silently truncating — a
 * truncated thread would quietly drop part of a complaint's history.
 */
export function appendComplaintMessage(existing: ComplaintMessage[], message: ComplaintMessage): ComplaintMessage[] {
  if (existing.length >= COMPLAINT_MAX_MESSAGES) {
    throw new BadRequestException({
      code: COMPLAINT_ERROR_CODES.MESSAGE_LIMIT_REACHED,
      message: `This complaint already carries the maximum of ${COMPLAINT_MAX_MESSAGES} messages.`,
    });
  }
  return [...existing, message];
}

/**
 * *** THE ONE PLACE `isInternal` IS ENFORCED. *** A patient's own view of a
 * complaint's thread never includes a message an admin marked internal —
 * built by filtering, field by field, never by trusting a caller to have
 * filtered upstream. Every patient-facing read in this module
 * (`complaint.service.ts#getOwnComplaint`/`listOwnComplaints`) routes its
 * `messages` through this function before they reach `feedback.mapper.ts`.
 */
export function toPatientVisibleMessages(messages: ComplaintMessage[]): ComplaintMessage[] {
  return messages.filter((message) => !message.isInternal);
}
