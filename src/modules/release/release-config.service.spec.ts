/**
 * `ReleaseConfigService` — key resolution with per-cell fallback, the
 * transactional audit, and full-document write validation.
 *
 * `new ReleaseConfigService(mockedDeps)`, never `Test.createTestingModule`.
 */

import { BadRequestException } from '@nestjs/common';
import type { Database } from '../../config/db/database.config';
import type { AppConfigService } from '../../shared/app-config/app-config.service';
import type { AuditService } from '../../shared/audit/audit.service';
import type { ReleaseConfigRepository } from './release-config.repository';
import { ReleaseConfigService } from './release-config.service';
import { RELEASE_CONFIG_KEYS, RELEASE_DEFAULT_ENTRY } from './release.constants';

function validEntry(overrides: Partial<Record<string, unknown>> = {}) {
  return { minimumSupportedVersion: '1.0.0', latestVersion: '1.1.0', storeUrl: 'https://example.com', message: null, ...overrides };
}

function validPolicy() {
  return {
    patient: { ios: validEntry(), android: validEntry() },
    doctor: { ios: validEntry(), android: validEntry() },
  };
}

describe('ReleaseConfigService', () => {
  let db: { transaction: jest.Mock };
  let repo: jest.Mocked<ReleaseConfigRepository>;
  let appConfig: jest.Mocked<AppConfigService>;
  let audit: jest.Mocked<AuditService>;
  let service: ReleaseConfigService;

  beforeEach(() => {
    db = { transaction: jest.fn(async (work: (tx: unknown) => Promise<unknown>) => work(db)) };
    repo = { find: jest.fn().mockResolvedValue(undefined), upsert: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<ReleaseConfigRepository>;
    appConfig = { getJson: jest.fn(), getNumber: jest.fn(), invalidate: jest.fn() } as unknown as jest.Mocked<AppConfigService>;
    audit = { write: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<AuditService>;
    service = new ReleaseConfigService(db as unknown as Database, repo, appConfig, audit);
  });

  describe('getResolved', () => {
    it('falls back to the permissive default for a missing policy', async () => {
      appConfig.getJson.mockResolvedValue(undefined);
      const resolved = await service.getResolved();
      expect(resolved.patient.ios).toEqual(RELEASE_DEFAULT_ENTRY);
      expect(resolved.doctor.android).toEqual(RELEASE_DEFAULT_ENTRY);
    });

    it('falls back per-cell, not per-document — one malformed cell does not blank the rest', async () => {
      appConfig.getJson.mockResolvedValue({
        patient: { ios: validEntry(), android: { minimumSupportedVersion: 'not-a-version', latestVersion: '1.0.0' } },
        doctor: { ios: validEntry(), android: validEntry() },
      });
      const resolved = await service.getResolved();
      expect(resolved.patient.ios.minimumSupportedVersion).toBe('1.0.0');
      expect(resolved.patient.android).toEqual(RELEASE_DEFAULT_ENTRY);
    });
  });

  describe('update', () => {
    it('rejects a malformed version anywhere in the document', async () => {
      const bad = validPolicy();
      bad.patient.ios.minimumSupportedVersion = 'nope';
      await expect(service.update('admin-1', bad)).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.upsert).not.toHaveBeenCalled();
    });

    it('rejects a document missing an app/platform cell', async () => {
      const bad = { patient: { ios: validEntry() } };
      await expect(service.update('admin-1', bad)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('writes an audit row with before/after, inside the same transaction as the upsert, then invalidates the memo', async () => {
      repo.find.mockResolvedValueOnce(undefined);
      const policy = validPolicy();

      await service.update('admin-1', policy);

      expect(db.transaction).toHaveBeenCalledTimes(1);
      expect(repo.upsert).toHaveBeenCalledWith(RELEASE_CONFIG_KEYS.POLICY, policy, db);
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({
          actorType: 'admin',
          actorId: 'admin-1',
          action: 'update',
          entityId: RELEASE_CONFIG_KEYS.POLICY,
          metadata: { before: null, after: policy },
        }),
        db,
      );
      expect(appConfig.invalidate).toHaveBeenCalledWith(RELEASE_CONFIG_KEYS.POLICY);
    });
  });
});
