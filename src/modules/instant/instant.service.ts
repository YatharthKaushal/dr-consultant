import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DATABASE } from '../../config/db/database.module';
import type { Database } from '../../config/db/database.config';
import type { InstantConsultancyRow } from '../../schema/instant-consultancy.schema';
import { AuditService } from '../../shared/audit/audit.service';
import { isUniqueConstraintViolation } from '../../shared/errors/postgres-error.util';
import { BookingFacade } from '../booking/booking.facade';
import { DoctorFacade } from '../doctor/doctor.facade';
import { PaymentFacade } from '../payment/payment.facade';
import { InstantConfigService } from './instant-config.service';
import type { NotificationPort } from './instant-notification.contract';
import { InstantPresenceService, SYSTEM_ACTOR, describeError } from './instant-presence.service';
import {
  INSTANT_AUDIT_ENTITY_TYPES,
  INSTANT_ERROR_CODES,
  INSTANT_NOTIFICATION_TEMPLATES,
  MAX_ROUTING_ATTEMPTS,
  NOTIFICATION_PORT,
  ROUTING_CANDIDATE_FETCH,
} from './instant.constants';
import type { CompletionGateView, InstantConsultView, InstantRequestView } from './instant.contract';
import { toInstantRequestView } from './instant.mapper';
import { InstantRepository } from './instant.repository';

/** What a patient gets back from requesting an instant consult, and from every status poll after it. */
export interface InstantConsultStatusView {
  consultationId: string;
  referenceCode: string;
  /** M-11's `consultation_status`. `awaiting_doctor` while routing, `pending_payment` once someone accepts. */
  status: string;
  doctorId: string | null;
  specialtyId: string;
  /** How many doctors have been tried. */
  attemptCount: number;
  /** When the offer currently outstanding closes, or `null` when none is. */
  offerExpiresAt: Date | null;
  /**
   * The payment, once a doctor has accepted and an order exists — INCLUDING the
   * gateway checkout handles.
   *
   * *** THIS IS THE PATIENT'S ONLY RELIABLE ROUTE TO CHECKOUT. *** FR-10.2
   * orders the instant flow request -> accept -> pay, so the order is minted
   * inside `accept`, which is a DOCTOR request the patient is not part of. The
   * patient therefore never sees `createOrderForConsultation`'s return value.
   *
   * This gap was originally left to the `instant_accepted` push notification's
   * deep link. That is not sufficient, for two compounding reasons: the
   * notification only ever carried `paymentId`, not the handles; and push has
   * no credentials configured, so nothing has ever actually been delivered. A
   * flow whose only path to payment is an undelivered notification is a flow
   * with no path to payment. `PaymentContract.getCheckoutHandles` was added —
   * additively, so no blind mirror broke — and the status poll now carries the
   * handles directly.
   *
   * `handles` is `null` whenever there is nothing to pay: no order yet, or the
   * payment is already captured. Neither value is secret — `gatewayKeyId` is
   * Razorpay's PUBLISHABLE key, designed to ship in a client bundle, and an
   * order id is useless without a signed payment. Caching them on this module
   * was rejected: in-process state a second instance silently gets wrong, for a
   * fact the payment module already holds durably.
   */
  payment:
    | {
        paymentId: string;
        status: string;
        handles: { gatewayOrderId: string; gatewayKeyId: string } | null;
      }
    | null;
}

/** The result of one routing pass. */
export type RoutingOutcome =
  | { routed: true; attempt: InstantRequestView }
  | { routed: false; reason: 'exhausted' | 'not_routable' | 'already_pending' };

/**
 * *** FR-10.2's INSTANT FLOW, WHICH RUNS BACKWARDS COMPARED TO A SCHEDULED
 * BOOKING. ***
 *
 *   scheduled:  pick a slot -> PAY -> confirmed
 *   instant:    request -> a doctor ACCEPTS -> pay -> consult
 *
 * That inversion is the source of nearly every design decision in this file
 * and of the second sweep in `instant-expiry.service.ts`. A scheduled booking
 * risks losing a SLOT if payment never lands; an instant one risks holding a
 * LIVE DOCTOR.
 *
 * ── THE FIVE STEPS, AND WHO OWNS EACH ──────────────────────────────────────
 *
 *   1. request   `BookingFacade.createInstantBooking` writes the consultation
 *                (M-11 owns `consultations`), then
 *                `transitionInstantConsultation` moves it to
 *                `awaiting_doctor`.
 *   2. route     one `instant_consultancy` row per doctor offered, this
 *                module's only table. `expires_at` = now + `instant
 *                .acceptance_window_seconds`.
 *   3. accept    `BookingFacade.assignDoctor`, then `PaymentFacade
 *                .createOrderForConsultation`, then `pending_payment` with a
 *                hold. The doctor moves to `in_consultation`.
 *   4. pay       *** NOTHING IN THIS MODULE. *** The EXISTING `payment
 *                .captured` -> `BookingPaymentListener` -> `confirmPayment`
 *                path takes it from `pending_payment` to `scheduled`,
 *                mode-agnostically. No new payment machinery, no second
 *                listener, no duplicate webhook handling.
 *   5. decline / timeout -> outcome `declined`/`timed_out` -> next attempt.
 *                Exhausted -> the patient is told and the consultation is
 *                released.
 *
 * ── THE ONE CROSS-MODULE RULE THIS FILE FOLLOWS EVERYWHERE ─────────────────
 *
 * It never touches `consultations` or `doctors`. Both go through their
 * facades, and both facades were EXTENDED (`transitionInstantConsultation`,
 * `transitionPresence`) rather than worked around. `instant.repository.ts`'s
 * header lists what that bought.
 */
