import { randomUUID } from 'node:crypto';
import type { ConsultationParticipantRow } from '../../schema/consultation-participants.schema';
import type { CallParty } from './video-room.util';
import { deriveSession } from './video-session.util';

/**
 * *** FR-8.6's THREE DERIVED FIGURES, AND THE COLUMNS THAT DO NOT EXIST. ***
 *
 * `docs/erd.sql` on `consultation_participants`: "Call duration is the summed
 * intervals, first join is min(joined_at), and the party with NO row here is
 * the one that did not show — none of the three is stored." The absent columns
 * enforce that at the schema level; this spec is what enforces that the
 * derivation is actually right, because there is no stored copy to check it
 * against and nothing else in the system will ever notice a wrong number.
 *
 * The cases that matter are the ones a real mobile call produces: a reconnect,
 * two overlapping sockets during a network handover, one side arriving early
 * and waiting, and a leave event that never came.
 */

const CONSULTATION_ID = randomUUID();
const AT = (isoMinuteOffset: number, seconds = 0) =>
  new Date(Date.UTC(2026, 8, 4, 10, isoMinuteOffset, seconds));

let sidSeq = 0;
function row(
  party: CallParty,
  joinedAt: Date,
  leftAt: Date | null,
  disconnectReason: string | null = null,
): ConsultationParticipantRow {
  sidSeq += 1;
  return {
    livekitParticipantSid: `PA_${String(sidSeq).padStart(4, '0')}`,
    consultationId: CONSULTATION_ID,
    party,
    joinedAt,
    leftAt,
    disconnectReason,
  };
}

