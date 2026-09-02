import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { StorageProviderRow } from '../../schema/storage-providers.schema';
import type { AuditService } from '../../shared/audit/audit.service';
import type { StorageProviderRepository } from './storage-provider.repository';
import { StorageProviderService } from './storage-provider.service';
import type { UpdateStorageProviderDto } from './storage.dto';

function providerRow(overrides: Partial<StorageProviderRow> = {}): StorageProviderRow {
  return {
    id: 'provider-1',
    provider: 's3',
    isActive: true,
    priority: 10,
    config: { bucket: 'existing-bucket', region: 'ap-south-1' },
    consecutiveFailures: 0,
    lastFailureAt: null,
    lastFailureKind: null,
    cooldownUntil: null,
    lastSucceededAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function createDeps() {
  const repo = {
    list: jest.fn(),
    findById: jest.fn(),
    findByProvider: jest.fn(),
    listActive: jest.fn(),
    update: jest.fn(),
    recordSuccess: jest.fn(),
    recordFailure: jest.fn(),
  } as unknown as jest.Mocked<StorageProviderRepository>;

  const audit = { write: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<AuditService>;

  const service = new StorageProviderService(repo, audit);
  return { service, repo, audit };
}

describe('StorageProviderService', () => {
  describe('adminList / adminGetById', () => {
    it('lists every provider', async () => {
      const { service, repo } = createDeps();
      repo.list.mockResolvedValue([providerRow()]);

      await expect(service.adminList()).resolves.toEqual([providerRow()]);
    });

    it('throws STORAGE_PROVIDER_NOT_FOUND (404) for a missing id', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(null);

      const error = await service.adminGetById('missing-id').catch((e: unknown) => e);

      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).getResponse()).toMatchObject({ code: 'STORAGE_PROVIDER_NOT_FOUND' });
    });
  });

  describe('adminUpdate: no-op discipline', () => {
    it('skips the update AND the audit write when the DTO carries no defined fields', async () => {
      const { service, repo, audit } = createDeps();
      const row = providerRow();
      repo.findById.mockResolvedValue(row);

      const result = await service.adminUpdate('admin-1', row.id, {});

      expect(result).toBe(row);
      expect(repo.update).not.toHaveBeenCalled();
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('throws STORAGE_PROVIDER_NOT_FOUND for a missing id before checking the DTO', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(null);

      await expect(service.adminUpdate('admin-1', 'missing-id', { isActive: false })).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('adminUpdate: partial field updates', () => {
    it('updates only isActive, leaving config/priority untouched in the write', async () => {
      const { service, repo } = createDeps();
      const row = providerRow();
      repo.findById.mockResolvedValue(row);
      repo.update.mockResolvedValue({ ...row, isActive: false });

      const dto: UpdateStorageProviderDto = { isActive: false };
      await service.adminUpdate('admin-1', row.id, dto);

      expect(repo.update).toHaveBeenCalledWith(row.id, { isActive: false });
    });

    it('updates only priority', async () => {
      const { service, repo } = createDeps();
      const row = providerRow();
      repo.findById.mockResolvedValue(row);
      repo.update.mockResolvedValue({ ...row, priority: 5 });

      await service.adminUpdate('admin-1', row.id, { priority: 5 });

      expect(repo.update).toHaveBeenCalledWith(row.id, { priority: 5 });
    });

    it('updates config for the s3 row when the keys match its provider', async () => {
      const { service, repo } = createDeps();
      const row = providerRow({ provider: 's3' });
      repo.findById.mockResolvedValue(row);
      repo.update.mockResolvedValue({ ...row, config: { bucket: 'new-bucket', region: 'us-east-1' } });

      await service.adminUpdate('admin-1', row.id, { config: { bucket: 'new-bucket', region: 'us-east-1' } });

      expect(repo.update).toHaveBeenCalledWith(row.id, { config: { bucket: 'new-bucket', region: 'us-east-1' } });
    });

    it('updates config for the cloudinary row when the keys match its provider', async () => {
      const { service, repo } = createDeps();
      const row = providerRow({ id: 'cloudinary-row', provider: 'cloudinary', config: {} });
      repo.findById.mockResolvedValue(row);
      repo.update.mockResolvedValue({ ...row, config: { cloudName: 'my-cloud' } });

      await service.adminUpdate('admin-1', row.id, { config: { cloudName: 'my-cloud' } });

      expect(repo.update).toHaveBeenCalledWith(row.id, { config: { cloudName: 'my-cloud' } });
    });

    it('accepts a real class-transformer-shaped config object — every declared field present as own property, foreign ones undefined', async () => {
      // Regression test for a bug caught live (not by the tests above, which
      // pass plain object literals): under this project's `target: ES2024`,
      // every field a `class-transformer` DTO instance declares is an own
      // enumerable property (value `undefined`) the moment it is
      // constructed, whether or not the caller's JSON named it. A
      // `dto.config` built this way has ALL FOUR `StorageProviderConfigDto`
      // keys as own properties even when only `bucket`/`region` were sent —
      // `Object.keys()` cannot tell "present and undefined" apart from
      // "absent", only reading each field's VALUE can. Replicated here
      // without pulling in class-transformer: a plain object with explicit
      // `undefined` for the foreign keys has the identical own-property
      // shape a real DTO instance would.
      const { service, repo } = createDeps();
      const row = providerRow({ provider: 's3' });
      repo.findById.mockResolvedValue(row);
      repo.update.mockResolvedValue(row);
      const classShapedConfig = { bucket: 'new-bucket', region: 'us-east-1', endpoint: undefined, cloudName: undefined };
      expect(Object.keys(classShapedConfig)).toEqual(['bucket', 'region', 'endpoint', 'cloudName']); // sanity: reproduces the real shape

      await expect(service.adminUpdate('admin-1', row.id, { config: classShapedConfig })).resolves.toBeDefined();

      expect(repo.update).toHaveBeenCalledWith(row.id, { config: classShapedConfig });
    });
  });

  describe('adminUpdate: config validated against the ROW\'s provider', () => {
    it('rejects (400) cloudName sent for the s3 row', async () => {
      const { service, repo } = createDeps();
      const row = providerRow({ provider: 's3' });
      repo.findById.mockResolvedValue(row);

      const error = await service
        .adminUpdate('admin-1', row.id, { config: { cloudName: 'not-valid-for-s3' } })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({ code: 'STORAGE_PROVIDER_CONFIG_INVALID' });
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('rejects (400) bucket sent for the cloudinary row', async () => {
      const { service, repo } = createDeps();
      const row = providerRow({ id: 'cloudinary-row', provider: 'cloudinary', config: {} });
      repo.findById.mockResolvedValue(row);

      const error = await service.adminUpdate('admin-1', row.id, { config: { bucket: 'not-valid-here' } }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('rejects before any DB write — the whole config object is validated first', async () => {
      const { service, repo } = createDeps();
      const row = providerRow({ provider: 's3' });
      repo.findById.mockResolvedValue(row);

      await service.adminUpdate('admin-1', row.id, { config: { bucket: 'ok', cloudName: 'not-ok' } }).catch(() => undefined);

      expect(repo.update).not.toHaveBeenCalled();
    });
  });

  describe('adminUpdate: audit', () => {
    it('writes an audit row with before/after for the changed fields only', async () => {
      const { service, repo, audit } = createDeps();
      const row = providerRow({ priority: 10, isActive: true });
      repo.findById.mockResolvedValue(row);
      repo.update.mockResolvedValue({ ...row, priority: 99, isActive: false });

      await service.adminUpdate('admin-42', row.id, { priority: 99, isActive: false });

      expect(audit.write).toHaveBeenCalledWith({
        actorType: 'admin',
        actorId: 'admin-42',
        action: 'update',
        entityType: 'storage_provider',
        entityId: row.id,
        metadata: {
          before: { priority: 10, isActive: true },
          after: { priority: 99, isActive: false },
        },
      });
    });
  });
});