@Injectable()
export class InstantService {
  private readonly logger = new Logger(InstantService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly repo: InstantRepository,
    private readonly bookings: BookingFacade,
    private readonly doctors: DoctorFacade,
    private readonly payments: PaymentFacade,
    private readonly presence: InstantPresenceService,
    private readonly config: InstantConfigService,
    @Inject(NOTIFICATION_PORT) private readonly notifications: NotificationPort,
    private readonly audit: AuditService,
  ) {}

  /* ── 1. The patient's request ──────────────────────────────────────────── */

  /**
   * FR-6.1's "Consult Now", end to end: create the consultation, move it to
   * `awaiting_doctor`, and offer it to the first doctor.
   *
   * A THREE-STEP SAGA, not one transaction, for the reason
   * `booking.service.ts#createBooking` sets out at length: the two facade
   * calls run on their own connections, and `backend/README.md` §2 forbids
   * cross-module transactions.
   *
   * Every interleaving is safe because of where the row is left if this
   * process dies mid-way:
   *   after step 1  `pending_payment` with a hold and no payment — exactly
   *                 Tier 1 of M-11's sweep, released without a gateway call.
   *   after step 2  `awaiting_doctor` with no attempt. Picked up by nothing,
   *                 which is why step 3's failure is CAUGHT and the request is
   *                 released here rather than left hanging.
   *
   * The hold is cleared at step 2 on purpose: while a request is routing
   * there is no doctor, no slot and nothing to pay for, so a live
   * `hold_expires_at` would only invite M-11's sweep to release a row that is
   * doing exactly what it should be.
   */
  async requestInstantConsult(input: {
    patientId: string;
    specialtyId: string;
    concernId?: string | null;
    intakeAnswers?: unknown;
  }): Promise<InstantConsultStatusView> {
    const booking = await this.bookings.createInstantBooking({
      patientId: input.patientId,
      specialtyId: input.specialtyId,
      concernId: input.concernId ?? null,
      intakeAnswers: input.intakeAnswers,
    });

    const moved = await this.bookings.transitionInstantConsultation({
      consultationId: booking.id,
      to: 'awaiting_doctor',
      from: ['pending_payment'],
      holdExpiresAt: null,
      reason: 'instant_request_routing',
    });
    if (!moved.changed || !moved.booking) {
      // Structurally unreachable — the row was created one call ago. Left as
      // a real branch rather than an assertion because the alternative is a
      // consultation nobody is routing and nobody is sweeping.
      throw new ConflictException({
        code: INSTANT_ERROR_CODES.INVALID_STATE_TRANSITION,
        message: 'We could not start your instant consultation. Please try again.',
      });
    }

    await this.audit.write({
      actorType: 'patient',
      actorId: input.patientId,
      action: 'create',
      entityType: INSTANT_AUDIT_ENTITY_TYPES.INSTANT_ROUTING,
      entityId: booking.id,
      consultationId: booking.id,
      metadata: { change: 'instant_request_opened', specialtyId: input.specialtyId },
    });

    try {
      await this.routeNext(booking.id, 'initial_request');
    } catch (error) {
      // Routing is best-effort HERE only: the request is already durable, and
      // the acceptance sweep does not chase a consultation with no attempt.
      // Releasing it now is better than leaving the patient on a spinner
      // forever, and the patient can simply ask again.
      this.logger.error(`Initial routing failed for consultation ${booking.id}: ${describeError(error)}`);
      await this.releaseRequest(booking.id, 'initial_routing_failed', INSTANT_NOTIFICATION_TEMPLATES.INSTANT_NO_DOCTOR_AVAILABLE);
    }

    return this.getStatus(booking.id, input.patientId);
  }

  /* ── 2. Routing ────────────────────────────────────────────────────────── */

