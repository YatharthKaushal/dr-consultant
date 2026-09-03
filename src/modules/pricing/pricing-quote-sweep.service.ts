import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { PriceQuoteRepository } from './price-quote.repository';
import { PricingService } from './pricing.service';
import { PRICING_SWEEP_BATCH_SIZE, PRICING_SWEEP_INTERVAL_MS } from './pricing.constants';

/**
 * *** HOW THE SWEEP IS SCHEDULED, AND WHY. ***
 *
 * Copied verbatim from `booking-slot-hold.service.ts`'s `SWEEP_SCHEDULING`
 * comment, because the reasoning is identical and the two must not diverge.
 *
 * `@nestjs/schedule` is NOT installed, and this module does not add it. The
 * sweep is driven by a plain `setInterval` owned by this service, started in
 * `onModuleInit` and cleared in `onApplicationShutdown`.
 *
 * Why not add the package:
 *   1. Adding a dependency means editing `package.json` AND `package-lock.json`
 *      — two of the highest-conflict files in the repository — while other
 *      modules are being built in PARALLEL WORKTREES. This project has already
 *      been bitten once by a same-numbered-migration collision across
 *      worktrees; a lock-file collision is the same class of problem, and it
 *      would be self-inflicted for a feature this small.
 *   2. `ScheduleModule.forRoot()` would also have to go into `app.module.ts`, a
 *      shared composition-root file every parallel worktree touches.
 *   3. `@nestjs/schedule` earns its keep for cron EXPRESSIONS, overlapping
 *      schedules and dynamic job registration. This is one fixed-period job.
 *      `setInterval` expresses it exactly, with no abstraction in between.
 *
 * The two things a naive `setInterval` gets wrong are both handled:
 *   - `.unref()` keeps the timer from holding the event loop open, so Jest runs
 *     and CLI processes still exit cleanly.
 *   - The handler is re-entrancy guarded (`sweepInFlight`), so a slow pass can
 *     never overlap the next tick.
 *
 * MULTI-INSTANCE SAFETY does not depend on the scheduler at all. Two processes
 * sweeping at once is harmless: every transition is a CONDITIONAL UPDATE guarded
 * on the status it expects, so the loser simply matches zero rows and does
 * nothing. Correctness lives in the statement, not in the timer.
 */
const SWEEP_SCHEDULING = true;

export interface QuoteSweepResult {
  examined: number;
  released: number;
  expiredWithoutReservation: number;
  failed: number;
}

/**
 * Releases the discount reservations that stale DRAFT quotes are still holding.
 *
 * ── *** THIS SWEEP IS NOT LOAD-BEARING FOR PRICE CORRECTNESS. *** ──────────
 *
 * A stale quote cannot be pinned whether or not this ever runs: `pin` is a
 * single conditional UPDATE carrying `AND expires_at > now()`, evaluated against
 * the database's own clock. So no price can go out of date and still be charged,
 * with no timer involved.
 *
 * What DOES need a sweep is the promotions side. `createQuote` reserves a
 * discount when it already has a consultation, and a reservation counts against
 * a coupon's total, per-user and distinct-user limits from the moment it is
 * taken. A patient who abandons checkout would otherwise leave that code burnt
 * until the reservation's own expiry — and the promotions module cannot see our
 * quote statuses to know better. Releasing it here closes that loop.
 *
 * ── WHY ONLY `draft`, NEVER `pinned` ───────────────────────────────────────
 *
 * A pinned quote has a live gateway order behind it, and the patient may be
 * mid-3-D-Secure at the exact moment this timer fires. Releasing its coupon
 * while a capture may still land would let the same code be spent twice — the
 * same reasoning `booking-slot-hold.service.ts` gives for never releasing a Tier
 * 2 hold on a blind timer. Pinned quotes are released by the explicit `abandon`
 * call on a failed or abandoned checkout, which knows the payment actually
 * failed.
 */
@Injectable()
export class PricingQuoteSweepService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(PricingQuoteSweepService.name);
  private timer: NodeJS.Timeout | null = null;
  private sweepInFlight = false;

  constructor(
    private readonly quotes: PriceQuoteRepository,
    private readonly pricing: PricingService,
  ) {}

  onModuleInit(): void {
    if (!SWEEP_SCHEDULING || this.timer) return;
    this.timer = setInterval(() => {
      void this.runScheduledSweep();
    }, PRICING_SWEEP_INTERVAL_MS);
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
      this.logger.warn('Previous price-quote sweep still running; skipping this tick.');
      return;
    }
    this.sweepInFlight = true;
    try {
      const result = await this.sweepStaleDrafts();
      if (result.released > 0 || result.expiredWithoutReservation > 0 || result.failed > 0) {
        this.logger.log(
          `Price-quote sweep: ${result.released} reservations released, ${result.expiredWithoutReservation} drafts expired, ${result.failed} failed.`,
        );
      }
    } catch (error) {
      this.logger.error(`Price-quote sweep failed: ${describeError(error)}`);
    } finally {
      this.sweepInFlight = false;
    }
  }

  /** One sweep pass. Safe to call directly (tests do), and safe to run concurrently with itself in another process. */
  async sweepStaleDrafts(now: Date = new Date()): Promise<QuoteSweepResult> {
    const candidates = await this.quotes.findStaleDraftsHoldingReservations(now, PRICING_SWEEP_BATCH_SIZE);
    const result: QuoteSweepResult = {
      examined: candidates.length,
      released: 0,
      expiredWithoutReservation: 0,
      failed: 0,
    };

    for (const candidate of candidates) {
      try {
        // `abandon` is itself idempotent — `abandonIfOpen` matches only `draft`
        // and `pinned`, so a quote another process has already expired is a
        // no-op here rather than a conflict.
        const outcome = await this.pricing.abandon({
          quoteId: candidate.id,
          consultationId: candidate.consultationId,
          reason: 'quote_expired_unpaid',
          status: 'expired',
        });
        if (outcome.changed) result.released += 1;
      } catch (error) {
        // One bad candidate must not stop the pass. It will be picked up again
        // on the next tick, because nothing about it changed.
        result.failed += 1;
        this.logger.error(`Price-quote sweep could not expire quote ${candidate.id}: ${describeError(error)}`);
      }
    }

    // Drafts with no consultation hold no reservation, so they need no port call
    // — just a status move, in bulk, so the table does not fill with `draft` rows
    // that will never be pinned.
    result.expiredWithoutReservation = await this.quotes.expireStaleDraftsWithoutReservations(
      now,
      PRICING_SWEEP_BATCH_SIZE,
    );

    return result;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
