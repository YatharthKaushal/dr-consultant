import { randomUUID } from 'node:crypto';
import {
  consultationIdFromRoomName,
  isCallParty,
  parseParticipantIdentity,
  participantIdentityFor,
  roomNameFor,
} from './video-room.util';

/**
 * *** THE ROOM REGISTRY IS THESE FUNCTIONS, SO THEY ARE TESTED AS ONE. ***
 *
 * There is no rooms table (`docs/erd.sql` gives M-14 one table and fixes the
 * room as "a function of this id"), which means `roomNameFor` and
 * `consultationIdFromRoomName` between them ARE the mapping from a LiveKit room
 * back to a consultation. If they ever stop being inverses, a webhook silently
 * writes session metadata against the wrong consultation — or, more likely,
 * against none — and nothing errors.
 *
 * The parsers get the harder half of the attention: they read strings that came
 * from OUTSIDE, and although the delivery carrying them was signature-verified,
 * the values inside it are not this platform's to trust.
 */
describe('video-room.util', () => {
  describe('roomNameFor / consultationIdFromRoomName', () => {
    it('round-trips a consultation id', () => {
      const consultationId = randomUUID();
      expect(consultationIdFromRoomName(roomNameFor(consultationId))).toBe(consultationId);
    });

    it('produces the documented `consult-<uuid>` shape', () => {
      const consultationId = '11111111-2222-3333-4444-555555555555';
      expect(roomNameFor(consultationId)).toBe('consult-11111111-2222-3333-4444-555555555555');
    });

    it.each([
      ['a room from another application', 'standup-2026-09-04'],
      ['the prefix with no id', 'consult-'],
      ['the prefix with something that is not a uuid', 'consult-not-a-uuid'],
      ['a uuid with no prefix', '11111111-2222-3333-4444-555555555555'],
      ['a near-miss prefix', 'consultation-11111111-2222-3333-4444-555555555555'],
      ['an empty name', ''],
    ])('refuses %s', (_label, roomName) => {
      expect(consultationIdFromRoomName(roomName)).toBeNull();
    });

    it('refuses a null or undefined room name rather than throwing', () => {
      // LiveKit sets `room` on every event this module acts on, but the
      // webhook handler must not be one bad delivery away from a 500 — it has
      // to answer 2xx.
      expect(consultationIdFromRoomName(null)).toBeNull();
      expect(consultationIdFromRoomName(undefined)).toBeNull();
    });

    it('refuses a room name that merely STARTS with a valid one', () => {
      // A lenient `slice` would have accepted this and produced a valid-looking
      // consultation id with trailing rubbish attached.
      expect(consultationIdFromRoomName(`${roomNameFor(randomUUID())}-shadow`)).toBeNull();
    });

    it('normalises an upper-case uuid, so one room cannot look like two consultations', () => {
      const consultationId = '11111111-2222-3333-4444-555555555555';
      expect(consultationIdFromRoomName(`consult-${consultationId.toUpperCase()}`)).toBe(consultationId);
    });
  });

  describe('participantIdentityFor / parseParticipantIdentity', () => {
    it.each(['patient', 'doctor'] as const)('round-trips a %s identity', (party) => {
      const accountId = randomUUID();
      expect(parseParticipantIdentity(participantIdentityFor(party, accountId))).toEqual({ party, accountId });
    });

    it('uses `:` and not `-`, because a uuid is full of hyphens', () => {
      // The whole reason for the separator choice. A `-` here would make the
      // identity unsplittable without ambiguity.
      const accountId = '11111111-2222-3333-4444-555555555555';
      expect(participantIdentityFor('doctor', accountId)).toBe(`doctor:${accountId}`);
    });

    it.each([
      ['a party the CHECK constraint forbids', `admin:${'11111111-2222-3333-4444-555555555555'}`],
      ['a party that is not on the enum at all', `nurse:${'11111111-2222-3333-4444-555555555555'}`],
      ['an account id that is not a uuid', 'patient:not-a-uuid'],
      ['no separator', 'patient'],
      ['a leading separator', ':11111111-2222-3333-4444-555555555555'],
      ['an empty identity', ''],
    ])('refuses %s', (_label, identity) => {
      expect(parseParticipantIdentity(identity)).toBeNull();
    });

    it('refuses `admin` and `system` specifically', () => {
      // `consultation_participants` has a CHECK that only `patient`/`doctor`
      // are ever written. If this parser let one through, the insert would fail
      // at the database with a constraint violation on a webhook that must
      // answer 2xx.
      const accountId = randomUUID();
      expect(parseParticipantIdentity(`admin:${accountId}`)).toBeNull();
      expect(parseParticipantIdentity(`system:${accountId}`)).toBeNull();
    });

    it('refuses a null or undefined identity rather than throwing', () => {
      expect(parseParticipantIdentity(null)).toBeNull();
      expect(parseParticipantIdentity(undefined)).toBeNull();
    });

    it('splits on the FIRST separator, so a colon inside the id cannot smuggle a second field', () => {
      expect(parseParticipantIdentity('patient:11111111-2222-3333-4444-555555555555:extra')).toBeNull();
    });
  });

  describe('isCallParty', () => {
    it('accepts the two a call can have and refuses the two it cannot', () => {
      expect(isCallParty('patient')).toBe(true);
      expect(isCallParty('doctor')).toBe(true);
      expect(isCallParty('admin')).toBe(false);
      expect(isCallParty('system')).toBe(false);
    });
  });
});