  /**
   * *** THE ROUTER. *** Offers the request to the next eligible doctor, or
   * releases it when there is none (FR-10.6).
   *
   * ORDER OF THE TWO WRITES, WHICH IS THE WHOLE CONCURRENCY ARGUMENT:
   * reserve the DOCTOR first (`available_now` -> `request_pending`, under
   * M-05's row lock), and only then insert the `instant_consultancy` row.
   *
   * Doing it the other way round has a failure that cannot be cleaned up: if
   * the attempt row were inserted first and the doctor turned out to be gone,
   * the attempt number would be spent on an offer nobody ever saw, and the
   * doctor could meanwhile be reserved by a different request. Reserving
   * first means a lost race costs nothing — the router just tries the next
   * name it already has in hand.
   *
   * The insert then carries its OWN guarantee: the unique index on
   * `(consultation_id, attempt_number)` is what stops two concurrent routers
   * both offering attempt N. The loser takes a `23505`, releases the doctor it
   * reserved, and reports `already_pending` — the same shape as M-11 treating
   * its partial unique index, not its advisory pre-check, as the authority.
   */
  async routeNext(consultationId: string, reason: string): Promise<RoutingOutcome> {
    const booking = await this.bookings.getBooking(consultationId);
    if (!booking || booking.mode !== 'instant') return { routed: false, reason: 'not_routable' };

    // The patient cancelled, a doctor already accepted, or a sweep released
    // it. All three mean this request is no longer looking for a doctor.
    if (booking.status !== 'awaiting_doctor') return { routed: false, reason: 'not_routable' };

    const state = await this.repo.getRoutingState(consultationId);
    if (state.hasPending) return { routed: false, reason: 'already_pending' };

    if (state.lastAttemptNumber >= MAX_ROUTING_ATTEMPTS) {
      await this.exhaust(consultationId, `max_attempts_${MAX_ROUTING_ATTEMPTS}`);
      return { routed: false, reason: 'exhausted' };
    }

    const candidates = await this.doctors.listInstantRoutingCandidates({
      specialtyId: booking.specialtyId,
      excludeDoctorIds: state.triedDoctorIds,
      limit: ROUTING_CANDIDATE_FETCH,
    });

    const windowSeconds = await this.config.getAcceptanceWindowSeconds();

    for (const candidate of candidates) {
      // RESERVE. A refusal here is the ordinary lost race — the doctor went
      // offline, paused, or another request got them first.
      const reserved = await this.presence.transition({
        doctorId: candidate.doctorId,
        to: 'request_pending',
        actor: SYSTEM_ACTOR,
        reason: 'instant_request_offered',
      });
      if (!reserved.changed) continue;

      const expiresAt = new Date(Date.now() + windowSeconds * 1_000);
      let attempt: InstantConsultancyRow;
      try {
        attempt = await this.db.transaction(async (tx) => {
          const row = await this.repo.insertAttempt(
            {
              consultationId,
              doctorId: candidate.doctorId,
              attemptNumber: state.lastAttemptNumber + 1,
              expiresAt,
            },
            tx,
          );
          await this.audit.write(
            {
              actorType: 'system',
              actorId: null,
              action: 'create',
              entityType: INSTANT_AUDIT_ENTITY_TYPES.INSTANT_REQUEST,
              entityId: row.id,
              consultationId,
              metadata: {
                change: 'offered',
                doctorId: candidate.doctorId,
                attemptNumber: row.attemptNumber,
                expiresAt: expiresAt.toISOString(),
                reason,
              },
            },
            tx,
          );
          return row;
        });
      } catch (error) {
        // Another router won attempt N. Give the doctor straight back.
        await this.presence.transition({
          doctorId: candidate.doctorId,
          to: 'available_now',
          actor: SYSTEM_ACTOR,
          reason: 'routing_lost_race',
        });
        if (isUniqueConstraintViolation(error)) return { routed: false, reason: 'already_pending' };
        throw error;
      }

      this.presence.publish({
        doctorId: candidate.doctorId,
        type: 'instant_request',
        data: {
          requestId: attempt.id,
          consultationId,
          attemptNumber: attempt.attemptNumber,
          expiresAt: attempt.expiresAt.toISOString(),
          secondsToAnswer: windowSeconds,
        },
      });

      // Best-effort, and never awaited into the outcome — see
      // `instant-notification.contract.ts` for why push is the FALLBACK here
      // and SSE is the primary channel.
      await this.notify({
        templateCode: INSTANT_NOTIFICATION_TEMPLATES.INSTANT_REQUEST,
        audience: { kind: 'doctor', id: candidate.doctorId },
        variables: { secondsToAnswer: windowSeconds, referenceCode: booking.referenceCode },
        consultationId,
        deepLinkData: { requestId: attempt.id, consultationId },
      });

      return { routed: true, attempt: toInstantRequestView(attempt) };
    }

    await this.exhaust(consultationId, candidates.length === 0 ? 'no_available_doctor' : 'all_candidates_lost');
    return { routed: false, reason: 'exhausted' };
  }

  /* ── 3. Accept and decline ─────────────────────────────────────────────── */

