import { BadRequestException } from '@nestjs/common';
import type { AppConfigService } from '../../shared/app-config/app-config.service';
import type { AuditService } from '../../shared/audit/audit.service';
import { AUDIT_CONFIG_KEYS, AUDIT_ERROR_CODES } from './audit.constants';
import type { AuditConfigRepository } from './audit-config.repository';
import { AuditConfigService } from './audit-config.service';

const ADMIN_ID = 'a0000000-0000-4000-8000-000000000001';

function createService(stored: Map<string, unknown> = new Map()) {
  const repo = {
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
  } as unknown as jest.Mocked<AuditConfigRepository>;

  const appConfig = { invalidate: jest.fn() } as unknown as jest.Mocked<AppConfigService>;
  const audit = { write: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<AuditService>;

  return { service: new AuditConfigService(repo, appConfig, audit), repo, appConfig, audit, stored };
}

describe('AuditConfigService', () => {
  describe('getResolved', () => {
    /** *** THE SHIPPED DEFAULT IS "OFF". *** See `audit.constants.ts#AUDIT_CONFIG_FALLBACKS` and `audit-retention-sweep.service.ts`'s header for the full SRS §5.3 reasoning. */
    it('defaults retentionDays to 0 (purging disabled) when nothing is stored', async () => {
      const { service } = createService();
      const resolved = await service.getResolved();
      expect(resolved.retentionDays).toBe(0);
    });

    it('always reports the fixed, informational purge-eligible action set', async () => {
      const { service } = createService();
      const resolved = await service.getResolved();
      expect(resolved.purgeEligibleActions).toEqual(['login', 'verify']);
    });

    it('returns a stored value inside bounds', async () => {
      const { service } = createService(new Map([[AUDIT_CONFIG_KEYS.RETENTION_DAYS, 90]]));
      expect((await service.getResolved()).retentionDays).toBe(90);
    });

    it.each([['not a number', 'oops'], ['a float', 12.5], ['negative', -5], ['below the floor', 10], ['above the ceiling', 99_999]])(
      'degrades a malformed/out-of-bounds stored value (%s) to 0',
      async (_label, value) => {
        const { service } = createService(new Map([[AUDIT_CONFIG_KEYS.RETENTION_DAYS, value]]));
        expect((await service.getResolved()).retentionDays).toBe(0);
      },
    );
  });

  describe('update', () => {
    it('writes the key, invalidates the memo, and audits a before/after', async () => {
      const { service, repo, appConfig, audit } = createService();

      const resolved = await service.update(ADMIN_ID, { retentionDays: 180 });

      expect(resolved.retentionDays).toBe(180);
      expect(repo.upsert).toHaveBeenCalledWith(AUDIT_CONFIG_KEYS.RETENTION_DAYS, 180);
      expect(appConfig.invalidate).toHaveBeenCalledWith(AUDIT_CONFIG_KEYS.RETENTION_DAYS);
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({
          actorType: 'admin',
          actorId: ADMIN_ID,
          action: 'update',
          entityType: 'audit_config',
          entityId: AUDIT_CONFIG_KEYS.RETENTION_DAYS,
          metadata: { before: null, after: 180 },
        }),
      );
    });

    it('accepts 0 explicitly — turning purging back off is a legitimate write, not a missing value', async () => {
      const { service, repo } = createService(new Map([[AUDIT_CONFIG_KEYS.RETENTION_DAYS, 365]]));
      await service.update(ADMIN_ID, { retentionDays: 0 });
      expect(repo.upsert).toHaveBeenCalledWith(AUDIT_CONFIG_KEYS.RETENTION_DAYS, 0);
    });

    it('refuses a non-zero value below the floor', async () => {
      const { service, repo } = createService();
      await expect(service.update(ADMIN_ID, { retentionDays: 10 })).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.upsert).not.toHaveBeenCalled();
    });

    it('refuses a non-zero value above the ceiling', async () => {
      const { service } = createService();
      await expect(service.update(ADMIN_ID, { retentionDays: 99_999 })).rejects.toMatchObject({
        response: { code: AUDIT_ERROR_CODES.CONFIG_INVALID },
      });
    });

    it('refuses a non-integer', async () => {
      const { service } = createService();
      await expect(service.update(ADMIN_ID, { retentionDays: 30.5 })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('a no-op call (nothing defined) writes nothing and audits nothing', async () => {
      const { service, repo, audit } = createService();
      await service.update(ADMIN_ID, {});
      expect(repo.upsert).not.toHaveBeenCalled();
      expect(audit.write).not.toHaveBeenCalled();
    });
  });
});
