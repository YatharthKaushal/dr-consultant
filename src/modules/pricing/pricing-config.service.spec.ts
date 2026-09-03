/**
 * `PricingConfigService` — key ownership, shape validation, the transactional
 * audit, and the memo invalidation without which an admin edits a catalogue and
 * watches nothing happen.
 *
 * `new PricingConfigService(mockedDeps)` with hand-rolled `jest.fn()`s, never
 * `Test.createTestingModule`.
 */

import { BadRequestException } from '@nestjs/common';
import type { Database } from '../../config/db/database.config';
import type { AppConfigService } from '../../shared/app-config/app-config.service';
import type { AuditService } from '../../shared/audit/audit.service';
import type { PricingConfigRepository } from './pricing-config.repository';
import { PricingConfigService } from './pricing-config.service';
import {
  PRICING_CONFIG_KEYS,
  PRICING_DEFAULT_COMPONENTS,
  PRICING_DEFAULT_QUOTE_TTL_MINUTES,
  PRICING_DEFAULT_TAX_PROFILE,
} from './pricing.constants';

describe('PricingConfigService', () => {
  let db: { transaction: jest.Mock };
  let repo: jest.Mocked<PricingConfigRepository>;
  let appConfig: jest.Mocked<AppConfigService>;
  let audit: jest.Mocked<AuditService>;
  let service: PricingConfigService;

  beforeEach(() => {
    // A fake transaction that simply invokes its callback. It has no locking or
    // rollback semantics — see `refund.invariant.integration.spec.ts` on what a
    // mocked transaction cannot prove — but it is sufficient to assert that the
    // audit and the write are issued together on the same executor.
    db = { transaction: jest.fn(async (work: (tx: unknown) => Promise<unknown>) => work(db)) };

    repo = {
      findByKeys: jest.fn().mockResolvedValue(new Map()),
      upsert: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<PricingConfigRepository>;

    appConfig = {
      getJson: jest.fn().mockResolvedValue(undefined),
      getNumber: jest.fn().mockImplementation(async (_key: string, fallback: number) => fallback),
      invalidate: jest.fn(),
    } as unknown as jest.Mocked<AppConfigService>;

    audit = { write: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<AuditService>;

    service = new PricingConfigService(db as unknown as Database, repo, appConfig, audit);
  });

  /* ================================================================== */
  /* Reads                                                               */
  /* ================================================================== */

  describe('getResolved — a bad row must not stop the platform taking payment', () => {
    /**
     * Billing at the documented default is a defensible outcome; refusing every
     * payment because one config row is malformed is not. But doing it SILENTLY
     * is also not — the fallback is flagged so the admin screen can say so.
     */
    it('falls back to the compiled-in catalogue when the stored one is unusable, and says so', async () => {
      appConfig.getJson.mockImplementation(async (key: string) =>
        key === PRICING_CONFIG_KEYS.COMPONENTS ? [{ code: 'broken' }] : undefined,
      );

      const resolved = await service.getResolved();

      expect(resolved.components).toEqual([...PRICING_DEFAULT_COMPONENTS]);
      expect(resolved.componentsFellBack).toBe(true);
    });

    it('falls back when the catalogue key has no row at all', async () => {
      const resolved = await service.getResolved();
      expect(resolved.components).toEqual([...PRICING_DEFAULT_COMPONENTS]);
      expect(resolved.componentsFellBack).toBe(true);
      expect(resolved.taxProfile).toEqual(PRICING_DEFAULT_TAX_PROFILE);
      expect(resolved.taxProfileFellBack).toBe(true);
    });

    it('uses a stored catalogue that validates, and does not flag a fallback', async () => {
      appConfig.getJson.mockImplementation(async (key: string) =>
        key === PRICING_CONFIG_KEYS.COMPONENTS ? [...PRICING_DEFAULT_COMPONENTS] : { ...PRICING_DEFAULT_TAX_PROFILE },
      );

      const resolved = await service.getResolved();

      expect(resolved.componentsFellBack).toBe(false);
      expect(resolved.taxProfileFellBack).toBe(false);
    });

    /** 15 minutes, deliberately shorter than `booking.slot_hold_minutes` (20). */
    it('defaults the TTL to 15 minutes', async () => {
      const resolved = await service.getResolved();
      expect(resolved.quoteTtlMinutes).toBe(PRICING_DEFAULT_QUOTE_TTL_MINUTES);
      expect(PRICING_DEFAULT_QUOTE_TTL_MINUTES).toBeLessThan(20);
    });

    it('ignores an out-of-range TTL rather than quoting a price that stands for a day', async () => {
      appConfig.getNumber.mockResolvedValue(10_000);
      expect((await service.getResolved()).quoteTtlMinutes).toBe(PRICING_DEFAULT_QUOTE_TTL_MINUTES);
    });
  });

  /* ================================================================== */
  /* Writes                                                              */
  /* ================================================================== */

  describe('update', () => {
    it('writes nothing and audits nothing for an empty change set', async () => {
      await service.update('admin1', {});
      expect(repo.upsert).not.toHaveBeenCalled();
      expect(audit.write).not.toHaveBeenCalled();
    });

    /**
     * *** THE AUDIT COMMITS OR ROLLS BACK WITH THE VALUE IT AUDITS. ***
     * A financial configuration value must never change without a record of who
     * changed it, so the before-read, the write and the audit share one
     * transaction rather than being three statements that could half-succeed.
     */
    it('writes, audits before/after, and invalidates the memo — in that order', async () => {
      repo.findByKeys.mockResolvedValue(new Map([[PRICING_CONFIG_KEYS.QUOTE_TTL_MINUTES, 15]]));

      await service.update('admin1', { quoteTtlMinutes: 20 });

      expect(db.transaction).toHaveBeenCalled();
      expect(repo.upsert).toHaveBeenCalledWith(PRICING_CONFIG_KEYS.QUOTE_TTL_MINUTES, 20, db);
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({
          actorType: 'admin',
          actorId: 'admin1',
          entityType: 'pricing_config',
          entityId: PRICING_CONFIG_KEYS.QUOTE_TTL_MINUTES,
          metadata: { before: 15, after: 20 },
        }),
        db,
      );
      // *** Without this the 30s memo keeps billing at the previous value. ***
      expect(appConfig.invalidate).toHaveBeenCalledWith(PRICING_CONFIG_KEYS.QUOTE_TTL_MINUTES);
    });

    /**
     * *** THE ADMIN SCREEN USES THE ENGINE'S OWN VALIDATOR. *** A second, looser
     * check here is how a panel comes to accept a catalogue the pricing path then
     * refuses — at checkout, for a patient.
     */
    it('refuses a catalogue with a duplicate code', async () => {
      const dupe = [PRICING_DEFAULT_COMPONENTS[0], { ...PRICING_DEFAULT_COMPONENTS[0], position: 9 }];
      await expect(service.update('admin1', { components: dupe })).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.upsert).not.toHaveBeenCalled();
    });

    it('refuses a catalogue with a forward reference, which would price off zero', async () => {
      const forward = [
        { ...PRICING_DEFAULT_COMPONENTS[1], position: 1 },
        { ...PRICING_DEFAULT_COMPONENTS[0], position: 2 },
      ];
      await expect(service.update('admin1', { components: forward })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses an exempt-and-inclusive component', async () => {
      const bad = [{ ...PRICING_DEFAULT_COMPONENTS[0], taxMode: 'inclusive' as const }];
      await expect(service.update('admin1', { components: bad })).rejects.toBeInstanceOf(BadRequestException);
    });

    /**
     * *** GST STATE CODES ARE COMPILED IN AND NOT ADMIN-EDITABLE. *** An admin
     * inventing code 99 produces an invoice that is invalid, silently, on every
     * bill.
     */
    it('refuses a tax profile naming a code the GST portal does not issue', async () => {
      await expect(
        service.update('admin1', {
          taxProfile: { ...PRICING_DEFAULT_TAX_PROFILE, registeredStateCode: '99' },
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      await expect(
        service.update('admin1', {
          taxProfile: { ...PRICING_DEFAULT_TAX_PROFILE, defaultPlaceOfSupplyStateCode: '75' },
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses a GSTIN that is not 15 characters', async () => {
      await expect(
        service.update('admin1', { taxProfile: { ...PRICING_DEFAULT_TAX_PROFILE, gstin: 'TOOSHORT' } }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts a null GSTIN, which is the seeded state until the client supplies one', async () => {
      await expect(
        service.update('admin1', { taxProfile: { ...PRICING_DEFAULT_TAX_PROFILE, gstin: null } }),
      ).resolves.toBeDefined();
    });

    it('refuses a TTL outside its bounds', async () => {
      await expect(service.update('admin1', { quoteTtlMinutes: 0 })).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.update('admin1', { quoteTtlMinutes: 10_000 })).rejects.toBeInstanceOf(BadRequestException);
    });

    /** Nothing is written when ANY key in the change set fails validation. */
    it('writes nothing at all when one key of several is invalid', async () => {
      await expect(
        service.update('admin1', { quoteTtlMinutes: 20, components: [{ code: 'broken' } as never] }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.upsert).not.toHaveBeenCalled();
    });
  });

  /* ================================================================== */
  /* hasCatalogue                                                        */
  /* ================================================================== */

  describe('hasCatalogue — what gates the legacy config screen', () => {
    /** Reads the ROW, not the 30s memo: a supersession check that lagged behind a seed would let an admin write a rate that is already dead. */
    it('reads the row rather than the memo', async () => {
      repo.findByKeys.mockResolvedValue(new Map([[PRICING_CONFIG_KEYS.COMPONENTS, []]]));
      expect(await service.hasCatalogue()).toBe(true);
      expect(repo.findByKeys).toHaveBeenCalledWith([PRICING_CONFIG_KEYS.COMPONENTS]);
    });

    it('is false when no catalogue has ever been configured', async () => {
      repo.findByKeys.mockResolvedValue(new Map());
      expect(await service.hasCatalogue()).toBe(false);
    });
  });
});
