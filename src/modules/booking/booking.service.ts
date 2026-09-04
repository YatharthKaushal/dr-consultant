import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { DATABASE } from '../../config/db/database.module';
import type { Database } from '../../config/db/database.config';
import type { ConsultationRow, NewConsultationRow } from '../../schema/consultations.schema';
import type { ConsultationStatus, Party } from '../../schema/enums.schema';
import { AppConfigService } from '../../shared/app-config/app-config.service';
import { AuditService } from '../../shared/audit/audit.service';
import { isUniqueConstraintViolation } from '../../shared/errors/postgres-error.util';
import { AvailabilityFacade } from '../availability/availability.facade';
import { CatalogueFacade } from '../catalogue/catalogue.facade';
import { DoctorFacade } from '../doctor/doctor.facade';
import { DocumentFacade } from '../document/document.facade';
import { PatientFacade } from '../patient/patient.facade';
import type { BookingPaymentPort, PaymentBreakdown } from './booking-payment.contract';
import {
  BOOKING_AUDIT_ENTITY_TYPES,
  BOOKING_CONFIG_FALLBACKS,
  BOOKING_CONFIG_KEYS,
  BOOKING_ERROR_CODES,
  BOOKING_PAYMENT_PORT,
  BOOKING_REFERENCE_PREFIX,
  BOOKING_RESOLUTION_KINDS,
  CANCELLABLE_STATUSES,
  NO_SHOW_STATUSES,
  RESCHEDULABLE_STATUSES,
} from './booking.constants';
import {
  DEFAULT_CANCELLATION_POLICY,
  decideRefund,
  parseRefundPolicy,
  refundAmountFor,
  type RefundPolicy,
} from './booking-policy.engine';
import { BookingRepository, type ExpiredInstantHold } from './booking.repository';

/** Who is acting. `party` drives both the ownership check and `cancelled_by_party`. */
export interface BookingActor {
  party: Party;
  /** `null` only for `party: 'system'` (the sweep). */
  accountId: string | null;
}

/** ADDITIVE (M-13) — see `BookingService#transitionInstantConsultation`. */
export interface InstantTransitionInput {
  consultationId: string;
  /** Only the statuses the instant flow itself moves through; anything else stays behind `cancel`/`reschedule`/`markNoShow`. */
  to: Extract<ConsultationStatus, 'awaiting_doctor' | 'pending_payment' | 'expired'>;
  /** The statuses this move is legal FROM — M-13's state machine, enforced here under the row lock. */
  from: readonly ConsultationStatus[];
  /** Omit to leave the hold alone. `null` clears it; a date sets it. */
  holdExpiresAt?: Date | null;
  /** Carried into the audit row's `metadata.reason`. */
  reason?: string;
}

/** ADDITIVE (M-13) — see `BookingService#transitionInstantConsultation`. */
export interface InstantTransitionResult {
  /** `false` for both an idempotent no-op (already in `to`) and a refusal — `refusal` tells them apart. */
  changed: boolean;
  /** The row as it stands after the call, or `null` when the consultation does not exist. */
  booking: ConsultationRow | null;
  refusal?: 'not_found' | 'not_instant' | 'illegal_transition';
}

export interface CreateBookingInput {
  patientId: string;
  doctorId: string;
  specialtyId: string;
  concernId?: string | null;
  scheduledStartAt: Date;
  intakeAnswers?: unknown;
}

/** What a patient gets back from a successful booking: the row, plus the checkout handles M-12 minted. */
export interface CreatedBooking {
  booking: ConsultationRow;
  payment: { paymentId: string; gatewayOrderId: string; gatewayKeyId: string; breakdown: PaymentBreakdown };
  /** M-11's "first consultation prompts for medical history" flag — true when this patient has no prior consultation that reached a consult. */
  isFirstConsultation: boolean;
}

/**
 * The booking lifecycle: create, cancel, reschedule, no-show, list, intake and
 * document gating. The HOLD lifecycle — confirming a payment, the expiry
 * sweep and the late-capture path — lives in `booking-slot-hold.service.ts`
 * so that a single file owns everything that can move a slot without a user
 * asking it to.
 *
 * ── THE SLOT GUARANTEE ─────────────────────────────────────────────────────
 *
 * `AvailabilityFacade.isSlotBookable` is ADVISORY ONLY. It answers "does this
 * look bookable" against rules, working hours and busy intervals, and it can
 * be stale by the time the insert runs. The AUTHORITY is the partial unique
 * index `consultations_doctor_slot_unique_idx` (`drizzle/0003_...sql`), and
 * every path that writes a `(doctor_id, scheduled_start_at)` pair catches its
 * `23505` and converts it to a clean 409 `SLOT_ALREADY_TAKEN`. That matters
 * beyond races, too: the index guards EQUAL START TIMES only, so an
 * overlapping-but-not-equal booking is caught by `isSlotBookable`'s busy
 * intervals and nothing else — the two mechanisms cover different holes and
 * both are required.
 *
 * ── WHY THE PAYMENT ORDER IS NOT IN THE CONSULTATION'S TRANSACTION ─────────
 *
 * See `createBooking`. Short version: `BookingPaymentPort` has no transaction
 * parameter (its shape is fixed by the parallel M-12 worktree) and
 * `backend/README.md` §2 forbids cross-module transactions, so M-12 writes on
 * its OWN connection. A `payments` row inserted on another connection while
 * this transaction still holds the uncommitted `consultations` row would block
 * on that row's foreign-key check — waiting for a transaction that is itself
 * waiting for the port call to return. That is a distributed deadlock, and it
 * would fire on every single booking. The compensating-action design below
 * avoids it and is backstopped by the sweep.
 */
@Injectable()
export class BookingService {
  private readonly logger = new Logger(BookingService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly repo: BookingRepository,
    private readonly patients: PatientFacade,
    private readonly doctors: DoctorFacade,
    private readonly catalogue: CatalogueFacade,
    private readonly availability: AvailabilityFacade,
    private readonly documents: DocumentFacade,
    @Inject(BOOKING_PAYMENT_PORT) private readonly payments: BookingPaymentPort,
    private readonly appConfig: AppConfigService,
    private readonly audit: AuditService,
  ) {}

