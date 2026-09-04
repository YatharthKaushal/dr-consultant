import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { ConsultationStatus } from '../../schema/enums.schema';
import { AuditService } from '../../shared/audit/audit.service';
import type { AuthContext } from '../../shared/auth/auth.types';
import { BookingFacade } from '../booking/booking.facade';
import type { BookingView } from '../booking/booking.contract';
import { InstantFacade } from '../instant/instant.facade';
import { PatientFacade } from '../patient/patient.facade';
import { PaymentFacade } from '../payment/payment.facade';
import { LivekitClient } from './livekit.client';
import { VideoConfigService } from './video-config.service';
import type { ConsentCheck, ConsentPort } from './video-consent.contract';
import {
  CONSENT_PORT,
  JOINABLE_CONSULTATION_STATUSES,
  LEGAL_VIDEO_STATUS_TRANSITIONS,
  VIDEO_AUDIT_ENTITY_TYPES,
  VIDEO_ERROR_CODES,
  VIDEO_PRIOR_HISTORY_LIMIT,
} from './video.constants';
import type { VideoJoinTicket, VideoSessionView } from './video.contract';
import { participantIdentityFor, roomNameFor, type CallParty } from './video-room.util';
import { deriveSession } from './video-session.util';
import { VideoRepository } from './video.repository';

/** FR-8.4's consultation room: everything the doctor needs beside the call, composed and stored nowhere. */
export interface VideoConsultationRoomView {
  consultationId: string;
  /** The booking itself — status, mode, scheduled time — read through M-11. */
  booking: BookingView;
  /** M-04's profile summary for the patient on the call. `null` only if the profile row has gone. */
  patient: Awaited<ReturnType<PatientFacade['getProfileSummary']>>;
  /** M-03's answer for `teleconsultation_consent`. Shown, not enforced, here — the gate is on the token. */
  consent: ConsentCheck;
  /** Earlier consultations between THIS doctor and THIS patient, newest first, capped. */
  priorConsultations: BookingView[];
  /** FR-8.6's session metadata as it stands right now, including a live call's running duration. */
  session: VideoSessionView;
  /**
   * *** UPLOADED DOCUMENTS ARE NOT COMPOSED HERE. *** See the class header for
   * why, and read this field as the pointer it is: the doctor's client fetches
   * them from M-10's own route, which already applies M-10's relationship rule.
   */
  documentsEndpoint: string;
}

/** What ending a call did. `changed: false` with no `refusal` is an idempotent no-op, not a failure. */
export interface VideoSessionEndResult {
  consultationId: string;
  changed: boolean;
  status: ConsultationStatus | null;
  refusal?: 'not_found' | 'illegal_transition';
  /** For an instant consult, whether the completion gate was set on the doctor (M-13's `markInstantConsultEnded`). */
  completionGateSet?: boolean;
}

