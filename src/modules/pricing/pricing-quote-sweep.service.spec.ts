/**
 * The stale-draft sweep.
 *
 * *** WHAT THIS SPEC IS AND IS NOT CLAIMING. ***
 *
 * It is NOT claiming the sweep keeps prices correct. It cannot, and it does not
 * need to: a stale quote is unpinnable because `pin` is one conditional UPDATE
 * carrying `AND expires_at > now()`, evaluated against the database's clock. No
 * timer is involved in that guarantee, and `price-quote.repository.ts` is where
 * it lives.
 *
 * What the sweep does is release the DISCOUNT RESERVATIONS that abandoned drafts
 * are still holding, so a coupon with a per-user limit does not stay burnt by a
 * checkout nobody completed. That is what is tested here.
 */

import type { PriceQuoteRepository } from './price-quote.repository';
import type { PricingService } from './pricing.service';
import { PricingQuoteSweepService } from './pricing-quote-sweep.service';

describe('PricingQuoteSweepService', () => {
  let quotes: jest.Mocked<PriceQuoteRepository>;
  let pricing: jest.Mocked<PricingService>;
  let sweep: PricingQuoteSweepService;

  beforeEach(() => {
    quotes = {
      findStaleDraftsHoldingReservations: jest.fn().mockResolvedValue([]),
      expireStaleDraftsWithoutReservations: jest.fn().mockResolvedValue(0),
    } as unknown as jest.Mocked<PriceQuoteRepository>;

    pricing = {
      abandon: jest.fn().mockResolvedValue({ changed: true }),
    } as unknown as jest.Mocked<PricingService>;

    sweep = new PricingQuoteSweepService(quotes, pricing);
  });

  afterEach(() => {
    sweep.onApplicationShutdown();
  });

  it('releases the reservation on every stale draft that holds one', async () => {
    quotes.findStaleDraftsHoldingReservations.mockResolvedValue([
      { id: 'q1', consultationId: 'c1' },
      { id: 'q2', consultationId: 'c2' },
    ]);

    const result = await sweep.sweepStaleDrafts();

    expect(result.released).toBe(2);
    expect(pricing.abandon).toHaveBeenCalledWith({
      quoteId: 'q1',
      consultationId: 'c1',
      reason: 'quote_expired_unpaid',
      status: 'expired',
    });
  });

  /** One bad candidate must not stop the pass — it is picked up again next tick, because nothing about it changed. */
  it('carries on past a candidate that throws', async () => {
    quotes.findStaleDraftsHoldingReservations.mockResolvedValue([
      { id: 'q1', consultationId: 'c1' },
      { id: 'q2', consultationId: 'c2' },
    ]);
    pricing.abandon.mockRejectedValueOnce(new Error('boom'));

    const result = await sweep.sweepStaleDrafts();

    expect(result.failed).toBe(1);
    expect(result.released).toBe(1);
    expect(pricing.abandon).toHaveBeenCalledTimes(2);
  });

  /** A quote another process already expired matched zero rows — a no-op, not a failure. */
  it('does not count an already-expired quote as released', async () => {
    quotes.findStaleDraftsHoldingReservations.mockResolvedValue([{ id: 'q1', consultationId: 'c1' }]);
    pricing.abandon.mockResolvedValue({ changed: false });

    const result = await sweep.sweepStaleDrafts();

    expect(result.released).toBe(0);
    expect(result.failed).toBe(0);
  });

  /** Drafts with no consultation hold no reservation, so they need no port call — just a bulk status move. */
  it('expires reservation-free drafts in bulk without a port call', async () => {
    quotes.expireStaleDraftsWithoutReservations.mockResolvedValue(7);

    const result = await sweep.sweepStaleDrafts();

    expect(result.expiredWithoutReservation).toBe(7);
    expect(pricing.abandon).not.toHaveBeenCalled();
  });

  /* ================================================================== */

  describe('scheduling — copied verbatim from booking-slot-hold.service.ts', () => {
    /**
     * `.unref()` keeps the timer from holding the event loop open, so Jest runs
     * and CLI processes still exit cleanly. Without it this suite would hang.
     */
    it('starts an unref’d interval on module init and clears it on shutdown', () => {
      sweep.onModuleInit();
      const timer = (sweep as unknown as { timer: NodeJS.Timeout | null }).timer;
      expect(timer).not.toBeNull();
      // `unref` leaves `hasRef()` false on a Node timer.
      expect((timer as unknown as { hasRef(): boolean }).hasRef()).toBe(false);

      sweep.onApplicationShutdown();
      expect((sweep as unknown as { timer: NodeJS.Timeout | null }).timer).toBeNull();
    });

    it('does not start a second timer if init runs twice', () => {
      sweep.onModuleInit();
      const first = (sweep as unknown as { timer: NodeJS.Timeout | null }).timer;
      sweep.onModuleInit();
      expect((sweep as unknown as { timer: NodeJS.Timeout | null }).timer).toBe(first);
    });

    /**
     * The re-entrancy guard: a slow pass must never overlap the next tick.
     * Asserted through the private entry point the timer actually calls, because
     * that is where the guard lives.
     */
    it('skips a tick while a previous pass is still running', async () => {
      let release: (() => void) | undefined;
      quotes.findStaleDraftsHoldingReservations.mockImplementation(
        () => new Promise((resolve) => {
          release = () => resolve([]);
        }),
      );

      const runner = sweep as unknown as { runScheduledSweep(): Promise<void> };
      const first = runner.runScheduledSweep();
      await runner.runScheduledSweep(); // returns immediately, guarded

      expect(quotes.findStaleDraftsHoldingReservations).toHaveBeenCalledTimes(1);

      release?.();
      await first;
    });
  });
});
