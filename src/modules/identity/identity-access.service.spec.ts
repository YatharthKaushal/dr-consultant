import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Database } from '../../config/db/database.config';
import type { AuditService } from '../../shared/audit/audit.service';
import { IdentityAccessRepository } from './identity-access.repository';
import { IdentityAccessService } from './identity-access.service';
import { IdentityRepository } from './identity.repository';

function createDb(): Database {
  return {
    transaction: jest.fn(async (fn: (tx: Database) => Promise<unknown>) => fn({} as Database)),
  } as unknown as Database;
}

function createDeps() {
  const db = createDb();
  const accessRepo = {
    findRoleById: jest.fn(),
    findPermissionById: jest.fn(),
    holdsRoleCode: jest.fn().mockResolvedValue(false),
    countSuperAdminHolders: jest.fn().mockResolvedValue(1),
    assignRole: jest.fn(),
    revokeRole: jest.fn(),
    grantPermission: jest.fn(),
    revokePermissionGrant: jest.fn(),
    getAdminRoles: jest.fn().mockResolvedValue([]),
    getAdminPermissionGrants: jest.fn().mockResolvedValue([]),
    listRoles: jest.fn(),
    listPermissions: jest.fn(),
  } as unknown as jest.Mocked<IdentityAccessRepository>;
  const identityRepo = {
    findAdminById: jest.fn(),
    findAdminByMobile: jest.fn(),
    createAdmin: jest.fn(),
    updateAdmin: jest.fn(),
    bumpTokenVersion: jest.fn(),
    listAdmins: jest.fn(),
  } as unknown as jest.Mocked<IdentityRepository>;
  const audit = { write: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;

  const service = new IdentityAccessService(db, accessRepo, identityRepo, audit);
  return { service, db, accessRepo, identityRepo, audit };
}

describe('IdentityAccessService', () => {
  describe('self-modification guardrail', () => {
    it('blocks an admin from touching their own roles or grants', async () => {
      const { service } = createDeps();

      await expect(service.assignRole('admin-1', 'admin-1', 'role-1')).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.revokeRole('admin-1', 'admin-1', 'role-1')).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.grantPermission('admin-1', 'admin-1', 'perm-1')).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.revokePermission('admin-1', 'admin-1', 'perm-1')).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('last-super_admin guardrail', () => {
    it('blocks removing the super_admin role from its only holder', async () => {
      const { service, accessRepo } = createDeps();
      accessRepo.findRoleById.mockResolvedValue({ id: 'role-super', code: 'super_admin', name: 'Super Admin' } as never);
      accessRepo.holdsRoleCode.mockResolvedValue(true);
      accessRepo.countSuperAdminHolders.mockResolvedValue(1);

      await expect(service.revokeRole('admin-1', 'admin-2', 'role-super')).rejects.toBeInstanceOf(ConflictException);
      expect(accessRepo.revokeRole).not.toHaveBeenCalled();
    });

    it('allows removing super_admin from one holder when another remains', async () => {
      const { service, accessRepo } = createDeps();
      accessRepo.findRoleById.mockResolvedValue({ id: 'role-super', code: 'super_admin', name: 'Super Admin' } as never);
      accessRepo.holdsRoleCode.mockResolvedValue(true);
      accessRepo.countSuperAdminHolders.mockResolvedValue(2);

      await service.revokeRole('admin-1', 'admin-2', 'role-super');

      expect(accessRepo.revokeRole).toHaveBeenCalledWith('admin-2', 'role-super', expect.anything());
    });

    it('does not run the super_admin check at all for a non-super_admin role', async () => {
      const { service, accessRepo } = createDeps();
      accessRepo.findRoleById.mockResolvedValue({ id: 'role-ops', code: 'operations', name: 'Operations' } as never);

      await service.revokeRole('admin-1', 'admin-2', 'role-ops');

      expect(accessRepo.countSuperAdminHolders).not.toHaveBeenCalled();
      expect(accessRepo.revokeRole).toHaveBeenCalled();
    });

    it('blocks deactivating the last super_admin via updateAdmin', async () => {
      const { service, accessRepo, identityRepo } = createDeps();
      identityRepo.findAdminById.mockResolvedValue({ id: 'admin-2', status: 'active' } as never);
      accessRepo.holdsRoleCode.mockResolvedValue(true);
      accessRepo.countSuperAdminHolders.mockResolvedValue(1);

      await expect(service.updateAdmin('admin-1', 'admin-2', { status: 'suspended' })).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(identityRepo.updateAdmin).not.toHaveBeenCalled();
    });
  });

  describe('updateAdmin session revocation', () => {
    it('bumps tokenVersion when status changes away from active', async () => {
      const { service, accessRepo, identityRepo } = createDeps();
      identityRepo.findAdminById.mockResolvedValue({ id: 'admin-2', status: 'active' } as never);
      accessRepo.holdsRoleCode.mockResolvedValue(false);
      accessRepo.countSuperAdminHolders.mockResolvedValue(3);
      identityRepo.updateAdmin.mockResolvedValue({ id: 'admin-2', status: 'suspended' } as never);

      await service.updateAdmin('admin-1', 'admin-2', { status: 'suspended' });

      expect(identityRepo.bumpTokenVersion).toHaveBeenCalledWith('admin', 'admin-2', expect.anything());
    });

    it('does not bump tokenVersion or run the super_admin check for a fullName-only update', async () => {
      const { service, accessRepo, identityRepo } = createDeps();
      identityRepo.findAdminById.mockResolvedValue({ id: 'admin-2', status: 'active' } as never);
      identityRepo.updateAdmin.mockResolvedValue({ id: 'admin-2', fullName: 'New Name' } as never);

      await service.updateAdmin('admin-1', 'admin-2', { fullName: 'New Name' });

      expect(identityRepo.bumpTokenVersion).not.toHaveBeenCalled();
      expect(accessRepo.holdsRoleCode).not.toHaveBeenCalled();
    });
  });

  describe('createAdmin', () => {
    it('rejects a duplicate mobile number', async () => {
      const { service, identityRepo } = createDeps();
      identityRepo.findAdminByMobile.mockResolvedValue({ id: 'existing' } as never);

      await expect(
        service.createAdmin('admin-1', { mobileNumber: '+919876543210', fullName: 'X' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(identityRepo.createAdmin).not.toHaveBeenCalled();
    });
  });

  describe('not-found handling', () => {
    it('404s assignRole when the role does not exist', async () => {
      const { service, accessRepo } = createDeps();
      accessRepo.findRoleById.mockResolvedValue(null as never);

      await expect(service.assignRole('admin-1', 'admin-2', 'missing-role')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404s grantPermission when the permission does not exist', async () => {
      const { service, accessRepo } = createDeps();
      accessRepo.findPermissionById.mockResolvedValue(null as never);

      await expect(service.grantPermission('admin-1', 'admin-2', 'missing-permission')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
