import type { CallParty } from './video-room.util';

/**
 * What a client needs to connect, and NOTHING else.
 *
 * `token` is the short-lived JWT (FR-8.5). `serverUrl` is `LIVEKIT_URL`. Both
 * are useless without the other, which is why they travel together. The API
 * SECRET is not here and is not derivable from either — see
 * `livekit.client.ts`.
 */
export interface VideoJoinTicket {
  consultationId: string;
  /** `consult-<consultation uuid>`. Returned so a client can log it and a support engineer can correlate it with LiveKit's own dashboards. */
  roomName: string;
  /** The self-hosted LiveKit server (`wss://...`), one per deployment. */
  serverUrl: string;
  /** The signed join token. Short-lived — see `expiresAt`. */
  token: string;
  /** Which side of the consultation this ticket admits. */
  party: CallParty;
  /** The LiveKit participant identity inside the token. Handed back so a client can recognise its own participant in the room roster. */
  identity: string;
  /** When the TOKEN stops being usable to CONNECT. Not when the call ends — see `video.constants.ts#VIDEO_CONFIG_FALLBACKS`. */
  expiresAt: Date;
}

/** One LiveKit CONNECTION — one `consultation_participants` row. A reconnect is a second entry, never an edit of the first. */
export interface VideoConnectionView {
  /** `PA_xxx`. The table's primary key, and what makes webhook redelivery idempotent. */
  participantSid: string;
  party: CallParty;
  joinedAt: Date;
  /** Null = still connected, or the `participant_left` webhook never arrived. */
  leftAt: Date | null;
  /** LiveKit's `DisconnectReason`, verbatim. Not an enum: LiveKit owns that vocabulary. */
  disconnectReason: string | null;
}

/** One side of the call, summarised. Every field here is COMPUTED from the connection rows — none of it is stored. */
export interface VideoPartySessionView {
  party: CallParty;
  /** False = this party has no row at all, which is what names a no-show (`docs/erd.sql`). */
  joined: boolean;
  /** `min(joined_at)` for this party. */
  firstJoinedAt: Date | null;
  lastLeftAt: Date | null;
  /** Still holding at least one open connection. */
  connected: boolean;
  /** How many times this party connected. More than one means they dropped and came back. */
  connectionCount: number;
  /** The summed length of this party's connections, in whole seconds. Overlapping connections are counted once. */
  connectedSeconds: number;
}

/**
 * FR-8.6's session metadata: "join and leave times and call duration ...
 * stored and linked to the consultation ID".
 *
 * *** THE JOIN AND LEAVE TIMES ARE STORED; THE DURATION, THE FIRST JOIN AND
 * THE NO-SHOW ARE NOT. *** `docs/erd.sql` on `consultation_participants`:
 * "Call duration is the summed intervals, first join is min(joined_at), and
 * the party with NO row here is the one that did not show - none of the three
 * is stored." The absent columns are what enforce it, and this view is where
 * the three are derived. See `video-session.util.ts`.
 */
export interface VideoSessionView {
  consultationId: string;
  /** Every connection, `joinedAt` ascending. */
  connections: VideoConnectionView[];
  patient: VideoPartySessionView;
  doctor: VideoPartySessionView;
  /** `min(joined_at)` across both parties — when the call actually began. */
  firstJoinedAt: Date | null;
  /** `max(left_at)`, or null while anyone is still connected or a leave event never arrived. */
  lastLeftAt: Date | null;
  /**
   * *** THE CONSULTATION'S LENGTH: the seconds BOTH parties were connected at
   * the same time. *** A patient sitting alone in the room is a wait, not a
   * consultation, and this is the figure a refund or a `technical_issue`
   * complaint is adjudicated on.
   */
  durationSeconds: number;
  /** Parties with no connection row at all. Empty, one, or both. This is the no-show fact, derived. */
  noShowParties: CallParty[];
  /** True while at least one connection is open. A live call, as far as the webhooks have told us. */
  live: boolean;
}

/**
 * M-14's public surface (`backend/README.md` §2).
 *
 * Deliberately narrow, and shaped around the consumers that ACTUALLY EXIST or
 * are named as depending on this module — the same restraint
 * `instant.contract.ts` and `booking.contract.ts` apply. Minting a token,
 * running the join gate, receiving the webhook and composing FR-8.4's
 * consultation room all run from this module's own controllers: no other
 * module joins a call.
 *
 * ── WHAT M-15 (CLINICAL RECORDS) NEEDS ─────────────────────────────────────
 *
 * `getSession` is the one method M-15 is expected to call, and the reason this
 * contract exists at all. `docs/MODULES.md` gives M-15 a "consultation ID
 * audit trail across booking, SESSION METADATA, prescription and case
 * summary", and lists M-14 among its dependencies. M-15 holds a consultation
 * id; this is how it reaches the call that produced the record, without
 * reading `consultation_participants` — which is this module's table.
 *
 * ── WHAT M-18/M-21 AND THE ADMIN PANEL NEED ────────────────────────────────
 *
 * `getSession` again. `docs/erd.sql` on `disconnect_reason`: "Read when
 * adjudicating a technical_issue complaint or a refund - it is the only thing
 * separating a hang-up from a dropped network." That is a complaints/refunds
 * read, and it goes through here rather than through the table.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────
 *
 * No `issueJoinToken`. Minting a token is the FR-8.5 gate, and the gate is
 * defined in terms of the CALLER — "the assigned patient and doctor". A
 * trusted module-to-module method that skipped it would be a way to obtain
 * admission to a clinical conversation without being either of them, and no
 * module has any business doing that. It stays on the controller, where an
 * `@CurrentUser()` exists.
 */
export interface VideoContract {
  /**
   * FR-8.6's session metadata for one consultation, derived from its
   * connection rows. Never `null`: a consultation with no connections at all
   * is a valid, meaningful answer — it is the double no-show — and is returned
   * with empty `connections` and both parties in `noShowParties`.
   *
   * No ownership check — a trusted module-to-module read; the CALLER
   * authorizes, the same rule `BookingContract#findById` and
   * `InstantContract#getInstantConsult` state.
   */
  getSession(consultationId: string): Promise<VideoSessionView>;
}
