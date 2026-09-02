import { ConflictException, NotFoundException } from '@nestjs/common';
import type { DoctorRow } from '../../schema/doctors.schema';
import type { AuditService } from '../../shared/audit/audit.service';
import type { AuthContext } from '../../shared/auth/auth.types';
import { DoctorDocumentRepository } from './doctor-document.repository';
import { DoctorSpecialtyRepository } from './doctor-specialty.repository';
import { DoctorRepository } from './doctor.repository';
import { DoctorService } from './doctor.service';

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
    consultationFeeInr: '0.00',
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
    findByMobile: jest.fn(),
    findByRegistrationNumber: jest.fn(),
    list: jest.fn(),
    create: jest.fn(),
    updateProfileFields: jest.fn(),
    updateOwnProfile: jest.fn(),
  } as unknown as jest.Mocked<DoctorRepository>;

  const specialtyRepo = {
    listByDoctor: jest.fn().mockResolvedValue([]),
  } as unknown as jest.Mocked<DoctorSpecialtyRepository>;

  const documentRepo = {
    listByDoctor: jest.fn().mockResolvedValue([]),
  } as unknown as jest.Mocked<DoctorDocumentRepository>;

  const audit = { write: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<AuditService>;

  const service = new DoctorService(repo, specialtyRepo, documentRepo, audit);
  return { service, repo, specialtyRepo, documentRepo, audit };
}

describe('DoctorService', () => {
  describe('updateOwnProfile — self-editable fields only', () => {
    it('writes only `bio` when only bio is provided', async () => {
      const { service, repo } = createDeps();
      repo.updateOwnProfile.mockResolvedValue(baseDoctor({ bio: 'hello' }));

      await service.updateOwnProfile('doctor-1', { bio: 'hello' });

      expect(repo.updateOwnProfile).toHaveBeenCalledWith('doctor-1', { bio: 'hello' });
    });

    it('writes only `languages` when only languages is provided', async () => {
      const { service, repo } = createDeps();
      repo.updateOwnProfile.mockResolvedValue(baseDoctor({ languages: ['en'] }));

      await service.updateOwnProfile('doctor-1', { languages: ['en'] });

      expect(repo.updateOwnProfile).toHaveBeenCalledWith('doctor-1', { languages: ['en'] });
    });

    it('never calls the repository update (and never touches any other field) for an empty patch', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(baseDoctor());

      const result = await service.updateOwnProfile('doctor-1', {});

      expect(repo.updateOwnProfile).not.toHaveBeenCalled();
      expect(result.fullName).toBe('Dr. Test');
    });

    it('404s when the doctor does not exist', async () => {
      const { service, repo } = createDeps();
      repo.updateOwnProfile.mockResolvedValue(null);

      await expect(service.updateOwnProfile('missing', { bio: 'x' })).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('getListedProfileForCaller — the listing visibility gate', () => {
    it('404s a patient caller for a doctor that is not verified+listed (never leaks existence via 403)', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(baseDoctor({ verificationStatus: 'pending', isListed: false }));
      const auth: AuthContext = { accountType: 'patient', accountId: 'patient-1' };

      await expect(service.getListedProfileForCaller('doctor-1', auth)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404s a doctor caller for another doctor that is verified but not listed', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(baseDoctor({ verificationStatus: 'verified', isListed: false }));
      const auth: AuthContext = { accountType: 'doctor', accountId: 'doctor-2' };

      await expect(service.getListedProfileForCaller('doctor-1', auth)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns the profile to a patient caller when verified and listed', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(baseDoctor({ verificationStatus: 'verified', isListed: true }));
      const auth: AuthContext = { accountType: 'patient', accountId: 'patient-1' };

      const result = await service.getListedProfileForCaller('doctor-1', auth);

      expect(result.id).toBe('doctor-1');
    });

    it('returns the profile to an admin caller regardless of verification/listing status', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(baseDoctor({ verificationStatus: 'pending', isListed: false }));
      const auth: AuthContext = { accountType: 'admin', accountId: 'admin-1' };

      const result = await service.getListedProfileForCaller('doctor-1', auth);

      expect(result.id).toBe('doctor-1');
    });
  });

  describe('adminCreate', () => {
    it('rejects a duplicate mobile number and never inserts', async () => {
      const { service, repo } = createDeps();
      repo.findByMobile.mockResolvedValue(baseDoctor());

      await expect(service.adminCreate('admin-1', { mobileNumber: '+919876543210', fullName: 'X' })).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(repo.create).not.toHaveBeenCalled();
    });
  });

  describe('adminUpdateProfileFields', () => {
    it('skips the repository update and the audit write for an empty patch', async () => {
      const { service, repo, audit } = createDeps();
      repo.findById.mockResolvedValue(baseDoctor());

      await service.adminUpdateProfileFields('admin-1', 'doctor-1', {});

      expect(repo.updateProfileFields).not.toHaveBeenCalled();
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('rejects a registration number already used by a different doctor', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(baseDoctor({ registrationNumber: 'OLD-1' }));
      repo.findByRegistrationNumber.mockResolvedValue(baseDoctor({ id: 'other-doctor', registrationNumber: 'NEW-1' }));

      await expect(
        service.adminUpdateProfileFields('admin-1', 'doctor-1', { registrationNumber: 'NEW-1' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(repo.updateProfileFields).not.toHaveBeenCalled();
    });

    it('audits an actual field change', async () => {
      const { service, repo, audit } = createDeps();
      repo.findById.mockResolvedValue(baseDoctor());
      repo.updateProfileFields.mockResolvedValue(baseDoctor({ fullName: 'New Name' }));

      await service.adminUpdateProfileFields('admin-1', 'doctor-1', { fullName: 'New Name' });

      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'update', entityType: 'doctor', entityId: 'doctor-1' }),
      );
    });
  });
});