  /* ── Create ───────────────────────────────────────────────────────────── */

  /**
   * A scheduled booking, from validation to a live slot hold with a gateway
   * order attached.
   *
   * The write is a two-step SAGA, not one transaction — see the class doc
   * comment for the deadlock that rules the single transaction out:
   *
   *   1. Insert the consultation (`pending_payment` + `hold_expires_at`) and
   *      its audit entry in ONE transaction, and commit. The partial unique
   *      index decides the slot here, atomically.
   *   2. Ask M-12 for the order. If that throws for ANY reason, COMPENSATE by
   *      releasing the hold immediately (status -> `expired`, which the index
   *      does not count as occupying), then surface `PAYMENT_SETUP_FAILED`.
   *
   * The window between the two steps is covered even if this process dies
   * inside it: the consultation is left `pending_payment` with a hold and NO
   * payment row, which is exactly Tier 1 of the sweep — released without any
   * gateway call. So the slot cannot be lost by any interleaving, which is
   * the property `docs/SRS.md` §6.4 actually asks for.
   */
  async createBooking(input: CreateBookingInput, actor: BookingActor): Promise<CreatedBooking> {
    const { doctorProfile } = await this.validateBookingTargets({
      patientId: input.patientId,
      doctorId: input.doctorId,
      specialtyId: input.specialtyId,
      concernId: input.concernId ?? null,
    });

    // ADVISORY. The index below is the authority — see the class doc comment.
    const bookability = await this.availability.isSlotBookable(input.doctorId, input.scheduledStartAt);
    if (!bookability.bookable) {
      throw new ConflictException({
        code: BOOKING_ERROR_CODES.SLOT_NOT_BOOKABLE,
        message: 'That slot cannot be booked.',
        reason: bookability.reason,
      });
    }

    const holdMinutes = await this.resolveHoldMinutes();
    const now = new Date();

    const booking = await this.insertBooking({
      patientId: input.patientId,
      doctorId: input.doctorId,
      specialtyId: input.specialtyId,
      concernId: input.concernId ?? null,
      mode: 'scheduled',
      scheduledStartAt: input.scheduledStartAt,
      durationMinutes: doctorProfile.consultationDurationMinutes,
      holdExpiresAt: new Date(now.getTime() + holdMinutes * 60_000),
      intakeAnswers: input.intakeAnswers ?? null,
      actor,
    });

    // STEP 2 of the saga. Any throw is compensated and rewrapped — a raw
    // gateway or payment-module error must never reach a patient.
    let order;
    try {
      order = await this.payments.createOrderForConsultation({
        consultationId: booking.id,
        consultationFeeInr: doctorProfile.consultationFeeInr,
      });
    } catch (error) {
      await this.compensateFailedPaymentSetup(booking.id, error);
      throw new ConflictException({
        code: BOOKING_ERROR_CODES.PAYMENT_SETUP_FAILED,
        message: 'We could not start payment for this booking. Your slot has been released — please try again.',
      });
    }

    return {
      booking,
      payment: {
        paymentId: order.paymentId,
        gatewayOrderId: order.gatewayOrderId,
        gatewayKeyId: order.gatewayKeyId,
        breakdown: order.breakdown,
      },
      isFirstConsultation: !(await this.repo.hasPriorConsultation(input.patientId, booking.id)),
    };
  }

  /**
   * M-13's entry point: an instant consultation with NO doctor and NO slot.
   * It still gets a hold, so the payment path is identical for both modes;
   * with `doctor_id` null the partial unique index simply does not apply, so
   * nothing can collide. M-13 owns everything that happens next — routing,
   * the acceptance window, timeouts, re-routing and the seven doctor states
   * are all explicitly out of scope here (`docs/MODULES.md`, M-13).
   */
  async createInstantBooking(
    input: { patientId: string; specialtyId: string; concernId?: string | null; intakeAnswers?: unknown },
    actor: BookingActor,
  ): Promise<ConsultationRow> {
    await this.validateBookingTargets({
      patientId: input.patientId,
      doctorId: null,
      specialtyId: input.specialtyId,
      concernId: input.concernId ?? null,
    });

    const holdMinutes = await this.resolveHoldMinutes();
    const specialty = await this.catalogue.getSpecialtyById(input.specialtyId);
    if (!specialty) throw specialtyNotBookable();

    return this.insertBooking({
      patientId: input.patientId,
      doctorId: null,
      specialtyId: input.specialtyId,
      concernId: input.concernId ?? null,
      mode: 'instant',
      scheduledStartAt: null,
      // No doctor is assigned yet, so no per-doctor duration exists. The
      // platform default stands in until M-13 assigns one; `assignDoctor`
      // corrects it to that doctor's own consultation duration.
      durationMinutes: DEFAULT_INSTANT_DURATION_MINUTES,
      holdExpiresAt: new Date(Date.now() + holdMinutes * 60_000),
      intakeAnswers: input.intakeAnswers ?? null,
      actor,
    });
  }

  /** Attaches the doctor M-13's routing chose. Does not touch `instant_consultancy` — that table is M-13's. */
  async assignDoctor(consultationId: string, doctorId: string, actor: BookingActor): Promise<ConsultationRow> {
    const profile = await this.doctors.getPublicProfile(doctorId);
    if (!profile || !(await this.doctors.isVerifiedAndListed(doctorId))) throw doctorNotBookable();

    return this.db.transaction(async (tx) => {
      const row = await this.repo.findByIdForUpdate(consultationId, tx);
      if (!row) throw bookingNotFound();
      if (row.mode !== 'instant' || row.doctorId !== null) {
        throw new ConflictException({
          code: BOOKING_ERROR_CODES.INVALID_STATE_TRANSITION,
          message: 'This consultation cannot have a doctor assigned.',
        });
      }
      if (!profile.specialties.some((specialty) => specialty.id === row.specialtyId)) {
        throw doctorSpecialtyMismatch();
      }

      const updated = await this.repo.updateStatusIfIn(
        consultationId,
        [row.status],
        { doctorId, durationMinutes: profile.consultationDurationMinutes },
        tx,
      );
      if (!updated) throw invalidTransition(row.status);

      await this.audit.write(
        {
          actorType: actor.party === 'system' ? 'system' : actor.party,
          actorId: actor.accountId,
          action: 'update',
          entityType: BOOKING_AUDIT_ENTITY_TYPES.CONSULTATION,
          entityId: consultationId,
          consultationId,
          metadata: { change: 'doctor_assigned', doctorId },
        },
        tx,
      );

      return updated;
    });
  }

