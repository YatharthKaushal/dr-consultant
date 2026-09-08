import { ConflictException, NotFoundException } from '@nestjs/common';
import type { DoctorRow } from '../../schema/doctors.schema';
import type { AuditService } from '../../shared/audit/audit.service';
import type { AuthContext } from '../../shared/auth/auth.types';
import type { CatalogueFacade } from '../catalogue/catalogue.facade';
import type { PublicSpecialty } from '../catalogue/catalogue.contract';
import type { IdentityFacade } from '../identity/identity.facade';
import { DoctorDocumentRepository } from './doctor-document.repository';
import { DoctorSpecialtyRepository } from './doctor-specialty.repository';
import { DoctorRepository } from './doctor.repository';
import { DoctorService } from './doctor.service';

function baseCatalogueSpecialty(overrides: Partial<PublicSpecialty> = {}): PublicSpecialty {
  return {
    id: 'spec-1',
    code: 'psychiatry',
    name: 'Psychiatry',
    description: null,
    canPrescribe: true,
    intakeForm: null,
    firstConsultForm: null,
    requiredDocuments: [],
    isActive: true,
    ...overrides,
  };
}

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
    deletedAt: null,
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
    listForAdmin: jest.fn().mockResolvedValue([]),
    countForAdmin: jest.fn().mockResolvedValue(0),
    create: jest.fn(),
    updateProfileFields: jest.fn(),
    updateOwnProfile: jest.fn(),
    softDelete: jest.fn(),
    restore: jest.fn(),
  } as unknown as jest.Mocked<DoctorRepository>;

  const specialtyRepo = {
    listByDoctor: jest.fn().mockResolvedValue([]),
    listByDoctorIds: jest.fn().mockResolvedValue([]),
  } as unknown as jest.Mocked<DoctorSpecialtyRepository>;

  const documentRepo = {
    listByDoctor: jest.fn().mockResolvedValue([]),
  } as unknown as jest.Mocked<DoctorDocumentRepository>;

  const audit = { write: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<AuditService>;

  const catalogue = {
    getSpecialtyById: jest.fn().mockResolvedValue(baseCatalogueSpecialty()),
  } as unknown as jest.Mocked<CatalogueFacade>;

  const identity = {
    revokeAllSessions: jest.fn().mockResolvedValue(undefined),
    anonymizeMobileNumber: jest.fn().mockResolvedValue({ changed: true }),
  } as unknown as jest.Mocked<IdentityFacade>;

  const service = new DoctorService(repo, specialtyRepo, documentRepo, audit, catalogue, identity);
  return { service, repo, specialtyRepo, documentRepo, audit, catalogue, identity };
}