/**
 * M-14's rules: FR-8.5's join gate, FR-8.4's consultation room, FR-8.6's
 * session metadata, and the two consultation status moves this module owns.
 *
 * ── THE JOIN GATE (FR-8.5) IS THE WHOLE POINT OF THIS FILE ────────────────
 *
 * "The backend issues short-lived join tokens ONLY to the assigned patient and
 * doctor, AFTER payment and consent checks pass." Three checks, all server
 * side, in this order, and every one of them is here rather than in a
 * controller:
 *
 *   1. ASSIGNED PARTICIPANT. The caller must be the consultation's
 *      `patientId` or its `doctorId`, resolved from `@CurrentUser()` and never
 *      from a path or body parameter. *** A FAILURE IS A 404, NOT A 403. ***
 *      `instant.controller.ts` states the convention and
 *      `BOOKING_ERROR_CODES.BOOKING_NOT_FOUND` gives the reason: one code for
 *      "does not exist" and "not yours", so nobody can probe for the existence
 *      of somebody else's consultation.
 *   2. PAYMENT. `PaymentFacade.getByConsultationId(...).status === 'paid'` —
 *      the same gate M-11 and M-13 already apply, reached through the same
 *      facade method, so there is one definition of "paid" on the platform.
 *   3. CONSENT. `CONSENT_PORT` (M-03), `teleconsultation_consent`. FAILS
 *      CLOSED: see `unavailable-consent.provider.ts`.
 *
 * Plus two preconditions that are not "checks" so much as facts: the
 * consultation has to be in a status a call can run in
 * (`JOINABLE_CONSULTATION_STATUSES`), and a SCHEDULED one has to be inside its
 * join window (`video.join_window_minutes`).
 *
 * *** THE ORDER MATTERS AND IS DELIBERATE. *** Ownership first, so that every
 * later refusal — "not paid", "no consent", "too early" — is only ever shown to
 * somebody who is genuinely on the consultation. A caller with no relationship
 * to it gets a 404 and learns nothing else.
 *
 * *** CONSENT IS ALWAYS THE PATIENT'S, WHOEVER IS ASKING. *** A doctor
 * requesting a token is checked against the PATIENT's
 * `teleconsultation_consent`, not their own. SRS 6.2: "consent is captured
 * before teleconsultation" — it is a precondition of the CONSULTATION, so if
 * the patient has not consented, neither side may join, and a doctor sitting
 * alone in a room the patient cannot enter helps nobody.
 *
 * ── WHAT THIS SERVICE DOES NOT DO ─────────────────────────────────────────
 *
 * It does not create rooms. `docs/erd.sql` fixes the room as a function of the
 * consultation id and gives it no table; LiveKit creates a room implicitly on
 * the first join, so there is nothing to create and nothing to clean up. See
 * `video-room.util.ts`.
 *
 * It does not move `doctors.presence`. That column is M-05's and its transition
 * table is M-13's (`LEGAL_PRESENCE_TRANSITIONS`, in `instant.constants.ts` and
 * NOT on `InstantContract`), so reaching it from here would be the deep import
 * `backend/README.md` §2 forbids. For an instant consult M-13 already sets
 * `in_consultation` at ACCEPT time, which is before any of this runs; ending
 * one goes through `InstantFacade.markInstantConsultEnded`, which is on the
 * contract precisely for this module. The residual gap — a doctor left
 * `available_now` during a SCHEDULED call, and therefore still routable — is
 * real, is M-13's to close with a `markConsultInProgress` sibling on its own
 * contract, and is reported rather than worked around here.
 */
@Injectable()
export class VideoService {
  private readonly logger = new Logger(VideoService.name);

  constructor(
    private readonly repo: VideoRepository,
    private readonly bookings: BookingFacade,
    private readonly payments: PaymentFacade,
    private readonly patients: PatientFacade,
    private readonly instant: InstantFacade,
    private readonly livekit: LivekitClient,
    private readonly config: VideoConfigService,
    @Inject(CONSENT_PORT) private readonly consent: ConsentPort,
    private readonly audit: AuditService,
  ) {}

  /* ── FR-8.5: the gate ─────────────────────────────────────────────────── */

