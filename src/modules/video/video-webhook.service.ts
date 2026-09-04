import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { AuditService } from '../../shared/audit/audit.service';
import { BookingFacade } from '../booking/booking.facade';
import { LivekitClient, type LivekitWebhookDelivery } from './livekit.client';
import {
  LIVEKIT_EVENTS,
  VIDEO_AUDIT_ENTITY_TYPES,
  VIDEO_ERROR_CODES,
} from './video.constants';
import {
  consultationIdFromRoomName,
  parseParticipantIdentity,
  type CallParty,
} from './video-room.util';
import { VideoRepository } from './video.repository';
import { VideoService } from './video.service';

/** What the controller reports back. `handled` distinguishes a delivery that changed something from one that did not; both answer 2xx. */
export interface VideoWebhookResult {
  received: true;
  handled: boolean;
  /**
   * `ignored`   — verified, but not an event or a room this platform acts on.
   * `duplicate` — a redelivery the primary key or the `left_at` guard absorbed.
   * `processed` — a row was written.
   * `failed`    — verified, but processing threw. Recorded in the log, answered 2xx.
   */
  outcome: 'processed' | 'duplicate' | 'ignored' | 'failed';
}

/**
 * The LiveKit webhook. FR-8.6's session metadata is built HERE and nowhere
 * else: "join and leave times and call duration ... stored and linked to the
 * consultation ID".
 *
 * ── THE SIGNATURE IS THE ENTIRE AUTH BOUNDARY ─────────────────────────────
 *
 * The route is `@Public()`. There is no bearer token and no session — the same
 * position `payment-webhook.controller.ts` is in, and `docs/MODULES.md`
 * describes the caller the same way: a "service account: non-human access for
 * third-party callbacks". If verification is wrong, anyone can post JSON that
 * fabricates a consultation's session metadata, and — because a
 * `participant_joined` moves the consultation to `in_progress` — start a
 * consultation that never happened.
 *
 * It is therefore delegated to `LivekitClient#verifyWebhook`, which runs the
 * SDK's `WebhookReceiver` over the RAW BYTES. That does two things and both are
 * required: it validates the `Authorization` JWT against `LIVEKIT_API_SECRET`,
 * and it compares the SHA-256 of the body against that token's `sha256` claim.
 * Re-serialising a parsed object would produce a different digest and fail
 * every genuine delivery — which is why `shared/http/webhook-safe-json.parser
 * .ts` exempts this route and keeps `request.rawBody`.
 *
 * ── IDEMPOTENCY IS THE PRIMARY KEY, NOT AN EVENTS TABLE ───────────────────
 *
 * There is no `video_webhook_events` table, and there deliberately is not one.
 * `docs/erd.sql` already put the idempotency key on the row that matters:
 * `consultation_participants.livekit_participant_sid` is "unique per CONNECTION
 * - this being the key is what makes webhook redelivery idempotent." A
 * redelivered `participant_joined` conflicts on that key and writes nothing; a
 * redelivered `participant_left` finds `left_at` already set and writes
 * nothing. Postgres decides, not a preceding SELECT that two concurrent
 * deliveries could both pass — the same discipline
 * `payment-events.schema.ts` states, expressed on a key that already existed.
 *
 * A RECONNECT is a NEW LiveKit connection with a NEW sid, so it takes a NEW
 * row. That is the table's whole design ("a reconnect adds a row rather than
 * overwriting one") and it falls straight out of the key.
 *
 * ── ALWAYS 2xx ONCE VERIFIED ──────────────────────────────────────────────
 *
 * LiveKit retries a non-2xx. Once a delivery has verified, every outcome below
 * — an event we do not handle, a room that is not ours, an identity that does
 * not belong to the consultation, or a handler that threw — answers 2xx and is
 * logged. The only non-2xx this endpoint returns is 401.
 *
 * *** ONE HONEST DIFFERENCE FROM THE PAYMENT WEBHOOK, CONFIRMED BY PROBING A
 * BOOTED SERVER RATHER THAN ASSUMED. *** `payment-webhook.service.ts`
 * deliberately answers 2xx to a correctly-signed body that is not valid JSON,
 * recording it for a human; this route answers 401 to the same thing. That is
 * not a choice made here — the SDK's `WebhookReceiver#receive` verifies the
 * signature and then `JSON.parse`s in one call, so the two failures are
 * indistinguishable from outside it, and the only way to tell them apart would
 * be to re-implement LiveKit's verification by hand (which
 * `livekit.client.ts` explains at length is the wrong trade).
 *
 * It is acceptable because the case cannot arise from a real sender: LiveKit
 * serialises its webhook bodies with protojson, so a non-JSON body carrying a
 * valid signature would mean the LiveKit server produced one — and a loud 401
 * in that situation is more useful than a quiet 2xx that records nothing. The
 * Fastify parser exemption is still doing its job either way: without it,
 * Fastify would answer its own `400 BAD_REQUEST` before this controller ran,
 * and `request.rawBody` would never be populated at all.
 *
 * *** THE HONEST LIMIT OF THAT CHOICE, WRITTEN DOWN. *** Unlike the payment
 * webhook, a failed delivery here is NOT durably recorded for a retry sweep to
 * pick up: `payment_events` exists, `video_webhook_events` does not, and the
 * ERD's model for this table has no place to put an unprocessable event. So a
 * `participant_left` that threw is LOST, and the consequence is a connection
 * that stays open in the data forever — which
 * `video-session.util.ts` reports as a duration that keeps growing. That is
 * visible rather than silent, and it is the trade the ERD makes; the
 * alternative is a table it deliberately does not have.
 */
