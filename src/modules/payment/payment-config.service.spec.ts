import type { AppConfigService } from '../../shared/app-config/app-config.service';
import type { AuditService } from '../../shared/audit/audit.service';
import type { PaymentConfigRepository } from './payment-config.repository';
import { PaymentConfigService } from './payment-config.service';
import type { PricingFacade } from '../pricing/pricing.facade';
import { calculateBill } from './payment-money.util';

const ADMIN_ID = 'a0000000-0000-4000-8000-000000000001';

describe('PaymentConfigService', () => {
  let repo: jest.Mocked<PaymentConfigRepository>;
  let appConfig: jest.Mocked<AppConfigService>;
  let audit: jest.Mocked<AuditService>;
  let pricing: jest.Mocked<PricingFacade>;
  let service: PaymentConfigService;
  let stored: Map<string, unknown>;

  beforeEach(() => {
    stored = new Map();

    repo = {
      findByKeys: jest.fn(async (keys: readonly string[]) => {
        const result = new Map<string, unknown>();
        for (const key of keys) {
          if (stored.has(key)) result.set(key, stored.get(key));
        }
        return result;
      }),
      upsert: jest.fn(async (key: string, value: unknown) => {
        stored.set(key, value);
      }),
    } as unknown as jest.Mocked<PaymentConfigRepository>;

    appConfig = { invalidate: jest.fn() } as unknown as jest.Mocked<AppConfigService>;
    audit = { write: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<AuditService>;

    // No pricing catalogue configured, so the legacy write path is still live
    // and every existing expectation below holds unchanged. The supersession
    // branch is exercised separately.
    pricing = { hasCatalogue: jest.fn().mockResolvedValue(false) } as unknown as jest.Mocked<PricingFacade>;
    service = new PaymentConfigService(repo, appConfig, audit, pricing);
  });

  /* ------------------------------------------------------------------ */

  describe('getResolved', () => {
    /** FR-7.3's worked example is the compiled-in default, so a fresh install bills correctly with no seed run. */
    it('falls back to the SRS defaults of 20% and 18% when nothing is stored', async () => {
      expect(await service.getResolved()).toEqual({ convenienceFeePct: 20, gstRate: 18 });
    });

    it('returns stored values', async () => {
      stored.set('payments.convenience_fee_pct', 15);
      stored.set('payments.gst_rate', 12);
      expect(await service.getResolved()).toEqual({ convenienceFeePct: 15, gstRate: 12 });
    });

    it('reads both keys in ONE query, not one per key', async () => {
      await service.getResolved();
      expect(repo.findByKeys).toHaveBeenCalledTimes(1);
      expect(repo.findByKeys).toHaveBeenCalledWith(['payments.convenience_fee_pct', 'payments.gst_rate']);
    });

    /**
     * `app_config.value` is untyped jsonb, so a malformed row is not caught by
     * the database. Billing at the documented default is defensible; billing
     * at `NaN` is not, and refusing to take any payment because one row is
     * malformed is worse than both.
     */
    it.each([['not a number'], [null], [true], [{}], [[]], [Number.NaN]])(
      'degrades a malformed stored value (%s) to the compiled-in default',
      async (value) => {
        stored.set('payments.gst_rate', value);
        expect((await service.getResolved()).gstRate).toBe(18);
      },
    );

    it('degrades an out-of-range stored value to the default', async () => {
      stored.set('payments.gst_rate', 500);
      expect((await service.getResolved()).gstRate).toBe(18);

      stored.set('payments.gst_rate', -5);
      expect((await service.getResolved()).gstRate).toBe(18);
    });

    it('accepts a zero rate — a legitimate configuration, not a missing value', async () => {
      stored.set('payments.convenience_fee_pct', 0);
      expect((await service.getResolved()).convenienceFeePct).toBe(0);
    });
  });

  describe('getRatesForBilling', () => {
    /**
     * The conversion to `numeric(5,2)`-shaped strings happens ONCE, here.
     * Letting each call site do its own `toString` is how `18.5` and `18.50`
     * end up on two different bills for the same rate.
     */
    it('renders rates as numeric(5,2)-shaped strings', async () => {
      expect(await service.getRatesForBilling()).toEqual({ convenienceFeePct: '20.00', gstPct: '18.00' });
    });

    it('renders a fractional rate with both decimal places', async () => {
      stored.set('payments.gst_rate', 18.5);
      expect((await service.getRatesForBilling()).gstPct).toBe('18.50');
    });

    it('renders a whole-number rate with both decimal places', async () => {
      stored.set('payments.convenience_fee_pct', 5);
      expect((await service.getRatesForBilling()).convenienceFeePct).toBe('5.00');
    });
  });

  /* ------------------------------------------------------------------ */

  describe('update', () => {
    it('writes only the fields that are present', async () => {
      await service.update(ADMIN_ID, { gstRate: 12 });

      expect(repo.upsert).toHaveBeenCalledTimes(1);
      expect(repo.upsert).toHaveBeenCalledWith('payments.gst_rate', 12);
    });

    it('writes both when both are present', async () => {
      await service.update(ADMIN_ID, { convenienceFeePct: 15, gstRate: 12 });
      expect(repo.upsert).toHaveBeenCalledTimes(2);
    });

    /** No misleading audit entry for a call that changed nothing — the discipline `search-config.service.ts` uses. */
    it('writes nothing and audits nothing for an empty update', async () => {
      const result = await service.update(ADMIN_ID, {});

      expect(repo.upsert).not.toHaveBeenCalled();
      expect(audit.write).not.toHaveBeenCalled();
      expect(appConfig.invalidate).not.toHaveBeenCalled();
      expect(result).toEqual({ convenienceFeePct: 20, gstRate: 18 });
    });

    /**
     * *** WITHOUT THIS THE 30s MEMO KEEPS BILLING AT THE OLD RATE. ***
     * An admin correcting a GST rate would watch nothing happen, while
     * patients kept being charged the previous one.
     */
    it('invalidates the AppConfigService memo for every key it writes', async () => {
      await service.update(ADMIN_ID, { convenienceFeePct: 15, gstRate: 12 });

      expect(appConfig.invalidate).toHaveBeenCalledWith('payments.convenience_fee_pct');
      expect(appConfig.invalidate).toHaveBeenCalledWith('payments.gst_rate');
      expect(appConfig.invalidate).toHaveBeenCalledTimes(2);
    });

    it('writes an audited BEFORE/AFTER for each changed key', async () => {
      stored.set('payments.gst_rate', 18);

      await service.update(ADMIN_ID, { gstRate: 12 });

      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({
          actorType: 'admin',
          actorId: ADMIN_ID,
          action: 'update',
          entityType: 'payment_config',
          // The KEY is the entity — an auditor asking who changed the GST rate
          // should not have to know a uuid.
          entityId: 'payments.gst_rate',
          metadata: { before: 18, after: 12 },
        }),
      );
    });

    it('records a null before for a key that had no row', async () => {
      await service.update(ADMIN_ID, { gstRate: 12 });
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: { before: null, after: 12 } }),
      );
    });

    it('returns the newly resolved configuration', async () => {
      expect(await service.update(ADMIN_ID, { gstRate: 12 })).toEqual({ convenienceFeePct: 20, gstRate: 12 });
    });
  });

  /* ------------------------------------------------------------------ */

  describe('the owned-key allow-list', () => {
    /**
     * *** THE MIRROR IMAGE OF search-config.service.ts's RULE. ***
     *
     * That file's own comment says an admin holding `SEARCH_MANAGE_MAPPING`
     * "must not be able to reach `payments.gst_rate` through this endpoint
     * because both happen to live in one table." The same must hold in this
     * direction: a payments admin must not be able to reach
     * `search.crisis_keywords` and switch off the safety guardrail.
     *
     * Structurally unreachable from the controller (the DTO has no free-form
     * key), and enforced in the service anyway — services hold the rules.
     */
    it('refuses a key this module does not own', async () => {
      const foreign = service as unknown as { assertOwnedKey(key: string): void };

      expect(() => foreign.assertOwnedKey('search.crisis_keywords')).toThrow(
        expect.objectContaining({
          status: 400,
          response: expect.objectContaining({ code: 'PAYMENT_CONFIG_KEY_NOT_OWNED' }),
        }) as never,
      );
    });

    it.each([
      ['search.crisis_keywords'],
      ['search.ai_enabled'],
      ['otp.request.max_per_number_per_hour'],
      ['documents.max_file_size_mb'],
      ['payments.something_else'],
      [''],
    ])('refuses the foreign key %s', (key) => {
      const foreign = service as unknown as { assertOwnedKey(key: string): void };
      expect(() => foreign.assertOwnedKey(key)).toThrow();
    });

    it.each([['payments.convenience_fee_pct'], ['payments.gst_rate']])('accepts the owned key %s', (key) => {
      const foreign = service as unknown as { assertOwnedKey(key: string): void };
      expect(() => foreign.assertOwnedKey(key)).not.toThrow();
    });

    it('never writes a foreign key even if one somehow reached the update path', async () => {
      await service.update(ADMIN_ID, { gstRate: 12 });
      for (const [key] of repo.upsert.mock.calls) {
        expect(String(key).startsWith('payments.')).toBe(true);
      }
    });
  });

  /* ------------------------------------------------------------------ */

  describe('shape validation', () => {
    it.each([
      [-1, 'below zero'],
      [101, 'above 100'],
      [Number.NaN, 'NaN'],
      [Number.POSITIVE_INFINITY, 'Infinity'],
    ])('refuses a gstRate of %s (%s)', async (value) => {
      await expect(service.update(ADMIN_ID, { gstRate: value })).rejects.toMatchObject({
        status: 400,
        response: { code: 'PAYMENT_CONFIG_INVALID' },
      });
      expect(repo.upsert).not.toHaveBeenCalled();
    });

    it('refuses a non-numeric value that bypassed the DTO', async () => {
      await expect(
        service.update(ADMIN_ID, { gstRate: 'eighteen' as unknown as number }),
      ).rejects.toMatchObject({ response: { code: 'PAYMENT_CONFIG_INVALID' } });
    });

    /**
     * `numeric(5,2)` holds two decimal places, so 18.005 would be silently
     * ROUNDED by Postgres on the way into `payments.gst_pct` — and the bill
     * would then not match the configured rate. Refused rather than rounded.
     */
    it('refuses a third decimal place rather than letting Postgres round it', async () => {
      await expect(service.update(ADMIN_ID, { gstRate: 18.005 })).rejects.toMatchObject({
        response: { code: 'PAYMENT_CONFIG_INVALID', message: expect.stringContaining('2 decimal places') as never },
      });
    });

    it('accepts exactly two decimal places', async () => {
      await expect(service.update(ADMIN_ID, { gstRate: 18.25 })).resolves.toBeDefined();
      expect(repo.upsert).toHaveBeenCalledWith('payments.gst_rate', 18.25);
    });

    /**
     * *** REGRESSION: THE DECIMAL-PLACE CHECK MUST NOT DO FLOAT ARITHMETIC. ***
     *
     * The check was `Math.round(value * 100) !== value * 100`, which forms a
     * product in IEEE-754 and then compares it to its own rounding. For 1,146
     * of the 10,001 two-decimal rates in [0, 100] that product is not the
     * integer it mathematically is:
     *
     *     8.21  * 100 === 821.0000000000001
     *     16.08 * 100 === 1607.9999999999998
     *     2.2   * 100 === 220.00000000000003
     *     0.07  * 100 === 7.000000000000001
     *
     * so each was REFUSED with "must have at most 2 decimal places" — a message
     * asserting something false about a number that has exactly two. The DTO's
     * `@IsNumber({ maxDecimalPlaces: 2 })` reads `toString()` rather than a
     * product and accepts all four, so the request passed HTTP validation and
     * was then rejected by the service.
     *
     * *** THE VALUES HERE ARE NOT INTERCHANGEABLE. *** The original test used
     * 18.25, and 18.5/20/18.3/7.77/12.1 behave the same way: each is a sum of
     * powers of two (or lands on an exact product anyway), round-trips cleanly,
     * and passes the BROKEN check. A regression test built from those values
     * cannot fail. Every rate below was verified to be one the old check
     * actually rejected.
     */
    it.each([[8.21], [16.08], [2.2], [0.07]])(
      'accepts the legal two-decimal rate %s, which float multiplication misjudges',
      async (rate) => {
        await expect(service.update(ADMIN_ID, { gstRate: rate })).resolves.toBeDefined();
        expect(repo.upsert).toHaveBeenCalledWith('payments.gst_rate', rate);
      },
    );

    /**
     * And the rate must survive into the arithmetic exactly. Expected values
     * below are derived BY HAND in integer paise, not by running the code:
     *
     *   fee 500.00 = 50000p; convenience 8.21% = 821bp
     *     50000 * 821 = 41_050_000; +5000 half; /10000 = 4105p  = 41.05
     *   subtotal = 50000 + 4105 = 54105p = 541.05
     *   GST 18% = 1800bp
     *     54105 * 1800 = 97_389_000; +5000; /10000 = 9739p = 97.39
     *     (541.05 x 0.18 = 97.389, half-up -> 97.39)
     *   total = 54105 + 9739 = 63844p = 638.44
     */
    it('bills a float-hostile rate exactly, in integer paise', async () => {
      await service.update(ADMIN_ID, { convenienceFeePct: 8.21, gstRate: 18 });

      const rates = await service.getRatesForBilling();
      expect(rates).toEqual({ convenienceFeePct: '8.21', gstPct: '18.00' });

      const bill = calculateBill('500.00', rates.convenienceFeePct, rates.gstPct);
      expect(bill.convenienceFeePaise).toBe(4105n);
      expect(bill.subtotalPaise).toBe(54_105n);
      expect(bill.gstPaise).toBe(9739n);
      expect(bill.totalPayablePaise).toBe(63_844n);
      // The components must sum to the total exactly — there is no stored total.
      expect(bill.consultationFeePaise + bill.convenienceFeePaise + bill.gstPaise).toBe(bill.totalPayablePaise);
    });

    it.each([[0], [100], [18], [20]])('accepts the boundary/typical value %s', async (value) => {
      await expect(service.update(ADMIN_ID, { convenienceFeePct: value })).resolves.toBeDefined();
    });

    it('validates BEFORE writing anything, so a bad second field does not leave the first written', async () => {
      await expect(
        service.update(ADMIN_ID, { convenienceFeePct: 15, gstRate: -1 }),
      ).rejects.toBeDefined();

      expect(repo.upsert).not.toHaveBeenCalled();
      expect(audit.write).not.toHaveBeenCalled();
    });
  });
});
