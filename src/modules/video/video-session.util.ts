import type { ConsultationParticipantRow } from '../../schema/consultation-participants.schema';
import type { VideoConnectionView, VideoPartySessionView, VideoSessionView } from './video.contract';
import { CALL_PARTY_LIST, isCallParty, type CallParty } from './video-room.util';

/**
 * *** DURATION, FIRST JOIN AND NO-SHOW ARE COMPUTED HERE AND STORED NOWHERE.
 * ***
 *
 * `docs/erd.sql` on `consultation_participants`: "Call duration is the summed
 * intervals, first join is min(joined_at), and the party with NO row here is
 * the one that did not show — none of the three is stored." The absent columns
 * are what ENFORCE that, and this file is the other half: every derived figure
 * in `VideoSessionView` comes out of these pure functions, so there is exactly
 * one definition of each and no way for a cached copy to disagree with the rows.
 *
 * Pure and synchronous, with `now` passed in rather than read — a duration
 * computed from a clock a test cannot move is a duration nobody can assert on.
 */

/** A half-open interval `[start, end)`, milliseconds since epoch. */
interface Interval {
  start: number;
  end: number;
}

/**
 * The whole derivation, from rows to view.
 *
 * `now` is used for one thing only: an OPEN connection (`left_at IS NULL`) is
 * treated as running up to `now`. That is the honest reading of the column —
 * `docs/erd.sql` says null means "still connected, or the webhook never
 * arrived" — and it is what makes a live call report a growing duration
 * instead of zero. It also means a connection whose `participant_left` webhook
 * was lost inflates that party's total indefinitely; the alternative (treating
 * an open connection as zero-length) understates every live call, which is the
 * worse of the two errors because it is silently wrong during the call itself
 * rather than visibly wrong afterwards.
 */
export function deriveSession(
  consultationId: string,
  rows: readonly ConsultationParticipantRow[],
  now: Date,
): VideoSessionView {
  // `party` is a `party` enum column carrying `patient`/`doctor` (its CHECK
  // constraint allows nothing else), but the column's TYPE also permits
  // `admin`/`system`. A row that somehow held one is dropped rather than
  // reshaped: it is not a side of a call, and every figure below is defined
  // per side.
  const connections: VideoConnectionView[] = rows
    .filter((row) => isCallParty(row.party))
    .map((row) => ({
      participantSid: row.livekitParticipantSid,
      party: row.party as CallParty,
      joinedAt: row.joinedAt,
      leftAt: row.leftAt,
      disconnectReason: row.disconnectReason,
    }))
    .sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime());

  const patient = derivePartySession('patient', connections, now);
  const doctor = derivePartySession('doctor', connections, now);

  const firstJoins = [patient.firstJoinedAt, doctor.firstJoinedAt].filter((at): at is Date => at !== null);
  const live = connections.some((connection) => connection.leftAt === null);

  return {
    consultationId,
    connections,
    patient,
    doctor,
    firstJoinedAt: firstJoins.length === 0 ? null : new Date(Math.min(...firstJoins.map((at) => at.getTime()))),
    // Null while ANYONE is still connected — a "last left" for a call that has
    // not ended would be a lie a UI would print as an end time.
    lastLeftAt: live ? null : latestLeftAt(connections),
    durationSeconds: overlapSeconds(intervalsFor(connections, 'patient', now), intervalsFor(connections, 'doctor', now)),
    noShowParties: CALL_PARTY_LIST.filter((party) => !connections.some((connection) => connection.party === party)),
    live,
  };
}

/**
 * One side of the call.
 *
 * `connectedSeconds` MERGES overlapping connections before summing. Overlap is
 * real and ordinary: a phone that switches from wifi to mobile data can hold
 * both sockets open for a second or two, and LiveKit issues a new sid for the
 * new one. Summing the raw intervals would then count that second twice and
 * make a party's connected time exceed the wall clock, which is the kind of
 * figure that quietly discredits a whole screen.
 */