  /**
   * *** ADDITIVE (M-13). THE INSTANT LIFECYCLE'S STATUS MOVES. ***
   *
   * `consultations` is this module's table, and FR-10.2 puts three status
   * moves inside M-13's flow that no method here covered:
   *
   *   `pending_payment` -> `awaiting_doctor`   the request starts routing
   *   `awaiting_doctor` -> `pending_payment`   a doctor accepted; now pay
   *   `awaiting_doctor` -> `expired`           every doctor was tried
   *
   * The alternative was M-13 writing `consultations.status` itself, which is
   * precisely the drift `booking.repository.ts`'s header flags in the other
   * direction. So the split is the same one M-05 makes for `doctors.presence`:
   * *** THE CALLER SUPPLIES THE LEGAL FROM-STATES, THIS MODULE TAKES THE ROW
   * LOCK AND ENFORCES THEM. *** M-13 owns the instant state machine; M-11
   * owns the row.
   *
   * Restricted to `mode: 'instant'` rows, so this can never become a general
   * status setter that routes around `cancel`/`reschedule`/`markNoShow` and
   * their policies. And it is NON-THROWING for a refused move — it returns a
   * `refusal`, because both of M-13's sweeps call it in a batch loop where one
   * refused candidate must not abandon the rest.
   */
  async transitionInstantConsultation(input: InstantTransitionInput): Promise<InstantTransitionResult> {
    return this.db.transaction(async (tx) => {
      const row = await this.repo.findByIdForUpdate(input.consultationId, tx);
      if (!row) return { changed: false, booking: null, refusal: 'not_found' as const };

      // The whole reason this is safe to expose: it cannot touch a scheduled
      // booking, so none of M-11's own policies can be routed around with it.
      if (row.mode !== 'instant') {
        return { changed: false, booking: row, refusal: 'not_instant' as const };
      }

      // Idempotent no-op — a retried sweep tick must not look like a state
      // change in the audit log.
      if (row.status === input.to) {
        return { changed: false, booking: row };
      }

      const patch: Partial<NewConsultationRow> = { status: input.to };
      // `holdExpiresAt` is only written when the caller says so, and `null` is
      // a MEANINGFUL value here (clear the hold), so the field's presence is
      // what decides — not its truthiness.
      if (input.holdExpiresAt !== undefined) patch.holdExpiresAt = input.holdExpiresAt;

      const updated = await this.repo.updateStatusIfIn(input.consultationId, input.from, patch, tx);
      if (!updated) {
        return { changed: false, booking: row, refusal: 'illegal_transition' as const };
      }

      await this.audit.write(
        {
          actorType: 'system',
          actorId: null,
          action: 'update',
          entityType: BOOKING_AUDIT_ENTITY_TYPES.CONSULTATION,
          entityId: input.consultationId,
          consultationId: input.consultationId,
          metadata: {
            change: 'instant_transition',
            before: row.status,
            after: input.to,
            ...(input.reason ? { reason: input.reason } : {}),
          },
        },
        tx,
      );

      return { changed: true, booking: updated };
    });
  }

  /** ADDITIVE (M-13) — see `BookingRepository#listExpiredInstantHolds`. */
  async listExpiredInstantHolds(now: Date, limit: number): Promise<ExpiredInstantHold[]> {
    return this.repo.listExpiredInstantHolds(now, limit);
  }

  /** ADDITIVE (M-13) — see `BookingRepository#listStaleAwaitingDoctorRequests`. */
  async listStaleAwaitingDoctorRequests(
    staleBefore: Date,
    limit: number,
  ): Promise<Array<{ consultationId: string; patientId: string; updatedAt: Date }>> {
    return this.repo.listStaleAwaitingDoctorRequests(staleBefore, limit);
  }

  /* ── Cancel ───────────────────────────────────────────────────────────── */

  /**
   * Cancels a booking and decides what money comes back.
   *
   * *** DELIBERATE DEVIATION FROM FR-7.7, READ LITERALLY. *** FR-7.7 says
   * "Refunds are initiated from the admin panel and their status is visible
   * to the patient", and M-12's feature list repeats it. THE USER EXPLICITLY
   * DECIDED OTHERWISE for the in-policy case: a cancellation that the
   * configured policy prices unambiguously raises its refund automatically,
   * via `createRefund(..., initiatedByAdminId: null, isAutomatic: true)` —
   * which is precisely the row shape `refunds.schema.ts` already anticipates
   * ("NULL for an automatic in-policy refund"). Anything the policy CANNOT
   * price (see `booking-policy.engine.ts`'s `RefundAmbiguityReason`) still
   * goes to a human, with the money held. So the deviation is narrow: it
   * automates the cases where an admin would have had no discretion anyway,
   * and preserves the admin panel for every case where they would.
   *
   * The refund is raised AFTER the cancelling transaction commits, on
   * purpose. Freeing the slot is the urgent, local, always-correct half;
   * moving money is the slow, remote, retryable half. If the refund call
   * fails, the cancellation still stands and the case lands in the admin
   * queue — the patient never loses a cancellation because a gateway was
   * briefly unreachable.
   */
  async cancel(consultationId: string, actor: BookingActor, reason: string | null): Promise<ConsultationRow> {
    const cancelled = await this.db.transaction(async (tx) => {
      const row = await this.repo.findByIdForUpdate(consultationId, tx);
      if (!row || !this.canAct(row, actor)) throw bookingNotFound();
      if (!(CANCELLABLE_STATUSES as readonly ConsultationStatus[]).includes(row.status)) {
        throw invalidTransition(row.status);
      }

      const updated = await this.repo.updateStatusIfIn(
        consultationId,
        CANCELLABLE_STATUSES,
        {
          status: 'cancelled',
          cancelledAt: new Date(),
          cancelledByParty: actor.party,
          cancellationReason: reason,
          // Clearing the hold is not cosmetic: it takes the row out of the
          // sweep's candidate set, so a cancelled booking is never swept.
          holdExpiresAt: null,
        },
        tx,
      );
      if (!updated) throw invalidTransition(row.status);

      await this.audit.write(
        {
          actorType: actor.party === 'system' ? 'system' : actor.party,
          actorId: actor.accountId,
          action: 'update',
          entityType: BOOKING_AUDIT_ENTITY_TYPES.CONSULTATION,
          entityId: consultationId,
          consultationId,
          metadata: { change: 'cancelled', before: row.status, after: 'cancelled', cancelledByParty: actor.party, reason },
        },
        tx,
      );

      return updated;
    });

    await this.settleCancellationRefund(cancelled, actor);
    return cancelled;
  }

