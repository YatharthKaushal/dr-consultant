import type { Party } from '../../schema/enums.schema';
import { VIDEO_IDENTITY_SEPARATOR, VIDEO_ROOM_NAME_PREFIX } from './video.constants';

/**
 * *** THE ROOM IS A FUNCTION OF THE CONSULTATION ID, AND THIS FILE IS THAT
 * FUNCTION. ***
 *
 * `docs/erd.sql` on `consultation_participants.consultation_id`: "parsed from
 * the room name, which is a function of this id". There is no rooms table, so
 * these four pure functions ARE the room registry — `roomNameFor` is called
 * when a token is minted and `consultationIdFromRoomName` when a webhook
 * arrives, and the two agree because they are inverses of each other and are
 * tested as a round trip.
 *
 * Everything here is pure and synchronous on purpose: no database, no clock, no
 * LiveKit. That is what makes it exhaustively testable, and it is why the
 * webhook path can trust a room name it did not mint.
 *
 * ── WHY THE PARSERS ARE STRICT ─────────────────────────────────────────────
 *
 * Both parsers return `null` rather than throwing, and both VALIDATE rather
 * than merely slicing. The room name and the participant identity arrive from
 * OUTSIDE — a LiveKit webhook body — and although the body's signature has been
 * verified by the time they are read, the values inside it are still strings a
 * misconfigured server, a second application sharing the same LiveKit project,
 * or a future SDK could put anything in. A lenient parser would turn
 * `consult-<not a uuid>` into a `consultation_id` that Postgres then rejects
 * with `22P02` at insert time, which surfaces as a 500 on a webhook that must
 * answer 2xx. Rejecting it here, cleanly, is the difference between "ignored,
 * one log line" and "retry storm".
 */

/**
 * The UUID shape a `uuid` column accepts. Not pinned to a version, for the
 * reason `shared/errors/uuid-param.pipe.ts` gives: ids are created with
 * `gen_random_uuid()`, and pinning would risk rejecting a legitimately stored
 * id on a technicality.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The only two `party` values `consultation_participants` accepts — its CHECK
 * constraint says so ("Only `party = patient` and `party = doctor` are ever
 * written"), and a video call has exactly two sides. `admin` and `system` exist
 * on the shared `party` enum for other tables.
 */
const CALL_PARTIES = ['patient', 'doctor'] as const;
export type CallParty = (typeof CALL_PARTIES)[number];

/** The room a consultation's call runs in. `consult-<uuid>`. */
export function roomNameFor(consultationId: string): string {
  return `${VIDEO_ROOM_NAME_PREFIX}${consultationId}`;
}

/**
 * The consultation a room name belongs to, or `null` if the name is not one of
 * ours.
 *
 * `null` is a NORMAL outcome, not a failure: one LiveKit deployment can host
 * more than one application, and a room this platform did not create is simply
 * not this platform's business. The webhook logs and ignores it.
 */
export function consultationIdFromRoomName(roomName: string | null | undefined): string | null {
  if (typeof roomName !== 'string' || !roomName.startsWith(VIDEO_ROOM_NAME_PREFIX)) return null;
  const candidate = roomName.slice(VIDEO_ROOM_NAME_PREFIX.length);
  return UUID_PATTERN.test(candidate) ? candidate.toLowerCase() : null;
}

/**
 * The LiveKit participant identity for one side of one consultation.
 *
 * *** THIS IS THE ONLY THING THAT SAYS WHICH SIDE CONNECTED. *** A
 * `participant_joined` webhook carries a room, a sid and an identity — no
 * patient id and no doctor id — so `consultation_participants.party` can only
 * come from here. It is re-checked against the booking on the way in
 * (`video-webhook.service.ts#resolveParty`), because an identity is a string
 * LiveKit echoed back, not an assertion this module should take on trust.
 */
export function participantIdentityFor(party: CallParty, accountId: string): string {
  return `${party}${VIDEO_IDENTITY_SEPARATOR}${accountId}`;
}

/** One parsed participant identity. */
export interface ParsedIdentity {
  party: CallParty;
  accountId: string;
}

/**
 * Splits `<party>:<uuid>`, or `null` if it is not one of ours.
 *
 * Splits on the FIRST separator and validates both halves. `party` must be
 * `patient` or `doctor` — the two the CHECK constraint allows — and the account
 * id must be a well-formed uuid, so a hostile or broken identity cannot become
 * a `party` value the database will reject or a uuid Postgres will refuse.
 */
export function parseParticipantIdentity(identity: string | null | undefined): ParsedIdentity | null {
  if (typeof identity !== 'string') return null;

  const separatorAt = identity.indexOf(VIDEO_IDENTITY_SEPARATOR);
  if (separatorAt <= 0) return null;

  const party = identity.slice(0, separatorAt);
  const accountId = identity.slice(separatorAt + VIDEO_IDENTITY_SEPARATOR.length);

  if (!(CALL_PARTIES as readonly string[]).includes(party)) return null;
  if (!UUID_PATTERN.test(accountId)) return null;

  return { party: party as CallParty, accountId: accountId.toLowerCase() };
}

/** Narrows the shared `party` enum to the two a call can have. Used where a `Party` from another module's view has to become a `CallParty`. */
export function isCallParty(party: Party | string): party is CallParty {
  return (CALL_PARTIES as readonly string[]).includes(party);
}

/** The two sides, in a fixed order, for anything that has to iterate them. */
export const CALL_PARTY_LIST: readonly CallParty[] = CALL_PARTIES;
