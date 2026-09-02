import { BadGatewayException, BadRequestException, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { StorageProviderRow } from '../../schema/storage-providers.schema';
import type { StorageProviderRepository } from './storage-provider.repository';
import type { StorageProviderRegistry } from './storage-provider.registry';
import { isCoolingDown, StorageRotationService } from './storage-rotation.service';
import { buildStorageKey } from './storage-key.util';
import { STORAGE_COOLDOWN_SECONDS, STORAGE_DEFAULT_SIGNED_URL_EXPIRY_SECONDS, STORAGE_MAX_FILE_SIZE_BYTES, type StorageFailureKind, type StorageProviderCode } from './storage.constants';
import type { StoreFileInput } from './storage.contract';
import type { StorageFailure, StorageProviderAdapter } from './storage-provider.types';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

function providerRow(overrides: Partial<StorageProviderRow> = {}): StorageProviderRow {
  return {
    id: 'provider-1',
    provider: 's3',
    isActive: true,
    priority: 10,
    config: {},
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

/** A rejection whose classified kind is decided by the test — mirrors `ai-rotation.service.spec.ts`'s `failsAs`. */
function failsAs(kind: StorageFailureKind, detail?: string): Error {
  return Object.assign(new Error(detail ?? `simulated ${kind}`), { __kind: kind });
}

function buildInput(overrides: Partial<StoreFileInput> = {}): StoreFileInput {
  return {
    buffer: Buffer.from('hello world'),
    fileName: 'report.pdf',
    contentType: 'application/pdf',
    category: 'doctor-documents',
    ...overrides,
  };
}

interface AdapterMock {
  adapter: StorageProviderAdapter;
  upload: jest.Mock;
  getSignedUrl: jest.Mock;
  delete: jest.Mock;
  isConfigured: jest.Mock;
  classify: jest.Mock;
}

function buildAdapterMock(provider: StorageProviderCode): AdapterMock {
  const upload = jest.fn();
  const getSignedUrl = jest.fn();
  const del = jest.fn();
  const isConfigured = jest.fn().mockReturnValue(true);
  const classify = jest.fn((error: unknown): StorageFailure => {
    const record = error as { __kind?: StorageFailureKind; message?: string };
    return { kind: record.__kind ?? 'unknown', detail: record.message ?? 'failed' };
  });

  const adapter: StorageProviderAdapter = {
    provider,
    classifier: { classify },
    isConfigured,
    upload,
    getSignedUrl,
    delete: del,
  };

  return { adapter, upload, getSignedUrl, delete: del, isConfigured, classify };
}

function createDeps() {
  const repo = {
    list: jest.fn().mockResolvedValue([]),
    listActive: jest.fn().mockResolvedValue([]),
    findById: jest.fn(),
    findByProvider: jest.fn().mockResolvedValue(null),
    update: jest.fn(),
    recordSuccess: jest.fn().mockResolvedValue(undefined),
    recordFailure: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<StorageProviderRepository>;

  const s3 = buildAdapterMock('s3');
  const cloudinary = buildAdapterMock('cloudinary');

  const registry = {
    find: jest.fn((provider: string) => (provider === 's3' ? s3.adapter : provider === 'cloudinary' ? cloudinary.adapter : null)),
  } as unknown as jest.Mocked<StorageProviderRegistry>;

  const service = new StorageRotationService(repo, registry);
  return { service, repo, registry, s3, cloudinary };
}

/** The module logs at warn/error by design; silence it so a passing run is readable. */
beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

afterAll(() => {
  jest.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */

describe('StorageRotationService', () => {
  describe('store: rotation across providers', () => {
    it('rotates to the second provider when the first fails an auth-shaped failure — no retry, sets cooldown', async () => {
      const { service, repo, s3, cloudinary } = createDeps();
      repo.listActive.mockResolvedValue([providerRow({ id: 's3-row', provider: 's3', priority: 10 }), providerRow({ id: 'cloudinary-row', provider: 'cloudinary', priority: 20 })]);
      s3.upload.mockRejectedValue(failsAs('invalid_credentials'));
      cloudinary.upload.mockResolvedValue({ storageKey: buildStorageKey('cloudinary', 'doctor-documents', 'obj-1'), sizeBytes: 11 });

      const result = await service.store(buildInput());

      expect(result).toEqual({ storageKey: 'cloudinary:doctor-documents/obj-1', sizeBytes: 11 });
      expect(s3.upload).toHaveBeenCalledTimes(1); // no same-provider retry for an auth-shaped failure
      expect(cloudinary.upload).toHaveBeenCalledTimes(1);
    });

    it('throws STORAGE_UNAVAILABLE (503) when every candidate fails', async () => {
      const { service, repo, s3, cloudinary } = createDeps();
      repo.listActive.mockResolvedValue([providerRow({ id: 's3-row', provider: 's3' }), providerRow({ id: 'cloudinary-row', provider: 'cloudinary' })]);
      s3.upload.mockRejectedValue(failsAs('access_denied'));
      cloudinary.upload.mockRejectedValue(failsAs('access_denied'));

      await expect(service.store(buildInput())).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('STORAGE_UNAVAILABLE carries the code, the attempt count and the last failure kind', async () => {
      const { service, repo, s3 } = createDeps();
      repo.listActive.mockResolvedValue([providerRow({ id: 's3-row', provider: 's3' })]);
      s3.upload.mockRejectedValue(failsAs('not_found'));

      const error = await service.store(buildInput()).catch((e: unknown) => e);

      expect((error as ServiceUnavailableException).getResponse()).toEqual({
        code: 'STORAGE_UNAVAILABLE',
        message: expect.any(String),
        attempted: 1,
        lastFailureKind: 'not_found',
      });
    });

    it('throws STORAGE_UNAVAILABLE with attempted: 0 when nothing is active at all', async () => {
      const { service, repo, s3 } = createDeps();
      repo.listActive.mockResolvedValue([]);

      const error = await service.store(buildInput()).catch((e: unknown) => e);

      expect(s3.upload).not.toHaveBeenCalled();
      expect((error as ServiceUnavailableException).getResponse()).toMatchObject({ code: 'STORAGE_UNAVAILABLE', attempted: 0, lastFailureKind: null });
    });

    it('stops after the per-request attempt cap even with more candidates available', async () => {
      const { service, repo, s3 } = createDeps();
      repo.listActive.mockResolvedValue(Array.from({ length: 20 }, (_, i) => providerRow({ id: `row-${i}`, provider: 's3' })));
      s3.upload.mockRejectedValue(failsAs('unknown'));

      await expect(service.store(buildInput())).rejects.toBeInstanceOf(ServiceUnavailableException);

      // Bounded — one upload must not become twenty upstream calls.
      expect(s3.upload).toHaveBeenCalledTimes(5);
    });
  });

  describe('store: ordering', () => {
    it('attempts candidates in exactly the order the repository returned them', async () => {
      const { service, repo, s3, cloudinary } = createDeps();
      repo.listActive.mockResolvedValue([providerRow({ id: 'cheap', provider: 's3', priority: 10 }), providerRow({ id: 'secondary', provider: 'cloudinary', priority: 20 })]);
      s3.upload.mockRejectedValue(failsAs('unknown'));
      cloudinary.upload.mockRejectedValue(failsAs('unknown'));

      await expect(service.store(buildInput())).rejects.toBeInstanceOf(ServiceUnavailableException);

      expect(s3.upload).toHaveBeenCalledTimes(1);
      expect(cloudinary.upload).toHaveBeenCalledTimes(1);
      // The health writes name the providers, in order.
      expect((repo.recordFailure as jest.Mock).mock.calls.map((call) => call[0])).toEqual(['cheap', 'secondary']);
    });
  });

  describe('store: cooldown skipping', () => {
    it('skips a provider whose cooldownUntil is in the future', async () => {
      const { service, repo, s3, cloudinary } = createDeps();
      const future = new Date(Date.now() + 60_000);
      repo.listActive.mockResolvedValue([providerRow({ id: 'cooling', provider: 's3', cooldownUntil: future }), providerRow({ id: 'ready', provider: 'cloudinary' })]);
      cloudinary.upload.mockResolvedValue({ storageKey: 'cloudinary:doctor-documents/x', sizeBytes: 1 });

      await service.store(buildInput());

      expect(s3.upload).not.toHaveBeenCalled();
      expect(repo.recordSuccess).toHaveBeenCalledWith('ready', expect.any(Date));
    });

    it('uses a provider whose cooldownUntil has already passed', async () => {
      const { service, repo, s3 } = createDeps();
      repo.listActive.mockResolvedValue([providerRow({ id: 'expired-cooldown', provider: 's3', cooldownUntil: new Date(Date.now() - 1_000) })]);
      s3.upload.mockResolvedValue({ storageKey: 's3:doctor-documents/x.pdf', sizeBytes: 1 });

      await service.store(buildInput());

      expect(s3.upload).toHaveBeenCalledTimes(1);
    });

    it('throws STORAGE_UNAVAILABLE when every candidate is cooling down', async () => {
      const { service, repo, s3, cloudinary } = createDeps();
      repo.listActive.mockResolvedValue([
        providerRow({ id: 's3-row', provider: 's3', cooldownUntil: new Date(Date.now() + 60_000) }),
        providerRow({ id: 'cloudinary-row', provider: 'cloudinary', cooldownUntil: new Date(Date.now() + 60_000) }),
      ]);

      await expect(service.store(buildInput())).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(s3.upload).not.toHaveBeenCalled();
      expect(cloudinary.upload).not.toHaveBeenCalled();
    });

    it('isCoolingDown treats a null column as "never cooled down"', () => {
      const now = new Date('2026-06-01T12:00:00.000Z');
      expect(isCoolingDown(providerRow({ cooldownUntil: null }), now)).toBe(false);
      expect(isCoolingDown(providerRow({ cooldownUntil: new Date('2026-06-01T12:00:01.000Z') }), now)).toBe(true);
      expect(isCoolingDown(providerRow({ cooldownUntil: new Date('2026-06-01T11:59:59.000Z') }), now)).toBe(false);
    });
  });

  describe('store: missing environment credentials', () => {
    it('skips a provider that is isActive: true in the database but not configured (missing env vars)', async () => {
      const { service, repo, s3, cloudinary } = createDeps();
      repo.listActive.mockResolvedValue([providerRow({ id: 's3-row', provider: 's3' }), providerRow({ id: 'cloudinary-row', provider: 'cloudinary' })]);
      s3.isConfigured.mockReturnValue(false);
      cloudinary.upload.mockResolvedValue({ storageKey: 'cloudinary:doctor-documents/x', sizeBytes: 1 });

      const result = await service.store(buildInput());

      expect(s3.upload).not.toHaveBeenCalled();
      expect(result.storageKey).toBe('cloudinary:doctor-documents/x');
    });
  });

  describe('store: network_or_timeout retry on the SAME provider', () => {
    it('retries once on the same provider, then rotates', async () => {
      const { service, repo, s3, cloudinary } = createDeps();
      repo.listActive.mockResolvedValue([providerRow({ id: 'flaky', provider: 's3' }), providerRow({ id: 'healthy', provider: 'cloudinary' })]);
      s3.upload.mockRejectedValueOnce(failsAs('network_or_timeout')).mockRejectedValueOnce(failsAs('network_or_timeout'));
      cloudinary.upload.mockResolvedValue({ storageKey: 'cloudinary:doctor-documents/x', sizeBytes: 1 });

      const result = await service.store(buildInput());

      expect(result.storageKey).toBe('cloudinary:doctor-documents/x');
      expect(s3.upload).toHaveBeenCalledTimes(2); // same-provider retry
      expect(cloudinary.upload).toHaveBeenCalledTimes(1);
    });

    it('succeeds on the retry without ever rotating', async () => {
      const { service, repo, s3, cloudinary } = createDeps();
      repo.listActive.mockResolvedValue([providerRow({ id: 'flaky', provider: 's3' }), providerRow({ id: 'other', provider: 'cloudinary' })]);
      s3.upload.mockRejectedValueOnce(failsAs('network_or_timeout')).mockResolvedValueOnce({ storageKey: 's3:doctor-documents/x.pdf', sizeBytes: 1 });

      await service.store(buildInput());

      expect(s3.upload).toHaveBeenCalledTimes(2);
      expect(cloudinary.upload).not.toHaveBeenCalled();
      expect(repo.recordSuccess).toHaveBeenCalledWith('flaky', expect.any(Date));
    });

    it('does NOT retry the same provider for a non-network_or_timeout kind', async () => {
      const { service, repo, s3, cloudinary } = createDeps();
      repo.listActive.mockResolvedValue([providerRow({ id: 's3-row', provider: 's3' }), providerRow({ id: 'cloudinary-row', provider: 'cloudinary' })]);
      s3.upload.mockRejectedValueOnce(failsAs('access_denied'));
      cloudinary.upload.mockResolvedValueOnce({ storageKey: 'cloudinary:doctor-documents/x', sizeBytes: 1 });

      await service.store(buildInput());

      // Exactly one call per provider — no same-provider retry.
      expect(s3.upload).toHaveBeenCalledTimes(1);
      expect(cloudinary.upload).toHaveBeenCalledTimes(1);
    });
  });

  describe('store: health columns', () => {
    it('records success on the provider that worked', async () => {
      const { service, repo, s3 } = createDeps();
      repo.listActive.mockResolvedValue([providerRow({ id: 'winner', provider: 's3' })]);
      s3.upload.mockResolvedValue({ storageKey: 's3:doctor-documents/x.pdf', sizeBytes: 1 });

      await service.store(buildInput());

      expect(repo.recordSuccess).toHaveBeenCalledWith('winner', expect.any(Date));
      expect(repo.recordFailure).not.toHaveBeenCalled();
    });

    it('records a failure with its classified kind and the standard cooldown', async () => {
      const { service, repo, s3 } = createDeps();
      repo.listActive.mockResolvedValue([providerRow({ id: 'loser', provider: 's3' })]);
      s3.upload.mockRejectedValue(failsAs('invalid_credentials'));

      const before = Date.now();
      await service.store(buildInput()).catch(() => undefined);

      expect(repo.recordFailure).toHaveBeenCalledWith('loser', {
        at: expect.any(Date),
        kind: 'invalid_credentials',
        cooldownUntil: expect.any(Date),
      });
      const { cooldownUntil } = (repo.recordFailure as jest.Mock).mock.calls[0][1] as { cooldownUntil: Date };
      expect(Math.round((cooldownUntil.getTime() - before) / 1_000)).toBe(STORAGE_COOLDOWN_SECONDS);
    });

    it('sets NO cooldown for network_or_timeout — a blip must not sideline a healthy provider', async () => {
      const { service, repo, s3 } = createDeps();
      repo.listActive.mockResolvedValue([providerRow({ id: 'flaky', provider: 's3' })]);
      s3.upload.mockRejectedValue(failsAs('network_or_timeout'));

      await service.store(buildInput()).catch(() => undefined);

      const calls = (repo.recordFailure as jest.Mock).mock.calls as [string, { cooldownUntil: Date | null }][];
      for (const [, params] of calls) {
        expect(params.cooldownUntil).toBeNull();
      }
    });

    it('NEVER writes is_active — disabling is the admin’s decision alone', async () => {
      const { service, repo, s3 } = createDeps();
      repo.listActive.mockResolvedValue([providerRow({ id: 'a', provider: 's3', consecutiveFailures: 99 })]);
      s3.upload.mockRejectedValue(failsAs('invalid_credentials'));

      await service.store(buildInput()).catch(() => undefined);

      // The repository exposes no `update`-through-rotation path — only the
      // admin service (`storage-provider.service.ts`) calls `repo.update`.
      const [, params] = (repo.recordFailure as jest.Mock).mock.calls[0] as [string, Record<string, unknown>];
      expect(params).not.toHaveProperty('isActive');
      expect(repo.update).not.toHaveBeenCalled();
    });
  });

  describe('store: health writes are best-effort', () => {
    it('a failed success-write does NOT fail an otherwise successful store', async () => {
      const { service, repo, s3 } = createDeps();
      repo.listActive.mockResolvedValue([providerRow({ id: 'winner', provider: 's3' })]);
      s3.upload.mockResolvedValue({ storageKey: 's3:doctor-documents/x.pdf', sizeBytes: 1 });
      (repo.recordSuccess as jest.Mock).mockRejectedValue(new Error('deadlock detected'));

      const result = await service.store(buildInput());

      expect(result.storageKey).toBe('s3:doctor-documents/x.pdf');
    });

    it('a failed failure-write does not stop rotation reaching a working provider', async () => {
      const { service, repo, s3, cloudinary } = createDeps();
      repo.listActive.mockResolvedValue([providerRow({ id: 'a', provider: 's3' }), providerRow({ id: 'b', provider: 'cloudinary' })]);
      s3.upload.mockRejectedValue(failsAs('invalid_credentials'));
      cloudinary.upload.mockResolvedValue({ storageKey: 'cloudinary:doctor-documents/x', sizeBytes: 1 });
      (repo.recordFailure as jest.Mock).mockRejectedValue(new Error('connection terminated'));

      await expect(service.store(buildInput())).resolves.toMatchObject({ storageKey: 'cloudinary:doctor-documents/x' });
    });
  });

  describe('store: size ceiling', () => {
    it('rejects a buffer over STORAGE_MAX_FILE_SIZE_BYTES before querying any provider', async () => {
      const { service, repo, s3 } = createDeps();
      const oversized = buildInput({ buffer: Buffer.alloc(STORAGE_MAX_FILE_SIZE_BYTES + 1) });

      const error = await service.store(oversized).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({ code: 'STORAGE_FILE_TOO_LARGE' });
      expect(repo.listActive).not.toHaveBeenCalled();
      expect(s3.upload).not.toHaveBeenCalled();
    });

    it('accepts a buffer exactly at the ceiling', async () => {
      const { service, repo, s3 } = createDeps();
      repo.listActive.mockResolvedValue([providerRow({ id: 's3-row', provider: 's3' })]);
      s3.upload.mockResolvedValue({ storageKey: 's3:doctor-documents/x.pdf', sizeBytes: STORAGE_MAX_FILE_SIZE_BYTES });

      const atCeiling = buildInput({ buffer: Buffer.alloc(STORAGE_MAX_FILE_SIZE_BYTES) });
      await expect(service.store(atCeiling)).resolves.toBeDefined();
    });
  });

  describe('getSignedUrl', () => {
    it('routes an s3-prefixed key to the S3 adapter', async () => {
      const { service, repo, s3, cloudinary } = createDeps();
      repo.findByProvider.mockImplementation(async (provider: string) => (provider === 's3' ? providerRow({ id: 's3-row', provider: 's3' }) : null));
      s3.getSignedUrl.mockResolvedValue('https://s3.example/signed');

      const url = await service.getSignedUrl('s3:doctor-documents/x.pdf');

      expect(url).toBe('https://s3.example/signed');
      expect(s3.getSignedUrl).toHaveBeenCalledWith('doctor-documents/x.pdf', STORAGE_DEFAULT_SIGNED_URL_EXPIRY_SECONDS, {});
      expect(cloudinary.getSignedUrl).not.toHaveBeenCalled();
    });

    it('routes a cloudinary-prefixed key to the Cloudinary adapter', async () => {
      const { service, repo, cloudinary } = createDeps();
      repo.findByProvider.mockImplementation(async (provider: string) => (provider === 'cloudinary' ? providerRow({ id: 'cloudinary-row', provider: 'cloudinary' }) : null));
      cloudinary.getSignedUrl.mockResolvedValue('https://cloudinary.example/signed');

      const url = await service.getSignedUrl('cloudinary:patient-files/x');

      expect(url).toBe('https://cloudinary.example/signed');
      expect(cloudinary.getSignedUrl).toHaveBeenCalledWith('patient-files/x', STORAGE_DEFAULT_SIGNED_URL_EXPIRY_SECONDS, {});
    });

    it('passes a caller-supplied expirySeconds through to the adapter', async () => {
      const { service, repo, s3 } = createDeps();
      repo.findByProvider.mockResolvedValue(providerRow({ id: 's3-row', provider: 's3' }));
      s3.getSignedUrl.mockResolvedValue('https://s3.example/signed');

      await service.getSignedUrl('s3:doctor-documents/x.pdf', 900);

      expect(s3.getSignedUrl).toHaveBeenCalledWith('doctor-documents/x.pdf', 900, {});
    });

    it('rejects a malformed key with STORAGE_KEY_INVALID (400) without touching the repository', async () => {
      const { service, repo } = createDeps();

      const error = await service.getSignedUrl('not-a-valid-key').catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({ code: 'STORAGE_KEY_INVALID' });
      expect(repo.findByProvider).not.toHaveBeenCalled();
    });

    it('throws the distinct honest STORAGE_PROVIDER_UNAVAILABLE_FOR_KEY when the row is inactive — no rotation attempt', async () => {
      const { service, repo, s3, cloudinary } = createDeps();
      repo.findByProvider.mockResolvedValue(providerRow({ id: 's3-row', provider: 's3', isActive: false }));

      const error = await service.getSignedUrl('s3:doctor-documents/x.pdf').catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect((error as ServiceUnavailableException).getResponse()).toMatchObject({ code: 'STORAGE_PROVIDER_UNAVAILABLE_FOR_KEY' });
      expect(s3.getSignedUrl).not.toHaveBeenCalled();
      // The whole point: there is nowhere to rotate TO for a specific object.
      expect(cloudinary.getSignedUrl).not.toHaveBeenCalled();
    });

    it('throws STORAGE_PROVIDER_UNAVAILABLE_FOR_KEY when the row is cooling down', async () => {
      const { service, repo, s3 } = createDeps();
      repo.findByProvider.mockResolvedValue(providerRow({ id: 's3-row', provider: 's3', cooldownUntil: new Date(Date.now() + 60_000) }));

      await expect(service.getSignedUrl('s3:doctor-documents/x.pdf')).rejects.toMatchObject({
        response: { code: 'STORAGE_PROVIDER_UNAVAILABLE_FOR_KEY' },
      });
      expect(s3.getSignedUrl).not.toHaveBeenCalled();
    });

    it('throws STORAGE_PROVIDER_UNAVAILABLE_FOR_KEY when the adapter reports missing env credentials', async () => {
      const { service, repo, s3 } = createDeps();
      repo.findByProvider.mockResolvedValue(providerRow({ id: 's3-row', provider: 's3' }));
      s3.isConfigured.mockReturnValue(false);

      await expect(service.getSignedUrl('s3:doctor-documents/x.pdf')).rejects.toMatchObject({
        response: { code: 'STORAGE_PROVIDER_UNAVAILABLE_FOR_KEY' },
      });
    });

    it('throws STORAGE_PROVIDER_UNAVAILABLE_FOR_KEY when no row exists for that provider at all', async () => {
      const { service, repo } = createDeps();
      repo.findByProvider.mockResolvedValue(null);

      await expect(service.getSignedUrl('s3:doctor-documents/x.pdf')).rejects.toMatchObject({
        response: { code: 'STORAGE_PROVIDER_UNAVAILABLE_FOR_KEY' },
      });
    });

    it('throws STORAGE_OPERATION_FAILED (502) when the provider is usable but the specific call fails, and records the failure', async () => {
      const { service, repo, s3 } = createDeps();
      repo.findByProvider.mockResolvedValue(providerRow({ id: 's3-row', provider: 's3' }));
      s3.getSignedUrl.mockRejectedValue(failsAs('not_found', 'no such key'));

      const error = await service.getSignedUrl('s3:doctor-documents/x.pdf').catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadGatewayException);
      expect((error as BadGatewayException).getResponse()).toMatchObject({ code: 'STORAGE_OPERATION_FAILED', failureKind: 'not_found' });
      expect(repo.recordFailure).toHaveBeenCalledWith('s3-row', expect.objectContaining({ kind: 'not_found' }));
    });

    it('records success after a real signed-url call', async () => {
      const { service, repo, s3 } = createDeps();
      repo.findByProvider.mockResolvedValue(providerRow({ id: 's3-row', provider: 's3' }));
      s3.getSignedUrl.mockResolvedValue('https://s3.example/signed');

      await service.getSignedUrl('s3:doctor-documents/x.pdf');

      expect(repo.recordSuccess).toHaveBeenCalledWith('s3-row', expect.any(Date));
    });
  });

  describe('delete', () => {
    it('routes to the correct adapter based on key prefix', async () => {
      const { service, repo, s3, cloudinary } = createDeps();
      repo.findByProvider.mockResolvedValue(providerRow({ id: 's3-row', provider: 's3' }));
      s3.delete.mockResolvedValue(undefined);

      await service.delete('s3:doctor-documents/x.pdf');

      expect(s3.delete).toHaveBeenCalledWith('doctor-documents/x.pdf', {});
      expect(cloudinary.delete).not.toHaveBeenCalled();
    });

    it('throws the distinct honest error rather than attempting a rotation when the provider is unusable', async () => {
      const { service, repo, s3, cloudinary } = createDeps();
      repo.findByProvider.mockResolvedValue(providerRow({ id: 's3-row', provider: 's3', isActive: false }));

      await expect(service.delete('s3:doctor-documents/x.pdf')).rejects.toMatchObject({
        response: { code: 'STORAGE_PROVIDER_UNAVAILABLE_FOR_KEY' },
      });
      expect(s3.delete).not.toHaveBeenCalled();
      expect(cloudinary.delete).not.toHaveBeenCalled();
    });

    it('throws STORAGE_OPERATION_FAILED (502) and records the failure when the live delete call fails', async () => {
      const { service, repo, s3 } = createDeps();
      repo.findByProvider.mockResolvedValue(providerRow({ id: 's3-row', provider: 's3' }));
      s3.delete.mockRejectedValue(failsAs('access_denied'));

      const error = await service.delete('s3:doctor-documents/x.pdf').catch((e: unknown) => e);

      expect(error).toBeInstanceOf(BadGatewayException);
      expect(repo.recordFailure).toHaveBeenCalledWith('s3-row', expect.objectContaining({ kind: 'access_denied' }));
    });

    it('records success after a real delete call', async () => {
      const { service, repo, s3 } = createDeps();
      repo.findByProvider.mockResolvedValue(providerRow({ id: 's3-row', provider: 's3' }));
      s3.delete.mockResolvedValue(undefined);

      await service.delete('s3:doctor-documents/x.pdf');

      expect(repo.recordSuccess).toHaveBeenCalledWith('s3-row', expect.any(Date));
    });
  });

  describe('isAvailable', () => {
    it('is true when at least one active, configured, non-cooled-down provider exists', async () => {
      const { service, repo } = createDeps();
      repo.listActive.mockResolvedValue([providerRow({ id: 'a', provider: 's3' })]);

      await expect(service.isAvailable()).resolves.toBe(true);
    });

    it('is false when there are no active providers at all', async () => {
      const { service, repo } = createDeps();
      repo.listActive.mockResolvedValue([]);

      await expect(service.isAvailable()).resolves.toBe(false);
    });

    it('is false when every provider is cooling down', async () => {
      const { service, repo } = createDeps();
      repo.listActive.mockResolvedValue([providerRow({ id: 'a', provider: 's3', cooldownUntil: new Date(Date.now() + 30_000) })]);

      await expect(service.isAvailable()).resolves.toBe(false);
    });

    it('is false when the only active provider is missing its env credentials', async () => {
      const { service, repo, s3 } = createDeps();
      repo.listActive.mockResolvedValue([providerRow({ id: 'a', provider: 's3' })]);
      s3.isConfigured.mockReturnValue(false);

      await expect(service.isAvailable()).resolves.toBe(false);
    });

    it('makes no upstream call — it is a kill-switch check, not a live probe', async () => {
      const { service, repo, s3 } = createDeps();
      repo.listActive.mockResolvedValue([providerRow({ id: 'a', provider: 's3' })]);

      await service.isAvailable();

      expect(s3.upload).not.toHaveBeenCalled();
      expect(s3.getSignedUrl).not.toHaveBeenCalled();
    });
  });

  describe('onModuleInit', () => {
    it('warns once for an active provider missing its environment credentials', async () => {
      const { service, repo, s3 } = createDeps();
      repo.list.mockResolvedValue([providerRow({ id: 'a', provider: 's3', isActive: true })]);
      s3.isConfigured.mockReturnValue(false);
      const warnSpy = jest.spyOn(Logger.prototype, 'warn');
      warnSpy.mockClear();

      await service.onModuleInit();

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"s3"'));
    });

    it('does not warn for an active, configured provider', async () => {
      const { service, repo, s3 } = createDeps();
      repo.list.mockResolvedValue([providerRow({ id: 'a', provider: 's3', isActive: true })]);
      s3.isConfigured.mockReturnValue(true);
      const warnSpy = jest.spyOn(Logger.prototype, 'warn');
      warnSpy.mockClear();

      await service.onModuleInit();

      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('does not warn about an INACTIVE provider missing credentials', async () => {
      const { service, repo, s3 } = createDeps();
      repo.list.mockResolvedValue([providerRow({ id: 'a', provider: 's3', isActive: false })]);
      s3.isConfigured.mockReturnValue(false);
      const warnSpy = jest.spyOn(Logger.prototype, 'warn');
      warnSpy.mockClear();

      await service.onModuleInit();

      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('never throws, even if the repository query fails', async () => {
      const { service, repo } = createDeps();
      repo.list.mockRejectedValue(new Error('connection refused'));

      await expect(service.onModuleInit()).resolves.toBeUndefined();
    });
  });
});
