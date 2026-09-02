import { NotFoundException } from '@nestjs/common';
import type { AuditService } from '../../shared/audit/audit.service';
import type { IdentityFacade } from '../identity/identity.facade';
import { PatientRepository } from './patient.repository';
import { PatientService } from './patient.service';

function basePatient(overrides: Record<string, unknown> = {}) {
  return {
    id: 'patient-1',
    status: 'pending',
    mobileNumber: '+919876543210',
    fullName: null,
    dateOfBirth: null,
    gender: 'undisclosed',
    preferredLanguage: 'en',
    tokenVersion: 0,
    pushToken: null,
    deviceId: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function createDeps() {
  const repo = {
    findById: jest.fn(),
    findAll: jest.fn(),
    updateProfile: jest.fn(),
    updateStatus: jest.fn(),
  } as unknown as jest.Mocked<PatientRepository>;

  const identity = {
    revokeAllSessions: jest.fn().mockResolvedValue(undefined),
    getEffectivePermissions: jest.fn(),
    hasPermission: jest.fn(),
    getContactIdentity: jest.fn(),
  } as unknown as jest.Mocked<IdentityFacade>;

  const audit = { write: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<AuditService>;

  const service = new PatientService(repo, identity, audit);
  return { service, repo, identity, audit };
}

describe('PatientService', () => {
  describe('getOwnProfile', () => {
    it('returns the profile without tokenVersion', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(basePatient({ status: 'active', fullName: 'Jane', tokenVersion: 7 }) as never);

      const result = await service.getOwnProfile('patient-1');

      expect(result).not.toHaveProperty('tokenVersion');
      expect(result.fullName).toBe('Jane');
    });

    it('404s when the patient does not exist', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(null);

      await expect(service.getOwnProfile('missing')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('updateOwnProfile — partial update', () => {
    it('applies only the fields present in the dto', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(basePatient({ status: 'active', fullName: 'Jane', dateOfBirth: '1990-01-01' }) as never);
      repo.updateProfile.mockResolvedValue(
        basePatient({ status: 'active', fullName: 'Jane', dateOfBirth: '1990-01-01', preferredLanguage: 'hi' }) as never,
      );

      await service.updateOwnProfile('patient-1', { preferredLanguage: 'hi' });

      expect(repo.updateProfile).toHaveBeenCalledWith('patient-1', { preferredLanguage: 'hi' });
    });

    it('404s when the patient does not exist', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(null);

      await expect(service.updateOwnProfile('missing', { fullName: 'Jane' })).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.updateProfile).not.toHaveBeenCalled();
    });
  });

  describe('updateOwnProfile — pending -> active profile completion', () => {
    it('flips status to active and audits when fullName and dateOfBirth are both present after the update', async () => {
      const { service, repo, audit } = createDeps();
      repo.findById.mockResolvedValue(basePatient({ status: 'pending', fullName: null, dateOfBirth: '1990-01-01' }) as never);
      repo.updateProfile.mockResolvedValue(
        basePatient({ status: 'active', fullName: 'Jane', dateOfBirth: '1990-01-01' }) as never,
      );

      await service.updateOwnProfile('patient-1', { fullName: 'Jane' });

      expect(repo.updateProfile).toHaveBeenCalledWith('patient-1', { fullName: 'Jane', status: 'active' });
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'update',
          entityType: 'patient',
          entityId: 'patient-1',
          metadata: expect.objectContaining({ from: 'pending', to: 'active' }),
        }),
      );
    });

    it('does NOT flip status when only fullName is set and dateOfBirth is still missing', async () => {
      const { service, repo, audit } = createDeps();
      repo.findById.mockResolvedValue(basePatient({ status: 'pending', fullName: null, dateOfBirth: null }) as never);
      repo.updateProfile.mockResolvedValue(basePatient({ status: 'pending', fullName: 'Jane', dateOfBirth: null }) as never);

      await service.updateOwnProfile('patient-1', { fullName: 'Jane' });

      expect(repo.updateProfile).toHaveBeenCalledWith('patient-1', { fullName: 'Jane' });
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('does NOT flip status when only dateOfBirth is set and fullName is still missing', async () => {
      const { service, repo, audit } = createDeps();
      repo.findById.mockResolvedValue(basePatient({ status: 'pending', fullName: null, dateOfBirth: null }) as never);
      repo.updateProfile.mockResolvedValue(basePatient({ status: 'pending', fullName: null, dateOfBirth: '1990-01-01' }) as never);

      await service.updateOwnProfile('patient-1', { dateOfBirth: '1990-01-01' });

      expect(repo.updateProfile).toHaveBeenCalledWith('patient-1', { dateOfBirth: '1990-01-01' });
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('does NOT flip status (or audit) when the account is already active', async () => {
      const { service, repo, audit } = createDeps();
      repo.findById.mockResolvedValue(basePatient({ status: 'active', fullName: 'Jane', dateOfBirth: '1990-01-01' }) as never);
      repo.updateProfile.mockResolvedValue(
        basePatient({ status: 'active', fullName: 'Jane Doe', dateOfBirth: '1990-01-01' }) as never,
      );

      await service.updateOwnProfile('patient-1', { fullName: 'Jane Doe' });

      expect(repo.updateProfile).toHaveBeenCalledWith('patient-1', { fullName: 'Jane Doe' });
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('does NOT flip status when fullName is set to an empty/whitespace string', async () => {
      const { service, repo, audit } = createDeps();
      repo.findById.mockResolvedValue(basePatient({ status: 'pending', fullName: null, dateOfBirth: '1990-01-01' }) as never);
      repo.updateProfile.mockResolvedValue(basePatient({ status: 'pending', fullName: '   ', dateOfBirth: '1990-01-01' }) as never);

      await service.updateOwnProfile('patient-1', { fullName: '   ' });

      expect(repo.updateProfile).toHaveBeenCalledWith('patient-1', { fullName: '   ' });
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('completes the profile using the EXISTING fullName when only dateOfBirth is submitted this call', async () => {
      // Regression coverage for the `nextFullName = existing.fullName` fallback branch:
      // a prior call already set a real fullName but dateOfBirth was still missing, so
      // the account is still 'pending'. This call supplies only dateOfBirth.
      const { service, repo, audit } = createDeps();
      repo.findById.mockResolvedValue(basePatient({ status: 'pending', fullName: 'Jane', dateOfBirth: null }) as never);
      repo.updateProfile.mockResolvedValue(basePatient({ status: 'active', fullName: 'Jane', dateOfBirth: '1990-01-01' }) as never);

      await service.updateOwnProfile('patient-1', { dateOfBirth: '1990-01-01' });

      expect(repo.updateProfile).toHaveBeenCalledWith('patient-1', { dateOfBirth: '1990-01-01', status: 'active' });
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: expect.objectContaining({ from: 'pending', to: 'active' }) }),
      );
    });

    it('does NOT complete the profile from an existing WHITESPACE-ONLY fullName, even once dateOfBirth is supplied', async () => {
      const { service, repo, audit } = createDeps();
      repo.findById.mockResolvedValue(basePatient({ status: 'pending', fullName: '   ', dateOfBirth: null }) as never);
      repo.updateProfile.mockResolvedValue(basePatient({ status: 'pending', fullName: '   ', dateOfBirth: '1990-01-01' }) as never);

      await service.updateOwnProfile('patient-1', { dateOfBirth: '1990-01-01' });

      expect(repo.updateProfile).toHaveBeenCalledWith('patient-1', { dateOfBirth: '1990-01-01' });
      expect(audit.write).not.toHaveBeenCalled();
    });
  });

  describe('admin: listForAdmin / getForAdmin', () => {
    it('lists patients without tokenVersion', async () => {
      const { service, repo } = createDeps();
      repo.findAll.mockResolvedValue([basePatient({ tokenVersion: 3 }) as never]);

      const result = await service.listForAdmin();

      expect(result).toHaveLength(1);
      expect(result[0]).not.toHaveProperty('tokenVersion');
    });

    it('404s getForAdmin when the patient does not exist', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(null);

      await expect(service.getForAdmin('missing')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('admin: updateStatus session revocation', () => {
    it('revokes all sessions when suspending', async () => {
      const { service, repo, identity } = createDeps();
      repo.findById.mockResolvedValue(basePatient({ status: 'active' }) as never);
      repo.updateStatus.mockResolvedValue(basePatient({ status: 'suspended' }) as never);

      await service.updateStatus('admin-1', 'patient-1', 'suspended');

      expect(identity.revokeAllSessions).toHaveBeenCalledWith('patient', 'patient-1');
    });

    it('revokes all sessions when deleting', async () => {
      const { service, repo, identity } = createDeps();
      repo.findById.mockResolvedValue(basePatient({ status: 'active' }) as never);
      repo.updateStatus.mockResolvedValue(basePatient({ status: 'deleted' }) as never);

      await service.updateStatus('admin-1', 'patient-1', 'deleted');

      expect(identity.revokeAllSessions).toHaveBeenCalledWith('patient', 'patient-1');
    });

    it('does NOT revoke sessions when reactivating to active', async () => {
      const { service, repo, identity } = createDeps();
      repo.findById.mockResolvedValue(basePatient({ status: 'suspended' }) as never);
      repo.updateStatus.mockResolvedValue(basePatient({ status: 'active' }) as never);

      await service.updateStatus('admin-1', 'patient-1', 'active');

      expect(identity.revokeAllSessions).not.toHaveBeenCalled();
    });

    it('does NOT revoke sessions (or write the audit entry) when the patient does not exist', async () => {
      const { service, repo, identity, audit } = createDeps();
      repo.findById.mockResolvedValue(null);

      await expect(service.updateStatus('admin-1', 'missing', 'suspended')).rejects.toBeInstanceOf(NotFoundException);
      expect(identity.revokeAllSessions).not.toHaveBeenCalled();
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('audits the status change with before/after and the acting admin', async () => {
      const { service, repo, audit } = createDeps();
      repo.findById.mockResolvedValue(basePatient({ status: 'active' }) as never);
      repo.updateStatus.mockResolvedValue(basePatient({ status: 'suspended' }) as never);

      await service.updateStatus('admin-1', 'patient-1', 'suspended');

      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({
          actorType: 'admin',
          actorId: 'admin-1',
          action: 'update',
          entityType: 'patient',
          entityId: 'patient-1',
          metadata: { from: 'active', to: 'suspended' },
        }),
      );
    });
  });
});
