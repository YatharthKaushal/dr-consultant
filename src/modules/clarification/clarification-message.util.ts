import { BadRequestException } from '@nestjs/common';
import type { ClarificationMessage } from './clarification.contract';
import { CLARIFICATION_ERROR_CODES, CLARIFICATION_MAX_MESSAGES } from './clarification.constants';

const VALID_MESSAGE_TYPES: readonly ClarificationMessage['messageType'][] = [
  'comment',
  'clinical_consideration',
  'clarification_request',
  'followup_advice',
];
const VALID_AUTHOR_TYPES: readonly ClarificationMessage['authorType'][] = ['doctor', 'admin'];

/**
 * `clarification_cases.messages` is `jsonb().$type<unknown[]>()` — what comes
 * back from Postgres is genuinely unknown at the type level, exactly the
 * situation `clinical-medicine.util.ts#parseMedicineLines` argues for
 * `clinical_records.medicines`. Re-parsed on every read rather than cast, so
 * a row written before this shape was pinned down is exactly the case that
 * gets caught instead of silently trusted.
 */
export function parseClarificationMessages(raw: unknown): ClarificationMessage[] {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new Error('clarification_cases.messages was not an array — should be unreachable, the column defaults to [].');
  }
  return raw.map((entry, index) => parseOne(entry, index));
}

function parseOne(entry: unknown, index: number): ClarificationMessage {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new Error(`clarification_cases.messages[${index}] was not an object — should be unreachable.`);
  }
  const record = entry as Record<string, unknown>;
  if (typeof record.authorId !== 'string' || record.authorId.length === 0) {
    throw new Error(`clarification_cases.messages[${index}].authorId was missing or not a string.`);
  }
  if (!VALID_AUTHOR_TYPES.includes(record.authorType as ClarificationMessage['authorType'])) {
    throw new Error(`clarification_cases.messages[${index}].authorType was not a recognised author type.`);
  }
  if (!VALID_MESSAGE_TYPES.includes(record.messageType as ClarificationMessage['messageType'])) {
    throw new Error(`clarification_cases.messages[${index}].messageType was not a recognised message type.`);
  }
  if (typeof record.body !== 'string') {
    throw new Error(`clarification_cases.messages[${index}].body was missing or not a string.`);
  }
  if (typeof record.at !== 'string') {
    throw new Error(`clarification_cases.messages[${index}].at was missing or not a string.`);
  }
  return {
    authorId: record.authorId,
    authorType: record.authorType as ClarificationMessage['authorType'],
    messageType: record.messageType as ClarificationMessage['messageType'],
    body: record.body,
    at: record.at,
  };
}

/**
 * Appends one message to an existing, already-parsed array — a plain JS
 * array operation, not SQL (`clarification.repository.ts` has no
 * jsonb-append helper; the service reads the row under the row lock,
 * appends here, and writes the whole array back in the same guarded
 * `UPDATE`, `clinical.repository.ts#updateDraft`'s read-modify-write shape
 * applied to an array column instead of scalar ones).
 *
 * Refuses past `CLARIFICATION_MAX_MESSAGES` rather than silently truncating
 * — a truncated thread would quietly drop a clinical exchange.
 */
export function appendClarificationMessage(
  existing: ClarificationMessage[],
  message: ClarificationMessage,
): ClarificationMessage[] {
  if (existing.length >= CLARIFICATION_MAX_MESSAGES) {
    throw new BadRequestException({
      code: CLARIFICATION_ERROR_CODES.MESSAGE_LIMIT_REACHED,
      message: `This case already carries the maximum of ${CLARIFICATION_MAX_MESSAGES} messages.`,
    });
  }
  return [...existing, message];
}