  /**
   * Prices the cancellation and either raises an automatic refund or files it
   * for a human. Never throws: a failure here must not undo a cancellation
   * that already committed, so every failure path ends in the admin queue.
   */
  private async settleCancellationRefund(booking: ConsultationRow, actor: BookingActor): Promise<void> {
    let payment: { paymentId: string; status: string; paidAt: Date | null } | null = null;
    try {
      payment = await this.payments.getByConsultationId(booking.id);
    } catch (error) {
      // The port is unavailable (pre-merge this is ALWAYS the case). We do not
      // know whether money was taken, so a human must look.
      await this.fileForAdminResolution(booking.id, BOOKING_RESOLUTION_KINDS.REFUND_NEEDS_REVIEW, {
        reason: 'payment_lookup_failed',
        detail: describeError(error),
      });
      return;
    }

    // Nothing was ever captured, so there is nothing to give back. Not an
    // ambiguity — a definite "no refund is owed".
    if (!payment || payment.status !== 'paid') return;

    const policy = await this.resolvePolicy(BOOKING_CONFIG_KEYS.CANCELLATION_POLICY, DEFAULT_CANCELLATION_POLICY);
    const decision = decideRefund({
      policy,
      scheduledStartAt: booking.scheduledStartAt,
      cancelledByParty: booking.cancelledByParty ?? actor.party,
      now: new Date(),
    });

    if (decision.outcome === 'needs_admin_review') {
      await this.fileForAdminResolution(booking.id, BOOKING_RESOLUTION_KINDS.REFUND_NEEDS_REVIEW, {
        reason: decision.reason,
        paymentId: payment.paymentId,
      });
      return;
    }

    if (decision.outcome === 'no_refund') {
      await this.audit.write({
        actorType: 'system',
        actorId: null,
        action: 'update',
        entityType: BOOKING_AUDIT_ENTITY_TYPES.CONSULTATION,
        entityId: booking.id,
        consultationId: booking.id,
        metadata: { change: 'refund_declined_by_policy', refundPct: 0, matchedTier: decision.matchedTier },
      });
      return;
    }

    const consultationFee = await this.resolveConsultationFee(booking);
    // *** THE FEE-BASED AMOUNT IS NOW THE LEGACY FALLBACK, NOT THE ANSWER. ***
    //
    // `refundPct` is sent alongside it, and M-12 prefers the percentage whenever
    // the payment was priced by the pricing engine — computing it against the
    // CAPTURED TOTAL rather than the consultation fee. A 100% tier on a 618.00
    // bill therefore returns 618.00, where it previously returned the 500.00 fee
    // and the patient never got the convenience fee or the GST back.
    //
    // *** THIS IS A COMMERCIAL CHANGE AND IT NEEDS THE CLIENT'S SIGN-OFF. ***
    // It changes what the published cancellation policy pays out and the
    // platform's revenue on every in-policy cancellation.
    //
    // The amount below still governs a LEGACY payment (no quote), which has no
    // per-component breakdown to apportion a tax reversal against. Sending both
    // is what keeps historical rows on their original base instead of silently
    // re-basing them.
    const amount = refundAmountFor(consultationFee, decision.refundPct);

    try {
      const refund = await this.payments.createRefund({
        paymentId: payment.paymentId,
        amount,
        reason: `Cancellation within policy (${decision.refundPct}%).`,
        initiatedByAdminId: null,
        isAutomatic: true,
        refundPct: decision.refundPct,
      });
      await this.audit.write({
        actorType: 'system',
        actorId: null,
        action: 'update',
        entityType: BOOKING_AUDIT_ENTITY_TYPES.CONSULTATION,
        entityId: booking.id,
        consultationId: booking.id,
        metadata: { change: 'auto_refund_raised', refundId: refund.refundId, refundPct: decision.refundPct, amount },
      });
    } catch (error) {
      await this.fileForAdminResolution(booking.id, BOOKING_RESOLUTION_KINDS.REFUND_NEEDS_REVIEW, {
        reason: 'refund_call_failed',
        detail: describeError(error),
        paymentId: payment.paymentId,
        intendedAmount: amount,
        refundPct: decision.refundPct,
      });
    }
  }

  /* ── Reschedule ───────────────────────────────────────────────────────── */

