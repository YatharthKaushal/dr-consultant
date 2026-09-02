import { ConflictException, NotFoundException } from '@nestjs/common';
import type { SpecialtyRow } from '../../schema/specialties.schema';
import type { AuditService } from '../../shared/audit/audit.service';
import type { AuthContext } from '../../shared/auth/auth.types';
import { SpecialtyRepository } from './specialty.repository';
import { SpecialtyService } from './specialty.service';

const NOW = new Date('2026-01-01T00:00:00.000Z');

function baseSpecialty(overrides: Partial<SpecialtyRow> = {}): SpecialtyRow {
  return {
    id: 'specialty-1',
    code: 'psychiatry',
    name: 'Psychiatry',
    description: null,
    canPrescribe: true,
    intakeForm: null,
    firstConsultForm: null,
    prescriptionTemplate: null,
    adviceTemplate: null,
    requiredDocuments: [],
    isActive: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as SpecialtyRow;
}

function createDeps() {
  const repo = {
    findById: jest.fn(),
    findByCode: jest.fn(),
    list: jest.fn(),
    listActive: jest.fn(),
    create: jest.fn(),
    updateGeneralFields: jest.fn(),
    updateTemplates: jest.fn(),
  } as unknown as jest.Mocked<SpecialtyRepository>;

  const audit = { write: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<AuditService>;

  const service = new SpecialtyService(repo, audit);
  return { service, repo, audit };
}

function auth(accountType: AuthContext['accountType']): AuthContext {
  return { accountType, accountId: 'caller-1' };
}

describe('SpecialtyService', () => {
  describe('adminCreate', () => {
    it('rejects a duplicate code (409)', async () => {
      const { service, repo } = createDeps();
      repo.findByCode.mockResolvedValue(baseSpecialty());

      await expect(
        service.adminCreate('admin-1', { code: 'psychiatry', name: 'Psychiatry', canPrescribe: true }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('creates and audits when the code is free', async () => {
      const { service, repo, audit } = createDeps();
      repo.findByCode.mockResolvedValue(null);
      repo.create.mockResolvedValue(baseSpecialty());

      await service.adminCreate('admin-1', { code: 'psychiatry', name: 'Psychiatry', canPrescribe: true });

      expect(repo.create).toHaveBeenCalled();
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'create', entityType: 'specialty', entityId: 'specialty-1' }),
      );
    });
  });

  describe('adminUpdate — canPrescribe/prescriptionTemplate rule', () => {
    it('rejects flipping canPrescribe to false while prescriptionTemplate is still set (409)', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(baseSpecialty({ canPrescribe: true, prescriptionTemplate: [{ name: 'Sertraline' }] }));

      await expect(service.adminUpdate('admin-1', 'specialty-1', { canPrescribe: false })).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(repo.updateGeneralFields).not.toHaveBeenCalled();
    });

    it('allows flipping canPrescribe to false when prescriptionTemplate is already null', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(baseSpecialty({ canPrescribe: true, prescriptionTemplate: null }));
      repo.updateGeneralFields.mockResolvedValue(baseSpecialty({ canPrescribe: false }));

      await service.adminUpdate('admin-1', 'specialty-1', { canPrescribe: false });

      expect(repo.updateGeneralFields).toHaveBeenCalledWith('specialty-1', { canPrescribe: false });
    });

    it('is a no-op (no update, no audit) when the DTO carries no defined fields', async () => {
      const { service, repo, audit } = createDeps();
      repo.findById.mockResolvedValue(baseSpecialty());

      await service.adminUpdate('admin-1', 'specialty-1', {});

      expect(repo.updateGeneralFields).not.toHaveBeenCalled();
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('404s when the specialty does not exist', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(null);

      await expect(service.adminUpdate('admin-1', 'missing', { name: 'X' })).rejects.toBeInstanceOf(NotFoundException);
    });

    it('audits before/after for changed fields', async () => {
      const { service, repo, audit } = createDeps();
      repo.findById.mockResolvedValue(baseSpecialty({ name: 'Old Name' }));
      repo.updateGeneralFields.mockResolvedValue(baseSpecialty({ name: 'New Name' }));

      await service.adminUpdate('admin-1', 'specialty-1', { name: 'New Name' });

      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'update',
          entityType: 'specialty',
          metadata: { before: { name: 'Old Name' }, after: { name: 'New Name' } },
        }),
      );
    });
  });

  describe('adminUpdateTemplates — canPrescribe/prescriptionTemplate rule', () => {
    it('rejects setting a non-null prescriptionTemplate when canPrescribe is currently false (409)', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(baseSpecialty({ canPrescribe: false, prescriptionTemplate: null }));

      await expect(
        service.adminUpdateTemplates('admin-1', 'specialty-1', { prescriptionTemplate: [{ name: 'Sertraline' }] }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(repo.updateTemplates).not.toHaveBeenCalled();
    });

    it('reads the specialty fresh — rejects even if a stale caller thinks canPrescribe was true', async () => {
      const { service, repo } = createDeps();
      // Current DB state has canPrescribe false regardless of what the caller assumes.
      repo.findById.mockResolvedValue(baseSpecialty({ canPrescribe: false }));

      await expect(
        service.adminUpdateTemplates('admin-1', 'specialty-1', { prescriptionTemplate: [{ name: 'X' }] }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('allows setting prescriptionTemplate to null (clearing) even when canPrescribe is false', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(baseSpecialty({ canPrescribe: false, prescriptionTemplate: null }));
      repo.updateTemplates.mockResolvedValue(baseSpecialty({ canPrescribe: false, prescriptionTemplate: null }));

      await service.adminUpdateTemplates('admin-1', 'specialty-1', { prescriptionTemplate: null });

      expect(repo.updateTemplates).toHaveBeenCalledWith('specialty-1', { prescriptionTemplate: null });
    });

    it('allows setting prescriptionTemplate when canPrescribe is true', async () => {
      const { service, repo, audit } = createDeps();
      const template = [{ name: 'Sertraline', dose: '50mg' }];
      repo.findById.mockResolvedValue(baseSpecialty({ canPrescribe: true, prescriptionTemplate: null }));
      repo.updateTemplates.mockResolvedValue(baseSpecialty({ canPrescribe: true, prescriptionTemplate: template }));

      await service.adminUpdateTemplates('admin-1', 'specialty-1', { prescriptionTemplate: template });

      expect(repo.updateTemplates).toHaveBeenCalledWith('specialty-1', { prescriptionTemplate: template });
      expect(audit.write).toHaveBeenCalled();
    });

    it('is a no-op when the DTO carries no defined fields', async () => {
      const { service, repo, audit } = createDeps();
      repo.findById.mockResolvedValue(baseSpecialty());

      await service.adminUpdateTemplates('admin-1', 'specialty-1', {});

      expect(repo.updateTemplates).not.toHaveBeenCalled();
      expect(audit.write).not.toHaveBeenCalled();
    });
  });

  describe('getByIdForCaller — visibility rule', () => {
    it('404s (not throwing a 403-shaped error) for a patient when the specialty is inactive', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(baseSpecialty({ isActive: false }));

      const error = await service.getByIdForCaller('specialty-1', auth('patient')).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NotFoundException);
    });

    it('404s for a doctor when the specialty is inactive', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(baseSpecialty({ isActive: false }));

      await expect(service.getByIdForCaller('specialty-1', auth('doctor'))).rejects.toBeInstanceOf(NotFoundException);
    });

    it('is visible to an admin even when inactive', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(baseSpecialty({ isActive: false }));

      const result = await service.getByIdForCaller('specialty-1', auth('admin'));
      expect(result.id).toBe('specialty-1');
    });

    it('is visible to a patient when active', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(baseSpecialty({ isActive: true }));

      const result = await service.getByIdForCaller('specialty-1', auth('patient'));
      expect(result.id).toBe('specialty-1');
    });

    it('404s when the specialty does not exist at all', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(null);

      await expect(service.getByIdForCaller('missing', auth('patient'))).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('listActive / getPublicById — public projection', () => {
    it('strips prescriptionTemplate/adviceTemplate from the public shape', async () => {
      const { service, repo } = createDeps();
      repo.listActive.mockResolvedValue([baseSpecialty({ prescriptionTemplate: [{ name: 'X' }], adviceTemplate: { covered: 'y' } })]);

      const [result] = await service.listActive();

      expect(result).not.toHaveProperty('prescriptionTemplate');
      expect(result).not.toHaveProperty('adviceTemplate');
    });

    it('getPublicById is not gated on isActive (used by the facade for point-of-use reads)', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(baseSpecialty({ isActive: false }));

      const result = await service.getPublicById('specialty-1');
      expect(result?.id).toBe('specialty-1');
    });

    it('getPublicById returns null when the specialty does not exist', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(null);

      await expect(service.getPublicById('missing')).resolves.toBeNull();
    });
  });
});
