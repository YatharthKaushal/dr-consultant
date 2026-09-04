import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { BookingFacade } from '../booking/booking.facade';
import { DoctorFacade } from '../doctor/doctor.facade';
import { PaymentFacade } from '../payment/payment.facade';
import { InstantPresenceService, SYSTEM_ACTOR, describeError } from './instant-presence.service';
import {
  ACCEPTANCE_SWEEP_INTERVAL_MS,
  INSTANT_AUDIT_ENTITY_TYPES,
  INSTANT_NOTIFICATION_TEMPLATES,
  PAYMENT_SWEEP_INTERVAL_MS,
  STRANDED_REQUEST_GRACE_MS,
  SWEEP_BATCH_SIZE,
  SWEEP_SCHEDULING,
} from './instant.constants';
import { InstantRepository } from './instant.repository';
import { InstantService } from './instant.service';
import { AuditService } from '../../shared/audit/audit.service';

export interface AcceptanceSweepResult {
  examined: number;
  timedOut: number;
  rerouted: number;
  exhausted: number;
  failed: number;
}

export interface PaymentSweepResult {
  examined: number;
  released: number;
  skipped: number;
  /** The gateway said the money was already in. Confirmed rather than released — see `askTheGatewayFirst`. */
  confirmed: number;
  failed: number;
}

export interface StrandedSweepResult {
  examined: number;
  /** Consultations that had genuinely stopped and were given another doctor. */
  rerouted: number;
  /** Consultations that had genuinely stopped and had nobody left, so were released. */
  released: number;
  /** Candidates that turned out to be fine — an offer was still outstanding, or they had already moved on. */
  skipped: number;
  failed: number;
}