  /**
   * Moves a booking to a new slot.
   *
   * The docs are silent on how reschedule is modelled, but the schema is not:
   * `consultations.rescheduled_from_consultation_id` is a self-reference
   * documented as "the prior consultation this replaced", so a reschedule is
   * a NEW ROW, never an update in place. That also keeps the audit trail
   * honest — the original booking survives with its own history.
   *
   * ORDER INSIDE THE TRANSACTION IS LOAD-BEARING:
   *   1. Cancel the old row FIRST. That is what frees its slot, because
   *      `cancelled` is not in the partial unique index's status list — and
   *      it is what lets a patient reschedule to a time that overlaps their
   *      own current booking, including the same slot. (The ADVISORY
   *      pre-check has to be told about that case separately — see
   *      `assertReschedulableInto`, which is what actually makes the
   *      overlapping and same-slot moves reachable.)
   *   2. Insert the new row. If the new slot is taken, the index raises
   *      `23505`, the WHOLE transaction rolls back, and the old booking is
   *      restored untouched. A failed reschedule never costs the patient the
   *      slot they already had.
   *   3. Move the payment across with an UPDATE — `payments.consultation_id`
   *      is UNIQUE, so one payment follows the patient to the live
   *      consultation. One payment, one live consultation, no re-charge, and
   *      no refund/re-charge round trip through the gateway.
   */
  async reschedule(consultationId: string, actor: BookingActor, newStartAt: Date): Promise<ConsultationRow> {
    const existing = await this.repo.findById(consultationId);
    if (!existing || !this.canAct(existing, actor)) throw bookingNotFound();
    if (!(RESCHEDULABLE_STATUSES as readonly ConsultationStatus[]).includes(existing.status)) {
      throw invalidTransition(existing.status);
    }
    if (existing.doctorId === null) {
      throw new ConflictException({
        code: BOOKING_ERROR_CODES.INVALID_BOOKING_SHAPE,
        message: 'A consultation with no assigned doctor cannot be rescheduled.',
      });
    }

    // Validated exactly like a fresh booking — same doctor gate, same slot
    // gate. `isSlotBookable` stays advisory; the index still decides.
    if (!(await this.doctors.isVerifiedAndListed(existing.doctorId))) throw doctorNotBookable();
    await this.assertReschedulableInto(existing, newStartAt);

    // Resolved BEFORE the transaction opens: the port is a remote call, and a
    // remote call must never run while we hold a row lock.
    const payment = await this.loadPaymentOrThrow(consultationId);
    const referenceCode = await this.generateReferenceCode();

    try {
      return await this.db.transaction(async (tx) => {
        const locked = await this.repo.findByIdForUpdate(consultationId, tx);
        if (!locked || !this.canAct(locked, actor)) throw bookingNotFound();
        if (!(RESCHEDULABLE_STATUSES as readonly ConsultationStatus[]).includes(locked.status)) {
          throw invalidTransition(locked.status);
        }

        // 1. Free the old slot.
        const cancelledOld = await this.repo.updateStatusIfIn(
          consultationId,
          RESCHEDULABLE_STATUSES,
          {
            status: 'cancelled',
            cancelledAt: new Date(),
            cancelledByParty: actor.party,
            cancellationReason: 'Rescheduled',
            holdExpiresAt: null,
          },
          tx,
        );
        if (!cancelledOld) throw invalidTransition(locked.status);

        // 2. Claim the new one. `23505` here rolls step 1 back with it.
        const created = await this.repo.insert(
          {
            referenceCode,
            patientId: locked.patientId,
            doctorId: locked.doctorId,
            specialtyId: locked.specialtyId,
            concernId: locked.concernId,
            mode: locked.mode,
            // Already paid for — it goes straight back to `scheduled`, with no
            // new hold and no second trip through checkout.
            status: 'scheduled',
            scheduledStartAt: newStartAt,
            durationMinutes: locked.durationMinutes,
            holdExpiresAt: null,
            intakeAnswers: locked.intakeAnswers,
            rescheduledFromConsultationId: locked.id,
            followupOfConsultationId: locked.followupOfConsultationId,
          },
          tx,
        );

        // 3. Carry the money over.
        await this.repo.movePaymentToConsultation(payment.paymentId, created.id, tx);

        await this.audit.write(
          {
            actorType: actor.party === 'system' ? 'system' : actor.party,
            actorId: actor.accountId,
            action: 'update',
            entityType: BOOKING_AUDIT_ENTITY_TYPES.CONSULTATION,
            entityId: consultationId,
            consultationId,
            metadata: { change: 'rescheduled_away', toConsultationId: created.id, before: locked.status, after: 'cancelled' },
          },
          tx,
        );
        await this.audit.write(
          {
            actorType: actor.party === 'system' ? 'system' : actor.party,
            actorId: actor.accountId,
            action: 'create',
            entityType: BOOKING_AUDIT_ENTITY_TYPES.CONSULTATION,
            entityId: created.id,
            consultationId: created.id,
            metadata: {
              change: 'rescheduled_into',
              fromConsultationId: consultationId,
              paymentId: payment.paymentId,
              scheduledStartAt: newStartAt.toISOString(),
            },
          },
          tx,
        );

        return created;
      });
    } catch (error) {
      if (isUniqueConstraintViolation(error)) throw slotAlreadyTaken();
      throw error;
    }
  }

  /* ── No-show ──────────────────────────────────────────────────────────── */

  /** Doctor-only (FR-18.3 also lets an admin). `no_show` is NOT in the index's occupying list, so marking one frees the slot — correct, since nobody attended it. */
  async markNoShow(consultationId: string, actor: BookingActor): Promise<ConsultationRow> {
    return this.db.transaction(async (tx) => {
      const row = await this.repo.findByIdForUpdate(consultationId, tx);
      if (!row || !this.canAct(row, actor)) throw bookingNotFound();
      if (!(NO_SHOW_STATUSES as readonly ConsultationStatus[]).includes(row.status)) throw invalidTransition(row.status);

      const updated = await this.repo.updateStatusIfIn(consultationId, NO_SHOW_STATUSES, { status: 'no_show', holdExpiresAt: null }, tx);
      if (!updated) throw invalidTransition(row.status);

      await this.audit.write(
        {
          actorType: actor.party === 'system' ? 'system' : actor.party,
          actorId: actor.accountId,
          action: 'update',
          entityType: BOOKING_AUDIT_ENTITY_TYPES.CONSULTATION,
          entityId: consultationId,
          consultationId,
          metadata: { change: 'no_show', before: row.status, after: 'no_show' },
        },
        tx,
      );

      return updated;
    });
  }

  /* ── Intake and documents ─────────────────────────────────────────────── */