  /**
   * *** THE ACCEPT, WHICH IS WHERE FR-10.2's INVERSION ACTUALLY HAPPENS. ***
   *
   * One transaction closes the offer, then a compensated saga does the rest —
   * the same structure as `booking.service.ts#createBooking`, and for the same
   * reason: `PaymentFacade` takes no `tx` and writes on its own connection, so
   * calling it inside this module's transaction would deadlock on the
   * uncommitted row it is waiting for.
   *
   * ORDER OF THE POST-COMMIT STEPS, AND WHAT EACH FAILURE LEAVES BEHIND:
   *
   *   a. read the fee            read-only.
   *   b. create the order        THROWS -> the consultation is untouched and
   *                              still `awaiting_doctor`. Compensated by
   *                              RELEASING the request, not by re-routing: a
   *                              gateway that just failed will fail for the
   *                              next doctor too, and marching five doctors
   *                              through an accept that cannot complete is
   *                              worse for them than telling the patient to
   *                              try again.
   *   c. assign the doctor       THROWS (the doctor stopped being listable
   *                              between the offer and the answer) -> the
   *                              consultation is untouched. Compensated by
   *                              re-routing to the NEXT doctor, which is
   *                              exactly FR-10.6's behaviour and costs the
   *                              patient nothing.
   *   d. move to pending_payment REFUSED (the patient cancelled mid-accept)
   *                              -> compensated, and the doctor is freed.
   *   e. presence                the doctor is committed to this consult.
   *
   * Steps c and d both run against a consultation this module verified one
   * step earlier, so a THROW from either is an infrastructure failure rather
   * than a business one; the compensation frees the doctor either way, and
   * the payment sweep is the backstop if a payment row was already created.
   */
  async accept(attemptId: string, doctorId: string): Promise<InstantRequestView> {
    const paymentWindowSeconds = await this.config.getPaymentWindowSeconds();
    const paymentDeadline = new Date(Date.now() + paymentWindowSeconds * 1_000);

    const attempt = await this.settleOffer(attemptId, doctorId, 'accepted', paymentDeadline);
    const booking = await this.bookings.getBooking(attempt.consultationId);
    if (!booking) throw instantConsultNotFound();

    // *** CHECKED BEFORE ANY MONEY IS TOUCHED, NOT AFTER. ***
    //
    // A patient can cancel while an offer is outstanding — M-11's `POST
    // /bookings/:id/cancel` accepts `awaiting_doctor` (`CANCELLABLE_STATUSES`)
    // and this module deliberately has no cancel path of its own, so that
    // window is real and ordinary rather than exotic.
    //
    // Step (d) below would refuse the transition anyway, but by then step (b)
    // has already minted a gateway order — a `payments` row against a
    // consultation nobody is going to hold, which is a money-shaped mess to
    // unpick and one the patient never asked for. So the status is re-read
    // here, before the first irreversible call, and the doctor is handed
    // straight back.
    if (booking.status !== 'awaiting_doctor') {
      await this.rollbackAccept(attempt, `consultation_status_${booking.status}`);
      throw new ConflictException({
        code: INSTANT_ERROR_CODES.INVALID_STATE_TRANSITION,
        message: 'This request is no longer waiting for a doctor.',
        currentStatus: booking.status,
      });
    }

    // (a) The fee the order is priced at. Read from the doctor's own profile
    // — there is no payment row yet to read it back from, which is the whole
    // difference from a cancellation refund (see `booking.repository.ts#
    // findBilledConsultationFee` for why THAT one must not do this).
    const profile = await this.doctors.getPublicProfile(doctorId);
    if (!profile) {
      await this.rollbackAccept(attempt, 'doctor_disappeared');
      throw instantConsultNotFound();
    }

    // (b) The order. Any throw is compensated and rewrapped — a raw gateway
    // error must never reach a doctor or a patient.
    try {
      await this.payments.createOrderForConsultation({
        consultationId: attempt.consultationId,
        consultationFeeInr: profile.consultationFeeInr,
      });
    } catch (error) {
      this.logger.error(`Payment setup failed for instant consultation ${attempt.consultationId}: ${describeError(error)}`);
      await this.rollbackAccept(attempt, 'payment_setup_failed');
      await this.releaseRequest(
        attempt.consultationId,
        'payment_setup_failed',
        INSTANT_NOTIFICATION_TEMPLATES.INSTANT_NO_DOCTOR_AVAILABLE,
      );
      throw new ConflictException({
        code: INSTANT_ERROR_CODES.PAYMENT_SETUP_FAILED,
        message: 'We could not start payment for this consultation. The request has been released.',
      });
    }

    // (c) Attach the doctor.
    try {
      await this.bookings.assignDoctor(attempt.consultationId, doctorId);
    } catch (error) {
      this.logger.error(`Could not assign doctor ${doctorId} to ${attempt.consultationId}: ${describeError(error)}`);
      await this.rollbackAccept(attempt, 'assign_doctor_failed');
      await this.routeNextQuietly(attempt.consultationId, 'assign_doctor_failed');
      throw new ConflictException({
        code: INSTANT_ERROR_CODES.INVALID_STATE_TRANSITION,
        message: 'This request could not be assigned to you. It has been offered to another doctor.',
      });
    }

    // (d) Now the patient owes money, and the clock in
    // `instant-expiry.service.ts` starts.
    const moved = await this.bookings.transitionInstantConsultation({
      consultationId: attempt.consultationId,
      to: 'pending_payment',
      from: ['awaiting_doctor'],
      holdExpiresAt: paymentDeadline,
      reason: 'instant_accepted_awaiting_payment',
    });
    if (!moved.changed) {
      await this.rollbackAccept(attempt, 'consultation_left_awaiting_doctor');
      throw new ConflictException({
        code: INSTANT_ERROR_CODES.INVALID_STATE_TRANSITION,
        message: 'This request is no longer waiting for a doctor.',
      });
    }

    // (e) The doctor is committed.
    await this.presence.transition({
      doctorId,
      to: 'in_consultation',
      actor: { actorType: 'doctor', actorId: doctorId },
      reason: 'instant_request_accepted',
    });

    this.presence.publish({
      doctorId,
      type: 'instant_request_settled',
      data: { requestId: attempt.id, consultationId: attempt.consultationId, outcome: 'accepted' },
    });

    const payment = await this.readPayment(attempt.consultationId);
    await this.notify({
      templateCode: INSTANT_NOTIFICATION_TEMPLATES.INSTANT_ACCEPTED,
      audience: { kind: 'patient', id: booking.patientId },
      variables: {
        doctorName: profile.fullName,
        referenceCode: booking.referenceCode,
        secondsToPay: paymentWindowSeconds,
      },
      consultationId: attempt.consultationId,
      // The checkout handles, so a delivered push can deep-link straight into
      // the gateway. NO LONGER THE ONLY PATH — the status poll carries them too
      // (see `InstantConsultStatusView.payment`), which matters because push
      // has no credentials configured and may never arrive.
      deepLinkData: {
        consultationId: attempt.consultationId,
        paymentId: payment?.paymentId ?? null,
        gatewayOrderId: payment?.handles?.gatewayOrderId ?? null,
        gatewayKeyId: payment?.handles?.gatewayKeyId ?? null,
      },
    });

    return toInstantRequestView(attempt);
  }

