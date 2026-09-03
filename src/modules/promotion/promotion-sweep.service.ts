import { Inject, Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { AffiliateRepository } from './affiliate.repository';
import { AffiliateService } from './affiliate.service';
import { PromotionConfigService } from './promotion-config.service';
import { PromotionRepository } from './promotion.repository';
import { PromotionService } from './promotion.service';
import { ReferralRepository } from './referral.repository';
import { ReferralService } from './referral.service';
import type { ConsultationLookupStatus, PromotionBookingLookupPort } from './promotion-booking.contract';
import {
  PROMOTION_BOOKING_LOOKUP_PORT,
  PROMOTION_PAID_CONSULTATION_STATUSES,
  PROMOTION_SWEEP_BATCH_SIZE,
  PROMOTION_SWEEP_INTERVAL_MS,
  PROMOTION_TERMINAL_CONSULTATION_STATUSES,
} from './promotion.constants';

/**
 * *** HOW THE SWEEP IS SCHEDULED, AND WHY. ***
 *
 * `@nestjs/schedule` is NOT installed, and this module does not add it. The
 * sweep is driven by a plain `setInterval` owned by this service, started in
 * `onModuleInit` and cleared in `onApplicationShutdown`.
 *
 * This is the same decision `booking-slot-hold.service.ts` documents in its
 * `SWEEP_SCHEDULING` comment, and it is copied here rather than cross-referenced
 * because the reasons apply again, unchanged:
 *
 *   1. Adding a dependency means editing `package.json` AND `package-lock.json`
 *      — two of the highest-conflict files in the repository — while three
 *      sibling modules are being built in PARALLEL WORKTREES. This project has
 *      already been bitten once by a same-numbered-migration collision across
 *      worktrees; a lock-file collision is the same class of problem, and it
 *      would be self-inflicted for a feature this small.
 *   2. `ScheduleModule.forRoot()` would also have to go into `app.module.ts`, a
 *      shared composition-root file every parallel worktree touches.
 *   3. `@nestjs/schedule` earns its keep for cron EXPRESSIONS, overlapping
 *      schedules and dynamic job registration. This is one fixed-period job.
 *
 * The two things a naive `setInterval` gets wrong are both handled:
 *   - `.unref()` keeps the timer from holding the event loop open, so Jest runs
 *     and CLI processes still exit cleanly.
 *   - The handler is re-entrancy guarded (`sweepInFlight`), so a slow pass can
 *     never overlap the next tick.
 *
 * MULTI-INSTANCE SAFETY does not depend on the scheduler at all. Two processes
 * sweeping at once is harmless: every transition below is a guarded UPDATE
 * (`WHERE status = ...`) or an `ON CONFLICT DO NOTHING`, so the loser simply
 * matches zero rows and does nothing. Correctness lives in the transaction, not
 * in the timer.
 */
const SWEEP_SCHEDULING = true;

export interface ReservationSweepResult {
  examined: number;
  released: number;
  confirmed: number;
  kept: number;
  failed: number;
}

export interface QualificationSweepResult {
  referralsExamined: number;
  referralsQualified: number;
  referralsVoided: number;
  commissionsExamined: number;
  commissionsAccrued: number;
  commissionsVoided: number;
  failed: number;
}

/**
 * Everything that moves a promotion's state without a user asking: expiring an
 * abandoned reservation, catching a capture whose event was lost, and turning a
 * `qualifying` referral or a `pending` commission into something owed.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ── THE TIERED RESERVATION SWEEP ─────────────────────────────────────────
 *
 * A candidate is a `reserved` redemption whose `expires_at` has passed. What
 * happens next depends ENTIRELY on what the consultation is actually doing —
 * never on the clock alone:
 *
 *   consultation is TERMINAL (`cancelled`/`no_show`/`expired`)
 *       -> RELEASE. The booking is dead, so the redemption is genuinely free.
 *
 *   consultation is still `pending_payment`
 *       -> *** KEEP. *** The patient may be mid-3-D-Secure at the exact moment
 *          the timer fires. Releasing a discount under a live payment that has
 *          ALREADY BEEN PRICED WITH IT lets the code be spent twice: this
 *          checkout will still charge the discounted amount, and the freed
 *          capacity lets somebody else take the last redemption of a capped
 *          coupon. NEVER RELEASE ON A BLIND TIMER.
 *
 *   consultation reached a PAID/LIVE status
 *       -> CONFIRM. The durable backstop for a lost `payment.captured`. The
 *          money arrived and the booking went live, so the reservation should
 *          have been burnt and was not.
 *
 *   anything else, including `unknown`
 *       -> KEEP, and look again next pass.
 *
 * *** `unknown` MEANS KEEP, AND THAT IS WHAT MAKES AN UNBOUND PORT SAFE. ***
 * `PROMOTION_BOOKING_LOOKUP_PORT`'s null object reports `unknown` for
 * everything, so before the coordinator rebinds it this sweep releases NOTHING.
 * It cannot leak a redemption. A stuck `reserved` row is visible, queryable and
 * releasable by a human; a double-spent capped coupon is none of those.
 * `booking-slot-hold.service.ts` takes the identical position for slots.
 * ══════════════════════════════════════════════════════════════════════════
 */
@Injectable()
export class PromotionSweepService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(PromotionSweepService.name);
  private timer: NodeJS.Timeout | null = null;
  private sweepInFlight = false;

  constructor(
    private readonly repo: PromotionRepository,
    private readonly referralRepo: ReferralRepository,
    private readonly affiliateRepo: AffiliateRepository,
    private readonly promotions: PromotionService,
    private readonly referrals: ReferralService,
    private readonly affiliates: AffiliateService,
    private readonly config: PromotionConfigService,
    @Inject(PROMOTION_BOOKING_LOOKUP_PORT) private readonly booking: PromotionBookingLookupPort,
  ) {}

  onModuleInit(): void {
    if (!SWEEP_SCHEDULING || this.timer) return;
    this.timer = setInterval(() => {
      void this.runScheduledSweep();
    }, PROMOTION_SWEEP_INTERVAL_MS);
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
      this.logger.warn('Previous promotion sweep still running; skipping this tick.');
      return;
    }
    this.sweepInFlight = true;
    try {
      const reservations = await this.sweepExpiredReservations();
      if (reservations.released > 0 || reservations.confirmed > 0 || reservations.failed > 0) {
        this.logger.log(
          `Reservation sweep: ${reservations.released} released, ${reservations.confirmed} confirmed, ${reservations.kept} kept, ${reservations.failed} failed.`,
        );
      }

      const qualifications = await this.sweepQualifications();
      if (
        qualifications.referralsQualified > 0 ||
        qualifications.referralsVoided > 0 ||
        qualifications.commissionsAccrued > 0 ||
        qualifications.commissionsVoided > 0 ||
        qualifications.failed > 0
      ) {
        this.logger.log(
          `Qualification sweep: ${qualifications.referralsQualified} referrals qualified, ${qualifications.referralsVoided} voided, ` +
            `${qualifications.commissionsAccrued} commissions accrued, ${qualifications.commissionsVoided} voided, ${qualifications.failed} failed.`,
        );
      }
    } catch (error) {
      this.logger.error(`Promotion sweep failed: ${describeError(error)}`);
    } finally {
      this.sweepInFlight = false;
    }
  }

  /* ====================================================================== */
  /* Tier 1-3: expired reservations                                          */
  /* ====================================================================== */

  /**
   * One pass over expired reservations. Safe to call directly (tests and the
   * admin endpoint do), and safe to run concurrently with itself in another
   * process.
   */
  async sweepExpiredReservations(now: Date = new Date()): Promise<ReservationSweepResult> {
    const candidates = await this.repo.findExpiredReservationCandidates(now, PROMOTION_SWEEP_BATCH_SIZE);
    const result: ReservationSweepResult = {
      examined: candidates.length,
      released: 0,
      confirmed: 0,
      kept: 0,
      failed: 0,
    };
    if (candidates.length === 0) return result;

    // ONE port call for the whole batch. A hundred candidates must not become a
    // hundred round trips, and the port becomes a TCP client the day this module
    // is extracted.
    const statuses = await this.safeBatchStatus(candidates.map((candidate) => candidate.consultationId));

    for (const candidate of candidates) {
      try {
        const status = statuses.get(candidate.consultationId) ?? 'unknown';
        const outcome = await this.sweepOneReservation(candidate.consultationId, status);
        result[outcome] += 1;
      } catch (error) {
        result.failed += 1;
        this.logger.error(
          `Sweeping reservation ${candidate.redemptionId} for consultation ${candidate.consultationId} failed: ${describeError(error)}`,
        );
      }
    }

    return result;
  }

  /**
   * One candidate, tiered. Exposed so a test can drive a single reservation
   * deterministically without a timer.
   *
   * The `keep` branch is the DEFAULT, not the exception: anything this method
   * does not positively recognise as dead or as paid is kept. That ordering is
   * the safety property — a new consultation status added by a later module
   * behaves conservatively rather than releasing money-adjacent state.
   */
  async sweepOneReservation(
    consultationId: string,
    status: ConsultationLookupStatus,
  ): Promise<'released' | 'confirmed' | 'kept'> {
    // *** UNKNOWN MEANS KEEP. *** An unbound port cannot leak a redemption.
    if (status === 'unknown') return 'kept';

    if ((PROMOTION_TERMINAL_CONSULTATION_STATUSES as readonly string[]).includes(status)) {
      const released = await this.promotions.release({ consultationId, reason: `consultation_${status}` });
      return released ? 'released' : 'kept';
    }

    if ((PROMOTION_PAID_CONSULTATION_STATUSES as readonly string[]).includes(status)) {
      // *** THE DURABLE BACKSTOP FOR A LOST `payment.captured`. ***
      //
      // The booking went live, so the money arrived, so this reservation should
      // already have been burnt and was not. Burn it now.
      //
      // The payment id is NULL on this path, and that is deliberate rather than
      // sloppy: this module never reads `payments` (`backend/README.md` §2), so
      // the only honest options are "consumed, payment unknown" or "reserved
      // forever". Consumed is the truthful state — the discount WAS spent, on a
      // bill the patient WAS charged — and a real `confirm` arriving later
      // backfills the id through `attachPaymentIdIfMissing` rather than being
      // refused. Leaving it `reserved` would instead require re-extending its
      // expiry every grace period and would log the same warning forever.
      const confirmed = await this.promotions.confirmFromSweep(consultationId, status);
      return confirmed ? 'confirmed' : 'kept';
    }

    // `pending_payment`, or a status this module does not recognise. The patient
    // may be mid-3-D-Secure. KEEP.
    return 'kept';
  }

  /* ====================================================================== */
  /* Qualification: referrals and commission accrual                        */
  /* ====================================================================== */

  /**
   * *** THE ONE SWEEP THAT SERVES BOTH CONSUMERS. ***
   *
   * `affiliate-commissions.schema.ts`: "Gating on the qualifying status means a
   * booking cancelled and refunded before completion NEVER BECOMES PAYABLE IN
   * THE FIRST PLACE — one sweep serves both consumers and nothing has to poll
   * another module's tables."
   *
   * *** READ `PROMOTION_DEFAULT_QUALIFYING_STATUSES` BEFORE EXPECTING THIS TO
   * DO ANYTHING. *** With the compiled-in default, no status in this codebase is
   * a qualifying status today, so this pass examines rows and qualifies none of
   * them. That is the safe direction and it is one `app_config` edit away from
   * changing.
   */
  async sweepQualifications(): Promise<QualificationSweepResult> {
    const config = await this.config.getResolved();
    const qualifying = new Set(config.referralQualifyingStatuses);

    const result: QualificationSweepResult = {
      referralsExamined: 0,
      referralsQualified: 0,
      referralsVoided: 0,
      commissionsExamined: 0,
      commissionsAccrued: 0,
      commissionsVoided: 0,
      failed: 0,
    };

    /* ---- Referrals ----------------------------------------------------- */

    const events = await this.referralRepo.findQualifyingCandidates(PROMOTION_SWEEP_BATCH_SIZE);
    result.referralsExamined = events.length;

    if (events.length > 0) {
      const statuses = await this.safeBatchStatus(events.map((event) => event.consultationId));
      for (const event of events) {
        try {
          const status = statuses.get(event.consultationId) ?? 'unknown';
          if (status === 'unknown') continue;

          if (qualifying.has(status)) {
            const outcome = await this.referrals.qualify(event.id);
            if (outcome.qualified) result.referralsQualified += 1;
          } else if ((PROMOTION_TERMINAL_CONSULTATION_STATUSES as readonly string[]).includes(status)) {
            const voided = await this.referrals.voidEvent(event.id, `consultation_${status}`);
            if (voided) result.referralsVoided += 1;
          }
        } catch (error) {
          result.failed += 1;
          this.logger.error(`Qualifying referral event ${event.id} failed: ${describeError(error)}`);
        }
      }
    }

    /* ---- Commissions --------------------------------------------------- */

    const commissions = await this.affiliateRepo.findPendingCommissions(PROMOTION_SWEEP_BATCH_SIZE);
    result.commissionsExamined = commissions.length;

    if (commissions.length > 0) {
      const statuses = await this.safeBatchStatus(commissions.map((commission) => commission.consultationId));
      for (const commission of commissions) {
        try {
          const status = statuses.get(commission.consultationId) ?? 'unknown';
          if (status === 'unknown') continue;

          if (qualifying.has(status)) {
            // *** THIS IS THE MOMENT MONEY BECOMES OWED TO A DOCTOR. ***
            const accrued = await this.affiliates.accrueCommission(commission.id, commission.consultationId);
            if (accrued) result.commissionsAccrued += 1;
          } else if ((PROMOTION_TERMINAL_CONSULTATION_STATUSES as readonly string[]).includes(status)) {
            const voided = await this.affiliates.voidPendingCommissionById(
              commission.id,
              commission.consultationId,
              `consultation_${status}`,
            );
            if (voided) result.commissionsVoided += 1;
          }
        } catch (error) {
          result.failed += 1;
          this.logger.error(`Accruing commission ${commission.id} failed: ${describeError(error)}`);
        }
      }
    }

    return result;
  }

  /**
   * The port call, with a belt to go with the null object's braces.
   *
   * The contract says `getConsultationStatuses` never throws, and this module's
   * own null object does not. But post-merge the binding is somebody else's
   * adapter over `BookingFacade`, and eventually a TCP client — so a throw here
   * degrades to "every candidate is `unknown`", which means KEEP, rather than
   * aborting the whole pass and leaving the referral and commission halves
   * unswept as well.
   */
  private async safeBatchStatus(consultationIds: readonly string[]): Promise<ReadonlyMap<string, ConsultationLookupStatus>> {
    try {
      return await this.booking.getConsultationStatuses(consultationIds);
    } catch (error) {
      this.logger.warn(
        `PROMOTION_BOOKING_LOOKUP_PORT threw while reading ${consultationIds.length} consultation status(es); treating every one as unknown (which means KEEP). ${describeError(error)}`,
      );
      return new Map();
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
