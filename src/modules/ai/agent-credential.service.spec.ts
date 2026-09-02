import { ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { AgentCredentialRow } from '../../schema/agent-credentials.schema';
import type { AgentProfileRow } from '../../schema/agent-profiles.schema';
import type { AuditService } from '../../shared/audit/audit.service';
import type { AgentCredentialRepository } from './agent-credential.repository';
import { AgentCredentialService } from './agent-credential.service';
import type { AgentProfileService } from './agent-profile.service';
import type { AiCryptoService } from './ai-crypto.service';
import type { AiRotationService } from './ai-rotation.service';
import type { LlmProviderRegistry } from './llm-provider.registry';

const PLAINTEXT_KEY = 'sk-proj-PLAINTEXTSECRETVALUE-4242';

function profileRow(overrides: Partial<AgentProfileRow> = {}): AgentProfileRow {
  return {
    id: 'profile-1',
    name: 'Primary',
    provider: 'openai_compatible',
    model: 'gpt-4o-mini',
    baseUrl: null,
    config: {},
    priority: 100,
    isActive: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function credentialRow(overrides: Partial<AgentCredentialRow> = {}): AgentCredentialRow {
  return {
    id: 'credential-1',
    profileId: 'profile-1',
    label: 'key one',
    encryptedKey: 'v1:iv:tag:cipher',
    keyLast4: '4242',
    priority: 100,
    isActive: true,
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

function uniqueViolation(): Error {
  return Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
}

function createDeps() {
  const repo = {
    findById: jest.fn(),
    findByIdWithProfile: jest.fn(),
    findByProfileAndLabel: jest.fn().mockResolvedValue(null),
    listByProfile: jest.fn().mockResolvedValue([]),
    countByProfile: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    deleteById: jest.fn().mockResolvedValue(true),
    recordSuccess: jest.fn(),
    recordFailure: jest.fn(),
  } as unknown as jest.Mocked<AgentCredentialRepository>;

  const profileService = {
    findRawById: jest.fn().mockResolvedValue(profileRow()),
  } as unknown as jest.Mocked<AgentProfileService>;

  const crypto = {
    encrypt: jest.fn((plaintext: string) => `enc(${plaintext})`),
    decrypt: jest.fn(),
    lastFour: jest.fn((plaintext: string) => plaintext.slice(-4)),
    matches: jest.fn().mockReturnValue(false),
  } as unknown as jest.Mocked<AiCryptoService>;

  const audit = { write: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<AuditService>;

  const rotation = {
    probe: jest.fn(),
  } as unknown as jest.Mocked<AiRotationService>;

  const registry = { require: jest.fn(), find: jest.fn() } as unknown as jest.Mocked<LlmProviderRegistry>;

  const service = new AgentCredentialService(repo, profileService, crypto, audit, rotation, registry);
  return { service, repo, profileService, crypto, audit, rotation, registry };
}

/** Every audit call this test made, serialised — used to prove no key material reached `audit_log`. */
function auditPayloads(audit: jest.Mocked<AuditService>): string {
  return JSON.stringify((audit.write as jest.Mock).mock.calls);
}

describe('AgentCredentialService', () => {
  describe('adminCreate', () => {
    it('encrypts the key, stores only last4, and never returns the plaintext', async () => {
      const { service, repo, crypto } = createDeps();
      repo.create.mockResolvedValue(credentialRow());

      await service.adminCreate('admin-1', 'profile-1', { label: 'key one', key: PLAINTEXT_KEY });

      expect(crypto.encrypt).toHaveBeenCalledWith(PLAINTEXT_KEY);
      expect(repo.create).toHaveBeenCalledWith({
        profileId: 'profile-1',
        label: 'key one',
        encryptedKey: `enc(${PLAINTEXT_KEY})`,
        keyLast4: '4242',
        priority: undefined,
        isActive: undefined,
      });
    });

    it('404s when the profile does not exist', async () => {
      const { service, profileService, repo } = createDeps();
      (profileService.findRawById as jest.Mock).mockResolvedValue(null);

      const error = await service
        .adminCreate('admin-1', 'missing', { label: 'k', key: PLAINTEXT_KEY })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).getResponse()).toMatchObject({ code: 'PROFILE_NOT_FOUND' });
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('rejects a duplicate label under the same profile (409)', async () => {
      const { service, repo } = createDeps();
      (repo.findByProfileAndLabel as jest.Mock).mockResolvedValue(credentialRow());

      const error = await service
        .adminCreate('admin-1', 'profile-1', { label: 'key one', key: PLAINTEXT_KEY })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({ code: 'CREDENTIAL_LABEL_TAKEN' });
    });

    it('converts a RACED duplicate insert into the same clean 409', async () => {
      const { service, repo } = createDeps();
      repo.create.mockRejectedValue(uniqueViolation());

      const error = await service
        .adminCreate('admin-1', 'profile-1', { label: 'key one', key: PLAINTEXT_KEY })
        .catch((e: unknown) => e);

      expect((error as ConflictException).getResponse()).toMatchObject({ code: 'CREDENTIAL_LABEL_TAKEN' });
    });

    it('audits the label and keyLast4 — and NOTHING resembling the key', async () => {
      const { service, repo, audit } = createDeps();
      repo.create.mockResolvedValue(credentialRow());

      await service.adminCreate('admin-1', 'profile-1', { label: 'key one', key: PLAINTEXT_KEY });

      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'create',
          entityType: 'agent_credential',
          metadata: { after: expect.objectContaining({ label: 'key one', keyLast4: '4242' }) },
        }),
      );

      const serialised = auditPayloads(audit);
      expect(serialised).not.toContain(PLAINTEXT_KEY);
      expect(serialised).not.toContain('PLAINTEXTSECRETVALUE');
      expect(serialised).not.toContain('enc(');
    });
  });

  describe('adminUpdate', () => {
    it('is a no-op (no write, no audit) for an empty DTO', async () => {
      const { service, repo, audit } = createDeps();
      repo.findById.mockResolvedValue(credentialRow());

      await service.adminUpdate('admin-1', 'credential-1', {});

      expect(repo.update).not.toHaveBeenCalled();
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('drops a key that is byte-identical to the stored one — no re-encrypt, no fake rotation in the audit log', async () => {
      const { service, repo, crypto, audit } = createDeps();
      repo.findById.mockResolvedValue(credentialRow());
      (crypto.matches as jest.Mock).mockReturnValue(true);

      await service.adminUpdate('admin-1', 'credential-1', { key: PLAINTEXT_KEY });

      expect(crypto.encrypt).not.toHaveBeenCalled();
      expect(repo.update).not.toHaveBeenCalled();
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('rotates the key in place when it genuinely differs', async () => {
      const { service, repo, crypto } = createDeps();
      repo.findById.mockResolvedValue(credentialRow({ keyLast4: '0000' }));
      repo.update.mockResolvedValue(credentialRow({ keyLast4: '4242' }));
      (crypto.matches as jest.Mock).mockReturnValue(false);

      await service.adminUpdate('admin-1', 'credential-1', { key: PLAINTEXT_KEY });

      expect(repo.update).toHaveBeenCalledWith('credential-1', {
        encryptedKey: `enc(${PLAINTEXT_KEY})`,
        keyLast4: '4242',
      });
    });

    it('records the rotation as a flag plus last4 — never the ciphertext or the plaintext', async () => {
      const { service, repo, audit } = createDeps();
      repo.findById.mockResolvedValue(credentialRow({ keyLast4: '0000' }));
      repo.update.mockResolvedValue(credentialRow({ keyLast4: '4242' }));

      await service.adminUpdate('admin-1', 'credential-1', { key: PLAINTEXT_KEY });

      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'update',
          metadata: { before: { keyLast4: '0000' }, after: { keyRotated: true, keyLast4: '4242' } },
        }),
      );

      const serialised = auditPayloads(audit);
      expect(serialised).not.toContain(PLAINTEXT_KEY);
      expect(serialised).not.toContain('enc(');
      expect(serialised).not.toContain('encryptedKey');
    });

    it('does NOT reset the health columns when the key is rotated', async () => {
      // An admin pasting a new secret has not PROVED it works. Clearing the
      // cooldown here would promote an unverified key to the front of the
      // rotation queue; the test endpoint exists for that.
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(credentialRow({ cooldownUntil: new Date('2030-01-01T00:00:00.000Z') }));
      repo.update.mockResolvedValue(credentialRow());

      await service.adminUpdate('admin-1', 'credential-1', { key: PLAINTEXT_KEY });

      const [, fields] = (repo.update as jest.Mock).mock.calls[0] as [string, Record<string, unknown>];
      expect(fields).not.toHaveProperty('cooldownUntil');
      expect(fields).not.toHaveProperty('consecutiveFailures');
      expect(fields).not.toHaveProperty('lastFailureKind');
    });

    it('rejects a label that collides with another credential under the same profile', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(credentialRow({ id: 'credential-1', label: 'key one' }));
      (repo.findByProfileAndLabel as jest.Mock).mockResolvedValue(credentialRow({ id: 'credential-2', label: 'key two' }));

      const error = await service.adminUpdate('admin-1', 'credential-1', { label: 'key two' }).catch((e: unknown) => e);

      expect((error as ConflictException).getResponse()).toMatchObject({ code: 'CREDENTIAL_LABEL_TAKEN' });
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('404s for an unknown id', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(null);

      const error = await service.adminUpdate('admin-1', 'missing', { label: 'x' }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).getResponse()).toMatchObject({ code: 'CREDENTIAL_NOT_FOUND' });
    });

    it('lets an admin disable a credential (the ONLY way is_active ever changes)', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(credentialRow({ isActive: true }));
      repo.update.mockResolvedValue(credentialRow({ isActive: false }));

      await service.adminUpdate('admin-1', 'credential-1', { isActive: false });

      expect(repo.update).toHaveBeenCalledWith('credential-1', { isActive: false });
    });
  });

  describe('adminDelete', () => {
    it('deletes and audits with label + last4 only', async () => {
      const { service, repo, audit } = createDeps();
      repo.findById.mockResolvedValue(credentialRow());

      await service.adminDelete('admin-1', 'credential-1');

      expect(repo.deleteById).toHaveBeenCalledWith('credential-1');
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'delete',
          metadata: { before: expect.objectContaining({ label: 'key one', keyLast4: '4242' }) },
        }),
      );
      expect(auditPayloads(audit)).not.toContain('v1:iv:tag:cipher');
    });

    it('404s for an unknown id', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(null);

      await expect(service.adminDelete('admin-1', 'missing')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('adminTest', () => {
    it('returns the probe result and the refreshed health columns', async () => {
      const { service, repo, rotation } = createDeps();
      (repo.findByIdWithProfile as jest.Mock).mockResolvedValue({
        credential: credentialRow(),
        profile: profileRow(),
      });
      (rotation.probe as jest.Mock).mockResolvedValue({
        ok: true,
        failureKind: null,
        detail: null,
        latencyMs: 412,
        providerNotConfigured: false,
      });
      repo.findById.mockResolvedValue(credentialRow({ cooldownUntil: null, lastSucceededAt: new Date() }));

      const result = await service.adminTest('admin-1', 'credential-1');

      expect(result.ok).toBe(true);
      expect(result.latencyMs).toBe(412);
      expect(result.credential.maskedKey).toBe('****4242');
      // No key material on the way out.
      expect(JSON.stringify(result)).not.toContain('v1:iv:tag:cipher');
    });

    it('returns 200 with a classified failure rather than throwing when the provider rejects the key', async () => {
      const { service, repo, rotation } = createDeps();
      (repo.findByIdWithProfile as jest.Mock).mockResolvedValue({
        credential: credentialRow(),
        profile: profileRow(),
      });
      (rotation.probe as jest.Mock).mockResolvedValue({
        ok: false,
        failureKind: 'insufficient_quota',
        detail: 'You exceeded your current quota',
        latencyMs: 220,
        providerNotConfigured: false,
      });
      repo.findById.mockResolvedValue(credentialRow({ consecutiveFailures: 1 }));

      const result = await service.adminTest('admin-1', 'credential-1');

      expect(result.ok).toBe(false);
      expect(result.failureKind).toBe('insufficient_quota');
      expect(result.credential.consecutiveFailures).toBe(1);
    });

    it('throws 503 PROVIDER_NOT_CONFIGURED when no call could be attempted at all', async () => {
      const { service, repo, rotation } = createDeps();
      (repo.findByIdWithProfile as jest.Mock).mockResolvedValue({
        credential: credentialRow(),
        profile: profileRow({ provider: 'bedrock' }),
      });
      (rotation.probe as jest.Mock).mockResolvedValue({
        ok: false,
        failureKind: 'model_unavailable',
        detail: 'AWS Bedrock is not configured in this build.',
        latencyMs: 1,
        providerNotConfigured: true,
      });

      const error = await service.adminTest('admin-1', 'credential-1').catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect((error as ServiceUnavailableException).getResponse()).toMatchObject({
        code: 'PROVIDER_NOT_CONFIGURED',
      });
    });

    it('propagates 400 UNSUPPORTED_PROVIDER before probing at all', async () => {
      const { service, repo, rotation, registry } = createDeps();
      (repo.findByIdWithProfile as jest.Mock).mockResolvedValue({
        credential: credentialRow(),
        profile: profileRow({ provider: 'some_future_provider' }),
      });
      (registry.require as jest.Mock).mockImplementation(() => {
        throw new Error('UNSUPPORTED_PROVIDER');
      });

      await expect(service.adminTest('admin-1', 'credential-1')).rejects.toThrow('UNSUPPORTED_PROVIDER');
      expect(rotation.probe).not.toHaveBeenCalled();
    });

    it('404s for an unknown credential', async () => {
      const { service, repo } = createDeps();
      (repo.findByIdWithProfile as jest.Mock).mockResolvedValue(null);

      await expect(service.adminTest('admin-1', 'missing')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('audits the probe as a verify action, carrying the outcome but no vendor detail and no key', async () => {
      const { service, repo, rotation, audit } = createDeps();
      (repo.findByIdWithProfile as jest.Mock).mockResolvedValue({
        credential: credentialRow(),
        profile: profileRow(),
      });
      (rotation.probe as jest.Mock).mockResolvedValue({
        ok: false,
        failureKind: 'invalid_key',
        detail: `the vendor echoed ${PLAINTEXT_KEY} back at us`,
        latencyMs: 90,
        providerNotConfigured: false,
      });
      repo.findById.mockResolvedValue(credentialRow());

      await service.adminTest('admin-1', 'credential-1');

      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'verify',
          entityType: 'agent_credential',
          metadata: expect.objectContaining({ ok: false, failureKind: 'invalid_key', keyLast4: '4242' }),
        }),
      );
      // Vendor text is not audit material — it is vendor-controlled and goes
      // to the server log instead.
      expect(auditPayloads(audit)).not.toContain(PLAINTEXT_KEY);
      expect(auditPayloads(audit)).not.toContain('echoed');
    });
  });

  describe('adminListByProfile', () => {
    it('404s when the profile does not exist', async () => {
      const { service, profileService } = createDeps();
      (profileService.findRawById as jest.Mock).mockResolvedValue(null);

      await expect(service.adminListByProfile('missing')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