  /**
   * FR-10.6's decline. The doctor goes straight back into the pool and the
   * request moves on — *** WITH NO PATIENT ACTION, *** which is the
   * requirement `docs/MODULES.md` puts in M-13's done-when bar.
   */
  async decline(attemptId: string, doctorId: string): Promise<InstantRequestView> {
    const attempt = await this.settleOffer(attemptId, doctorId, 'declined');

    await this.presence.transition({
      doctorId,
      to: 'available_now',
      actor: { actorType: 'doctor', actorId: doctorId },
      reason: 'instant_request_declined',
    });

    this.presence.publish({
      doctorId,
      type: 'instant_request_settled',
      data: { requestId: attempt.id, consultationId: attempt.consultationId, outcome: 'declined' },
    });

    await this.routeNextQuietly(attempt.consultationId, 'declined');
    return toInstantRequestView(attempt);
  }

  /**
   * The shared close-the-offer transaction behind `accept` and `decline`.
   *
   * Takes the attempt's row lock FIRST and re-reads `outcome` through it, so a
   * doctor answering at the same moment the timeout sweep fires serializes:
   * whichever transaction commits first wins, and the other's `WHERE outcome
   * IN ('pending')` guard finds nothing and reports a clean 409 rather than
   * overwriting a settled outcome.
   *
   * `REQUEST_NOT_FOUND` covers both "no such attempt" and "not yours", so a
   * doctor cannot probe for another doctor's requests — the same reasoning
   * `BOOKING_ERROR_CODES.BOOKING_NOT_FOUND` gives.
   */
  private async settleOffer(
    attemptId: string,
    doctorId: string,
    outcome: 'accepted' | 'declined',
    newExpiresAt?: Date,
  ): Promise<InstantConsultancyRow> {
    return this.db.transaction(async (tx) => {
      const attempt = await this.repo.findAttemptByIdForUpdate(attemptId, tx);
      if (!attempt || attempt.doctorId !== doctorId) throw requestNotFound();

      if (attempt.outcome !== 'pending') {
        throw new ConflictException({
          code: INSTANT_ERROR_CODES.REQUEST_NOT_PENDING,
          message: 'This request has already been answered.',
          outcome: attempt.outcome,
        });
      }

      // The window closed while the answer was in flight. A separate code
      // from `REQUEST_NOT_PENDING` on purpose: the doctor did nothing wrong
      // and the app should say so rather than implying a double-tap.
      if (attempt.expiresAt.getTime() <= Date.now()) {
        throw new ConflictException({
          code: INSTANT_ERROR_CODES.REQUEST_WINDOW_CLOSED,
          message: 'The time to answer this request has passed.',
        });
      }

      const settled = await this.repo.updateOutcomeIfIn(
        attemptId,
        ['pending'],
        outcome,
        // Accepting REPURPOSES `expires_at` from the acceptance window to the
        // payment window — see `instant.repository.ts#updateOutcomeIfIn`.
        newExpiresAt ? { expiresAt: newExpiresAt } : {},
        tx,
      );
      if (!settled) {
        throw new ConflictException({
          code: INSTANT_ERROR_CODES.REQUEST_NOT_PENDING,
          message: 'This request has already been answered.',
        });
      }

      await this.audit.write(
        {
          actorType: 'doctor',
          actorId: doctorId,
          action: 'update',
          entityType: INSTANT_AUDIT_ENTITY_TYPES.INSTANT_REQUEST,
          entityId: attemptId,
          consultationId: attempt.consultationId,
          metadata: { change: outcome, doctorId, attemptNumber: attempt.attemptNumber },
        },
        tx,
      );

      return settled;
    });
  }