  /**
   * Snapshots the patient's answers to the specialty intake form (FR-19.2 —
   * the form itself is M-06's, specialty-wise and admin-authored; this only
   * stores what came back). Only while the consult has not started: once a
   * doctor is reading it, the answers they saw must not change under them.
   */
  async saveIntakeAnswers(consultationId: string, actor: BookingActor, answers: unknown): Promise<ConsultationRow> {
    return this.db.transaction(async (tx) => {
      const row = await this.repo.findByIdForUpdate(consultationId, tx);
      if (!row || !this.canAct(row, actor)) throw bookingNotFound();

      const editable: readonly ConsultationStatus[] = ['pending_payment', 'scheduled', 'awaiting_doctor'];
      if (!editable.includes(row.status)) throw invalidTransition(row.status);

      const updated = await this.repo.updateStatusIfIn(consultationId, editable, { intakeAnswers: answers }, tx);
      if (!updated) throw invalidTransition(row.status);

      await this.audit.write(
        {
          actorType: actor.party === 'system' ? 'system' : actor.party,
          actorId: actor.accountId,
          action: 'update',
          entityType: BOOKING_AUDIT_ENTITY_TYPES.CONSULTATION,
          entityId: consultationId,
          consultationId,
          metadata: { change: 'intake_answers_saved' },
        },
        tx,
      );

      return updated;
    });
  }

  /**
   * FR-6.3's booking-side gate for attaching a report or photo.
   *
   * *** SCOPE NOTE — WHO WRITES THE LINK. *** The durable
   * `patient_files.consultation_id` link is written by M-10 at UPLOAD time
   * (`POST /documents` accepts a `consultationId` and validates it through
   * `CONSULTATION_LOOKUP_PROVIDER`, which is THIS module's facade once the
   * coordinator rebinds it). M-11 must not write `patient_files` — it is
   * another module's table (`backend/README.md` §2) and `DocumentContract`
   * deliberately exposes no write method.
   *
   * So what this does is the half M-11 legitimately owns: confirm the
   * booking is the caller's and still open for attachments, confirm through
   * `DocumentFacade` that the file exists and belongs to the same patient,
   * and record the attachment against the consultation in the audit trail.
   * It returns the resolved file so a client can render it immediately.
   */
  async attachDocument(consultationId: string, actor: BookingActor, fileId: string) {
    const booking = await this.repo.findById(consultationId);
    if (!booking || !this.canAct(booking, actor)) throw bookingNotFound();

    const closed: readonly ConsultationStatus[] = ['completed', 'cancelled', 'expired', 'no_show'];
    if (closed.includes(booking.status)) throw invalidTransition(booking.status);

    const file = await this.documents.getPatientFileById(fileId);
    if (!file || file.patientId !== booking.patientId) {
      throw new NotFoundException({
        code: BOOKING_ERROR_CODES.DOCUMENT_NOT_ATTACHABLE,
        message: 'Document not found.',
      });
    }

    await this.audit.write({
      actorType: actor.party === 'system' ? 'system' : actor.party,
      actorId: actor.accountId,
      action: 'update',
      entityType: BOOKING_AUDIT_ENTITY_TYPES.CONSULTATION,
      entityId: consultationId,
      consultationId,
      metadata: { change: 'document_attached', patientFileId: fileId, fileName: file.fileName },
    });

    return file;
  }

  /* ── Reads ────────────────────────────────────────────────────────────── */

  async getOwnBooking(consultationId: string, actor: BookingActor): Promise<ConsultationRow> {
    const row = await this.repo.findById(consultationId);
    if (!row || !this.canAct(row, actor)) throw bookingNotFound();
    return row;
  }

  async listForParty(input: {
    party: 'patient' | 'doctor';
    accountId: string;
    scope: 'upcoming' | 'past';
    limit: number;
    offset: number;
  }): Promise<ConsultationRow[]> {
    return this.repo.listForParty(input);
  }

  async listForAdmin(input: { status?: ConsultationStatus; limit: number; offset: number }): Promise<ConsultationRow[]> {
    return this.repo.listForAdmin(input);
  }

  async listAdminResolutionQueue(limit: number, offset: number) {
    return this.repo.listAdminResolutionQueue(limit, offset);
  }

  /** The pre-booking bill, so a patient sees the total before committing to a slot. Wrapped like every other port call. */
  async quoteForDoctor(doctorId: string): Promise<PaymentBreakdown> {
    const profile = await this.doctors.getPublicProfile(doctorId);
    if (!profile) throw doctorNotBookable();
    try {
      return await this.payments.quote(profile.consultationFeeInr);
    } catch {
      throw new ConflictException({
        code: BOOKING_ERROR_CODES.PAYMENT_SETUP_FAILED,
        message: 'We could not price this consultation right now. Please try again.',
      });
    }
  }

  /* ── Internals ────────────────────────────────────────────────────────── */

  /** The consultation insert plus its audit entry, in one transaction. `23505` from the partial unique index becomes a clean 409. */
  private async insertBooking(input: {
    patientId: string;
    doctorId: string | null;
    specialtyId: string;
    concernId: string | null;
    mode: 'scheduled' | 'instant';
    scheduledStartAt: Date | null;
    durationMinutes: number;
    holdExpiresAt: Date;
    intakeAnswers: unknown;
    actor: BookingActor;
  }): Promise<ConsultationRow> {
    const referenceCode = await this.generateReferenceCode();

    try {
      return await this.db.transaction(async (tx) => {
        const row = await this.repo.insert(
          {
            referenceCode,
            patientId: input.patientId,
            doctorId: input.doctorId,
            specialtyId: input.specialtyId,
            concernId: input.concernId,
            mode: input.mode,
            status: 'pending_payment',
            scheduledStartAt: input.scheduledStartAt,
            durationMinutes: input.durationMinutes,
            holdExpiresAt: input.holdExpiresAt,
            intakeAnswers: input.intakeAnswers,
          },
          tx,
        );

        await this.audit.write(
          {
            actorType: input.actor.party === 'system' ? 'system' : input.actor.party,
            actorId: input.actor.accountId,
            action: 'create',
            entityType: BOOKING_AUDIT_ENTITY_TYPES.CONSULTATION,
            entityId: row.id,
            consultationId: row.id,
            metadata: {
              change: 'booking_created',
              mode: input.mode,
              doctorId: input.doctorId,
              scheduledStartAt: input.scheduledStartAt?.toISOString() ?? null,
              holdExpiresAt: input.holdExpiresAt.toISOString(),
            },
          },
          tx,
        );

        return row;
      });
    } catch (error) {
      // THE AUTHORITATIVE double-booking answer. `isSlotBookable` may well
      // have said yes a moment ago; the index is what actually decides.
      if (isUniqueConstraintViolation(error)) throw slotAlreadyTaken();
      throw error;
    }
  }