/**
 * *** THE THREE THINGS THAT MOVE AN INSTANT REQUEST WITHOUT ANYONE ASKING. ***
 *
 * Both are plain `setInterval`s owned by this service, started in
 * `onModuleInit`, cleared in `onApplicationShutdown`, `.unref()`'d and
 * re-entrancy guarded — copied from `booking-slot-hold.service.ts`, whose
 * `SWEEP_SCHEDULING` note is reproduced in `instant.constants.ts` and explains
 * why `@nestjs/schedule` is not installed and is not being added.
 *
 * Correctness does not live in either timer. Every candidate is re-checked
 * under `SELECT ... FOR UPDATE` inside the transaction that acts on it, so two
 * processes sweeping at once is harmless: the loser's guard does not match and
 * it does nothing.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SWEEP 1 — THE ACCEPTANCE WINDOW (FR-10.6)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * An offer whose `expires_at` has passed with no answer becomes `timed_out`,
 * the doctor goes back to `available_now`, and the request is offered to the
 * NEXT doctor. This is the mechanism behind M-13's done-when bar: "a declined
 * request reaches the next doctor without patient action" — a timeout is the
 * same path as a decline, minus the doctor's tap.
 *
 * No starvation: timing an offer out sets `outcome = 'timed_out'`, which
 * removes it from the candidate query permanently, so a backlog drains
 * instead of being re-read forever.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SWEEP 2 — THE PAYMENT WINDOW AFTER ACCEPTANCE
 *
 * *** THIS FAILURE MODE HAS NO PRECEDENT ANYWHERE IN THE SCHEDULED FLOW.
 * READ THIS BEFORE CHANGING ANY OF IT. ***
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * FR-10.2 orders the instant flow request -> accept -> PAY. A scheduled
 * booking is paid for BEFORE anything is committed, so the worst an abandoned
 * checkout can cost is a slot, and `booking-slot-hold.service.ts` is built
 * around never losing one: its Tier 2 asks the gateway before releasing any
 * hold that reached checkout, and its default on an unknown answer is TO KEEP
 * HOLDING, because "holding a slot too long is a scheduling annoyance;
 * releasing one under a live payment is a money problem."
 *
 * Here the thing being held is not a slot. It is a DOCTOR — sitting
 * `in_consultation`, invisible to every other instant request, waiting on one
 * patient who has walked away from a checkout screen. Applying M-11's rule
 * here would mean a doctor blocked for up to `booking.slot_hold_minutes` (20)
 * because one patient's UPI app timed out, and doctors who experience that
 * stop going Available Now.
 *
 * So this sweep deliberately INVERTS M-11's default:
 *
 *   M-11:  unknown payment state -> KEEP the hold. Protect the money.
 *   M-13:  window elapsed        -> RELEASE the doctor. Protect the supply.
 *
 * What makes that safe rather than reckless is that the money is not dropped.
 * If the payment lands after the release, M-12's WEBHOOK emits
 * `payment.captured`, `BookingPaymentListener` calls `confirmPayment`, and
 * M-11's `confirmLateCapture` re-acquires the consultation. For an instant row
 * that re-acquire cannot fail on a slot clash, because there is no
 * `scheduled_start_at` and the partial unique index does not apply.
 *
 * *** BUT THAT CHAIN IS A FAST PATH, NOT A GUARANTEE, AND THIS SWEEP USED TO
 * TREAT IT AS ONE. READ THIS BEFORE TRUSTING IT. ***
 *
 * `booking-payment.listener.ts` says so itself, in its own header: "This is a
 * fast path, not the guarantee ... The durable guarantee lives in
 * `BookingSlotHoldService`'s two-tier sweep: every expired hold that has a
 * gateway order is reconciled against Razorpay." That backstop is driven off
 * `consultations.status = 'pending_payment'`. *** RELEASING TO `expired` IS
 * EXACTLY WHAT TAKES A ROW OUT OF IT. *** `PaymentRepository.listStale`
 * describes a payment-side reconciliation sweep, but nothing calls it, so
 * there is no second net underneath.
 *
 * So for a released instant consultation the ONLY route from a real capture
 * back to the patient was one in-process event. Lose the webhook — the precise
 * failure Tier 2 exists to cover — or be restarting when it arrives, and the
 * money sat captured at Razorpay with `payments.status = 'created'`, the
 * consultation `expired`, nothing filed for an operator, and nothing anywhere
 * that would ever look at it again.
 *
 * `askTheGatewayFirst` below closes that: before releasing, this sweep does
 * for an instant hold what Tier 2 does for a scheduled one — it ASKS. The
 * inversion is untouched, because it only ever applied to an UNKNOWN answer:
 * `paid` confirms, and every other answer, including an unreachable gateway,
 * still releases the doctor on M-13's own clock.
 *
 * The residual exposure is a patient whose money lands in the seconds between
 * the gateway answering "not paid" and this sweep committing the release. That
 * one still goes down the late-capture path, and it is worth being precise
 * about where it ends up: `confirmLateCapture` re-acquires an `expired`
 * instant row to `scheduled` and files NOTHING for a human — the admin
 * resolution queue is only reached when the row cannot be re-acquired at all.
 * So the patient gets a confirmed consultation whose doctor may by then be
 * `in_consultation` with somebody else, and nobody is told. That is a real
 * gap, it belongs to M-11/M-14 rather than here, and it is written down rather
 * than implied. It is bounded by `instant.payment_window_seconds`, which is in
 * `app_config` precisely so an operator can retune this trade without a
 * release.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SWEEP 3 — THE STRANDED REQUEST
 *
 * *** THE HOLE THE OTHER TWO LEAVE, AND THE ONLY ONE WITH NO OWNER AT ALL. ***
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Sweep 1 reads `instant_consultancy` WHERE `outcome = 'pending'`. Sweep 2 and
 * M-11's own hold sweep both read `consultations` WHERE there is a
 * `hold_expires_at` in the past. A consultation in `awaiting_doctor` has
 * NEITHER once its last offer has been settled: M-13 clears the hold on
 * purpose when routing starts (there is no doctor, no slot and nothing to pay
 * for), and a settled attempt is not `pending`.
 *
 * So every path that settles an offer and then fails to open the next one left
 * the request alive on the patient's screen and dead in the database, forever:
 *
 *   `decline` -> `routeNextQuietly` throws (the router's candidate query, the
 *   presence write or the attempt insert failed);
 *   the acceptance sweep times an offer out and its `routeNext` throws;
 *   `accept` rolls back after `assignDoctor` fails and the re-route throws;
 *   the process dies between `requestInstantConsult`'s step 2 and step 3.
 *
 * `InstantService#routeNextQuietly` now releases on a failed re-route, which
 * closes the first three IN PROCESS. This sweep is the DURABLE backstop —
 * the one that also covers a process that simply stopped existing mid-saga —
 * and it is deliberately the dumbest of the three: hand every stale
 * `awaiting_doctor` request straight back to `routeNext`, which already knows
 * how to refuse one that has an offer outstanding (`already_pending`), how to
 * find the next doctor, and how to release one that has run out
 * (`exhausted`). No new decision is made here.
 */