function derivePartySession(
  party: CallParty,
  connections: readonly VideoConnectionView[],
  now: Date,
): VideoPartySessionView {
  const own = connections.filter((connection) => connection.party === party);

  if (own.length === 0) {
    return {
      party,
      joined: false,
      firstJoinedAt: null,
      lastLeftAt: null,
      connected: false,
      connectionCount: 0,
      connectedSeconds: 0,
    };
  }

  const connected = own.some((connection) => connection.leftAt === null);

  return {
    party,
    joined: true,
    firstJoinedAt: new Date(Math.min(...own.map((connection) => connection.joinedAt.getTime()))),
    lastLeftAt: connected ? null : latestLeftAt(own),
    connected,
    connectionCount: own.length,
    connectedSeconds: totalSeconds(merge(intervalsFor(own, party, now))),
  };
}

/** `max(left_at)` over connections that have one. Null when none has. */
function latestLeftAt(connections: readonly VideoConnectionView[]): Date | null {
  const times = connections
    .map((connection) => connection.leftAt)
    .filter((at): at is Date => at !== null)
    .map((at) => at.getTime());
  return times.length === 0 ? null : new Date(Math.max(...times));
}

/**
 * One party's connections as intervals.
 *
 * An open connection ends at `now`; see `deriveSession`'s header. A connection
 * whose `left_at` somehow precedes its `joined_at` — clock skew between LiveKit
 * nodes, or an out-of-order delivery that landed on the wrong row — is clamped
 * to zero length rather than allowed to subtract from a total.
 */
function intervalsFor(
  connections: readonly VideoConnectionView[],
  party: CallParty,
  now: Date,
): Interval[] {
  return connections
    .filter((connection) => connection.party === party)
    .map((connection) => {
      const start = connection.joinedAt.getTime();
      const end = (connection.leftAt ?? now).getTime();
      return { start, end: Math.max(start, end) };
    });
}

/** Merges overlapping and touching intervals into a minimal disjoint set. */
function merge(intervals: readonly Interval[]): Interval[] {
  if (intervals.length === 0) return [];

  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged: Interval[] = [{ ...sorted[0] }];

  for (const interval of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    if (interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end);
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

/** Whole seconds covered by a disjoint interval set. Truncated, not rounded — a call is not 61 seconds long because it ran for 60.6. */
function totalSeconds(intervals: readonly Interval[]): number {
  return Math.floor(intervals.reduce((total, interval) => total + (interval.end - interval.start), 0) / 1000);
}

/**
 * *** THE CONSULTATION'S LENGTH: the time BOTH parties were connected at once.
 * ***
 *
 * Not the sum of the two parties' connected time, and not the wall clock from
 * first join to last leave. A patient who joins ten minutes early and waits
 * alone has not had a ten-minute consultation, and a doctor reading the
 * history in an empty room has not either. When a refund or a
 * `technical_issue` complaint asks "how long did they actually talk", this is
 * the number that answers it.
 *
 * Both sides are merged first, so a reconnect on either side cannot
 * double-count the overlap.
 */
function overlapSeconds(patientIntervals: readonly Interval[], doctorIntervals: readonly Interval[]): number {
  const patient = merge(patientIntervals);
  const doctor = merge(doctorIntervals);

  const intersection: Interval[] = [];
  let patientAt = 0;
  let doctorAt = 0;

  while (patientAt < patient.length && doctorAt < doctor.length) {
    const start = Math.max(patient[patientAt].start, doctor[doctorAt].start);
    const end = Math.min(patient[patientAt].end, doctor[doctorAt].end);
    if (start < end) intersection.push({ start, end });

    // Advance whichever interval ends first — both lists are disjoint and
    // sorted, so nothing before that point can intersect anything again.
    if (patient[patientAt].end < doctor[doctorAt].end) patientAt += 1;
    else doctorAt += 1;
  }

  return totalSeconds(intersection);
}
