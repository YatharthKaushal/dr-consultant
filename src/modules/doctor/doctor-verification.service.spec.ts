import { ConflictException, NotFoundException } from '@nestjs/common';
import type { DoctorRow } from '../../schema/doctors.schema';
import type { AuditService } from '../../shared/audit/audit.service';
import type { IdentityFacade } from '../identity/identity.facade';
import { DoctorVerificationService } from './doctor-verification.service';
import { DoctorRepository } from './doctor.repository';

const NOW = new Date('2026-01-01T00:00:00.000Z');

function baseDoctor(overrides: Partial<DoctorRow> = {}): DoctorRow {
  return {
    id: 'doctor-1',
    mobileNumber: '+919876543210',
    mobileVerifiedAt: null,
    tokenVersion: 0,
    pushToken: null,
    deviceId: null,
    fullName: 'Dr. Test',
    bio: null,
    languages: [],
    verificationStatus: 'pending',
    registrationNumber: null,
    qualification: null,
    yearsOfExperience: null,
    verifiedByAdminId: null,
    verifiedAt: null,
    seniorityLevel: 'standard',
    consultationFeeInr: '500.00',
    consultationDurationMinutes: 30,
    bufferMinutes: 5,
    isListed: false,
    allowInstantConsult: false,
    presence: 'offline',
    blockedByConsultationId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as DoctorRow;
}

function createDeps() {
  const repo = {
    findById: jest.fn(),
    updateVerification: jest.fn(),
    updateListing: jest.fn(),
    updateFee: jest.fn(),
    updateSeniority: jest.fn(),
  } as unknown as jest.Mocked<DoctorRepository>;

  const audit = { write: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<AuditService>;
  const identity = { revokeAllSessions: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<IdentityFacade>;

  const service = new DoctorVerificationService(repo, audit, identity);
  return { service, repo, audit, identity };
}

describe('DoctorVerificationService', () => {
  describe('404 handling — doctor does not exist', () => {
    it('setVerificationStatus 404s when the doctor does not exist', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(null);

      await expect(service.setVerificationStatus('admin-1', 'missing', { status: 'verified' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('setListing 404s when the doctor does not exist', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(null);

      await expect(service.setListing('admin-1', 'missing', { isListed: true })).rejects.toBeInstanceOf(NotFoundException);
    });

    it('setFee 404s when the doctor does not exist', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(null);

      await expect(service.setFee('admin-1', 'missing', { consultationFeeInr: 500 })).rejects.toBeInstanceOf(NotFoundException);
    });

    it('setExpertRole 404s when the doctor does not exist', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(null);

      await expect(service.setExpertRole('admin-1', 'missing', { seniorityLevel: 'expert' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('404 handling — repository update races (row disappears after the existence check)', () => {
    it('setVerificationStatus 404s when updateVerification returns null', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(baseDoctor({ verificationStatus: 'pending' }));
      repo.updateVerification.mockResolvedValue(null);

      await expect(service.setVerificationStatus('admin-1', 'doctor-1', { status: 'verified' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('setListing 404s when updateListing returns null', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(baseDoctor({ verificationStatus: 'verified', isListed: false }));
      repo.updateListing.mockResolvedValue(null);

      await expect(service.setListing('admin-1', 'doctor-1', { isListed: true })).rejects.toBeInstanceOf(NotFoundException);
    });

    it('setFee 404s when updateFee returns null', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(baseDoctor({ consultationFeeInr: '500.00' }));
      repo.updateFee.mockResolvedValue(null);

      await expect(service.setFee('admin-1', 'doctor-1', { consultationFeeInr: 750 })).rejects.toBeInstanceOf(NotFoundException);
    });

    it('setExpertRole 404s when updateSeniority returns null', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(baseDoctor({ seniorityLevel: 'standard' }));
      repo.updateSeniority.mockResolvedValue(null);

      await expect(service.setExpertRole('admin-1', 'doctor-1', { seniorityLevel: 'expert' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('setVerificationStatus', () => {
    it('moving from `pending` to `under_review` does NOT force isListed, set verifiedByAdminId/verifiedAt, or revoke sessions', async () => {
      const { service, repo, identity } = createDeps();
      repo.findById.mockResolvedValue(baseDoctor({ verificationStatus: 'pending', isListed: false }));
      repo.updateVerification.mockResolvedValue(baseDoctor({ verificationStatus: 'under_review' }));

      await service.setVerificationStatus('admin-1', 'doctor-1', { status: 'under_review' });

      const [, update] = repo.updateVerification.mock.calls[0]!;
      expect(update).toEqual({ verificationStatus: 'under_review' });
      expect(identity.revokeAllSessions).not.toHaveBeenCalled();
    });

    it('is a no-op (no update, no session revocation, no audit) when the status is unchanged', async () => {
      const { service, repo, audit, identity } = createDeps();
      repo.findById.mockResolvedValue(baseDoctor({ verificationStatus: 'verified' }));

      await service.setVerificationStatus('admin-1', 'doctor-1', { status: 'verified' });

      expect(repo.updateVerification).not.toHaveBeenCalled();
      expect(identity.revokeAllSessions).not.toHaveBeenCalled();
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('moving to `verified` sets verifiedByAdminId/verifiedAt and does not revoke sessions', async () => {
      const { service, repo, identity } = createDeps();
      repo.findById.mockResolvedValue(baseDoctor({ verificationStatus: 'under_review' }));
      repo.updateVerification.mockResolvedValue(baseDoctor({ verificationStatus: 'verified' }));

      await service.setVerificationStatus('admin-1', 'doctor-1', { status: 'verified' });

      expect(repo.updateVerification).toHaveBeenCalledWith(
        'doctor-1',
        expect.objectContaining({ verificationStatus: 'verified', verifiedByAdminId: 'admin-1' }),
      );
      expect(identity.revokeAllSessions).not.toHaveBeenCalled();
    });

    it('moving to `rejected` forces isListed false, sets verifiedByAdminId/verifiedAt, and revokes sessions', async () => {
      const { service, repo, identity, audit } = createDeps();
      repo.findById.mockResolvedValue(baseDoctor({ verificationStatus: 'under_review', isListed: true }));
      repo.updateVerification.mockResolvedValue(baseDoctor({ verificationStatus: 'rejected', isListed: false }));

      await service.setVerificationStatus('admin-1', 'doctor-1', { status: 'rejected' });

      expect(repo.updateVerification).toHaveBeenCalledWith(
        'doctor-1',
        expect.objectContaining({ verificationStatus: 'rejected', isListed: false, verifiedByAdminId: 'admin-1' }),
      );
      expect(identity.revokeAllSessions).toHaveBeenCalledWith('doctor', 'doctor-1', { actorType: 'admin', actorId: 'admin-1' });
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'verify',
          entityType: 'doctor',
          metadata: { before: { status: 'under_review' }, after: { status: 'rejected' } },
        }),
      );
    });

    it('moving to `suspended` forces isListed false and revokes sessions, but does NOT set verifiedByAdminId/verifiedAt', async () => {
      const { service, repo, identity } = createDeps();
      repo.findById.mockResolvedValue(baseDoctor({ verificationStatus: 'verified', isListed: true }));
      repo.updateVerification.mockResolvedValue(baseDoctor({ verificationStatus: 'suspended', isListed: false }));

      await service.setVerificationStatus('admin-1', 'doctor-1', { status: 'suspended' });

      const [, update] = repo.updateVerification.mock.calls[0]!;
      expect(update).toEqual({ verificationStatus: 'suspended', isListed: false });
      expect(identity.revokeAllSessions).toHaveBeenCalledWith('doctor', 'doctor-1', { actorType: 'admin', actorId: 'admin-1' });
    });
  });

  describe('setListing', () => {
    it('rejects setting isListed:true when the doctor is not verified', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(baseDoctor({ verificationStatus: 'pending', isListed: false }));

      await expect(service.setListing('admin-1', 'doctor-1', { isListed: true })).rejects.toBeInstanceOf(ConflictException);
      expect(repo.updateListing).not.toHaveBeenCalled();
    });

    it('allows setting isListed:true when the doctor is verified', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(baseDoctor({ verificationStatus: 'verified', isListed: false }));
      repo.updateListing.mockResolvedValue(baseDoctor({ verificationStatus: 'verified', isListed: true }));

      await service.setListing('admin-1', 'doctor-1', { isListed: true });

      expect(repo.updateListing).toHaveBeenCalledWith('doctor-1', { isListed: true, allowInstantConsult: false });
    });

    it('is a no-op (no update, no audit) when nothing actually changes', async () => {
      const { service, repo, audit } = createDeps();
      repo.findById.mockResolvedValue(baseDoctor({ verificationStatus: 'verified', isListed: true, allowInstantConsult: false }));

      await service.setListing('admin-1', 'doctor-1', { isListed: true });

      expect(repo.updateListing).not.toHaveBeenCalled();
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('changes only allowInstantConsult when isListed is omitted from the dto — isListed carries its EXISTING value forward, not a default', async () => {
      const { service, repo, audit } = createDeps();
      repo.findById.mockResolvedValue(baseDoctor({ verificationStatus: 'verified', isListed: true, allowInstantConsult: false }));
      repo.updateListing.mockResolvedValue(baseDoctor({ verificationStatus: 'verified', isListed: true, allowInstantConsult: true }));

      await service.setListing('admin-1', 'doctor-1', { allowInstantConsult: true });

      expect(repo.updateListing).toHaveBeenCalledWith('doctor-1', { isListed: true, allowInstantConsult: true });
      expect(audit.write).toHaveBeenCalled();
    });

    it('an empty dto (both fields omitted) is a no-op', async () => {
      const { service, repo, audit } = createDeps();
      repo.findById.mockResolvedValue(baseDoctor({ verificationStatus: 'verified', isListed: true, allowInstantConsult: false }));

      await service.setListing('admin-1', 'doctor-1', {});

      expect(repo.updateListing).not.toHaveBeenCalled();
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('allows explicitly setting isListed:false on a verified doctor without the verification-gate check firing', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(baseDoctor({ verificationStatus: 'verified', isListed: true }));
      repo.updateListing.mockResolvedValue(baseDoctor({ verificationStatus: 'verified', isListed: false }));

      await expect(service.setListing('admin-1', 'doctor-1', { isListed: false })).resolves.toBeDefined();
    });
  });

  describe('setFee', () => {
    it('is a no-op (no update, no audit) when the fee is unchanged', async () => {
      const { service, repo, audit } = createDeps();
      repo.findById.mockResolvedValue(baseDoctor({ consultationFeeInr: '500.00' }));

      await service.setFee('admin-1', 'doctor-1', { consultationFeeInr: 500 });

      expect(repo.updateFee).not.toHaveBeenCalled();
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('updates and audits when the fee changes', async () => {
      const { service, repo, audit } = createDeps();
      repo.findById.mockResolvedValue(baseDoctor({ consultationFeeInr: '500.00' }));
      repo.updateFee.mockResolvedValue(baseDoctor({ consultationFeeInr: '750.00' }));

      await service.setFee('admin-1', 'doctor-1', { consultationFeeInr: 750 });

      expect(repo.updateFee).toHaveBeenCalledWith('doctor-1', '750.00');
      expect(audit.write).toHaveBeenCalled();
    });
  });

  describe('setExpertRole', () => {
    it('audits FR-1.5 even when the seniority level is unchanged (deliberate exception to the no-op discipline)', async () => {
      const { service, repo, audit } = createDeps();
      repo.findById.mockResolvedValue(baseDoctor({ seniorityLevel: 'expert' }));
      repo.updateSeniority.mockResolvedValue(baseDoctor({ seniorityLevel: 'expert' }));

      await service.setExpertRole('admin-1', 'doctor-1', { seniorityLevel: 'expert' });

      expect(repo.updateSeniority).toHaveBeenCalledWith('doctor-1', 'expert');
      expect(audit.write).toHaveBeenCalled();
    });
  });
});