@Injectable()
export class InstantExpiryService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(InstantExpiryService.name);

  private acceptanceTimer: NodeJS.Timeout | null = null;
  private paymentTimer: NodeJS.Timeout | null = null;
  private acceptanceSweepInFlight = false;
  private paymentSweepInFlight = false;

  constructor(
    private readonly repo: InstantRepository,
    private readonly instant: InstantService,
    private readonly bookings: BookingFacade,
    private readonly doctors: DoctorFacade,
    private readonly payments: PaymentFacade,
    private readonly presence: InstantPresenceService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    if (!SWEEP_SCHEDULING) return;

    if (!this.acceptanceTimer) {
      this.acceptanceTimer = setInterval(() => {
        void this.runScheduledAcceptanceSweep();
      }, ACCEPTANCE_SWEEP_INTERVAL_MS);
      // Never hold the process open for a timer.
      this.acceptanceTimer.unref();
    }

    if (!this.paymentTimer) {
      this.paymentTimer = setInterval(() => {
        void this.runScheduledPaymentSweep();
      }, PAYMENT_SWEEP_INTERVAL_MS);
      this.paymentTimer.unref();
    }
  }

  onApplicationShutdown(): void {
    if (this.acceptanceTimer) {
      clearInterval(this.acceptanceTimer);
      this.acceptanceTimer = null;
    }
    if (this.paymentTimer) {
      clearInterval(this.paymentTimer);
      this.paymentTimer = null;
    }
  }

  /* ── Sweep 1: the acceptance window ────────────────────────────────────── */

  /** The timer's entry point: re-entrancy guarded, and it never lets a failure escape into an unhandled rejection. */
  private async runScheduledAcceptanceSweep(): Promise<void> {
    if (this.acceptanceSweepInFlight) {
      this.logger.warn('Previous acceptance-window sweep still running; skipping this tick.');
      return;
    }
    this.acceptanceSweepInFlight = true;
    try {
      const result = await this.sweepExpiredOffers();
      if (result.timedOut > 0 || result.failed > 0) {
        this.logger.log(
          `Acceptance sweep: ${result.timedOut} timed out, ${result.rerouted} re-routed, ${result.exhausted} exhausted, ${result.failed} failed.`,
        );
      }

      // Same tick, same question. See SWEEP 3 in the class header.
      const stranded = await this.sweepStrandedRequests();
      if (stranded.rerouted > 0 || stranded.released > 0 || stranded.failed > 0) {
        this.logger.log(
          `Stranded-request sweep: ${stranded.rerouted} re-routed, ${stranded.released} released, ${stranded.skipped} skipped, ${stranded.failed} failed.`,
        );
      }
    } catch (error) {
      this.logger.error(`Acceptance-window sweep failed: ${describeError(error)}`);
    } finally {
      this.acceptanceSweepInFlight = false;
    }
  }

  /**
   * One acceptance-window pass. Safe to call directly (tests and the admin
   * endpoint do), and safe to run concurrently with itself in another process.
   */
  async sweepExpiredOffers(now: Date = new Date()): Promise<AcceptanceSweepResult> {
    const candidates = await this.repo.findExpiredPendingAttempts(now, SWEEP_BATCH_SIZE);
    const result: AcceptanceSweepResult = {
      examined: candidates.length,
      timedOut: 0,
      rerouted: 0,
      exhausted: 0,
      failed: 0,
    };

    for (const candidate of candidates) {
      try {
        // `timeOutAttempt` re-checks the outcome under the row lock, so a
        // doctor who answered between the candidate query and here wins and
        // this returns false.
        if (!(await this.instant.timeOutAttempt(candidate.id))) continue;
        result.timedOut += 1;

        const routed = await this.instant.routeNext(candidate.consultationId, 'acceptance_window_expired');
        if (routed.routed) result.rerouted += 1;
        else if (routed.reason === 'exhausted') result.exhausted += 1;
      } catch (error) {
        result.failed += 1;
        this.logger.error(`Timing out instant request ${candidate.id} failed: ${describeError(error)}`);
      }
    }

    return result;
  }

  /* ── Sweep 2: the payment window after acceptance ──────────────────────── */

  private async runScheduledPaymentSweep(): Promise<void> {
    if (this.paymentSweepInFlight) {
      this.logger.warn('Previous instant-payment sweep still running; skipping this tick.');
      return;
    }
    this.paymentSweepInFlight = true;
    try {
      const result = await this.sweepUnpaidAcceptedRequests();
      if (result.released > 0 || result.confirmed > 0 || result.failed > 0) {
        this.logger.log(
          `Instant payment sweep: ${result.released} released, ${result.confirmed} confirmed from the gateway, ` +
            `${result.skipped} skipped, ${result.failed} failed.`,
        );
      }
    } catch (error) {
      this.logger.error(`Instant-payment sweep failed: ${describeError(error)}`);
    } finally {
      this.paymentSweepInFlight = false;
    }
  }

  /**
   * One payment-window pass — the sweep with no equivalent in the scheduled
   * flow. See the class header for the whole argument; the code below is the
   * short version.
   *
   * Candidates come from `BookingFacade.listExpiredInstantHolds`, which is
   * driven off `consultations.status = 'pending_payment'`. That is what makes
   * this pass self-limiting: releasing a candidate moves it to `expired`, and
   * a payment that lands first moves it to `scheduled`. Either way it stops
   * being a candidate, so there is no marker to maintain and no backlog to
   * re-read.
   */
  async sweepUnpaidAcceptedRequests(now: Date = new Date()): Promise<PaymentSweepResult> {
    const candidates = await this.bookings.listExpiredInstantHolds(now, SWEEP_BATCH_SIZE);
    const result: PaymentSweepResult = { examined: candidates.length, released: 0, skipped: 0, confirmed: 0, failed: 0 };

    for (const candidate of candidates) {
      try {
        const outcome = await this.releaseUnpaidRequest(candidate.consultationId, candidate.doctorId);
        if (outcome === 'released') result.released += 1;
        else if (outcome === 'confirmed') result.confirmed += 1;
        else result.skipped += 1;
      } catch (error) {
        result.failed += 1;
        this.logger.error(
          `Releasing unpaid instant consultation ${candidate.consultationId} failed: ${describeError(error)}`,
        );
      }
    }

    return result;
  }

  /**
   * *** THE ONE THING THIS SWEEP BORROWS FROM M-11's TIER 2. ***
   *
   * Returns `true` when the money is already in and the consultation has been
   * confirmed instead of released.
   *
   * WHY THIS IS NOT THE "NEVER RELEASE UNDER A LIVE PAYMENT" RULE COMING BACK.
   * That rule is about an UNKNOWN answer, and M-11's default on one is to keep
   * holding. This sweep's default on an unknown answer is unchanged: release,
   * and protect the supply. A gateway that says `paid` is not a live payment,
   * it is a finished one — and releasing a consultation the patient has
   * already paid for was never the trade being made.
   *
   * Everything is best-effort and every failure falls through to the release.
   * A gateway we cannot reach must not be able to pin a doctor: that is the
   * whole point of this sweep, and it is the one place M-13 and M-11 genuinely
   * disagree.
   *
   * `reconcileWithGateway` marks the payment `paid` locally but deliberately
   * does NOT emit `PAYMENT_CAPTURED_EVENT` (see `payment.service.ts`, which
   * says its only caller confirms the booking itself). So this confirms the
   * booking itself, as that comment requires of any second caller.
   */
  private async askTheGatewayFirst(consultationId: string): Promise<boolean> {
    try {
      const payment = await this.payments.getByConsultationId(consultationId);
      // No payment row means no money can be in flight — M-11's Tier 1, and no
      // gateway call is warranted.
      if (!payment) return false;

      const status =
        payment.status === 'paid'
          ? 'paid'
          : (await this.payments.reconcileWithGateway(payment.paymentId)).status;
      if (status !== 'paid') return false;

      await this.bookings.confirmPayment(consultationId);
      this.logger.log(
        `Instant consultation ${consultationId} was already PAID when its payment window elapsed; confirmed instead of released.`,
      );
      return true;
    } catch (error) {
      // Deliberately swallowed. The doctor is released below, which is this
      // sweep's whole reason for existing, and a capture that lands anyway
      // still reaches `confirmLateCapture`.
      this.logger.warn(
        `Could not reconcile the payment for instant consultation ${consultationId} before releasing it; ` +
          `releasing on M-13's own clock. ${describeError(error)}`,
      );
      return false;
    }
  }

  /* ── Sweep 3: the stranded request ─────────────────────────────────────── */

  /**
   * One stranded-request pass. Shares the acceptance sweep's tick — it answers
   * the same question ("is this request still moving?") and its candidate
   * query is an indexed lookup that returns nothing at all in the ordinary
   * case.
   *
   * `routeNext` makes every decision: `already_pending` means the request was
   * never stranded (a false positive, and free), `not_routable` means it has
   * already moved on, `exhausted` means it was released, and a routed one is
   * back on its way to a doctor.
   */
  async sweepStrandedRequests(now: Date = new Date()): Promise<StrandedSweepResult> {
    const candidates = await this.bookings.listStaleAwaitingDoctorRequests(
      new Date(now.getTime() - STRANDED_REQUEST_GRACE_MS),
      SWEEP_BATCH_SIZE,
    );
    const result: StrandedSweepResult = { examined: candidates.length, rerouted: 0, released: 0, skipped: 0, failed: 0 };

    for (const candidate of candidates) {
      try {
        const routed = await this.instant.routeNext(candidate.consultationId, 'stranded_request_sweep');
        if (routed.routed) result.rerouted += 1;
        else if (routed.reason === 'exhausted') result.released += 1;
        else result.skipped += 1;
      } catch (error) {
        result.failed += 1;
        this.logger.error(
          `Re-routing stranded instant consultation ${candidate.consultationId} failed: ${describeError(error)}`,
        );
      }
    }

    return result;
  }

  /**
   * *** RELEASE THE DOCTOR, THEN THE REQUEST. ***
   *
   * The doctor is un-gated and freed FIRST, before the consultation is
   * released, and the order is not arbitrary. The consultation release is
   * idempotent and self-healing — the next pass re-attempts it, because a
   * `pending_payment` row with a lapsed hold is still a candidate. Un-gating
   * is not: if the process dies after the release but before the un-gate, the
   * doctor stays blocked with no consultation left to point at, and nothing
   * would ever come back for them.
   *
   * `clearCompletionGate` is addressed by CONSULTATION, so it is a no-op
   * unless this consultation was actually the one gating this doctor. In
   * practice a gate is rarely set at this point — an unpaid consult never
   * reaches `markInstantConsultEnded` — but the call is unconditional because
   * a stuck gate is the one state a doctor cannot get themselves out of.
   */
  private async releaseUnpaidRequest(
    consultationId: string,
    doctorId: string | null,
  ): Promise<'released' | 'confirmed' | 'skipped'> {
    // The un-gate stays UNCONDITIONAL and stays FIRST — see the header. It is
    // addressed by consultation, so it is a no-op unless this consultation is
    // the one gating this doctor, and a stuck gate is the one state a doctor
    // cannot get out of on their own.
    if (doctorId) {
      await this.doctors.clearCompletionGate({ consultationId, actor: SYSTEM_ACTOR });
    }

    // *** RE-READ THE STATUS BEFORE FREEING THE DOCTOR, NOT AFTER. ***
    //
    // `listExpiredInstantHolds` ran before this loop started and every
    // candidate costs several more round trips, so a `pending_payment` row can
    // easily become `scheduled` in between — which is exactly what happens
    // when the patient pays a second after the window closed and
    // `BookingPaymentListener` confirms it.
    //
    // This read used to sit BELOW the presence write, and that ordering was
    // the bug: `in_consultation` -> `available_now` is legal, so the write
    // succeeded unconditionally, and the status check only stopped the
    // *release* — which by then was moot. A patient who had just PAID lost
    // their doctor, who went straight back into the routing pool and was
    // offered somebody else's request while still holding this consultation.
    //
    // A payment landing inside the few milliseconds between this read and the
    // presence write is still possible, and is still M-11's `confirmLateCapture`
    // problem rather than this sweep's; the exposure went from "the whole
    // batch, plus two facade round trips per candidate" to "two statements".
    const candidate = await this.bookings.getBooking(consultationId);
    if (!candidate || candidate.status !== 'pending_payment') return 'skipped';

    // *** ASK THE GATEWAY BEFORE RELEASING, EXACTLY AS M-11's TIER 2 DOES. ***
    // See the class header for why the fast-path event alone was not a
    // backstop. `paid` is the only answer that changes what happens here.
    if (await this.askTheGatewayFirst(consultationId)) return 'confirmed';

    if (doctorId) {
      // `in_consultation` -> `available_now` is the whole point of this sweep.
      // A refusal is fine and is not retried: the doctor may have gone offline
      // in the meantime, and dragging them back into the routing pool would be
      // worse than leaving them where they put themselves.
      const freed = await this.presence.transition({
        doctorId,
        to: 'available_now',
        actor: SYSTEM_ACTOR,
        // Only out of the state this sweep is undoing. `available_now`'s legal
        // `from` set also contains `offline`, `paused` and `scheduled_only`,
        // and a doctor who put themselves in one of those must be left there —
        // this sweep gives back a doctor it is holding, it does not decide
        // that a doctor is available.
        onlyFrom: ['in_consultation'],
        reason: 'instant_payment_window_expired',
      });
      if (!freed.changed && freed.refusal) {
        this.logger.debug(
          `Doctor ${doctorId} not returned to available_now after an unpaid instant consult (${freed.refusal}); leaving them at ${String(freed.before)}.`,
        );
      }
    }

    await this.instant.releaseRequest(
      consultationId,
      'instant_payment_window_expired',
      INSTANT_NOTIFICATION_TEMPLATES.INSTANT_PAYMENT_WINDOW_EXPIRED,
    );

    await this.audit.write({
      actorType: 'system',
      actorId: null,
      action: 'update',
      entityType: INSTANT_AUDIT_ENTITY_TYPES.INSTANT_ROUTING,
      entityId: consultationId,
      consultationId,
      metadata: {
        change: 'doctor_released_unpaid',
        doctorId,
        // Written down in the audit trail because this is the one place the
        // instant flow knowingly parts company with M-11's "never release
        // under a live payment" rule.
        note: 'payment window elapsed; the gateway was asked and did not say paid; M-11 confirmLateCapture covers a payment that lands after this',
      },
    });

    return 'released';
  }
}