  /**
   * Runs the whole gate and mints one short-lived join token.
   *
   * Audited on success, with the party and the TTL and WITHOUT the token —
   * "who was let into which consultation, when" is the question an incident
   * starts from, and the token itself is a credential that has no business in
   * a log table. Best-effort (no `tx`): the mint is not a database write, so
   * there is no state for the audit row to be atomic with, and refusing a
   * legitimate join because `audit_log` was unavailable would be a
   * self-inflicted outage on a consultation that is happening right now.
   */
  async issueJoinTicket(consultationId: string, auth: AuthContext): Promise<VideoJoinTicket> {
    // GATE 1 — assigned participant. First, so nothing below can be used to
    // probe a consultation the caller has no part in.
    const { booking, party } = await this.resolveParticipant(consultationId, auth);

    this.assertJoinableStatus(booking);
    await this.assertJoinWindowOpen(booking);

    // GATE 2 — payment.
    await this.assertPaid(booking);

    // GATE 3 — consent, always the PATIENT's. Fails closed.
    await this.assertPatientConsent(booking);

    const ttlSeconds = await this.config.getJoinTokenTtlSeconds();
    const roomName = roomNameFor(booking.id);
    const identity = participantIdentityFor(party, auth.accountId);

    const token = await this.livekit.mintJoinToken({
      roomName,
      identity,
      // A ROLE LABEL, never a person's name — see `livekit.client.ts`. Token
      // claims are echoed to every participant in the room.
      displayName: party === 'patient' ? 'Patient' : 'Doctor',
      ttlSeconds,
    });

    if (token === null) {
      // The underlying error was logged inside the client, where the secret
      // lives. Nothing about it is repeated here.
      throw new ConflictException({
        code: VIDEO_ERROR_CODES.TOKEN_MINT_FAILED,
        message: 'Could not issue a join token for this consultation. Please try again.',
      });
    }

    await this.audit.write({
      actorType: party,
      actorId: auth.accountId,
      action: 'create',
      entityType: VIDEO_AUDIT_ENTITY_TYPES.JOIN_TOKEN,
      entityId: booking.id,
      consultationId: booking.id,
      metadata: { party, identity, roomName, ttlSeconds },
    });

    return {
      consultationId: booking.id,
      roomName,
      serverUrl: this.livekit.getServerUrl(),
      token,
      party,
      identity,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000),
    };
  }

  /* ── FR-8.6: session metadata ─────────────────────────────────────────── */

  /** The trusted module-to-module read behind `VideoContract#getSession`. No ownership check — the CALLER authorizes. */
  async getSession(consultationId: string, now: Date = new Date()): Promise<VideoSessionView> {
    const rows = await this.repo.listConnections(consultationId);
    return deriveSession(consultationId, rows, now);
  }

  /** The same read, for a patient or doctor on the consultation. 404 for anybody else. */
  async getSessionForCaller(consultationId: string, auth: AuthContext): Promise<VideoSessionView> {
    const { booking } = await this.resolveParticipant(consultationId, auth);
    return this.getSession(booking.id);
  }

  /* ── FR-8.4: the consultation room ────────────────────────────────────── */

  /**
   * "The doctor consultation room shows patient details, uploaded documents,
   * consent status and prior history on the same screen as the call."
   *
   * *** A COMPOSITION. IT STORES NOTHING OF ITS OWN AND READS THROUGH EACH
   * OWNING FACADE. *** That is the rule `docs/MODULES.md` states for M-16's
   * Care Plan — "the Care Plan stores nothing of its own; it reads through
   * each owning module" — applied early, because this screen has exactly the
   * same shape: four modules' facts on one surface, none of them copied.
   *
   * *** UPLOADED DOCUMENTS ARE THE ONE PIECE NOT COMPOSED HERE, AND THAT IS A
   * DELIBERATE GAP RATHER THAN AN OVERSIGHT. *** M-10's public surface
   * (`DocumentContract`) exposes exactly one method, `getPatientFileById`, and
   * has no listing. Composing the list would need either a new method on M-10's
   * facade — a module this round does not own, and one being changed under a
   * different track — or a second copy of `patient-file.service.ts
   * #listForDoctorHistory`'s relationship rule, which decides which of a
   * patient's files a given doctor may see. A second copy of an access rule is
   * the worst of the available options, so the field carries the route instead:
   * `GET /api/consultations/:id/documents` is M-10's own doctor-facing endpoint,
   * it already enforces that rule, and one extra call from a client assembling
   * a screen costs nothing. Reported to the coordinator as the one facade
   * addition M-14 would ask M-10 for.
   */
  async getConsultationRoom(consultationId: string, doctorId: string): Promise<VideoConsultationRoomView> {
    const booking = await this.bookings.getBooking(consultationId);
    // Same 404-not-403 rule as the token gate: a doctor who is not THIS
    // consultation's doctor learns only that there is nothing here for them.
    if (!booking || booking.doctorId !== doctorId) throw consultationNotFound();

    const [patient, consent, session, priorConsultations] = await Promise.all([
      this.patients.getProfileSummary(booking.patientId),
      this.checkPatientConsent(booking.patientId),
      this.getSession(booking.id),
      this.listPriorConsultations(doctorId, booking),
    ]);

    return {
      consultationId: booking.id,
      booking,
      patient,
      consent,
      priorConsultations,
      session,
      documentsEndpoint: `/api/consultations/${booking.id}/documents`,
    };
  }

  /* ── The two status moves ─────────────────────────────────────────────── */

  /**
   * *** THE CALL STARTED. *** `scheduled` -> `in_progress`.
   *
   * Driven by the `participant_joined` webhook and by nothing else — not by a
   * token mint. A minted token is an intention to join; a webhook is LiveKit
   * saying somebody actually connected, and only the second is a fact worth
   * writing to `consultations.status`. FR-8.6's session metadata is
   * webhook-driven for the same reason, so the status and the rows it is
   * derived from can never disagree about whether anyone showed up.
   *
   * Idempotent by construction: `transitionConsultationStatus` no-ops when the
   * row is already `in_progress`, so the second participant joining, and a
   * redelivery of the first, both write nothing.
   *
   * Never throws. Its caller is a webhook handler that must answer 2xx.
   */
  async markCallStarted(consultationId: string): Promise<void> {
    const result = await this.bookings.transitionConsultationStatus({
      consultationId,
      to: 'in_progress',
      from: LEGAL_VIDEO_STATUS_TRANSITIONS.in_progress,
      reason: 'video_participant_joined',
    });

    if (result.refusal === 'illegal_transition') {
      // Ordinary, not alarming: a redelivered join for a consultation that has
      // since ended, or one an admin cancelled mid-call. Logged so an operator
      // reading a support case can see the sequence.
      this.logger.log(
        `Consultation ${consultationId} did not move to in_progress from ${result.booking?.status ?? 'unknown'}.`,
      );
      return;
    }

    // *** AND TAKE THE DOCTOR OUT OF THE ROUTING POOL. ***
    //
    // An INSTANT consult reached `in_consultation` at accept, but nothing did
    // that for a SCHEDULED one — so without this a doctor sitting
    // `available_now` could be handed an instant request in the middle of a
    // booked video call. `markConsultInProgress` is mode-agnostic and
    // idempotent, so it is called for every call and no-ops for the instant
    // case.
    //
    // Best-effort, and deliberately AFTER the status move: the status is the
    // fact FR-8.6 hangs off, and a presence write that fails must not cost us
    // it. A failure here is bounded — the doctor is offered one request they
    // must decline, and M-13's acceptance window re-routes it.
    try {
      const presence = await this.instant.markConsultInProgress(consultationId);
      if (presence.refusal) {
        this.logger.warn(
          `Consultation ${consultationId} started but the doctor was not moved to in_consultation ` +
            `(${presence.refusal}); they may be offered an instant request mid-call.`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Consultation ${consultationId} started but taking the doctor out of the routing pool threw: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * *** THE CALL ENDED. *** `in_progress` -> `awaiting_documentation`, and for
   * an INSTANT consult, the doctor's completion gate.
   *
   * Two callers, both legitimate and both idempotent:
   *   - the `room_finished` webhook, which is LiveKit saying the room emptied
   *     and closed. The authoritative signal.
   *   - the doctor's explicit "end consultation" (`POST .../end`), which is
   *     immediate rather than waiting for LiveKit's empty-room timeout.
   *
   * *** `markInstantConsultEnded` IS CALLED ONLY AFTER THE STATUS ACTUALLY
   * MOVED, AND ONLY FOR `mode: 'instant'`. *** `instant.facade.ts` labels that
   * method for exactly this call site: "M-14 (Video) ... The call ended, so
   * gate the doctor and move them to `completing_notes`." Gating on `changed`
   * means a redelivered `room_finished` cannot set the gate a second time —
   * though M-13's own method is idempotent too, so this is belt and braces
   * rather than the only protection.
   *
   * It is also best-effort: a failure there is logged, never thrown. The
   * consultation is ALREADY in `awaiting_documentation` by then, the webhook
   * must answer 2xx, and a doctor who was not gated is a doctor who might be
   * offered one extra instant request — recoverable, and much cheaper than a
   * webhook retry storm on a call that genuinely ended.
   */
  async endSession(consultationId: string, reason: string): Promise<VideoSessionEndResult> {
    const result = await this.bookings.transitionConsultationStatus({
      consultationId,
      to: 'awaiting_documentation',
      from: LEGAL_VIDEO_STATUS_TRANSITIONS.awaiting_documentation,
      reason,
    });

    const outcome: VideoSessionEndResult = {
      consultationId,
      changed: result.changed,
      status: result.booking?.status ?? null,
      ...(result.refusal ? { refusal: result.refusal } : {}),
    };

    if (!result.changed || result.booking === null) return outcome;
    if (result.booking.mode !== 'instant') return outcome;

    try {
      const gate = await this.instant.markInstantConsultEnded(consultationId);
      outcome.completionGateSet = gate.changed;
      if (gate.refusal) {
        this.logger.warn(
          `Consultation ${consultationId} ended, but the completion gate was refused (${gate.refusal}).`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Consultation ${consultationId} ended, but setting the doctor's completion gate failed: ${describeError(error)}`,
      );
    }

    return outcome;
  }

  /** The doctor's explicit End Consultation. Ownership first, then the same `endSession` the webhook uses. */
  async endSessionAsDoctor(consultationId: string, auth: AuthContext): Promise<VideoSessionEndResult> {
    const { booking } = await this.resolveParticipant(consultationId, auth);
    return this.endSession(booking.id, 'video_ended_by_doctor');
  }

  /* ── The gate's individual checks ─────────────────────────────────────── */

  /**
   * *** GATE 1. *** Resolves the caller to one side of the consultation, or
   * refuses with a 404.
   *
   * The party comes from the BOOKING, not from the token's `accountType`: a
   * doctor account whose id happens to equal a patient id is not a thing, but
   * deriving the party from the row rather than from the claim means the answer
   * cannot be influenced by anything the caller sends. An `admin` account
   * reaches this and matches neither id, so it gets the same 404 — admins read
   * a session through `GET /admin/video/...`, which is permission-gated, and
   * never hold a join token.
   */
  private async resolveParticipant(
    consultationId: string,
    auth: AuthContext,
  ): Promise<{ booking: BookingView; party: CallParty }> {
    const booking = await this.bookings.getBooking(consultationId);
    if (!booking) throw consultationNotFound();

    if (auth.accountType === 'patient' && booking.patientId === auth.accountId) {
      return { booking, party: 'patient' };
    }
    if (auth.accountType === 'doctor' && booking.doctorId !== null && booking.doctorId === auth.accountId) {
      return { booking, party: 'doctor' };
    }

    throw consultationNotFound();
  }

  /** The consultation has to be in a status a call can run in, and it has to have a doctor to call. */
  private assertJoinableStatus(booking: BookingView): void {
    if (booking.doctorId === null) {
      // Only reachable for an instant request still routing. A distinct code
      // because "nobody has accepted yet" is a wait, not a refusal.
      throw new ConflictException({
        code: VIDEO_ERROR_CODES.DOCTOR_NOT_ASSIGNED,
        message: 'No doctor has been assigned to this consultation yet.',
      });
    }

    if (!(JOINABLE_CONSULTATION_STATUSES as readonly string[]).includes(booking.status)) {
      throw new ConflictException({
        code: VIDEO_ERROR_CODES.CONSULTATION_NOT_JOINABLE,
        message: `This consultation cannot be joined while it is ${booking.status}.`,
        status: booking.status,
      });
    }
  }

  /**
   * *** THE JOIN WINDOW, AND ONLY THE EARLY EDGE OF IT. ***
   *
   * `docs/erd.sql`: "`video.join_window_minutes` is how early before
   * scheduled_start_at the backend will mint a join token."
   *
   * Two consultations are exempt, and neither is a special case so much as an
   * absence:
   *   - an INSTANT consultation has `scheduled_start_at = null`. It has no
   *     appointment time at all — both parties are present right now, which is
   *     the entire premise of FR-10.2 — so there is no "early" to be.
   *   - a consultation already `in_progress` is past the question. Re-checking
   *     the window on a RECONNECT would cut off a call that overran its slot,
   *     which is the one moment a dropped patient most needs to get back in.
   *
   * There is no late edge; see `video.constants.ts#VIDEO_CONFIG_FALLBACKS`.
   */
  private async assertJoinWindowOpen(booking: BookingView, now: Date = new Date()): Promise<void> {
    if (booking.scheduledStartAt === null) return;
    if (booking.status === 'in_progress') return;

    const windowMinutes = await this.config.getJoinWindowMinutes();
    const opensAt = new Date(booking.scheduledStartAt.getTime() - windowMinutes * 60_000);

    if (now.getTime() < opensAt.getTime()) {
      throw new ConflictException({
        code: VIDEO_ERROR_CODES.JOIN_WINDOW_NOT_OPEN,
        message: `This consultation opens for joining at ${opensAt.toISOString()}.`,
        opensAt: opensAt.toISOString(),
        joinWindowMinutes: windowMinutes,
      });
    }
  }

  /**
   * *** GATE 2. *** FR-8.5's payment check.
   *
   * Reads M-12 through the same `getByConsultationId` that M-11 and M-13 gate
   * on, so "paid" has one definition on this platform. A THROW from the payment
   * module is a refusal here, not a pass: an unreachable payment module means
   * we do not know whether this consultation was paid for, and "do not know"
   * must never open the door. The same fail-closed reasoning the consent port
   * is built on.
   */
  private async assertPaid(booking: BookingView): Promise<void> {
    let status: string | null = null;

    try {
      const payment = await this.payments.getByConsultationId(booking.id);
      status = payment?.status ?? null;
    } catch (error) {
      this.logger.error(
        `Could not read the payment for consultation ${booking.id}; refusing the join. ${describeError(error)}`,
      );
      throw paymentNotCompleted();
    }

    if (status !== 'paid') throw paymentNotCompleted();
  }

  /**
   * *** GATE 3. *** FR-8.5's consent check, and SRS 6.2's "consent is captured
   * before teleconsultation".
   *
   * Always the PATIENT's `teleconsultation_consent`, whoever is asking — see
   * the class header. The error carries `currentVersion` so a client can send
   * the patient straight to the document they need to accept rather than
   * making them go looking for it.
   */
  private async assertPatientConsent(booking: BookingView): Promise<void> {
    const consent = await this.checkPatientConsent(booking.patientId);
    if (consent.hasCurrentConsent) return;

    throw new ConflictException({
      code: VIDEO_ERROR_CODES.CONSENT_REQUIRED,
      message: 'Teleconsultation consent has not been accepted for this patient.',
      currentVersion: consent.currentVersion,
      acceptedVersion: consent.acceptedVersion,
    });
  }

  /**
   * The consent read, wrapped.
   *
   * `ConsentPort#checkPatientConsent` is documented as never throwing and
   * failing closed, and the null object honours that — but the port will be
   * rebound to a real module, and this module's guarantee must not depend on
   * another one keeping its promise. A throw is caught here and turned into
   * the same closed answer the contract asks for.
   */
  private async checkPatientConsent(patientId: string): Promise<ConsentCheck> {
    try {
      return await this.consent.checkPatientConsent({
        patientId,
        documentType: 'teleconsultation_consent',
      });
    } catch (error) {
      this.logger.error(
        `The consent port threw for patient ${patientId}; failing CLOSED. ${describeError(error)}`,
      );
      return { hasCurrentConsent: false, acceptedVersion: null, acceptedAt: null, currentVersion: null };
    }
  }

  /**
   * FR-8.4's "prior history": earlier consultations between THIS doctor and
   * THIS patient, newest first, capped at `VIDEO_PRIOR_HISTORY_LIMIT`.
   *
   * Read through `BookingFacade`, one call for the ids and one per booking —
   * the cap is what keeps that bounded, and it is applied before the reads, not
   * after. The consultation in hand is excluded: it is already the subject of
   * the screen.
   *
   * *** A DOCTOR-AND-PATIENT PAIR, NOT THE PATIENT'S WHOLE HISTORY. *** SRS 6.2:
   * "a doctor sees only assigned patients and their own cases." The patient's
   * consultations with other doctors are not this doctor's to read, and
   * `listConsultationIdsBetween` is the facade method that says so — the same
   * one M-10 uses to decide which of a patient's documents a doctor may see.
   */
  private async listPriorConsultations(doctorId: string, booking: BookingView): Promise<BookingView[]> {
    let ids: string[] = [];
    try {
      ids = await this.bookings.listConsultationIdsBetween(doctorId, booking.patientId);
    } catch (error) {
      // Best-effort: the call is the point of this screen, and a history read
      // that failed must not stop a doctor from seeing their patient.
      this.logger.warn(`Could not read prior consultations for ${booking.id}: ${describeError(error)}`);
      return [];
    }

    const priors = await Promise.all(
      ids
        .filter((id) => id !== booking.id)
        .slice(0, VIDEO_PRIOR_HISTORY_LIMIT)
        .map((id) => this.bookings.getBooking(id)),
    );

    return priors
      .filter((prior): prior is BookingView => prior !== null)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * *** ONE CODE FOR "DOES NOT EXIST" AND "NOT YOURS", AND A 404 FOR BOTH. ***
 * `instant.controller.ts` states the convention and
 * `BOOKING_ERROR_CODES.BOOKING_NOT_FOUND` gives the reason: a 403 would confirm
 * that a consultation exists to somebody with no relationship to it, which is
 * enough to enumerate the platform's consultations by id.
 */
export function consultationNotFound(): NotFoundException {
  return new NotFoundException({
    code: VIDEO_ERROR_CODES.CONSULTATION_NOT_FOUND,
    message: 'Consultation not found.',
  });
}

function paymentNotCompleted(): ConflictException {
  return new ConflictException({
    code: VIDEO_ERROR_CODES.PAYMENT_NOT_COMPLETED,
    message: 'This consultation has not been paid for.',
  });
}

/** Never interpolates a raw provider object into a message — `razorpay.client.ts`'s discipline, applied to every third party this module reads. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