  /**
   * Undoes the DOCTOR half of a failed accept: back to `available_now`, free
   * to take the next request.
   *
   * The attempt's outcome is deliberately LEFT as `accepted`. It is true — the
   * doctor did accept — and FR-18.6's acceptance rate is computed straight off
   * these rows (`doctor-reliability.service.ts`), so rewriting it to
   * `declined` or `timed_out` to tidy up would quietly penalise a doctor for
   * an outage on our side.
   */
  private async rollbackAccept(attempt: InstantConsultancyRow, reason: string): Promise<void> {
    await this.presence.transition({
      doctorId: attempt.doctorId,
      to: 'available_now',
      actor: SYSTEM_ACTOR,
      reason: `accept_rolled_back_${reason}`,
    });

    await this.audit.write({
      actorType: 'system',
      actorId: null,
      action: 'update',
      entityType: INSTANT_AUDIT_ENTITY_TYPES.INSTANT_REQUEST,
      entityId: attempt.id,
      consultationId: attempt.consultationId,
      metadata: { change: 'accept_rolled_back', reason, doctorId: attempt.doctorId },
    });
  }

  /* ── 5. Timeout, exhaustion and release ────────────────────────────────── */

  /**
   * One offer's acceptance window closed with no answer (FR-10.6). Called by
   * the acceptance sweep, and safe to call twice: the `WHERE outcome IN
   * ('pending')` guard under the row lock means the second caller does
   * nothing.
   *
   * Returns whether THIS call is the one that timed it out, so the sweep only
   * re-routes once.
   */
  async timeOutAttempt(attemptId: string): Promise<boolean> {
    const timedOut = await this.db.transaction(async (tx) => {
      const attempt = await this.repo.findAttemptByIdForUpdate(attemptId, tx);
      if (!attempt || attempt.outcome !== 'pending') return null;
      if (attempt.expiresAt.getTime() > Date.now()) return null;

      const settled = await this.repo.updateOutcomeIfIn(attemptId, ['pending'], 'timed_out', {}, tx);
      if (!settled) return null;

      await this.audit.write(
        {
          actorType: 'system',
          actorId: null,
          action: 'update',
          entityType: INSTANT_AUDIT_ENTITY_TYPES.INSTANT_REQUEST,
          entityId: attemptId,
          consultationId: attempt.consultationId,
          metadata: { change: 'timed_out', doctorId: attempt.doctorId, attemptNumber: attempt.attemptNumber },
        },
        tx,
      );
      return settled;
    });

    if (!timedOut) return false;

    // The doctor did not answer. They may simply have put the phone down, so
    // they go back to `available_now` rather than `offline` — the disconnect
    // handler owns `offline`, and guessing it here would take a doctor who is
    // there out of the pool.
    await this.presence.transition({
      doctorId: timedOut.doctorId,
      to: 'available_now',
      actor: SYSTEM_ACTOR,
      reason: 'instant_request_timed_out',
    });

    this.presence.publish({
      doctorId: timedOut.doctorId,
      type: 'instant_request_withdrawn',
      data: { requestId: timedOut.id, consultationId: timedOut.consultationId, reason: 'timed_out' },
    });

    return true;
  }

  /** FR-10.6, exhausted: nobody is left to try. Tell the patient and release the consultation. */
  private async exhaust(consultationId: string, reason: string): Promise<void> {
    await this.releaseRequest(consultationId, reason, INSTANT_NOTIFICATION_TEMPLATES.INSTANT_NO_DOCTOR_AVAILABLE);
  }

  /**
   * Releases a request that is not going to happen: routing ran out, payment
   * setup failed, or the post-acceptance payment window closed.
   *
   * `expired`, never `cancelled`: `cancelled` is a decision a person made
   * (`consultations.cancelled_by_party` exists to record which one), and
   * writing it for a system release would put words in a patient's mouth.
   * `expired` is what M-11 already uses for a hold that lapsed, and — like
   * `cancelled` — it is not a slot-occupying status.
   *
   * Idempotent through `transitionInstantConsultation`'s `from` guard, so the
   * sweeps and the routing path can both reach it for the same consultation
   * without fighting.
   */
  async releaseRequest(consultationId: string, reason: string, templateCode: string): Promise<void> {
    const superseded = await this.repo.supersedePendingAttempts(consultationId);

    const released = await this.bookings.transitionInstantConsultation({
      consultationId,
      to: 'expired',
      from: ['awaiting_doctor', 'pending_payment'],
      holdExpiresAt: null,
      reason,
    });

    if (!released.changed) return;

    await this.audit.write({
      actorType: 'system',
      actorId: null,
      action: 'update',
      entityType: INSTANT_AUDIT_ENTITY_TYPES.INSTANT_ROUTING,
      entityId: consultationId,
      consultationId,
      metadata: { change: 'instant_request_released', reason, supersededAttempts: superseded },
    });

    if (released.booking) {
      await this.notify({
        templateCode,
        audience: { kind: 'patient', id: released.booking.patientId },
        variables: { referenceCode: released.booking.referenceCode },
        consultationId,
      });
    }
  }

