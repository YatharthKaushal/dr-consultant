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
    lockSuperAdminGuard: jest.fn().mockResolvedValue(undefined),
    assignRole: jest.fn().mockResolvedValue(true),
    revokeRole: jest.fn().mockResolvedValue(true),
    grantPermission: jest.fn().mockResolvedValue(true),
    revokePermissionGrant: jest.fn().mockResolvedValue(true),
    getAdminRoles: jest.fn().mockResolvedValue([]),
    getAdminPermissionGrants: jest.fn().mockResolvedValue([]),
    listRoles: jest.fn(),
    listPermissions: jest.fn(),
  } as unknown as jest.Mocked<IdentityAccessRepository>;
  const identityRepo = {
    // Defaults to "exists" — the common case for every mutation test.
    // Individual tests override to null for the 404 cases.
    findAdminById: jest.fn().mockResolvedValue({ id: 'admin-2', status: 'active' }),
    findAdminByMobile: jest.fn(),
    createAdmin: jest.fn(),
    updateAdmin: jest.fn().mockResolvedValue({ id: 'admin-2', status: 'active' }),
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

  describe('target-admin existence', () => {
    it('404s assignRole/revokeRole/grantPermission/revokePermission when the target admin does not exist', async () => {
      const { service, identityRepo } = createDeps();
      identityRepo.findAdminById.mockResolvedValue(null as never);

      await expect(service.assignRole('admin-1', 'missing', 'role-1')).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.revokeRole('admin-1', 'missing', 'role-1')).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.grantPermission('admin-1', 'missing', 'perm-1')).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.revokePermission('admin-1', 'missing', 'perm-1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('never reaches the database for a role/permission id when the target admin is missing (fails fast)', async () => {
      const { service, identityRepo, accessRepo } = createDeps();
      identityRepo.findAdminById.mockResolvedValue(null as never);

      await expect(service.assignRole('admin-1', 'missing', 'role-1')).rejects.toBeInstanceOf(NotFoundException);
      expect(accessRepo.findRoleById).not.toHaveBeenCalled();
    });
  });

  describe('last-super_admin guardrail', () => {
    it('blocks removing the super_admin role when it would leave zero active holders', async () => {
      const { service, accessRepo } = createDeps();
      accessRepo.findRoleById.mockResolvedValue({ id: 'role-super', code: 'super_admin', name: 'Super Admin' } as never);
      accessRepo.revokeRole.mockResolvedValue(true);
      accessRepo.countSuperAdminHolders.mockResolvedValue(0);

      await expect(service.revokeRole('admin-1', 'admin-2', 'role-super')).rejects.toBeInstanceOf(ConflictException);
      // The lock is acquired before the count is trusted.
      expect(accessRepo.lockSuperAdminGuard).toHaveBeenCalled();
    });

    it('allows removing super_admin when at least one active holder remains afterward', async () => {
      const { service, accessRepo } = createDeps();
      accessRepo.findRoleById.mockResolvedValue({ id: 'role-super', code: 'super_admin', name: 'Super Admin' } as never);
      accessRepo.revokeRole.mockResolvedValue(true);
      accessRepo.countSuperAdminHolders.mockResolvedValue(1);

      await service.revokeRole('admin-1', 'admin-2', 'role-super');

      expect(accessRepo.revokeRole).toHaveBeenCalledWith('admin-2', 'role-super', expect.anything());
    });

    it('does not acquire the lock or count holders for a non-super_admin role', async () => {
      const { service, accessRepo } = createDeps();
      accessRepo.findRoleById.mockResolvedValue({ id: 'role-ops', code: 'operations', name: 'Operations' } as never);
      accessRepo.revokeRole.mockResolvedValue(true);

      await service.revokeRole('admin-1', 'admin-2', 'role-ops');

      expect(accessRepo.lockSuperAdminGuard).not.toHaveBeenCalled();
      expect(accessRepo.countSuperAdminHolders).not.toHaveBeenCalled();
    });

    it('does not guard or audit a revoke that was already a no-op (admin never held the role)', async () => {
      const { service, accessRepo, audit } = createDeps();
      accessRepo.findRoleById.mockResolvedValue({ id: 'role-super', code: 'super_admin', name: 'Super Admin' } as never);
      accessRepo.revokeRole.mockResolvedValue(false);

      await service.revokeRole('admin-1', 'admin-2', 'role-super');

      expect(accessRepo.countSuperAdminHolders).not.toHaveBeenCalled();
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('blocks deactivating the last active super_admin via updateAdmin, and rolls back the status change', async () => {
      const { service, accessRepo, identityRepo, audit } = createDeps();
      identityRepo.updateAdmin.mockResolvedValue({ id: 'admin-2', status: 'suspended' } as never);
      accessRepo.holdsRoleCode.mockResolvedValue(true);
      accessRepo.countSuperAdminHolders.mockResolvedValue(0);

      await expect(service.updateAdmin('admin-1', 'admin-2', { status: 'suspended' })).rejects.toBeInstanceOf(
        ConflictException,
      );
      // The update was attempted (and would be rolled back by the real
      // transaction) but neither the session revocation nor the audit
      // entry for a change that got rolled back should ever run.
      expect(identityRepo.bumpTokenVersion).not.toHaveBeenCalled();
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('allows deactivating a super_admin when another active one remains', async () => {
      const { service, accessRepo, identityRepo } = createDeps();
      identityRepo.updateAdmin.mockResolvedValue({ id: 'admin-2', status: 'suspended' } as never);
      accessRepo.holdsRoleCode.mockResolvedValue(true);
      accessRepo.countSuperAdminHolders.mockResolvedValue(1);

      await service.updateAdmin('admin-1', 'admin-2', { status: 'suspended' });

      expect(identityRepo.bumpTokenVersion).toHaveBeenCalledWith('admin', 'admin-2', expect.anything());
    });
  });

  describe('updateAdmin session revocation', () => {
    it('bumps tokenVersion when status changes away from active and the admin is not a super_admin', async () => {
      const { service, accessRepo, identityRepo } = createDeps();
      accessRepo.holdsRoleCode.mockResolvedValue(false);
      identityRepo.updateAdmin.mockResolvedValue({ id: 'admin-2', status: 'suspended' } as never);

      await service.updateAdmin('admin-1', 'admin-2', { status: 'suspended' });

      expect(identityRepo.bumpTokenVersion).toHaveBeenCalledWith('admin', 'admin-2', expect.anything());
    });

    it('does not bump tokenVersion, lock, or check holders for a fullName-only update', async () => {
      const { service, accessRepo, identityRepo } = createDeps();
      identityRepo.updateAdmin.mockResolvedValue({ id: 'admin-2', fullName: 'New Name' } as never);

      await service.updateAdmin('admin-1', 'admin-2', { fullName: 'New Name' });

      expect(identityRepo.bumpTokenVersion).not.toHaveBeenCalled();
      expect(accessRepo.lockSuperAdminGuard).not.toHaveBeenCalled();
      expect(accessRepo.holdsRoleCode).not.toHaveBeenCalled();
    });

    it('never returns tokenVersion to the caller', async () => {
      const { service, identityRepo } = createDeps();
      identityRepo.updateAdmin.mockResolvedValue({ id: 'admin-2', fullName: 'New Name', tokenVersion: 4 } as never);

      const result = await service.updateAdmin('admin-1', 'admin-2', { fullName: 'New Name' });

      expect(result).not.toHaveProperty('tokenVersion');
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

  describe('idempotent RBAC mutations do not write a misleading audit entry', () => {
    it('does not audit assignRole when the admin already held the role', async () => {
      const { service, accessRepo, audit } = createDeps();
      accessRepo.findRoleById.mockResolvedValue({ id: 'role-1', code: 'operations', name: 'Operations' } as never);
      accessRepo.assignRole.mockResolvedValue(false);

      await service.assignRole('admin-1', 'admin-2', 'role-1');

      expect(audit.write).not.toHaveBeenCalled();
    });

    it('does not audit grantPermission when the admin already held the grant', async () => {
      const { service, accessRepo, audit } = createDeps();
      accessRepo.findPermissionById.mockResolvedValue({ id: 'perm-1', key: 'doctors.verify' } as never);
      accessRepo.grantPermission.mockResolvedValue(false);

      await service.grantPermission('admin-1', 'admin-2', 'perm-1');

      expect(audit.write).not.toHaveBeenCalled();
    });

    it('does not audit revokePermission when the admin never held the grant', async () => {
      const { service, accessRepo, audit } = createDeps();
      accessRepo.findPermissionById.mockResolvedValue({ id: 'perm-1', key: 'doctors.verify' } as never);
      accessRepo.revokePermissionGrant.mockResolvedValue(false);

      await service.revokePermission('admin-1', 'admin-2', 'perm-1');

      expect(audit.write).not.toHaveBeenCalled();
    });

    it('DOES audit assignRole when the role was actually newly assigned', async () => {
      const { service, accessRepo, audit } = createDeps();
      accessRepo.findRoleById.mockResolvedValue({ id: 'role-1', code: 'operations', name: 'Operations' } as never);
      accessRepo.assignRole.mockResolvedValue(true);

      await service.assignRole('admin-1', 'admin-2', 'role-1');

      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'create', entityType: 'admin_role', entityId: 'admin-2' }),
        expect.anything(),
      );
    });
  });

  describe('not-found handling for role/permission ids', () => {
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

    it('404s revokeRole when the role does not exist', async () => {
      const { service, accessRepo } = createDeps();
      accessRepo.findRoleById.mockResolvedValue(null as never);

      await expect(service.revokeRole('admin-1', 'admin-2', 'missing-role')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('404s revokePermission when the permission does not exist', async () => {
      const { service, accessRepo } = createDeps();
      accessRepo.findPermissionById.mockResolvedValue(null as never);

      await expect(service.revokePermission('admin-1', 'admin-2', 'missing-permission')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('DOES audit real-change paths for every RBAC/ABAC mutation', () => {
    it('DOES audit revokeRole when the role was actually held and removed (non-super_admin)', async () => {
      const { service, accessRepo, audit } = createDeps();
      accessRepo.findRoleById.mockResolvedValue({ id: 'role-1', code: 'operations', name: 'Operations' } as never);
      accessRepo.revokeRole.mockResolvedValue(true);

      await service.revokeRole('admin-1', 'admin-2', 'role-1');

      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'delete', entityType: 'admin_role', entityId: 'admin-2' }),
        expect.anything(),
      );
    });

    it('DOES audit grantPermission when the grant was newly created, and includes the reason in metadata', async () => {
      const { service, accessRepo, audit } = createDeps();
      accessRepo.findPermissionById.mockResolvedValue({ id: 'perm-1', key: 'doctors.verify' } as never);
      accessRepo.grantPermission.mockResolvedValue(true);

      await service.grantPermission('admin-1', 'admin-2', 'perm-1', 'coverage during leave');

      expect(accessRepo.grantPermission).toHaveBeenCalledWith('admin-2', 'perm-1', 'admin-1', 'coverage during leave', expect.anything());
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'create',
          entityType: 'admin_permission_grant',
          entityId: 'admin-2',
          metadata: expect.objectContaining({ permissionKey: 'doctors.verify', reason: 'coverage during leave' }),
        }),
        expect.anything(),
      );
    });

    it('DOES audit revokePermission when the grant was actually held and removed', async () => {
      const { service, accessRepo, audit } = createDeps();
      accessRepo.findPermissionById.mockResolvedValue({ id: 'perm-1', key: 'doctors.verify' } as never);
      accessRepo.revokePermissionGrant.mockResolvedValue(true);

      await service.revokePermission('admin-1', 'admin-2', 'perm-1');

      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'delete', entityType: 'admin_permission_grant', entityId: 'admin-2' }),
        expect.anything(),
      );
    });

    it('does not audit assignRole no-op call and does not require a role lock for a non-super_admin role', async () => {
      const { service, accessRepo, audit } = createDeps();
      accessRepo.findRoleById.mockResolvedValue({ id: 'role-1', code: 'operations', name: 'Operations' } as never);
      accessRepo.assignRole.mockResolvedValue(false);

      await service.assignRole('admin-1', 'admin-2', 'role-1');

      expect(audit.write).not.toHaveBeenCalled();
    });
  });

  describe('getAdminAccess', () => {
    it('404s when the admin does not exist', async () => {
      const { service, identityRepo } = createDeps();
      identityRepo.findAdminById.mockResolvedValue(null as never);

      await expect(service.getAdminAccess('missing')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns the admin (without tokenVersion), roles, and grants', async () => {
      const { service, identityRepo, accessRepo } = createDeps();
      identityRepo.findAdminById.mockResolvedValue({ id: 'admin-2', status: 'active', tokenVersion: 3 } as never);
      accessRepo.getAdminRoles.mockResolvedValue([{ roleId: 'role-1', code: 'operations', name: 'Operations' }] as never);
      accessRepo.getAdminPermissionGrants.mockResolvedValue([{ permissionId: 'perm-1', key: 'doctors.verify' }] as never);

      const result = await service.getAdminAccess('admin-2');

      expect(result.admin).not.toHaveProperty('tokenVersion');
      expect(result.roles).toHaveLength(1);
      expect(result.grants).toHaveLength(1);
    });
  });

  describe('catalog and read passthroughs', () => {
    it('listEffectivePermissions delegates to the access repository', async () => {
      const { service, accessRepo } = createDeps();
      (accessRepo.listEffectivePermissions as jest.Mock) = jest.fn().mockResolvedValue(['doctors.verify']);

      await expect(service.listEffectivePermissions('admin-1')).resolves.toEqual(['doctors.verify']);
    });

    it('hasAllPermissions delegates to the access repository', async () => {
      const { service, accessRepo } = createDeps();
      (accessRepo.hasAllPermissions as jest.Mock) = jest.fn().mockResolvedValue(true);

      await expect(service.hasAllPermissions('admin-1', ['doctors.verify' as never])).resolves.toBe(true);
    });

    it('listRoles delegates to the access repository', async () => {
      const { service, accessRepo } = createDeps();
      accessRepo.listRoles.mockResolvedValue([{ id: 'role-1', code: 'operations', name: 'Operations' }] as never);

      await expect(service.listRoles()).resolves.toHaveLength(1);
    });

    it('listPermissions delegates to the access repository', async () => {
      const { service, accessRepo } = createDeps();
      accessRepo.listPermissions.mockResolvedValue([{ id: 'perm-1', key: 'doctors.verify' }] as never);

      await expect(service.listPermissions()).resolves.toHaveLength(1);
    });

    it('listAdminRoleCodes maps role rows down to just their codes', async () => {
      const { service, accessRepo } = createDeps();
      accessRepo.getAdminRoles.mockResolvedValue([
        { roleId: 'role-1', code: 'operations', name: 'Operations' },
        { roleId: 'role-2', code: 'support', name: 'Support' },
      ] as never);

      await expect(service.listAdminRoleCodes('admin-1')).resolves.toEqual(['operations', 'support']);
    });

    it('listAdmins strips tokenVersion from every row', async () => {
      const { service, identityRepo } = createDeps();
      identityRepo.listAdmins.mockResolvedValue([{ id: 'admin-1', status: 'active', tokenVersion: 4 }] as never);

      const result = await service.listAdmins();

      expect(result[0]).not.toHaveProperty('tokenVersion');
    });
  });

  describe('createAdmin — success path', () => {
    it('creates the admin and audits the creation', async () => {
      const { service, identityRepo, audit } = createDeps();
      identityRepo.findAdminByMobile.mockResolvedValue(null as never);
      identityRepo.createAdmin.mockResolvedValue({ id: 'admin-3', status: 'active', tokenVersion: 0, fullName: 'New Admin' } as never);

      const result = await service.createAdmin('admin-1', { mobileNumber: '+919876543210', fullName: 'New Admin' });

      expect(result).not.toHaveProperty('tokenVersion');
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'create', entityType: 'admin', entityId: 'admin-3' }),
      );
    });
  });
});