@Injectable()
export class VideoWebhookService {
  private readonly logger = new Logger(VideoWebhookService.name);

  constructor(
    private readonly livekit: LivekitClient,
    private readonly repo: VideoRepository,
    private readonly video: VideoService,
    private readonly bookings: BookingFacade,
    private readonly audit: AuditService,
  ) {}

  /**
   * *** THE AUTH BOUNDARY. *** Verifies and returns the flattened delivery, or
   * `null`.
   *
   * Every failure mode returns `null` rather than throwing, so the controller
   * has exactly one rejection path and no branch can fall through to
   * "verified". See `livekit.client.ts#verifyWebhook`.
   */
  async verify(rawBody: Buffer, authHeader: string | undefined): Promise<LivekitWebhookDelivery | null> {
    return this.livekit.verifyWebhook(rawBody, authHeader);
  }

  /** Rejects before anything is read or written. The only non-2xx this endpoint returns. */
  rejectUnverified(): never {
    throw new UnauthorizedException({
      code: VIDEO_ERROR_CODES.WEBHOOK_SIGNATURE_INVALID,
      message: 'Invalid webhook signature.',
    });
  }

  /**
   * Handles one VERIFIED delivery.
   *
   * Never throws for a processing failure — the caller must answer 2xx.
   */
  async handle(delivery: LivekitWebhookDelivery, receivedAt: Date = new Date()): Promise<VideoWebhookResult> {
    // *** THE ROOM IS THE ONLY LINK TO A CONSULTATION. *** `docs/erd.sql`:
    // `consultation_id` is "parsed from the room name, which is a function of
    // this id". A room this platform did not name is not this platform's
    // business — one LiveKit deployment can host more than one application —
    // so it is ignored rather than failed.
    const consultationId = consultationIdFromRoomName(delivery.roomName);
    if (consultationId === null) {
      this.logger.log(`Ignoring LiveKit ${delivery.event || 'event'} for room ${delivery.roomName ?? '<none>'}.`);
      return { received: true, handled: false, outcome: 'ignored' };
    }

    try {
      switch (delivery.event) {
        case LIVEKIT_EVENTS.PARTICIPANT_JOINED:
          return await this.handleParticipantJoined(delivery, consultationId, receivedAt);
        case LIVEKIT_EVENTS.PARTICIPANT_LEFT:
          return await this.handleParticipantLeft(delivery, consultationId, receivedAt);
        case LIVEKIT_EVENTS.ROOM_FINISHED:
          return await this.handleRoomFinished(consultationId);
        default:
          // Recorded in the log and not acted on. LiveKit lets a project
          // subscribe to a dozen event types, and a dashboard change must not
          // start a retry storm — `payment-webhook.service.ts` makes the same
          // call for the same reason.
          this.logger.log(`LiveKit event ${delivery.event} is not acted on.`);
          return { received: true, handled: false, outcome: 'ignored' };
      }
    } catch (error) {
      // *** A HANDLER FAILURE STILL ANSWERS 2xx. *** See the class header for
      // what that costs here and why it is still the right answer.
      this.logger.error(
        `LiveKit ${delivery.event} for consultation ${consultationId} failed during processing: ${describeError(error)}`,
      );
      return { received: true, handled: false, outcome: 'failed' };
    }
  }

  /* ---------------------------------------------------------------------- */