describe('DoctorService', () => {
  describe('getOwnProfile', () => {
    it('404s when the doctor does not exist', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(null);

      await expect(service.getOwnProfile('missing')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('assembles the profile with specialties and documents (stripping tokenVersion/storageKey)', async () => {
      const { service, repo, specialtyRepo, documentRepo, catalogue } = createDeps();
      repo.findById.mockResolvedValue(baseDoctor());
      specialtyRepo.listByDoctor.mockResolvedValue([
        { id: 'ds-1', doctorId: 'doctor-1', specialtyId: 'spec-1', isPrimary: true, createdAt: NOW },
      ]);
      catalogue.getSpecialtyById.mockResolvedValue(baseCatalogueSpecialty({ id: 'spec-1', code: 'psychiatry', name: 'Psychiatry' }));
      documentRepo.listByDoctor.mockResolvedValue([
        {
          id: 'doc-1',
          doctorId: 'doctor-1',
          documentType: 'registration_certificate',
          storageKey: 'secret/key.pdf',
          fileName: 'x.pdf',
          reviewStatus: 'pending',
          verifiedByAdminId: null,
          verifiedAt: null,
          rejectionReason: null,
          createdAt: NOW,
        } as never,
      ]);

      const result = await service.getOwnProfile('doctor-1');

      expect(result.specialties).toEqual([{ id: 'spec-1', code: 'psychiatry', name: 'Psychiatry', isPrimary: true }]);
      expect(result.documents[0]).not.toHaveProperty('storageKey');
      expect(result).not.toHaveProperty('tokenVersion');
    });

    it('throws when a doctor_specialties row references a specialty the catalogue no longer has (data integrity, should be unreachable)', async () => {
      const { service, repo, specialtyRepo, documentRepo, catalogue } = createDeps();
      repo.findById.mockResolvedValue(baseDoctor());
      specialtyRepo.listByDoctor.mockResolvedValue([
        { id: 'ds-1', doctorId: 'doctor-1', specialtyId: 'spec-missing', isPrimary: true, createdAt: NOW },
      ]);
      documentRepo.listByDoctor.mockResolvedValue([]);
      catalogue.getSpecialtyById.mockResolvedValue(null);

      await expect(service.getOwnProfile('doctor-1')).rejects.toThrow(/no longer exists/);
    });
  });

  describe('getPublicProfile (facade-backed read)', () => {
    it('returns null when the doctor does not exist', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(null);

      await expect(service.getPublicProfile('missing')).resolves.toBeNull();
    });

    it('returns the public profile shape when the doctor exists', async () => {
      const { service, repo, specialtyRepo } = createDeps();
      repo.findById.mockResolvedValue(baseDoctor({ fullName: 'Dr. Test' }));
      specialtyRepo.listByDoctor.mockResolvedValue([]);

      const result = await service.getPublicProfile('doctor-1');

      expect(result?.fullName).toBe('Dr. Test');
    });
  });

  describe('isVerifiedAndListed', () => {
    it('is false when the doctor does not exist', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(null);

      await expect(service.isVerifiedAndListed('missing')).resolves.toBe(false);
    });

    it('is false when verified but not listed', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(baseDoctor({ verificationStatus: 'verified', isListed: false }));

      await expect(service.isVerifiedAndListed('doctor-1')).resolves.toBe(false);
    });

    it('is false when listed but not verified', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(baseDoctor({ verificationStatus: 'pending', isListed: true }));

      await expect(service.isVerifiedAndListed('doctor-1')).resolves.toBe(false);
    });

    it('is true when both verified and listed', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(baseDoctor({ verificationStatus: 'verified', isListed: true }));

      await expect(service.isVerifiedAndListed('doctor-1')).resolves.toBe(true);
    });
  });

  /** ADDITIVE (M-17/case clarification) — see `doctor.contract.ts#DoctorContract.isExpertDoctor`. */
  describe('isExpertDoctor', () => {
    it('is false when the doctor does not exist', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(null);

      await expect(service.isExpertDoctor('missing')).resolves.toBe(false);
    });

    it('is false when verified but seniorityLevel is standard', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(baseDoctor({ verificationStatus: 'verified', seniorityLevel: 'standard' }));

      await expect(service.isExpertDoctor('doctor-1')).resolves.toBe(false);
    });

    it('is false when seniorityLevel is expert but not verified', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(baseDoctor({ verificationStatus: 'pending', seniorityLevel: 'expert' }));

      await expect(service.isExpertDoctor('doctor-1')).resolves.toBe(false);
    });

    it('does not require isListed — an expert reviewer need not be a bookable, publicly-listed doctor', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(
        baseDoctor({ verificationStatus: 'verified', seniorityLevel: 'expert', isListed: false }),
      );

      await expect(service.isExpertDoctor('doctor-1')).resolves.toBe(true);
    });

    it('is true when both verified and seniorityLevel is expert', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(baseDoctor({ verificationStatus: 'verified', seniorityLevel: 'expert' }));

      await expect(service.isExpertDoctor('doctor-1')).resolves.toBe(true);
    });
  });

  describe('admin: adminList / adminGetDetail / requireDoctor', () => {
    it('adminList strips the auth/device internals but KEEPS presence — the admin projection deliberately re-adds it', async () => {
      const { service, repo } = createDeps();
      repo.listForAdmin.mockResolvedValue([baseDoctor({ tokenVersion: 5, presence: 'available_now' })]);
      repo.countForAdmin.mockResolvedValue(1);

      const result = await service.adminList();
      const [row] = result.items;

      expect(row).not.toHaveProperty('tokenVersion');
      expect(row).not.toHaveProperty('pushToken');
      expect(row).not.toHaveProperty('deviceId');
      // presence is stripped from SafeDoctorRow but added back for admins:
      // "must not edit" is not "must not read". See doctor.mapper.ts.
      expect(row?.presence).toBe('available_now');
    });

    it('adminList returns a paginated envelope, and derives stage on every row', async () => {
      const { service, repo } = createDeps();
      repo.listForAdmin.mockResolvedValue([
        baseDoctor({ id: 'd1', verificationStatus: 'pending' }),
        baseDoctor({ id: 'd2', verificationStatus: 'verified', consultationFeeInr: '0', isListed: false }),
        baseDoctor({ id: 'd3', verificationStatus: 'verified', consultationFeeInr: '900.00', isListed: true }),
      ]);
      repo.countForAdmin.mockResolvedValue(42);

      const result = await service.adminList({ limit: 3, offset: 6 });

      expect(result.items.map((d) => d.stage)).toEqual(['awaiting_verification', 'needs_fee', 'live']);
      expect({ total: result.total, limit: result.limit, offset: result.offset }).toEqual({
        total: 42,
        limit: 3,
        offset: 6,
      });
    });

    it('adminList passes ONE identical filter to both the page query and the count query', async () => {
      const { service, repo } = createDeps();

      await service.adminList({ search: 'neha', stage: 'needs_fee', isListed: 'false' });

      // The page and the total must agree about what they are counting;
      // computing them from different predicates is how a table ends up
      // claiming 40 results and rendering 12.
      expect(repo.listForAdmin.mock.calls[0]?.[0]).toEqual(repo.countForAdmin.mock.calls[0]?.[0]);
    });

    it('adminList distinguishes "not filtered" from "filtered to false"', async () => {
      const { service, repo } = createDeps();

      await service.adminList({ isListed: 'false' });
      expect(repo.listForAdmin.mock.calls[0]?.[0]).toMatchObject({ isListed: false });

      repo.listForAdmin.mockClear();
      await service.adminList({});
      expect(repo.listForAdmin.mock.calls[0]?.[0].isListed).toBeUndefined();
    });

    it('adminList excludes soft-deleted doctors unless asked', async () => {
      const { service, repo } = createDeps();

      await service.adminList({});
      expect(repo.listForAdmin.mock.calls[0]?.[0]).toMatchObject({ includeDeleted: false });

      repo.listForAdmin.mockClear();
      await service.adminList({ includeDeleted: 'true' });
      expect(repo.listForAdmin.mock.calls[0]?.[0]).toMatchObject({ includeDeleted: true });
    });

    it('adminGetDetail 404s when the doctor does not exist', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(null);

      await expect(service.adminGetDetail('missing')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('adminGetDetail returns specialties and documents like getOwnProfile', async () => {
      const { service, repo, specialtyRepo, documentRepo } = createDeps();
      repo.findById.mockResolvedValue(baseDoctor());
      specialtyRepo.listByDoctor.mockResolvedValue([]);
      documentRepo.listByDoctor.mockResolvedValue([]);

      const result = await service.adminGetDetail('doctor-1');

      expect(result.specialties).toEqual([]);
      expect(result.documents).toEqual([]);
    });

    it('requireDoctor 404s when the doctor does not exist', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(null);

      await expect(service.requireDoctor('missing')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('requireDoctor returns the raw row when the doctor exists', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(baseDoctor({ tokenVersion: 9 }));

      const result = await service.requireDoctor('doctor-1');

      expect(result.tokenVersion).toBe(9);
    });
  });

  describe('adminCreate — success path', () => {
    it('creates the doctor and audits the creation', async () => {
      const { service, repo, audit } = createDeps();
      repo.findByMobile.mockResolvedValue(null);
      repo.create.mockResolvedValue(baseDoctor({ id: 'doctor-9', fullName: 'New Doc' }));

      const result = await service.adminCreate('admin-1', { mobileNumber: '+919876543210', fullName: 'New Doc' });

      expect(result.fullName).toBe('New Doc');
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'create', entityType: 'doctor', entityId: 'doctor-9' }),
      );
    });
  });

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

    it('404s on an empty patch too, when the doctor does not exist', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(null);

      await expect(service.updateOwnProfile('missing', {})).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.updateOwnProfile).not.toHaveBeenCalled();
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

    it('converts a concurrent unique-violation on insert (the check-then-insert race) into the same 409 MOBILE_NUMBER_TAKEN', async () => {
      const { service, repo, audit } = createDeps();
      repo.findByMobile.mockResolvedValue(null); // sequential check passes...
      repo.create.mockRejectedValue({ code: '23505', message: 'duplicate key value violates unique constraint' }); // ...but a concurrent insert beat this one to it

      await expect(service.adminCreate('admin-1', { mobileNumber: '+919876543210', fullName: 'X' })).rejects.toMatchObject({
        status: 409,
        response: { code: 'MOBILE_NUMBER_TAKEN' },
      });
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('rethrows an unrelated insert error unchanged (not a unique violation)', async () => {
      const { service, repo } = createDeps();
      repo.findByMobile.mockResolvedValue(null);
      const dbError = new Error('connection reset');
      repo.create.mockRejectedValue(dbError);

      await expect(service.adminCreate('admin-1', { mobileNumber: '+919876543210', fullName: 'X' })).rejects.toBe(dbError);
    });
  });

  describe('adminUpdateProfileFields', () => {
    it('404s when the doctor does not exist', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(null);

      await expect(
        service.adminUpdateProfileFields('admin-1', 'missing', { fullName: 'X' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

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

    it('allows re-submitting the SAME registration number the doctor already has (the clash check excludes self)', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(baseDoctor({ registrationNumber: 'REG-1' }));
      repo.updateProfileFields.mockResolvedValue(baseDoctor({ registrationNumber: 'REG-1' }));

      await service.adminUpdateProfileFields('admin-1', 'doctor-1', { registrationNumber: 'REG-1' });

      expect(repo.findByRegistrationNumber).not.toHaveBeenCalled();
      expect(repo.updateProfileFields).toHaveBeenCalled();
    });

    it('allows a registration number clash check to resolve to the SAME doctor id without conflict', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(baseDoctor({ id: 'doctor-1', registrationNumber: 'OLD-1' }));
      repo.findByRegistrationNumber.mockResolvedValue(baseDoctor({ id: 'doctor-1', registrationNumber: 'NEW-1' }));
      repo.updateProfileFields.mockResolvedValue(baseDoctor({ registrationNumber: 'NEW-1' }));

      await service.adminUpdateProfileFields('admin-1', 'doctor-1', { registrationNumber: 'NEW-1' });

      expect(repo.updateProfileFields).toHaveBeenCalled();
    });

    it('404s when the repository update returns null (doctor removed between the existence check and the write)', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(baseDoctor());
      repo.updateProfileFields.mockResolvedValue(null);

      await expect(
        service.adminUpdateProfileFields('admin-1', 'doctor-1', { fullName: 'New Name' }),
      ).rejects.toBeInstanceOf(NotFoundException);
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

    it('converts a concurrent unique-violation on update (the check-then-update race) into the same 409 REGISTRATION_NUMBER_TAKEN', async () => {
      const { service, repo, audit } = createDeps();
      repo.findById.mockResolvedValue(baseDoctor({ registrationNumber: 'OLD-1' }));
      repo.findByRegistrationNumber.mockResolvedValue(null); // sequential check passes...
      repo.updateProfileFields.mockRejectedValue({ code: '23505', message: 'duplicate key value violates unique constraint' }); // ...but a concurrent update beat this one to it

      await expect(
        service.adminUpdateProfileFields('admin-1', 'doctor-1', { registrationNumber: 'NEW-1' }),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: 'REGISTRATION_NUMBER_TAKEN' },
      });
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('rethrows an unrelated update error unchanged (not a unique violation)', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(baseDoctor());
      const dbError = new Error('connection reset');
      repo.updateProfileFields.mockRejectedValue(dbError);

      await expect(service.adminUpdateProfileFields('admin-1', 'doctor-1', { fullName: 'New Name' })).rejects.toBe(dbError);
    });
  });

  describe('softDeleteForDeletionRequest / restoreFromDeletion (account-deletion lifecycle round)', () => {
    it('soft-deletes, revokes sessions, vacates the mobile number, audits, and returns the pre-mutation snapshot', async () => {
      const { service, repo, identity, audit } = createDeps();
      const existing = baseDoctor({ mobileNumber: '+919876543210', fullName: 'Dr. Test' });
      repo.findById.mockResolvedValue(existing);
      repo.softDelete.mockResolvedValue(baseDoctor({ deletedAt: NOW }));

      const result = await service.softDeleteForDeletionRequest('doctor-1', { actorType: 'admin', actorId: 'admin-1' });

      expect(result.softDeleted).toBe(true);
      expect(result.originalMobileNumber).toBe('+919876543210');
      expect(result.snapshot).toMatchObject({ id: 'doctor-1', fullName: 'Dr. Test' });
      expect(identity.revokeAllSessions).toHaveBeenCalledWith('doctor', 'doctor-1', { actorType: 'admin', actorId: 'admin-1' });
      expect(identity.anonymizeMobileNumber).toHaveBeenCalledWith('doctor', 'doctor-1');
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({ actorType: 'admin', actorId: 'admin-1', action: 'delete', entityType: 'doctor', entityId: 'doctor-1' }),
      );
    });

    it('attributes the sweep correctly — actorType system, actorId null', async () => {
      const { service, repo, identity } = createDeps();
      repo.findById.mockResolvedValue(baseDoctor());
      repo.softDelete.mockResolvedValue(baseDoctor({ deletedAt: NOW }));

      await service.softDeleteForDeletionRequest('doctor-1', { actorType: 'system', actorId: null });

      expect(identity.revokeAllSessions).toHaveBeenCalledWith('doctor', 'doctor-1', { actorType: 'system', actorId: 'doctor-1' });
    });

    it('is idempotent — already-deleted returns softDeleted:false without touching identity', async () => {
      const { service, repo, identity } = createDeps();
      repo.findById.mockResolvedValue(baseDoctor({ deletedAt: NOW }));

      const result = await service.softDeleteForDeletionRequest('doctor-1', { actorType: 'admin', actorId: 'admin-1' });

      expect(result).toEqual({ softDeleted: false, snapshot: null, originalMobileNumber: null });
      expect(identity.anonymizeMobileNumber).not.toHaveBeenCalled();
    });

    it('404s when the doctor does not exist', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(null);
      await expect(service.softDeleteForDeletionRequest('missing', { actorType: 'admin', actorId: 'admin-1' })).rejects.toBeInstanceOf(NotFoundException);
    });

    it('restoreFromDeletion delegates the caller-supplied verificationStatus straight to the repository', async () => {
      const { service, repo } = createDeps();
      repo.restore.mockResolvedValue(baseDoctor({ verificationStatus: 'verified' }));

      const result = await service.restoreFromDeletion('doctor-1', 'verified');

      expect(repo.restore).toHaveBeenCalledWith('doctor-1', 'verified');
      expect(result).toEqual({ restored: true });
    });

    it('restoreFromDeletion reports false when the repository guard refuses (not actually deleted)', async () => {
      const { service, repo } = createDeps();
      repo.restore.mockResolvedValue(null);
      expect(await service.restoreFromDeletion('doctor-1', 'pending')).toEqual({ restored: false });
    });
  });
});