  /* ── The completion gate (FR-10.5) ─────────────────────────────────────── */

  /**
   * *** SETS THE COMPLETION GATE. *** The instant consult is over: block this
   * doctor from any new instant request until the prescription-or-advice and
   * the case summary are done, and move them to `completing_notes`.
   *
   * The gate is written BEFORE the presence move, and the order matters. If
   * the process dies between the two, the doctor is gated but still shows as
   * `in_consultation` — they take no new requests, which is the safe side of
   * the failure. The other order would leave them `completing_notes` and
   * UNGATED, which routing would happily ignore.
   */
  async markInstantConsultEnded(consultationId: string): Promise<CompletionGateView> {
    const booking = await this.bookings.getBooking(consultationId);
    if (!booking || booking.mode !== 'instant') throw instantConsultNotFound();
    if (!booking.doctorId) {
      throw new ConflictException({
        code: INSTANT_ERROR_CODES.INVALID_STATE_TRANSITION,
        message: 'This consultation has no doctor to gate.',
      });
    }

    const gate = await this.doctors.setCompletionGate({
      doctorId: booking.doctorId,
      consultationId,
      actor: SYSTEM_ACTOR,
    });

    if (gate.refusal === 'already_gated') {
      throw new ConflictException({
        code: INSTANT_ERROR_CODES.COMPLETION_GATE_ACTIVE,
        message: 'This doctor still owes documentation for an earlier consultation.',
        blockedByConsultationId: gate.blockedByConsultationId,
      });
    }
    if (gate.refusal === 'doctor_not_found') throw doctorNotFoundError();

    await this.presence.transition({
      doctorId: booking.doctorId,
      to: 'completing_notes',
      actor: SYSTEM_ACTOR,
      reason: 'instant_consult_ended',
    });

    return gate;
  }

  /**
   * The doctor-facing form of `markInstantConsultEnded`, with the ownership
   * check `InstantContract` deliberately leaves out.
   *
   * The facade version is a trusted module-to-module call (M-14 knows the call
   * ended; the CALLER authorizes), exactly like `BookingContract.findById`.
   * This one is reached from an HTTP route, so it must not be: without the
   * check, any doctor could end any other doctor's consult and gate them out
   * of the routing pool. A consultation that is not the caller's returns the
   * same 404 a stranger gets.
   */
  async markOwnInstantConsultEnded(consultationId: string, doctorId: string): Promise<CompletionGateView> {
    const booking = await this.bookings.getBooking(consultationId);
    if (!booking || booking.mode !== 'instant' || booking.doctorId !== doctorId) throw instantConsultNotFound();
    return this.markInstantConsultEnded(consultationId);
  }

  /**
   * *** CLEARS THE COMPLETION GATE. M-15 CALLS THIS. *** Idempotent — see
   * `instant.contract.ts` for what "the same transaction" from `docs/erd.sql`
   * can and cannot mean across a module boundary.
   *
   * The presence move back to `available_now` is best-effort and its refusal
   * is ignored on purpose: a doctor who finished their notes at midnight and
   * closed the app is `offline`, and dragging them back into the routing pool
   * because they filed some paperwork would be exactly wrong.
   */
  async clearCompletionGate(consultationId: string): Promise<CompletionGateView> {
    const gate = await this.doctors.clearCompletionGate({ consultationId, actor: SYSTEM_ACTOR });

    if (gate.changed && gate.doctorId) {
      await this.presence.transition({
        doctorId: gate.doctorId,
        to: 'available_now',
        actor: SYSTEM_ACTOR,
        reason: 'completion_gate_cleared',
      });
    }

    return gate;
  }

  /* ── Reads ─────────────────────────────────────────────────────────────── */

  /** The doctor's outstanding offers. The reconnect path: a stream carries no history, so a doctor coming back reads the table. */
  async listPendingForDoctor(doctorId: string): Promise<InstantRequestView[]> {
    const rows = await this.repo.listPendingAttemptsForDoctor(doctorId, new Date());
    return rows.map(toInstantRequestView);
  }

  /** One request with its full routing history. `null` when the consultation is unknown or not `mode: 'instant'`. */
  async getInstantConsult(consultationId: string): Promise<InstantConsultView | null> {
    const booking = await this.bookings.getBooking(consultationId);
    if (!booking || booking.mode !== 'instant') return null;

    const attempts = (await this.repo.listAttemptsByConsultation(consultationId)).map(toInstantRequestView);
    return {
      consultationId,
      doctorId: booking.doctorId,
      status: booking.status,
      attempts,
      pendingAttempt: attempts.find((attempt) => attempt.outcome === 'pending') ?? null,
    };
  }

