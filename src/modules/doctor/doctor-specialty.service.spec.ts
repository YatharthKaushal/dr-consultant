import { NotFoundException } from '@nestjs/common';
import type { Database } from '../../config/db/database.config';
import type { DoctorRow } from '../../schema/doctors.schema';
import type { AuditService } from '../../shared/audit/audit.service';
import type { CatalogueFacade } from '../catalogue/catalogue.facade';
import type { PublicSpecialty } from '../catalogue/catalogue.contract';
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

function baseSpecialty(overrides: Partial<PublicSpecialty> = {}): PublicSpecialty {
  return {
    id: 'specialty-1',
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

function createDeps() {
  const db = createDb();
  const doctorRepo = { findById: jest.fn() } as unknown as jest.Mocked<DoctorRepository>;
  const repo = {
    findByDoctorAndSpecialty: jest.fn(),
    listByDoctor: jest.fn(),
    clearPrimary: jest.fn().mockResolvedValue(undefined),
    insert: jest.fn(),
    setPrimaryFlag: jest.fn(),
    remove: jest.fn(),
    findPrimaryByDoctor: jest.fn(),
  } as unknown as jest.Mocked<DoctorSpecialtyRepository>;
  const audit = { write: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<AuditService>;
  const catalogue = { getSpecialtyById: jest.fn() } as unknown as jest.Mocked<CatalogueFacade>;

  const service = new DoctorSpecialtyService(db, doctorRepo, repo, audit, catalogue);
  return { service, db, doctorRepo, repo, audit, catalogue };
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
      const { service, doctorRepo, catalogue } = createDeps();
      doctorRepo.findById.mockResolvedValue(baseDoctor());
      catalogue.getSpecialtyById.mockResolvedValue(null);

      await expect(service.assign('admin-1', 'doctor-1', { specialtyId: 'missing' })).rejects.toBeInstanceOf(NotFoundException);
    });

    it('is idempotent — already assigned with the same isPrimary flag does not write or audit', async () => {
      const { service, doctorRepo, repo, audit, db, catalogue } = createDeps();
      doctorRepo.findById.mockResolvedValue(baseDoctor());
      catalogue.getSpecialtyById.mockResolvedValue(baseSpecialty());
      repo.findByDoctorAndSpecialty.mockResolvedValue({ id: 'ds-1', doctorId: 'doctor-1', specialtyId: 'specialty-1', isPrimary: false, createdAt: new Date() });

      await service.assign('admin-1', 'doctor-1', { specialtyId: 'specialty-1', isPrimary: false });

      expect(db.transaction).not.toHaveBeenCalled();
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('runs the unset-old-primary-then-set-new-primary sequence when assigning a new primary specialty', async () => {
      const { service, doctorRepo, repo, audit, catalogue } = createDeps();
      doctorRepo.findById.mockResolvedValue(baseDoctor());
      catalogue.getSpecialtyById.mockResolvedValue(baseSpecialty());
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
      const { service, doctorRepo, repo, catalogue } = createDeps();
      doctorRepo.findById.mockResolvedValue(baseDoctor());
      catalogue.getSpecialtyById.mockResolvedValue(baseSpecialty());
      repo.findByDoctorAndSpecialty.mockResolvedValue({ id: 'ds-1', doctorId: 'doctor-1', specialtyId: 'specialty-1', isPrimary: false, createdAt: new Date() });
      repo.setPrimaryFlag.mockResolvedValue({ id: 'ds-1', doctorId: 'doctor-1', specialtyId: 'specialty-1', isPrimary: true, createdAt: new Date() });

      await service.assign('admin-1', 'doctor-1', { specialtyId: 'specialty-1', isPrimary: true });

      expect(repo.clearPrimary).toHaveBeenCalled();
      expect(repo.setPrimaryFlag).toHaveBeenCalledWith('ds-1', true, expect.anything());
      expect(repo.insert).not.toHaveBeenCalled();
    });

    it('demotes an already-primary specialty to non-primary WITHOUT calling clearPrimary (nothing else needs unsetting)', async () => {
      const { service, doctorRepo, repo, catalogue } = createDeps();
      doctorRepo.findById.mockResolvedValue(baseDoctor());
      catalogue.getSpecialtyById.mockResolvedValue(baseSpecialty());
      repo.findByDoctorAndSpecialty.mockResolvedValue({ id: 'ds-1', doctorId: 'doctor-1', specialtyId: 'specialty-1', isPrimary: true, createdAt: new Date() });
      repo.setPrimaryFlag.mockResolvedValue({ id: 'ds-1', doctorId: 'doctor-1', specialtyId: 'specialty-1', isPrimary: false, createdAt: new Date() });

      await service.assign('admin-1', 'doctor-1', { specialtyId: 'specialty-1', isPrimary: false });

      expect(repo.clearPrimary).not.toHaveBeenCalled();
      expect(repo.setPrimaryFlag).toHaveBeenCalledWith('ds-1', false, expect.anything());
    });

    it('defaults isPrimary to false when the dto omits it', async () => {
      const { service, doctorRepo, repo, catalogue } = createDeps();
      doctorRepo.findById.mockResolvedValue(baseDoctor());
      catalogue.getSpecialtyById.mockResolvedValue(baseSpecialty());
      repo.findByDoctorAndSpecialty.mockResolvedValue(null);
      repo.insert.mockResolvedValue({ id: 'ds-3', doctorId: 'doctor-1', specialtyId: 'specialty-1', isPrimary: false, createdAt: new Date() });

      await service.assign('admin-1', 'doctor-1', { specialtyId: 'specialty-1' });

      expect(repo.insert).toHaveBeenCalledWith('doctor-1', 'specialty-1', false, expect.anything());
      expect(repo.clearPrimary).not.toHaveBeenCalled();
    });

    it('throws DOCTOR_SPECIALTY_NOT_FOUND (not DOCTOR_NOT_FOUND) if insert unexpectedly returns no row (race)', async () => {
      const { service, doctorRepo, repo, catalogue } = createDeps();
      doctorRepo.findById.mockResolvedValue(baseDoctor());
      catalogue.getSpecialtyById.mockResolvedValue(baseSpecialty());
      repo.findByDoctorAndSpecialty.mockResolvedValue(null);
      repo.insert.mockResolvedValue(null as never);

      await expect(service.assign('admin-1', 'doctor-1', { specialtyId: 'specialty-1' })).rejects.toMatchObject({
        status: 404,
        response: { code: 'DOCTOR_SPECIALTY_NOT_FOUND' },
      });
    });

    it('throws DOCTOR_SPECIALTY_NOT_FOUND (not DOCTOR_NOT_FOUND) if setPrimaryFlag unexpectedly returns null (race)', async () => {
      const { service, doctorRepo, repo, catalogue } = createDeps();
      doctorRepo.findById.mockResolvedValue(baseDoctor());
      catalogue.getSpecialtyById.mockResolvedValue(baseSpecialty());
      repo.findByDoctorAndSpecialty.mockResolvedValue({ id: 'ds-1', doctorId: 'doctor-1', specialtyId: 'specialty-1', isPrimary: false, createdAt: new Date() });
      repo.setPrimaryFlag.mockResolvedValue(null);

      await expect(service.assign('admin-1', 'doctor-1', { specialtyId: 'specialty-1', isPrimary: true })).rejects.toMatchObject({
        status: 404,
        response: { code: 'DOCTOR_SPECIALTY_NOT_FOUND' },
      });
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
    it('returns the primary specialty canPrescribe value, resolved via CatalogueFacade', async () => {
      const { service, repo, catalogue } = createDeps();
      repo.findPrimaryByDoctor.mockResolvedValue({
        id: 'ds-1',
        doctorId: 'doctor-1',
        specialtyId: 'specialty-1',
        isPrimary: true,
        createdAt: new Date(),
      });
      catalogue.getSpecialtyById.mockResolvedValue(baseSpecialty({ canPrescribe: true }));

      await expect(service.getPrescribingEligibility('doctor-1')).resolves.toBe(true);
      expect(catalogue.getSpecialtyById).toHaveBeenCalledWith('specialty-1');
    });

    it('returns false when the doctor has no primary specialty, without calling the catalogue', async () => {
      const { service, repo, catalogue } = createDeps();
      repo.findPrimaryByDoctor.mockResolvedValue(null);

      await expect(service.getPrescribingEligibility('doctor-1')).resolves.toBe(false);
      expect(catalogue.getSpecialtyById).not.toHaveBeenCalled();
    });

    it('returns false when the primary specialty row references a specialty the catalogue no longer has', async () => {
      const { service, repo, catalogue } = createDeps();
      repo.findPrimaryByDoctor.mockResolvedValue({
        id: 'ds-1',
        doctorId: 'doctor-1',
        specialtyId: 'specialty-1',
        isPrimary: true,
        createdAt: new Date(),
      });
      catalogue.getSpecialtyById.mockResolvedValue(null);

      await expect(service.getPrescribingEligibility('doctor-1')).resolves.toBe(false);
    });
  });
});
