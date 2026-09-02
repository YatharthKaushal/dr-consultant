import { ConflictException, NotFoundException } from '@nestjs/common';
import type { ConcernRow } from '../../schema/concerns.schema';
import type { SpecialtyRow } from '../../schema/specialties.schema';
import type { AuditService } from '../../shared/audit/audit.service';
import { ConcernRepository } from './concern.repository';
import { ConcernService } from './concern.service';
import { SpecialtyService } from './specialty.service';

function baseConcern(overrides: Partial<ConcernRow> = {}): ConcernRow {
  return {
    id: 'concern-1',
    specialtyId: 'specialty-1',
    code: 'anxiety',
    name: 'Anxiety',
    matchPhrases: [],
    matchWeight: 1,
    isActive: true,
    ...overrides,
  } as ConcernRow;
}

function baseSpecialty(overrides: Partial<SpecialtyRow> = {}): SpecialtyRow {
  return { id: 'specialty-1', code: 'psychiatry', name: 'Psychiatry', canPrescribe: true, ...overrides } as SpecialtyRow;
}

function createDeps() {
  const repo = {
    findById: jest.fn(),
    findBySpecialtyAndCode: jest.fn(),
    list: jest.fn(),
    listActive: jest.fn(),
    create: jest.fn(),
    updateGeneralFields: jest.fn(),
    updateMapping: jest.fn(),
  } as unknown as jest.Mocked<ConcernRepository>;

  const specialtyService = { findRawById: jest.fn() } as unknown as jest.Mocked<SpecialtyService>;
  const audit = { write: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<AuditService>;

  const service = new ConcernService(repo, specialtyService, audit);
  return { service, repo, specialtyService, audit };
}

describe('ConcernService', () => {
  describe('adminCreate', () => {
    it('404s when the specialty does not exist', async () => {
      const { service, specialtyService } = createDeps();
      specialtyService.findRawById.mockResolvedValue(null);

      await expect(
        service.adminCreate('admin-1', { specialtyId: 'missing', code: 'anxiety', name: 'Anxiety' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects a duplicate (specialtyId, code) pair (409)', async () => {
      const { service, specialtyService, repo } = createDeps();
      specialtyService.findRawById.mockResolvedValue(baseSpecialty());
      repo.findBySpecialtyAndCode.mockResolvedValue(baseConcern());

      await expect(
        service.adminCreate('admin-1', { specialtyId: 'specialty-1', code: 'anxiety', name: 'Anxiety' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('creates and audits when the specialty exists and the code is free', async () => {
      const { service, specialtyService, repo, audit } = createDeps();
      specialtyService.findRawById.mockResolvedValue(baseSpecialty());
      repo.findBySpecialtyAndCode.mockResolvedValue(null);
      repo.create.mockResolvedValue(baseConcern());

      await service.adminCreate('admin-1', { specialtyId: 'specialty-1', code: 'anxiety', name: 'Anxiety' });

      expect(repo.create).toHaveBeenCalled();
      expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ action: 'create', entityType: 'concern' }));
    });

    it('converts a concurrent unique-violation on insert (the check-then-insert race) into the same 409 CONCERN_CODE_TAKEN', async () => {
      const { service, specialtyService, repo, audit } = createDeps();
      specialtyService.findRawById.mockResolvedValue(baseSpecialty());
      repo.findBySpecialtyAndCode.mockResolvedValue(null); // sequential check passes...
      repo.create.mockRejectedValue({ code: '23505', message: 'duplicate key value violates unique constraint' }); // ...but a concurrent insert beat this one to it

      await expect(
        service.adminCreate('admin-1', { specialtyId: 'specialty-1', code: 'anxiety', name: 'Anxiety' }),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: 'CONCERN_CODE_TAKEN' },
      });
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('rethrows an unrelated insert error unchanged (not a unique violation)', async () => {
      const { service, specialtyService, repo } = createDeps();
      specialtyService.findRawById.mockResolvedValue(baseSpecialty());
      repo.findBySpecialtyAndCode.mockResolvedValue(null);
      const dbError = new Error('connection reset');
      repo.create.mockRejectedValue(dbError);

      await expect(
        service.adminCreate('admin-1', { specialtyId: 'specialty-1', code: 'anxiety', name: 'Anxiety' }),
      ).rejects.toBe(dbError);
    });
  });

  describe('adminUpdate — general fields', () => {
    it('404s when the concern does not exist', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(null);

      await expect(service.adminUpdate('admin-1', 'missing', { name: 'X' })).rejects.toBeInstanceOf(NotFoundException);
    });

    it('is a no-op (no update, no audit) when the DTO carries no defined fields', async () => {
      const { service, repo, audit } = createDeps();
      repo.findById.mockResolvedValue(baseConcern());

      await service.adminUpdate('admin-1', 'concern-1', {});

      expect(repo.updateGeneralFields).not.toHaveBeenCalled();
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('validates the new specialty exists when reassigning specialtyId (404 if not)', async () => {
      const { service, repo, specialtyService } = createDeps();
      repo.findById.mockResolvedValue(baseConcern({ specialtyId: 'specialty-1' }));
      specialtyService.findRawById.mockResolvedValue(null);

      await expect(service.adminUpdate('admin-1', 'concern-1', { specialtyId: 'specialty-2' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(repo.updateGeneralFields).not.toHaveBeenCalled();
    });

    it('rejects reassignment when the target specialty already has a concern with this code (409)', async () => {
      const { service, repo, specialtyService } = createDeps();
      repo.findById.mockResolvedValue(baseConcern({ id: 'concern-1', specialtyId: 'specialty-1', code: 'anxiety' }));
      specialtyService.findRawById.mockResolvedValue(baseSpecialty({ id: 'specialty-2' }));
      repo.findBySpecialtyAndCode.mockResolvedValue(baseConcern({ id: 'concern-2', specialtyId: 'specialty-2', code: 'anxiety' }));

      await expect(service.adminUpdate('admin-1', 'concern-1', { specialtyId: 'specialty-2' })).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('reassigns successfully and audits before/after when the target specialty has no clash', async () => {
      const { service, repo, specialtyService, audit } = createDeps();
      repo.findById.mockResolvedValue(baseConcern({ id: 'concern-1', specialtyId: 'specialty-1', code: 'anxiety' }));
      specialtyService.findRawById.mockResolvedValue(baseSpecialty({ id: 'specialty-2' }));
      repo.findBySpecialtyAndCode.mockResolvedValue(null);
      repo.updateGeneralFields.mockResolvedValue(baseConcern({ specialtyId: 'specialty-2' }));

      await service.adminUpdate('admin-1', 'concern-1', { specialtyId: 'specialty-2' });

      expect(repo.updateGeneralFields).toHaveBeenCalledWith('concern-1', { specialtyId: 'specialty-2' });
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'update',
          entityType: 'concern',
          metadata: { before: { specialtyId: 'specialty-1' }, after: { specialtyId: 'specialty-2' } },
        }),
      );
    });

    it('converts a concurrent unique-violation on the reassignment update (the check-then-update race) into the same 409 CONCERN_CODE_TAKEN', async () => {
      const { service, repo, specialtyService, audit } = createDeps();
      repo.findById.mockResolvedValue(baseConcern({ id: 'concern-1', specialtyId: 'specialty-1', code: 'anxiety' }));
      specialtyService.findRawById.mockResolvedValue(baseSpecialty({ id: 'specialty-2' }));
      repo.findBySpecialtyAndCode.mockResolvedValue(null); // sequential check passes...
      repo.updateGeneralFields.mockRejectedValue({ code: '23505', message: 'duplicate key value violates unique constraint' }); // ...but a concurrent write beat this one to it

      await expect(service.adminUpdate('admin-1', 'concern-1', { specialtyId: 'specialty-2' })).rejects.toMatchObject({
        status: 409,
        response: { code: 'CONCERN_CODE_TAKEN' },
      });
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('rethrows an unrelated update error unchanged (not a unique violation)', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(baseConcern());
      const dbError = new Error('connection reset');
      repo.updateGeneralFields.mockRejectedValue(dbError);

      await expect(service.adminUpdate('admin-1', 'concern-1', { name: 'New Name' })).rejects.toBe(dbError);
    });

    it('does not accept matchPhrases/matchWeight — field isolation from the mapping endpoint', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(baseConcern());
      repo.updateGeneralFields.mockResolvedValue(baseConcern({ name: 'New Name' }));

      // UpdateConcernDto (TS type) has no matchPhrases/matchWeight fields at all —
      // even if a caller (bypassing the type system, as a raw JS object would)
      // smuggled them in, adminUpdate must never forward them to the repo.
      await service.adminUpdate('admin-1', 'concern-1', { name: 'New Name', matchPhrases: ['smuggled'] } as never);

      expect(repo.updateGeneralFields).toHaveBeenCalledWith('concern-1', { name: 'New Name' });
    });
  });

  describe('adminUpdateMapping — matchPhrases/matchWeight only', () => {
    it('404s when the concern does not exist', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(null);

      await expect(service.adminUpdateMapping('admin-1', 'missing', { matchWeight: 5 })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('is a no-op when the DTO carries no defined fields', async () => {
      const { service, repo, audit } = createDeps();
      repo.findById.mockResolvedValue(baseConcern());

      await service.adminUpdateMapping('admin-1', 'concern-1', {});

      expect(repo.updateMapping).not.toHaveBeenCalled();
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('updates matchPhrases/matchWeight and audits before/after', async () => {
      const { service, repo, audit } = createDeps();
      repo.findById.mockResolvedValue(baseConcern({ matchPhrases: ['worried'], matchWeight: 1 }));
      repo.updateMapping.mockResolvedValue(baseConcern({ matchPhrases: ['worried', 'anxious'], matchWeight: 3 }));

      await service.adminUpdateMapping('admin-1', 'concern-1', { matchPhrases: ['worried', 'anxious'], matchWeight: 3 });

      expect(repo.updateMapping).toHaveBeenCalledWith('concern-1', { matchPhrases: ['worried', 'anxious'], matchWeight: 3 });
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: {
            before: { matchPhrases: ['worried'], matchWeight: 1 },
            after: { matchPhrases: ['worried', 'anxious'], matchWeight: 3 },
          },
        }),
      );
    });

    it('does not accept name/isActive/specialtyId — field isolation from the general edit endpoint', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(baseConcern());
      repo.updateMapping.mockResolvedValue(baseConcern({ matchWeight: 9 }));

      await service.adminUpdateMapping('admin-1', 'concern-1', { matchWeight: 9, name: 'smuggled' } as never);

      expect(repo.updateMapping).toHaveBeenCalledWith('concern-1', { matchWeight: 9 });
    });
  });

  describe('listActive / getPublicById', () => {
    it('getPublicById is not gated on isActive (used by the facade for point-of-use reads)', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(baseConcern({ isActive: false }));

      const result = await service.getPublicById('concern-1');
      expect(result?.id).toBe('concern-1');
    });

    it('getPublicById returns null when the concern does not exist', async () => {
      const { service, repo } = createDeps();
      repo.findById.mockResolvedValue(null);

      await expect(service.getPublicById('missing')).resolves.toBeNull();
    });
  });
});
