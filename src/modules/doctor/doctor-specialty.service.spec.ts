import { NotFoundException } from '@nestjs/common';
import type { Database } from '../../config/db/database.config';
import type { DoctorRow } from '../../schema/doctors.schema';
import type { SpecialtyRow } from '../../schema/specialties.schema';
import type { AuditService } from '../../shared/audit/audit.service';
import { DoctorSpecialtyRepository } from './doctor-specialty.repository';
import { DoctorSpecialtyService } from './doctor-specialty.service';
import { DoctorRepository } from './doctor.repository';

function createDb(): Database {
  return {
    transaction: jest.fn(async (fn: (tx: Database) => Promise<unknown>) => fn({} as Database)),
  } as unknown as Database;
}

function baseDoctor(): DoctorRow {
  return { id: 'doctor-1' } as DoctorRow;
}

function baseSpecialty(overrides: Partial<SpecialtyRow> = {}): SpecialtyRow {
  return { id: 'specialty-1', code: 'psychiatry', name: 'Psychiatry', canPrescribe: true, ...overrides } as SpecialtyRow;
}

function createDeps() {
  const db = createDb();
  const doctorRepo = { findById: jest.fn() } as unknown as jest.Mocked<DoctorRepository>;
  const repo = {
    findSpecialtyById: jest.fn(),
    findByDoctorAndSpecialty: jest.fn(),
    listByDoctor: jest.fn(),
    clearPrimary: jest.fn().mockResolvedValue(undefined),
    insert: jest.fn(),
    setPrimaryFlag: jest.fn(),
    remove: jest.fn(),
    findPrimaryByDoctor: jest.fn(),
  } as unknown as jest.Mocked<DoctorSpecialtyRepository>;
  const audit = { write: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<AuditService>;

  const service = new DoctorSpecialtyService(db, doctorRepo, repo, audit);
  return { service, db, doctorRepo, repo, audit };
}

describe('DoctorSpecialtyService', () => {
  describe('assign', () => {
    it('404s when the doctor does not exist', async () => {
      const { service, doctorRepo } = createDeps();
      doctorRepo.findById.mockResolvedValue(null);

      await expect(service.assign('admin-1', 'doctor-1', { specialtyId: 'specialty-1' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('404s when the specialty does not exist', async () => {
      const { service, doctorRepo, repo } = createDeps();
      doctorRepo.findById.mockResolvedValue(baseDoctor());
      repo.findSpecialtyById.mockResolvedValue(null);

      await expect(service.assign('admin-1', 'doctor-1', { specialtyId: 'missing' })).rejects.toBeInstanceOf(NotFoundException);
    });

    it('is idempotent — already assigned with the same isPrimary flag does not write or audit', async () => {
      const { service, doctorRepo, repo, audit, db } = createDeps();
      doctorRepo.findById.mockResolvedValue(baseDoctor());
      repo.findSpecialtyById.mockResolvedValue(baseSpecialty());
      repo.findByDoctorAndSpecialty.mockResolvedValue({ id: 'ds-1', doctorId: 'doctor-1', specialtyId: 'specialty-1', isPrimary: false, createdAt: new Date() });

      await service.assign('admin-1', 'doctor-1', { specialtyId: 'specialty-1', isPrimary: false });

      expect(db.transaction).not.toHaveBeenCalled();
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('runs the unset-old-primary-then-set-new-primary sequence when assigning a new primary specialty', async () => {
      const { service, doctorRepo, repo, audit } = createDeps();
      doctorRepo.findById.mockResolvedValue(baseDoctor());
      repo.findSpecialtyById.mockResolvedValue(baseSpecialty());
      repo.findByDoctorAndSpecialty.mockResolvedValue(null);
      repo.insert.mockResolvedValue({ id: 'ds-2', doctorId: 'doctor-1', specialtyId: 'specialty-1', isPrimary: true, createdAt: new Date() });

      await service.assign('admin-1', 'doctor-1', { specialtyId: 'specialty-1', isPrimary: true });

      expect(repo.clearPrimary).toHaveBeenCalledWith('doctor-1', expect.anything());
      expect(repo.insert).toHaveBeenCalledWith('doctor-1', 'specialty-1', true, expect.anything());
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'create', entityType: 'doctor_specialty', entityId: 'doctor-1' }),
        expect.anything(),
      );
    });

    it('promotes an already-assigned (non-primary) specialty to primary via setPrimaryFlag, not insert', async () => {
      const { service, doctorRepo, repo } = createDeps();
      doctorRepo.findById.mockResolvedValue(baseDoctor());
      repo.findSpecialtyById.mockResolvedValue(baseSpecialty());
      repo.findByDoctorAndSpecialty.mockResolvedValue({ id: 'ds-1', doctorId: 'doctor-1', specialtyId: 'specialty-1', isPrimary: false, createdAt: new Date() });
      repo.setPrimaryFlag.mockResolvedValue({ id: 'ds-1', doctorId: 'doctor-1', specialtyId: 'specialty-1', isPrimary: true, createdAt: new Date() });

      await service.assign('admin-1', 'doctor-1', { specialtyId: 'specialty-1', isPrimary: true });

      expect(repo.clearPrimary).toHaveBeenCalled();
      expect(repo.setPrimaryFlag).toHaveBeenCalledWith('ds-1', true, expect.anything());
      expect(repo.insert).not.toHaveBeenCalled();
    });

    it('demotes an already-primary specialty to non-primary WITHOUT calling clearPrimary (nothing else needs unsetting)', async () => {
      const { service, doctorRepo, repo } = createDeps();
      doctorRepo.findById.mockResolvedValue(baseDoctor());
      repo.findSpecialtyById.mockResolvedValue(baseSpecialty());
      repo.findByDoctorAndSpecialty.mockResolvedValue({ id: 'ds-1', doctorId: 'doctor-1', specialtyId: 'specialty-1', isPrimary: true, createdAt: new Date() });
      repo.setPrimaryFlag.mockResolvedValue({ id: 'ds-1', doctorId: 'doctor-1', specialtyId: 'specialty-1', isPrimary: false, createdAt: new Date() });

      await service.assign('admin-1', 'doctor-1', { specialtyId: 'specialty-1', isPrimary: false });

      expect(repo.clearPrimary).not.toHaveBeenCalled();
      expect(repo.setPrimaryFlag).toHaveBeenCalledWith('ds-1', false, expect.anything());
    });

    it('defaults isPrimary to false when the dto omits it', async () => {
      const { service, doctorRepo, repo } = createDeps();
      doctorRepo.findById.mockResolvedValue(baseDoctor());
      repo.findSpecialtyById.mockResolvedValue(baseSpecialty());
      repo.findByDoctorAndSpecialty.mockResolvedValue(null);
      repo.insert.mockResolvedValue({ id: 'ds-3', doctorId: 'doctor-1', specialtyId: 'specialty-1', isPrimary: false, createdAt: new Date() });

      await service.assign('admin-1', 'doctor-1', { specialtyId: 'specialty-1' });

      expect(repo.insert).toHaveBeenCalledWith('doctor-1', 'specialty-1', false, expect.anything());
      expect(repo.clearPrimary).not.toHaveBeenCalled();
    });

    it('throws doctorNotFound if insert unexpectedly returns no row (race)', async () => {
      const { service, doctorRepo, repo } = createDeps();
      doctorRepo.findById.mockResolvedValue(baseDoctor());
      repo.findSpecialtyById.mockResolvedValue(baseSpecialty());
      repo.findByDoctorAndSpecialty.mockResolvedValue(null);
      repo.insert.mockResolvedValue(null as never);

      await expect(service.assign('admin-1', 'doctor-1', { specialtyId: 'specialty-1' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('throws doctorNotFound if setPrimaryFlag unexpectedly returns null (race)', async () => {
      const { service, doctorRepo, repo } = createDeps();
      doctorRepo.findById.mockResolvedValue(baseDoctor());
      repo.findSpecialtyById.mockResolvedValue(baseSpecialty());
      repo.findByDoctorAndSpecialty.mockResolvedValue({ id: 'ds-1', doctorId: 'doctor-1', specialtyId: 'specialty-1', isPrimary: false, createdAt: new Date() });
      repo.setPrimaryFlag.mockResolvedValue(null);

      await expect(service.assign('admin-1', 'doctor-1', { specialtyId: 'specialty-1', isPrimary: true })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('remove', () => {
    it('404s when the doctor does not exist', async () => {
      const { service, doctorRepo, repo } = createDeps();
      doctorRepo.findById.mockResolvedValue(null);

      await expect(service.remove('admin-1', 'missing', 'specialty-1')).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.remove).not.toHaveBeenCalled();
    });

    it('does not audit a remove that was already a no-op (specialty not assigned)', async () => {
      const { service, doctorRepo, repo, audit } = createDeps();
      doctorRepo.findById.mockResolvedValue(baseDoctor());
      repo.remove.mockResolvedValue(false);

      await service.remove('admin-1', 'doctor-1', 'specialty-1');

      expect(audit.write).not.toHaveBeenCalled();
    });

    it('audits an actual removal', async () => {
      const { service, doctorRepo, repo, audit } = createDeps();
      doctorRepo.findById.mockResolvedValue(baseDoctor());
      repo.remove.mockResolvedValue(true);

      await service.remove('admin-1', 'doctor-1', 'specialty-1');

      expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ action: 'delete', entityType: 'doctor_specialty' }));
    });
  });

  describe('getPrescribingEligibility', () => {
    it('returns the primary specialty canPrescribe value', async () => {
      const { service, repo } = createDeps();
      repo.findPrimaryByDoctor.mockResolvedValue({ specialtyId: 'specialty-1', canPrescribe: true });

      await expect(service.getPrescribingEligibility('doctor-1')).resolves.toBe(true);
    });

    it('returns false when the doctor has no primary specialty', async () => {
      const { service, repo } = createDeps();
      repo.findPrimaryByDoctor.mockResolvedValue(null);

      await expect(service.getPrescribingEligibility('doctor-1')).resolves.toBe(false);
    });
  });
});