  /**
   * *** ONE CONNECTION OPENED. ***
   *
   * Writes the row, then moves the consultation to `in_progress`. In that
   * order: the row is the evidence and the status is the summary, and a status
   * that says a call is running with no row to show for it would be the worse
   * of the two inconsistencies.
   *
   * `joined_at` is LiveKit's own timestamp when it sent one, and our receipt
   * time otherwise. Not the other way round: LiveKit knows when the socket
   * opened and we only know when the HTTP request arrived, and a redelivery
   * arriving minutes later must not record the participant as joining minutes
   * late.
   */
  private async handleParticipantJoined(
    delivery: LivekitWebhookDelivery,
    consultationId: string,
    receivedAt: Date,
  ): Promise<VideoWebhookResult> {
    const participant = await this.resolveParticipant(delivery, consultationId);
    if (participant === null) return { received: true, handled: false, outcome: 'ignored' };

    const joinedAt = delivery.participant?.joinedAt ?? receivedAt;

    const inserted = await this.repo.insertConnectionIfNew({
      livekitParticipantSid: participant.sid,
      consultationId,
      party: participant.party,
      joinedAt,
    });

    if (!inserted) {
      // *** THE REPLAY BRANCH, DECIDED BY THE DATABASE. *** Not an error, and
      // deliberately not re-processed: the row it would have written is the row
      // already there.
      this.logger.log(`LiveKit participant ${participant.sid} is already recorded — redelivery is a no-op.`);
      return { received: true, handled: false, outcome: 'duplicate' };
    }

    await this.audit.write({
      actorType: 'system',
      actorId: null,
      action: 'webhook',
      entityType: VIDEO_AUDIT_ENTITY_TYPES.SESSION,
      entityId: participant.sid,
      consultationId,
      metadata: { event: delivery.event, party: participant.party, joinedAt: joinedAt.toISOString() },
    });

    // *** THE CALL STARTED. *** Idempotent — the second participant joining is
    // a no-op, as is a redelivery of the first.
    await this.video.markCallStarted(consultationId);

    return { received: true, handled: true, outcome: 'processed' };
  }

  /**
   * *** ONE CONNECTION CLOSED. ***
   *
   * An UPSERT rather than an update, because LiveKit makes no ordering
   * guarantee across deliveries and a leave that overtakes its own join must
   * not be dropped — see `video.repository.ts#closeConnection`.
   *
   * `disconnect_reason` is stored VERBATIM, exactly as LiveKit spelled it
   * (`docs/erd.sql`: "Not an enum: LiveKit owns this vocabulary and adds to
   * it"). See `livekit.client.ts` for why it is read from the raw JSON rather
   * than from the decoded protobuf.
   *
   * *** THIS DOES NOT END THE CONSULTATION. *** One participant leaving is a
   * reconnect as often as it is a goodbye, and treating the first drop as the
   * end of a consultation would move it to `awaiting_documentation` while the
   * other side is still sitting in the room. `room_finished` is the end.
   *
   * *** BUT IT CAN START ONE. *** The upsert exists because a leave can
   * overtake its own join; when it does, it CREATES the row, and the late join
   * then arrives as a `duplicate` and does nothing. The status move used to
   * live only on that path, so a consultation whose join deliveries lost the
   * race stayed `scheduled` for ever — never `in_progress`, the doctor never
   * taken out of the routing pool, and the `room_finished` that followed
   * refused, because `awaiting_documentation` is legal only from
   * `in_progress`. A leave that had to create its own row is LiveKit telling us
   * a connection we never recorded existed, which is the same fact
   * `participant_joined` carries, so it starts the call too.
   */
  private async handleParticipantLeft(
    delivery: LivekitWebhookDelivery,
    consultationId: string,
    receivedAt: Date,
  ): Promise<VideoWebhookResult> {
    const participant = await this.resolveParticipant(delivery, consultationId);
    if (participant === null) return { received: true, handled: false, outcome: 'ignored' };

    // *** DID WE EVER SEE THE JOIN? *** Read BEFORE the upsert, because after
    // it the row exists either way. A miss means this leave is about to CREATE
    // the row — the out-of-order case `closeConnection` is an upsert for — and
    // therefore that a connection this platform never recorded has just been
    // proved to have existed. Only a hint, never a guard: two concurrent leaves
    // for one sid can both miss, and `markCallStarted` is idempotent, so the
    // worst that costs is a second no-op transaction.
    const alreadyRecorded = (await this.repo.findConnection(participant.sid)) !== undefined;

    const written = await this.repo.closeConnection({
      livekitParticipantSid: participant.sid,
      consultationId,
      party: participant.party,
      joinedAt: delivery.participant?.joinedAt ?? receivedAt,
      leftAt: receivedAt,
      disconnectReason: delivery.participant?.disconnectReason ?? null,
    });

    if (!written) {
      // The `left_at IS NULL` guard refused: this connection is already closed,
      // so the FIRST leave time stands and a redelivery cannot move it.
      this.logger.log(`LiveKit participant ${participant.sid} is already closed — redelivery is a no-op.`);
      return { received: true, handled: false, outcome: 'duplicate' };
    }

    await this.audit.write({
      actorType: 'system',
      actorId: null,
      action: 'webhook',
      entityType: VIDEO_AUDIT_ENTITY_TYPES.SESSION,
      entityId: participant.sid,
      consultationId,
      metadata: {
        event: delivery.event,
        party: participant.party,
        leftAt: receivedAt.toISOString(),
        disconnectReason: delivery.participant?.disconnectReason ?? null,
      },
    });

    // *** THE CALL STARTED, AND WE ARE ONLY LEARNING IT NOW. *** See the header
    // for the failure this closes. Idempotent, and refused cleanly for a
    // consultation that is past `scheduled`, so the ordinary path — where the
    // join was recorded first and already moved the status — costs nothing.
    if (!alreadyRecorded) await this.video.markCallStarted(consultationId);

    return { received: true, handled: true, outcome: 'processed' };
  }