  /**
   * The patient's status poll. Ownership is checked HERE, not in the
   * controller, and a mismatch returns the same not-found a stranger gets, so
   * a patient cannot probe for another patient's consultation — the rule
   * `booking.service.ts` applies to every one of its own reads.
   */
  async getStatus(consultationId: string, patientId: string): Promise<InstantConsultStatusView> {
    const booking = await this.bookings.getBooking(consultationId);
    if (!booking || booking.mode !== 'instant' || booking.patientId !== patientId) throw instantConsultNotFound();

    const attempts = await this.repo.listAttemptsByConsultation(consultationId);
    const pending = attempts.find((attempt) => attempt.outcome === 'pending') ?? null;
    const accepted = attempts.find((attempt) => attempt.outcome === 'accepted') ?? null;

    return {
      consultationId,
      referenceCode: booking.referenceCode,
      status: booking.status,
      doctorId: booking.doctorId,
      specialtyId: booking.specialtyId,
      attemptCount: attempts.length,
      // While routing, this is the acceptance window; once accepted it is the
      // payment window (see `instant.repository.ts#updateOutcomeIfIn`).
      offerExpiresAt: (pending ?? accepted)?.expiresAt ?? null,
      payment: await this.readPayment(consultationId),
    };
  }

  /* ── Helpers ───────────────────────────────────────────────────────────── */

  /** Re-routing that must never take down the caller — a decline whose next offer fails is still a valid decline, and the acceptance sweep will try again. */
  private async routeNextQuietly(consultationId: string, reason: string): Promise<void> {
    try {
      await this.routeNext(consultationId, reason);
    } catch (error) {
      this.logger.error(`Re-routing consultation ${consultationId} after ${reason} failed: ${describeError(error)}`);
    }
  }

  /**
   * The one place this module talks to `NOTIFICATION_PORT`.
   *
   * Wrapped in a `try` even though the port's contract says `notify` MUST NOT
   * throw: a port is an interface, the implementation is somebody else's
   * module in another worktree, and "must not throw" is a promise rather than
   * a guarantee. A failed notification never fails a consult — see
   * `unavailable-notification.provider.ts` for why this port, alone among the
   * ports in this codebase, is best-effort on both sides.
   */
  private async notify(request: Parameters<NotificationPort['notify']>[0]): Promise<void> {
    try {
      const result = await this.notifications.notify(request);
      if (!result.queued && result.reason && result.reason !== 'provider_unavailable') {
        this.logger.debug(`Notification "${request.templateCode}" not queued: ${result.reason}`);
      }
    } catch (error) {
      this.logger.warn(`Notification "${request.templateCode}" threw; ignoring. ${describeError(error)}`);
    }
  }

  /**
   * M-12's view of the consultation's payment, plus the checkout handles the
   * patient needs to open the gateway. `null` on any failure — a payment-module
   * problem must never break a status poll, because the poll is also how the
   * patient learns their request was DECLINED.
   *
   * The handles are fetched separately and degrade on their own: a patient who
   * can see `status` but not `handles` is told to retry, which is strictly
   * better than a poll that 500s.
   */
  private async readPayment(
    consultationId: string,
  ): Promise<{ paymentId: string; status: string; handles: { gatewayOrderId: string; gatewayKeyId: string } | null } | null> {
    try {
      const payment = await this.payments.getByConsultationId(consultationId);
      if (!payment) return null;

      let handles: { gatewayOrderId: string; gatewayKeyId: string } | null = null;
      try {
        const checkout = await this.payments.getCheckoutHandles(consultationId);
        if (checkout) {
          handles = { gatewayOrderId: checkout.gatewayOrderId, gatewayKeyId: checkout.gatewayKeyId };
        }
      } catch (error) {
        this.logger.warn(
          `Could not read checkout handles for consultation ${consultationId}; the patient will see the ` +
            `payment but cannot open checkout from this poll. ${describeError(error)}`,
        );
      }

      return { paymentId: payment.paymentId, status: payment.status, handles };
    } catch (error) {
      this.logger.warn(`Could not read the payment for consultation ${consultationId}: ${describeError(error)}`);
      return null;
    }
  }
}

export function requestNotFound(): NotFoundException {
  return new NotFoundException({ code: INSTANT_ERROR_CODES.REQUEST_NOT_FOUND, message: 'Instant request not found.' });
}

export function instantConsultNotFound(): NotFoundException {
  return new NotFoundException({
    code: INSTANT_ERROR_CODES.INSTANT_CONSULT_NOT_FOUND,
    message: 'Instant consultation not found.',
  });
}

export function doctorNotFoundError(): NotFoundException {
  return new NotFoundException({ code: INSTANT_ERROR_CODES.DOCTOR_NOT_FOUND, message: 'Doctor not found.' });
}
