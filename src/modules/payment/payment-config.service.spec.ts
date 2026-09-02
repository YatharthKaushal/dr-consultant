import type { AppConfigService } from '../../shared/app-config/app-config.service';
import type { AuditService } from '../../shared/audit/audit.service';
import type { PaymentConfigRepository } from './payment-config.repository';
import { PaymentConfigService } from './payment-config.service';

const ADMIN_ID = 'a0000000-0000-4000-8000-000000000001';

describe('PaymentConfigService', () => {
  let repo: jest.Mocked<PaymentConfigRepository>;
  let appConfig: jest.Mocked<AppConfigService>;
  let audit: jest.Mocked<AuditService>;
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

    service = new PaymentConfigService(repo, appConfig, audit);
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