  /**
   * Releases a hold whose payment setup failed. Best-effort by design: if
   * this write fails too, the row stays `pending_payment` with a hold and no
   * payment, which the sweep's Tier 1 releases on its next pass. Never
   * rethrows — the caller is already about to surface `PAYMENT_SETUP_FAILED`,
   * and a compensation failure must not replace that with something worse.
   */
  private async compensateFailedPaymentSetup(consultationId: string, cause: unknown): Promise<void> {
    try {
      await this.db.transaction(async (tx) => {
        const released = await this.repo.updateStatusIfIn(
          consultationId,
          ['pending_payment'],
          { status: 'expired', holdExpiresAt: null },
          tx,
        );
        if (!released) return;
        await this.audit.write(
          {
            actorType: 'system',
            actorId: null,
            action: 'update',
            entityType: BOOKING_AUDIT_ENTITY_TYPES.CONSULTATION,
            entityId: consultationId,
            consultationId,
            metadata: { change: 'hold_released', reason: 'payment_setup_failed', detail: describeError(cause) },
          },
          tx,
        );
      });
    } catch (error) {
      this.logger.error(
        `Failed to release hold for consultation ${consultationId} after payment setup failed; the sweep will collect it. ${describeError(error)}`,
      );
    }
  }

  /** Files a case for a human, with the money held. See `booking.constants.ts` for why the queue is an audit entity. */
  private async fileForAdminResolution(consultationId: string, kind: string, detail: Record<string, unknown>): Promise<void> {
    await this.audit.write({
      actorType: 'system',
      actorId: null,
      action: 'create',
      entityType: BOOKING_AUDIT_ENTITY_TYPES.ADMIN_RESOLUTION,
      entityId: consultationId,
      consultationId,
      metadata: { kind, ...detail },
    });
  }

  /**
   * The slot gate for a RESCHEDULE, which is not quite the gate for a fresh
   * booking.
   *
   * *** THE BOOKING BEING MOVED MUST NOT BLOCK ITS OWN MOVE. ***
   * `AvailabilityContract.isSlotBookable` takes only `(doctorId, startsAtUtc)`
   * — there is no way to tell it "ignore this one consultation" — so it counts
   * the appointment we are about to cancel among the doctor's busy intervals
   * and answers `already_taken`. That made rescheduling to the SAME slot, or to
   * any slot inside the appointment's own duration (a 10:00 half-hour consult
   * moved to 10:15), fail with a 409 naming a conflict against the patient's
   * own booking — while `reschedule`'s doc comment promised exactly that case
   * would work. Verified live before the fix: `POST /bookings/:id/reschedule`
   * to 09:00 and to 09:15 on a 09:00 30-minute booking both returned
   * `SLOT_NOT_BOOKABLE / already_taken`.
   *
   * `already_taken` is the ONLY verdict this can affect, so it is the only one
   * re-tested — against this module's own table, with the moved row excluded
   * and the same occupying-status set the partial unique index uses. Every
   * other reason (`blocked`, `outside_working_hours`, `too_soon`,
   * `too_far_ahead`, `doctor_not_bookable`) is a fact about the doctor's
   * calendar rules that the moved row cannot have caused, and still stands.
   *
   * This LOOSENS nothing: a slot genuinely taken by somebody else still fails
   * here, and if it is taken between this check and the insert the partial
   * unique index refuses the insert and the whole reschedule rolls back.
   */
  private async assertReschedulableInto(existing: ConsultationRow, newStartAt: Date): Promise<void> {
    const doctorId = existing.doctorId;
    if (doctorId === null) throw bookingNotFound();

    const bookability = await this.availability.isSlotBookable(doctorId, newStartAt);
    if (bookability.bookable) return;

    if (bookability.reason === 'already_taken') {
      // The interval the REPLACEMENT row will occupy — its own duration, which
      // is what `reschedule` copies onto the new row.
      const endsAt = new Date(newStartAt.getTime() + existing.durationMinutes * 60_000);
      const takenByAnother = await this.repo.hasOccupyingOverlap(doctorId, newStartAt, endsAt, existing.id);
      if (!takenByAnother) return;
    }

    throw new ConflictException({
      code: BOOKING_ERROR_CODES.SLOT_NOT_BOOKABLE,
      message: 'That slot cannot be booked.',
      reason: bookability.reason,
    });
  }

  /** Every "may this be booked at all" check a create or reschedule shares. */
  private async validateBookingTargets(input: {
    patientId: string;
    doctorId: string | null;
    specialtyId: string;
    concernId: string | null;
  }): Promise<{ doctorProfile: { consultationFeeInr: string; consultationDurationMinutes: number } }> {
    const patient = await this.patients.getProfileSummary(input.patientId);
    if (!patient) {
      throw new NotFoundException({ code: BOOKING_ERROR_CODES.PATIENT_NOT_FOUND, message: 'Patient not found.' });
    }

    const specialty = await this.catalogue.getSpecialtyById(input.specialtyId);
    // A NEW booking may only be taken under an ACTIVE specialty — unlike a
    // read of an existing one, which must keep working after deactivation
    // (`catalogue.contract.ts`).
    if (!specialty || !specialty.isActive) throw specialtyNotBookable();

    if (input.concernId) {
      const concern = await this.catalogue.getConcernById(input.concernId);
      if (!concern || concern.specialtyId !== input.specialtyId) {
        throw new BadRequestException({
          code: BOOKING_ERROR_CODES.CONCERN_NOT_BOOKABLE,
          message: 'That concern does not belong to the selected specialty.',
        });
      }
    }

    if (input.doctorId === null) {
      return { doctorProfile: { consultationFeeInr: '0', consultationDurationMinutes: DEFAULT_INSTANT_DURATION_MINUTES } };
    }

    const profile = await this.doctors.getPublicProfile(input.doctorId);
    if (!profile || !(await this.doctors.isVerifiedAndListed(input.doctorId))) throw doctorNotBookable();

    // The `consultations_doctor_specialty_fk` composite FK enforces this at
    // the database too; checking here turns a raw FK violation into a clean
    // 400 that names the actual problem.
    if (!profile.specialties.some((specialty) => specialty.id === input.specialtyId)) throw doctorSpecialtyMismatch();

    return {
      doctorProfile: {
        consultationFeeInr: profile.consultationFeeInr,
        consultationDurationMinutes: profile.consultationDurationMinutes,
      },
    };
  }