  /**
   * *** THE ROOM EMPTIED AND LIVEKIT CLOSED IT: THE CALL IS OVER. ***
   *
   * `in_progress` -> `awaiting_documentation`, plus M-13's completion gate for
   * an instant consult. Both live in `VideoService#endSession`, shared with the
   * doctor's explicit End Consultation, so the two paths cannot drift.
   *
   * A `room_finished` for a consultation that was never `in_progress` — a room
   * created and abandoned before anybody connected — refuses cleanly and
   * answers 2xx. That is a NO-SHOW, and naming it is M-11's `markNoShow` with
   * its own policy, not this webhook's to decide.
   */
  private async handleRoomFinished(consultationId: string): Promise<VideoWebhookResult> {
    const result = await this.video.endSession(consultationId, 'video_room_finished');
    return {
      received: true,
      handled: result.changed,
      outcome: result.changed ? 'processed' : 'duplicate',
    };
  }

  /**
   * *** THE IDENTITY IS RE-CHECKED AGAINST THE BOOKING. ***
   *
   * A `participant_*` webhook carries a room, a sid and an identity, and no
   * patient or doctor id — so `consultation_participants.party` can only come
   * from the identity string. That string is something LiveKit echoed back
   * from a token, and although the delivery's signature proves LiveKit sent it,
   * it does NOT prove that this platform minted the token: one LiveKit project
   * can serve more than one application, and a room name is guessable from a
   * consultation id.
   *
   * So the account named in the identity must actually be this consultation's
   * `patientId` (for `patient`) or its `doctorId` (for `doctor`). Anything else
   * is logged and recorded NOWHERE — no row, no status move. Without this check
   * the party column would be an unverified claim, and the no-show derivation
   * that hangs off it ("the party with NO row here is the one that did not
   * show") would be too.
   */
  private async resolveParticipant(
    delivery: LivekitWebhookDelivery,
    consultationId: string,
  ): Promise<{ sid: string; party: CallParty } | null> {
    const participant = delivery.participant;
    if (participant === null) {
      this.logger.warn(`LiveKit ${delivery.event} for consultation ${consultationId} carried no participant.`);
      return null;
    }

    const identity = parseParticipantIdentity(participant.identity);
    if (identity === null) {
      this.logger.warn(
        `LiveKit ${delivery.event} for consultation ${consultationId} carried an unrecognised identity.`,
      );
      return null;
    }

    const booking = await this.bookings.getBooking(consultationId);
    if (!booking) {
      this.logger.warn(`LiveKit ${delivery.event} named consultation ${consultationId}, which does not exist.`);
      return null;
    }

    const expectedAccountId = identity.party === 'patient' ? booking.patientId : booking.doctorId;
    if (expectedAccountId === null || expectedAccountId !== identity.accountId) {
      this.logger.warn(
        `LiveKit ${delivery.event} claimed ${identity.party} for consultation ${consultationId}, ` +
          'but that account is not on the consultation. Recording nothing.',
      );
      return null;
    }

    return { sid: participant.sid, party: identity.party };
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
