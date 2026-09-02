import { Inject, Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { DATABASE } from '../../config/db/database.module';
import type { Database } from '../../config/db/database.config';
import type { ConsultationRow } from '../../schema/consultations.schema';
import { AuditService } from '../../shared/audit/audit.service';
import { isUniqueConstraintViolation } from '../../shared/errors/postgres-error.util';
import type { BookingPaymentPort } from './booking-payment.contract';
import { BOOKING_AUDIT_ENTITY_TYPES, BOOKING_PAYMENT_PORT, BOOKING_RESOLUTION_KINDS } from './booking.constants';
import { BookingRepository, type ExpiredHoldCandidate } from './booking.repository';
import { bookingNotFound } from './booking.service';

/** How often the sweep runs. See `SWEEP_SCHEDULING` on why this is an interval and not a cron. */
export const SWEEP_INTERVAL_MS = 60_000;

/** Candidates examined per pass. Bounds one pass's work (and, in Tier 2, its gateway calls) so a backlog drains steadily instead of in one spike. */
export const SWEEP_BATCH_SIZE = 100;

/**
 * *** HOW THE SWEEP IS SCHEDULED, AND WHY. ***
 *
 * `@nestjs/schedule` is NOT installed, and this module does not add it. The
 * sweep is driven by a plain `setInterval` owned by this service, started in
 * `onModuleInit` and cleared in `onApplicationShutdown`.
 *
 * Why not add the package:
 *   1. Adding a dependency means editing `package.json` AND `package-lock.
 *      json` — two of the highest-conflict files in the repository — while
 *      M-12 and M-13 are being built in PARALLEL WORKTREES. This project has
 *      already been bitten once by a same-numbered-migration collision across
 *      worktrees; a lock-file collision is the same class of problem, and it
 *      would be self-inflicted for a feature this small.
 *   2. `ScheduleModule.forRoot()` would also have to go into `app.module.ts`,
 *      a shared composition-root file every parallel worktree touches.
 *   3. `@nestjs/schedule` earns its keep for cron EXPRESSIONS, overlapping
 *      schedules and dynamic job registration. This is one fixed-period job.
 *      `setInterval` expresses it exactly, with no abstraction in between.
 *
 * The two things a naive `setInterval` gets wrong are both handled:
 *   - `.unref()` keeps the timer from holding the event loop open, so Jest
 *     runs and CLI processes still exit cleanly.
 *   - The handler is re-entrancy guarded (`sweepInFlight`), so a slow pass
 *     can never overlap the next tick.
 *
 * MULTI-INSTANCE SAFETY does not depend on the scheduler at all. Two
 * processes sweeping at once is harmless: each candidate is locked with
 * `SELECT ... FOR UPDATE` and re-checked under that lock, so the loser's
 * status guard simply does not match and it does nothing. Correctness lives
 * in the transaction, not in the timer.
 */
const SWEEP_SCHEDULING = true;

/**
 * Everything that can move a slot without a user asking: confirming a
 * payment, expiring an abandoned hold, and catching a payment that arrived
 * after its hold was already gone.
 *
 * ── THE TWO-TIER SWEEP ─────────────────────────────────────────────────────
 *
 * A hold is a `pending_payment` consultation with a `hold_expires_at` in the
 * past. What happens next depends ENTIRELY on whether the patient reached the
 * gateway:
 *
 *   TIER 1 — no `gateway_order_id` on the payment (or no payment row at all).
 *     The patient never got as far as checkout, so no money can possibly be
 *     in flight. Release immediately; no gateway call, no waiting.
 *
 *   TIER 2 — a `gateway_order_id` exists. *** NEVER RELEASED ON A BLIND
 *     TIMER. *** The patient may be mid-3-D-Secure at the exact moment the
 *     timer fires, and releasing the slot under a payment that is about to
 *     succeed is how a payment gets stranded. So we ASK THE GATEWAY first,
 *     through `reconcileWithGateway`, and act on the answer:
 *       paid                 -> CONFIRM the booking (never release it)
 *       definitively failed  -> release
 *       anything else        -> KEEP HOLDING, and re-examine next pass
 *
 *     The default on an unknown or unreachable answer is to KEEP THE HOLD.
 *     Holding a slot too long is a scheduling annoyance; releasing one under
 *     a live payment is a money problem.
 */
@Injectable()
export class BookingSlotHoldService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(BookingSlotHoldService.name);
  private timer: NodeJS.Timeout | null = null;
  private sweepInFlight = false;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly repo: BookingRepository,
    @Inject(BOOKING_PAYMENT_PORT) private readonly payments: BookingPaymentPort,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    if (!SWEEP_SCHEDULING || this.timer) return;
    this.timer = setInterval(() => {
      void this.runScheduledSweep();
    }, SWEEP_INTERVAL_MS);
    // Never hold the process open for a timer.
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** The timer's entry point: re-entrancy guarded, and it never lets a failure escape into an unhandled rejection. */
  private async runScheduledSweep(): Promise<void> {
    if (this.sweepInFlight) {
      this.logger.warn('Previous slot-hold sweep still running; skipping this tick.');
      return;
    }
    this.sweepInFlight = true;
    try {
      const result = await this.sweepExpiredHolds();
      if (result.released > 0 || result.confirmed > 0 || result.stillHeld > 0) {
        this.logger.log(
          `Slot-hold sweep: ${result.released} released, ${result.confirmed} confirmed, ${result.stillHeld} still held, ${result.failed} failed.`,
        );
      }
    } catch (error) {
      this.logger.error(`Slot-hold sweep failed: ${describeError(error)}`);
    } finally {
      this.sweepInFlight = false;
    }
  }

  /**
   * One sweep pass. Safe to call directly (tests and the admin endpoint do),
   * and safe to run concurrently with itself in another process.
   */
  async sweepExpiredHolds(now: Date = new Date()): Promise<SweepResult> {
    const candidates = await this.repo.findExpiredHoldCandidates(now, SWEEP_BATCH_SIZE);
    const result: SweepResult = { examined: candidates.length, released: 0, confirmed: 0, stillHeld: 0, failed: 0 };

    for (const candidate of candidates) {
      try {
        const outcome = await this.sweepOne(candidate);
        result[outcome] += 1;
      } catch (error) {
        result.failed += 1;
        this.logger.error(`Sweeping hold for consultation ${candidate.consultationId} failed: ${describeError(error)}`);
      }
    }

    return result;
  }

  /** One candidate, tiered. Exposed for tests to drive a single hold deterministically. */
  async sweepOne(candidate: ExpiredHoldCandidate): Promise<'released' | 'confirmed' | 'stillHeld'> {
    // TIER 1 — checkout was never entered, so no money can be in flight.
    if (!candidate.paymentId || !candidate.gatewayOrderId) {
      const released = await this.releaseHold(candidate.consultationId, 'hold_expired_no_gateway_order');
      return released ? 'released' : 'stillHeld';
    }

    // TIER 2 — ask the gateway before touching anything.
    let reconciled: { status: string; changed: boolean };
    try {
      reconciled = await this.payments.reconcileWithGateway(candidate.paymentId);
    } catch (error) {
      // We could not find out what happened. Keeping the hold is the only
      // safe default — see the class doc comment.
      this.logger.warn(
        `Could not reconcile payment ${candidate.paymentId} for consultation ${candidate.consultationId}; keeping the hold. ${describeError(error)}`,
      );
      return 'stillHeld';
    }

    if (reconciled.status === 'paid') {
      await this.confirmPayment(candidate.consultationId);
      return 'confirmed';
    }

    if (DEFINITIVELY_FAILED_PAYMENT_STATUSES.includes(reconciled.status)) {
      const released = await this.releaseHold(candidate.consultationId, `hold_expired_payment_${reconciled.status}`);
      return released ? 'released' : 'stillHeld';
    }

    // `created`, `pending`, or anything this module does not recognise: the
    // payment is still open, so the slot stays held and we look again next
    // pass.
    return 'stillHeld';
  }

  /**
   * Payment succeeded — take the booking live.
   *
   * Three shapes reach here, and all three are handled rather than assumed
   * away, because a gateway webhook can arrive at any time and more than once:
   *
   *   `pending_payment`  the ordinary case. -> `scheduled`, hold cleared.
   *   `scheduled`        a REPLAYED webhook. Idempotent no-op.
   *   hold already gone  LATE CAPTURE. -> `confirmLateCapture`.
   */
  async confirmPayment(consultationId: string): Promise<ConsultationRow> {
    const confirmed = await this.db.transaction(async (tx) => {
      const row = await this.repo.findByIdForUpdate(consultationId, tx);
      if (!row) throw bookingNotFound();

      // Replayed webhook — already live. Nothing to do, and no error: a
      // gateway that retries must not be answered with a failure.
      if (row.status === 'scheduled') return row;

      if (row.status !== 'pending_payment') return null;

      const updated = await this.repo.updateStatusIfIn(
        consultationId,
        ['pending_payment'],
        { status: 'scheduled', holdExpiresAt: null },
        tx,
      );
      if (!updated) return null;

      await this.audit.write(
        {
          actorType: 'system',
          actorId: null,
          action: 'update',
          entityType: BOOKING_AUDIT_ENTITY_TYPES.CONSULTATION,
          entityId: consultationId,
          consultationId,
          metadata: { change: 'payment_confirmed', before: 'pending_payment', after: 'scheduled' },
        },
        tx,
      );
      return updated;
    });

    if (confirmed) return confirmed;
    return this.confirmLateCapture(consultationId);
  }

  /**
   * *** RESIDUAL LATE CAPTURE. *** The payment succeeded, but the hold is
   * already gone — the sweep released it, or the process died between
   * releasing and confirming. The money is real, so the booking must end up
   * either LIVE or IN FRONT OF A HUMAN. It is never quietly dropped, and it
   * is never auto-refunded.
   *
   * The attempt to re-acquire is a single atomic UPDATE back to `scheduled`.
   * That is what makes it safe: `scheduled` IS in the partial unique index's
   * status list, so if another patient has taken the slot in the meantime,
   * Postgres raises `23505` and the update is refused. There is no read-then-
   * write window to lose.
   *
   * Slot genuinely taken -> the admin resolution queue, with the money HELD.
   * Deliberately NOT an automatic refund: somebody has paid for a
   * consultation and a human should decide between rebooking them, refunding
   * them, or asking the doctor to take both. Auto-refunding would silently
   * turn "we owe you an appointment" into "we gave you your money back",
   * which is a worse outcome to discover after the fact.
   */
  async confirmLateCapture(consultationId: string): Promise<ConsultationRow> {
    try {
      return await this.db.transaction(async (tx) => {
        const row = await this.repo.findByIdForUpdate(consultationId, tx);
        if (!row) throw bookingNotFound();

        if (row.status === 'scheduled') return row;

        // Only a released hold may be re-acquired. A `cancelled`, `completed`
        // or `no_show` row is a decision somebody made on purpose, and a late
        // payment must not overwrite it — that goes to a human below.
        if (row.status !== 'expired') {
          await this.fileForAdminResolution(
            consultationId,
            BOOKING_RESOLUTION_KINDS.LATE_CAPTURE_SLOT_TAKEN,
            { reason: 'late_capture_on_non_reacquirable_status', status: row.status },
            tx,
          );
          return row;
        }

        const reacquired = await this.repo.updateStatusIfIn(
          consultationId,
          ['expired'],
          { status: 'scheduled', holdExpiresAt: null },
          tx,
        );
        if (!reacquired) throw bookingNotFound();

        await this.audit.write(
          {
            actorType: 'system',
            actorId: null,
            action: 'update',
            entityType: BOOKING_AUDIT_ENTITY_TYPES.CONSULTATION,
            entityId: consultationId,
            consultationId,
            metadata: { change: 'late_capture_reacquired', before: 'expired', after: 'scheduled' },
          },
          tx,
        );
        return reacquired;
      });
    } catch (error) {
      // The slot was taken by somebody else while this row sat released. The
      // index refused the re-acquire; a human now decides, money held.
      if (isUniqueConstraintViolation(error)) {
        const row = await this.repo.findById(consultationId);
        await this.fileForAdminResolution(consultationId, BOOKING_RESOLUTION_KINDS.LATE_CAPTURE_SLOT_TAKEN, {
          reason: 'slot_taken_by_another_booking',
          doctorId: row?.doctorId ?? null,
          scheduledStartAt: row?.scheduledStartAt?.toISOString() ?? null,
          moneyHeld: true,
        });
        if (row) return row;
      }
      throw error;
    }
  }

  /**
   * Releases one hold. Re-checks the status UNDER the row lock, so a payment
   * that landed between the candidate query and this transaction wins the
   * race and the hold is left alone — returns `false` in that case rather
   * than forcing the release.
   */
  private async releaseHold(consultationId: string, reason: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const row = await this.repo.findByIdForUpdate(consultationId, tx);
      // Confirmed, cancelled, or already released while we were queuing.
      if (!row || row.status !== 'pending_payment') return false;

      const released = await this.repo.updateStatusIfIn(
        consultationId,
        ['pending_payment'],
        { status: 'expired', holdExpiresAt: null },
        tx,
      );
      if (!released) return false;

      await this.audit.write(
        {
          actorType: 'system',
          actorId: null,
          action: 'update',
          entityType: BOOKING_AUDIT_ENTITY_TYPES.CONSULTATION,
          entityId: consultationId,
          consultationId,
          metadata: { change: 'hold_released', reason, before: 'pending_payment', after: 'expired' },
        },
        tx,
      );
      return true;
    });
  }

  private async fileForAdminResolution(
    consultationId: string,
    kind: string,
    detail: Record<string, unknown>,
    tx?: Parameters<Parameters<Database['transaction']>[0]>[0],
  ): Promise<void> {
    const entry = {
      actorType: 'system' as const,
      actorId: null,
      action: 'create' as const,
      entityType: BOOKING_AUDIT_ENTITY_TYPES.ADMIN_RESOLUTION,
      entityId: consultationId,
      consultationId,
      metadata: { kind, ...detail },
    };
    // Called with a transaction from inside one, and without from the
    // post-rollback catch path. Passing an explicit `undefined` second
    // argument would work identically for `AuditService`, but the two call
    // shapes are kept genuinely distinct so a test can tell a transactional
    // audit write from a best-effort one.
    if (tx) await this.audit.write(entry, tx);
    else await this.audit.write(entry);
  }
}

/**
 * Payment statuses that mean the money definitively is NOT coming. Only these
 * release a Tier 2 hold. `created`/`pending` are still open; `refunded`/
 * `partially_refunded` imply a capture already happened and are not a reason
 * to expire a hold on a blind sweep.
 */
const DEFINITIVELY_FAILED_PAYMENT_STATUSES: readonly string[] = ['failed'];

export interface SweepResult {
  examined: number;
  released: number;
  confirmed: number;
  stillHeld: number;
  failed: number;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
