import { ConflictException, NotFoundException } from '@nestjs/common';
import type { AgentProfileRow } from '../../schema/agent-profiles.schema';
import type { AuditService } from '../../shared/audit/audit.service';
import type { AgentCredentialRepository } from './agent-credential.repository';
import type { AgentProfileRepository } from './agent-profile.repository';
import { AgentProfileService } from './agent-profile.service';

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

/** A `pg` unique-violation, duck-typed exactly as `isUniqueConstraintViolation` recognises it. */
function uniqueViolation(): Error {
  return Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
}

function createDeps() {
  const repo = {
    findById: jest.fn(),
    findByName: jest.fn().mockResolvedValue(null),
    list: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    deleteById: jest.fn().mockResolvedValue(true),
    hasActive: jest.fn(),
  } as unknown as jest.Mocked<AgentProfileRepository>;

  const credentialRepo = {
    countByProfile: jest.fn().mockResolvedValue(0),
  } as unknown as jest.Mocked<AgentCredentialRepository>;

  const audit = { write: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<AuditService>;

  const service = new AgentProfileService(repo, credentialRepo, audit);
  return { service, repo, credentialRepo, audit };
}

describe('AgentProfileService', () => {
  describe('adminGetById', () => {
    it('throws PROFILE_NOT_FOUND (404) for an unknown id', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(null);

      const error = await service.adminGetById('missing').catch((e: unknown) => e);

      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).getResponse()).toMatchObject({ code: 'PROFILE_NOT_FOUND' });
    });
  });

  describe('adminCreate', () => {
    it('creates and audits with the defined fields', async () => {
      const { service, repo, audit } = createDeps();
      repo.create.mockResolvedValue(profileRow({ id: 'new-profile' }));

      await service.adminCreate('admin-1', {
        name: 'Groq fallback',
        provider: 'openai_compatible',
        model: 'llama-3.3-70b-versatile',
        baseUrl: 'https://api.groq.com/openai/v1',
        priority: 50,
      });

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Groq fallback', baseUrl: 'https://api.groq.com/openai/v1' }),
      );
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({
          actorType: 'admin',
          actorId: 'admin-1',
          action: 'create',
          entityType: 'agent_profile',
          entityId: 'new-profile',
        }),
      );
    });

    it('normalises an omitted baseUrl to null', async () => {
      const { service, repo } = createDeps();
      repo.create.mockResolvedValue(profileRow());

      await service.adminCreate('admin-1', { name: 'A', provider: 'anthropic', model: 'claude-sonnet-4-5' });

      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: null }));
    });

    it('rejects a duplicate name with 409 PROFILE_NAME_TAKEN', async () => {
      const { service, repo } = createDeps();
      repo.findByName.mockResolvedValue(profileRow());

      const error = await service
        .adminCreate('admin-1', { name: 'Primary', provider: 'anthropic', model: 'claude-sonnet-4-5' })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({ code: 'PROFILE_NAME_TAKEN' });
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('converts a RACED duplicate insert into the same clean 409, not a 500', async () => {
      // Two admins saving the same name at once: both pass the findByName
      // check, the second insert hits the unique constraint.
      const { service, repo, audit } = createDeps();
      repo.create.mockRejectedValue(uniqueViolation());

      const error = await service
        .adminCreate('admin-1', { name: 'Primary', provider: 'anthropic', model: 'claude-sonnet-4-5' })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({ code: 'PROFILE_NAME_TAKEN' });
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('re-throws a non-unique driver error untouched', async () => {
      const { service, repo } = createDeps();
      repo.create.mockRejectedValue(Object.assign(new Error('deadlock'), { code: '40P01' }));

      await expect(
        service.adminCreate('admin-1', { name: 'X', provider: 'anthropic', model: 'm' }),
      ).rejects.toThrow('deadlock');
    });
  });

  describe('adminUpdate', () => {
    it('is a no-op (no write, no audit) when the DTO carries no defined fields', async () => {
      const { service, repo, audit } = createDeps();
      repo.findById.mockResolvedValue(profileRow());

      const result = await service.adminUpdate('admin-1', 'profile-1', {});

      expect(repo.update).not.toHaveBeenCalled();
      expect(audit.write).not.toHaveBeenCalled();
      expect(result.id).toBe('profile-1');
    });

    it('writes before/after into the audit metadata', async () => {
      const { service, repo, audit } = createDeps();
      repo.findById.mockResolvedValue(profileRow({ model: 'gpt-4o-mini', priority: 100 }));
      repo.update.mockResolvedValue(profileRow({ model: 'gpt-4o', priority: 10 }));

      await service.adminUpdate('admin-1', 'profile-1', { model: 'gpt-4o', priority: 10 });

      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'update',
          entityType: 'agent_profile',
          metadata: { before: { model: 'gpt-4o-mini', priority: 100 }, after: { model: 'gpt-4o', priority: 10 } },
        }),
      );
    });

    it('allows renaming to the profile’s OWN current name without a 409', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(profileRow({ name: 'Primary' }));
      repo.update.mockResolvedValue(profileRow({ name: 'Primary' }));

      await service.adminUpdate('admin-1', 'profile-1', { name: 'Primary' });

      // Unchanged name — no uniqueness lookup at all.
      expect(repo.findByName).not.toHaveBeenCalled();
      expect(repo.update).toHaveBeenCalled();
    });

    it('rejects renaming onto another profile’s name', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(profileRow({ id: 'profile-1', name: 'Primary' }));
      repo.findByName.mockResolvedValue(profileRow({ id: 'profile-2', name: 'Fallback' }));

      const error = await service.adminUpdate('admin-1', 'profile-1', { name: 'Fallback' }).catch((e: unknown) => e);

      expect((error as ConflictException).getResponse()).toMatchObject({ code: 'PROFILE_NAME_TAKEN' });
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('converts a raced duplicate update into a 409', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(profileRow({ name: 'Primary' }));
      repo.update.mockRejectedValue(uniqueViolation());

      const error = await service.adminUpdate('admin-1', 'profile-1', { name: 'Renamed' }).catch((e: unknown) => e);

      expect((error as ConflictException).getResponse()).toMatchObject({ code: 'PROFILE_NAME_TAKEN' });
    });

    it('404s for an unknown id', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(null);

      await expect(service.adminUpdate('admin-1', 'missing', { model: 'x' })).rejects.toBeInstanceOf(NotFoundException);
    });

    it('can clear baseUrl back to null with an explicit null', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(profileRow({ baseUrl: 'https://example.test/v1' }));
      repo.update.mockResolvedValue(profileRow({ baseUrl: null }));

      await service.adminUpdate('admin-1', 'profile-1', { baseUrl: null });

      expect(repo.update).toHaveBeenCalledWith('profile-1', { baseUrl: null });
    });
  });

  describe('adminDelete', () => {
    it('deletes a profile with no credentials and audits it', async () => {
      const { service, repo, audit } = createDeps();
      repo.findById.mockResolvedValue(profileRow());

      await service.adminDelete('admin-1', 'profile-1');

      expect(repo.deleteById).toHaveBeenCalledWith('profile-1');
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'delete', entityType: 'agent_profile', entityId: 'profile-1' }),
      );
    });

    it('REFUSES (409) to delete a profile that still has credentials — it does NOT cascade', async () => {
      // The deliberate safety choice: cascading would destroy irrecoverable
      // third-party keys behind one click, and leave one audit row instead of
      // one per key.
      const { service, repo, credentialRepo, audit } = createDeps();
      repo.findById.mockResolvedValue(profileRow());
      (credentialRepo.countByProfile as jest.Mock).mockResolvedValue(3);

      const error = await service.adminDelete('admin-1', 'profile-1').catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: 'PROFILE_HAS_CREDENTIALS',
        credentialCount: 3,
      });
      expect(repo.deleteById).not.toHaveBeenCalled();
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('404s for an unknown id', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(null);

      await expect(service.adminDelete('admin-1', 'missing')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