  /** Ownership. A patient sees only their own, a doctor only theirs, an admin all — FR-1.4. Failure collapses to 404, never 403, so a caller cannot probe for existence. */
  private canAct(row: ConsultationRow, actor: BookingActor): boolean {
    switch (actor.party) {
      case 'patient':
        return row.patientId === actor.accountId;
      case 'doctor':
        return row.doctorId !== null && row.doctorId === actor.accountId;
      case 'admin':
      case 'system':
        return true;
    }
  }

  private async loadPaymentOrThrow(consultationId: string): Promise<{ paymentId: string; status: string; paidAt: Date | null }> {
    let payment: { paymentId: string; status: string; paidAt: Date | null } | null;
    try {
      payment = await this.payments.getByConsultationId(consultationId);
    } catch {
      throw new ConflictException({
        code: BOOKING_ERROR_CODES.PAYMENT_SETUP_FAILED,
        message: 'We could not reach payment for this booking. Please try again.',
      });
    }
    if (!payment) {
      throw new ConflictException({
        code: BOOKING_ERROR_CODES.PAYMENT_NOT_FOUND,
        message: 'This booking has no payment to move.',
      });
    }
    return payment;
  }

  /**
   * The refund base: what THIS consultation was actually billed, read off its
   * own payment row (`booking.repository.ts#findBilledConsultationFee` explains
   * why it is read there and not taken from the doctor's live profile).
   *
   * The live profile remains the fallback for the case where no payment row
   * exists at all — unreachable from the cancellation path, which only gets
   * here once the port has already reported `status: 'paid'`, but a wrong
   * refund is worse than a redundant guard.
   */
  private async resolveConsultationFee(booking: ConsultationRow): Promise<string> {
    const billed = await this.repo.findBilledConsultationFee(booking.id);
    if (billed !== null) return billed;

    if (!booking.doctorId) return '0';
    const profile = await this.doctors.getPublicProfile(booking.doctorId);
    return profile?.consultationFeeInr ?? '0';
  }

  private async resolveHoldMinutes(): Promise<number> {
    const minutes = await this.appConfig.getNumber(
      BOOKING_CONFIG_KEYS.SLOT_HOLD_MINUTES,
      BOOKING_CONFIG_FALLBACKS.SLOT_HOLD_MINUTES,
    );
    // A non-positive hold would create an already-expired one, which the
    // sweep would collect on its next pass — a config typo must not make
    // booking impossible.
    return minutes > 0 ? minutes : BOOKING_CONFIG_FALLBACKS.SLOT_HOLD_MINUTES;
  }

  private async resolvePolicy(key: string, fallback: RefundPolicy): Promise<RefundPolicy> {
    const raw = await this.appConfig.getJson<unknown>(key, fallback);
    return parseRefundPolicy(raw, fallback);
  }

  /**
   * A human-quotable code, inside `varchar(24)`: `DRC-<base36 ms>-<6 random>`
   * is 19 characters. The random tail is what makes a collision essentially
   * impossible; the timestamp keeps codes roughly sortable and readable.
   * `reference_code` is UNIQUE, so a collision would surface as a `23505`
   * indistinguishable from the slot one — hence the pre-check and retry here
   * rather than relying on the catch.
   */
  private async generateReferenceCode(): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const stamp = Date.now().toString(36).toUpperCase();
      const tail = randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
      const code = `${BOOKING_REFERENCE_PREFIX}-${stamp}-${tail}`;
      if (!(await this.repo.referenceCodeExists(code))) return code;
    }
    // 503, not 409: nothing about the request is wrong and there is nothing
    // for the caller to change — the server transiently could not allocate,
    // and retrying is exactly the right response.
    throw new ServiceUnavailableException({
      code: BOOKING_ERROR_CODES.REFERENCE_ALLOCATION_FAILED,
      message: 'Could not allocate a booking reference. Please try again.',
    });
  }
}

/** Stands in until M-13 assigns a doctor and the row takes that doctor's own consultation duration. */
const DEFAULT_INSTANT_DURATION_MINUTES = 15;

/** Collapses "doesn't exist" and "isn't yours" into one 404 — mirrors `document/report-request.service.ts#consultationNotFound`. */
export function bookingNotFound(): NotFoundException {
  return new NotFoundException({ code: BOOKING_ERROR_CODES.BOOKING_NOT_FOUND, message: 'Booking not found.' });
}

export function slotAlreadyTaken(): ConflictException {
  return new ConflictException({
    code: BOOKING_ERROR_CODES.SLOT_ALREADY_TAKEN,
    message: 'That slot has just been taken. Please choose another.',
  });
}

export function invalidTransition(from: ConsultationStatus): ConflictException {
  return new ConflictException({
    code: BOOKING_ERROR_CODES.INVALID_STATE_TRANSITION,
    message: `This booking cannot be changed while it is ${from}.`,
    currentStatus: from,
  });
}

export function doctorNotBookable(): ConflictException {
  return new ConflictException({ code: BOOKING_ERROR_CODES.DOCTOR_NOT_BOOKABLE, message: 'This doctor cannot be booked right now.' });
}

export function specialtyNotBookable(): ConflictException {
  return new ConflictException({
    code: BOOKING_ERROR_CODES.SPECIALTY_NOT_BOOKABLE,
    message: 'This specialty is not available for booking.',
  });
}

export function doctorSpecialtyMismatch(): BadRequestException {
  return new BadRequestException({
    code: BOOKING_ERROR_CODES.DOCTOR_SPECIALTY_MISMATCH,
    message: 'This doctor does not practise the selected specialty.',
  });
}

/** Never returned to a client — only ever written into `audit_log.metadata` or a server-side log. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