describe('deriveSession', () => {
  /** Well after every fixture below, so an OPEN connection is unambiguous. */
  const NOW = AT(120);

  describe('the no-show fact', () => {
    it('names BOTH parties when nobody ever connected', () => {
      const session = deriveSession(CONSULTATION_ID, [], NOW);

      expect(session.noShowParties).toEqual(['patient', 'doctor']);
      expect(session.patient.joined).toBe(false);
      expect(session.doctor.joined).toBe(false);
      expect(session.firstJoinedAt).toBeNull();
      expect(session.durationSeconds).toBe(0);
      expect(session.live).toBe(false);
    });

    it('names the ONE party with no row — which is exactly how the ERD defines a no-show', () => {
      const session = deriveSession(CONSULTATION_ID, [row('patient', AT(0), AT(10))], NOW);

      expect(session.noShowParties).toEqual(['doctor']);
      expect(session.patient.joined).toBe(true);
      expect(session.doctor.joined).toBe(false);
    });

    it('names nobody once both sides have a row, even a very short one', () => {
      const session = deriveSession(
        CONSULTATION_ID,
        [row('patient', AT(0), AT(10)), row('doctor', AT(9), AT(9, 1))],
        NOW,
      );
      expect(session.noShowParties).toEqual([]);
    });
  });

  describe('first join', () => {
    it('is min(joined_at) across BOTH parties', () => {
      const session = deriveSession(
        CONSULTATION_ID,
        [row('doctor', AT(5), AT(30)), row('patient', AT(2), AT(30))],
        NOW,
      );

      expect(session.firstJoinedAt).toEqual(AT(2));
      expect(session.patient.firstJoinedAt).toEqual(AT(2));
      expect(session.doctor.firstJoinedAt).toEqual(AT(5));
    });

    it('is the FIRST connection, not the latest, when a party reconnects', () => {
      const session = deriveSession(
        CONSULTATION_ID,
        [row('patient', AT(0), AT(5)), row('patient', AT(7), AT(20))],
        NOW,
      );
      expect(session.patient.firstJoinedAt).toEqual(AT(0));
      expect(session.patient.connectionCount).toBe(2);
    });
  });

  describe('duration', () => {
    it('is the time BOTH parties were connected, not the wall clock', () => {
      // The patient waits ten minutes alone, then the doctor joins for twenty.
      // A wall-clock reading would call this a thirty-minute consultation.
      const session = deriveSession(
        CONSULTATION_ID,
        [row('patient', AT(0), AT(30)), row('doctor', AT(10), AT(30))],
        NOW,
      );

      expect(session.durationSeconds).toBe(20 * 60);
      expect(session.patient.connectedSeconds).toBe(30 * 60);
      expect(session.doctor.connectedSeconds).toBe(20 * 60);
    });

    it('is zero when the two were never in the room at the same time', () => {
      // A real and unhappy case: the doctor joins just after the patient gives
      // up. Two rows, two non-trivial connections, and no consultation.
      const session = deriveSession(
        CONSULTATION_ID,
        [row('patient', AT(0), AT(10)), row('doctor', AT(12), AT(20))],
        NOW,
      );

      expect(session.durationSeconds).toBe(0);
      expect(session.noShowParties).toEqual([]);
      expect(session.patient.connectedSeconds).toBe(10 * 60);
    });

    it('bridges a reconnect: two overlaps on one side are summed, not just the first', () => {
      const session = deriveSession(
        CONSULTATION_ID,
        [
          row('doctor', AT(0), AT(60)),
          row('patient', AT(0), AT(10)),
          // Two minutes offline, then back for another ten.
          row('patient', AT(12), AT(22)),
        ],
        NOW,
      );

      expect(session.durationSeconds).toBe(20 * 60);
      expect(session.patient.connectionCount).toBe(2);
    });

    it('counts an OVERLAP on one side once, so connected time can never exceed the clock', () => {
      // A wifi-to-mobile handover holds both sockets open for a moment, and
      // LiveKit issues a new sid for the new one. Summing raw intervals would
      // report the patient as connected for longer than the call lasted.
      const session = deriveSession(
        CONSULTATION_ID,
        [row('patient', AT(0), AT(10)), row('patient', AT(9), AT(20)), row('doctor', AT(0), AT(20))],
        NOW,
      );

      expect(session.patient.connectedSeconds).toBe(20 * 60);
      expect(session.durationSeconds).toBe(20 * 60);
    });

    it('truncates rather than rounds — a 60.6 second call is 60 seconds', () => {
      const session = deriveSession(
        CONSULTATION_ID,
        [
          row('patient', AT(0), new Date(AT(0).getTime() + 60_600)),
          row('doctor', AT(0), new Date(AT(0).getTime() + 60_600)),
        ],
        NOW,
      );
      expect(session.durationSeconds).toBe(60);
    });

    it('clamps a leave that precedes its own join to zero rather than subtracting', () => {
      // Clock skew between LiveKit nodes, or a delivery that landed on the
      // wrong row. Without the clamp this would produce a NEGATIVE contribution
      // and a total that is nonsense.
      const session = deriveSession(
        CONSULTATION_ID,
        [row('patient', AT(10), AT(5)), row('doctor', AT(0), AT(20))],
        NOW,
      );

      expect(session.patient.connectedSeconds).toBe(0);
      expect(session.durationSeconds).toBe(0);
    });
  });

  describe('a live call', () => {
    it('treats an OPEN connection as running up to `now`, so the duration grows', () => {
      const session = deriveSession(
        CONSULTATION_ID,
        [row('patient', AT(0), null), row('doctor', AT(0), null)],
        AT(7),
      );

      expect(session.live).toBe(true);
      expect(session.durationSeconds).toBe(7 * 60);
      expect(session.patient.connected).toBe(true);
      // Not "they left at 10:07" — nobody has left.
      expect(session.lastLeftAt).toBeNull();
      expect(session.patient.lastLeftAt).toBeNull();
    });

    it('reports `live` while ANY connection is open, even after one side leaves', () => {
      const session = deriveSession(
        CONSULTATION_ID,
        [row('patient', AT(0), AT(5)), row('doctor', AT(0), null)],
        AT(10),
      );

      expect(session.live).toBe(true);
      expect(session.patient.connected).toBe(false);
      expect(session.patient.lastLeftAt).toEqual(AT(5));
      expect(session.doctor.connected).toBe(true);
    });

    it('reports `lastLeftAt` only once every connection is closed', () => {
      const session = deriveSession(
        CONSULTATION_ID,
        [row('patient', AT(0), AT(20)), row('doctor', AT(0), AT(18))],
        NOW,
      );

      expect(session.live).toBe(false);
      expect(session.lastLeftAt).toEqual(AT(20));
    });
  });

  describe('the rows themselves', () => {
    it('returns every connection, `joinedAt` ascending, with the disconnect reason verbatim', () => {
      const session = deriveSession(
        CONSULTATION_ID,
        [
          row('patient', AT(9), AT(20), 'CLIENT_INITIATED'),
          row('doctor', AT(2), AT(20), 'DUPLICATE_IDENTITY'),
        ],
        NOW,
      );

      expect(session.connections.map((connection) => connection.party)).toEqual(['doctor', 'patient']);
      expect(session.connections.map((connection) => connection.disconnectReason)).toEqual([
        'DUPLICATE_IDENTITY',
        'CLIENT_INITIATED',
      ]);
    });

    it('drops a row whose party is not one of the two a call can have', () => {
      // The CHECK constraint makes this unreachable through the write path, but
      // the COLUMN's type still permits `admin`/`system`, and every figure here
      // is defined per side. Dropping beats reshaping.
      const rogue = { ...row('patient', AT(0), AT(5)), party: 'admin' as CallParty };
      const session = deriveSession(CONSULTATION_ID, [rogue], NOW);

      expect(session.connections).toEqual([]);
      expect(session.noShowParties).toEqual(['patient', 'doctor']);
    });
  });
});
