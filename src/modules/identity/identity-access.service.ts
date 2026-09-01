import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DATABASE } from '../../config/db/database.module';
import type { Database } from '../../config/db/database.config';
import type { AdminRow } from '../../schema/admins.schema';
import { AuditService } from '../../shared/audit/audit.service';
import type { PermissionKey } from '../../shared/auth/permission.catalog';
import { IdentityAccessRepository } from './identity-access.repository';
import { IDENTITY_AUDIT_ENTITY_TYPES, IDENTITY_ERROR_CODES } from './identity.constants';
import { normalizeMobileNumber } from './identity-phone.util';
import { IdentityRepository } from './identity.repository';

/**
 * RBAC/ABAC (role and direct-permission assignment) AND general admin
 * account management — the two are combined in one service rather than
 * split further because every admin-management mutation shares the same
 * guardrail machinery (last-super_admin protection, session revocation on
 * status change, audited writes), and `identity.service.ts` stays scoped to
 * the OTP sign-in flow.
 */
@Injectable()
export class IdentityAccessService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly accessRepo: IdentityAccessRepository,
    private readonly identityRepo: IdentityRepository,
    private readonly audit: AuditService,
  ) {}

  /* ---------------------------------------------------------------------- */
  /* Effective-permission resolution (read by shared/auth's guards)          */
  /* ---------------------------------------------------------------------- */

  async listEffectivePermissions(adminId: string): Promise<PermissionKey[]> {
    return this.accessRepo.listEffectivePermissions(adminId);
  }

  async hasAllPermissions(adminId: string, keys: readonly PermissionKey[]): Promise<boolean> {
    return this.accessRepo.hasAllPermissions(adminId, keys);
  }

  /* ---------------------------------------------------------------------- */
  /* Catalog reads                                                           */
  /* ---------------------------------------------------------------------- */

  async listRoles() {
    return this.accessRepo.listRoles();
  }

  async listPermissions() {
    return this.accessRepo.listPermissions();
  }

  /** Just the role codes — used by `GET /auth/me`, which already has the admin's existence confirmed via its own token resolution. */
  async listAdminRoleCodes(adminId: string): Promise<string[]> {
    const roles = await this.accessRepo.getAdminRoles(adminId);
    return roles.map((role) => role.code);
  }

  async getAdminAccess(adminId: string) {
    const admin = await this.identityRepo.findAdminById(adminId);
    if (!admin) {
      throw new NotFoundException({ code: IDENTITY_ERROR_CODES.ADMIN_NOT_FOUND, message: 'Admin not found.' });
    }
    const [roles, grants] = await Promise.all([
      this.accessRepo.getAdminRoles(adminId),
      this.accessRepo.getAdminPermissionGrants(adminId),
    ]);
    return { admin, roles, grants };
  }

  /* ---------------------------------------------------------------------- */
  /* Admin account management                                                */
  /* ---------------------------------------------------------------------- */

  async listAdmins(): Promise<AdminRow[]> {
    return this.identityRepo.listAdmins();
  }

  async createAdmin(actingAdminId: string, data: { mobileNumber: string; fullName: string }, ipAddress?: string): Promise<AdminRow> {
    const mobileNumber = normalizeMobileNumber(data.mobileNumber);
    const existing = await this.identityRepo.findAdminByMobile(mobileNumber);
    if (existing) {
      throw new ConflictException({ code: IDENTITY_ERROR_CODES.MOBILE_NUMBER_TAKEN, message: 'An admin with this mobile number already exists.' });
    }

    const admin = await this.identityRepo.createAdmin({ mobileNumber, fullName: data.fullName });
    await this.audit.write({
      actorType: 'admin',
      actorId: actingAdminId,
      action: 'create',
      entityType: IDENTITY_AUDIT_ENTITY_TYPES.ADMIN,
      entityId: admin.id,
      ipAddress,
    });
    return admin;
  }

  /**
   * Setting `status` to anything other than `active` bumps `tokenVersion`
   * in the same transaction — a suspension must kill live sessions
   * immediately, not wait out the access-token TTL. Also enforces the
   * last-super_admin guardrail: you cannot suspend/delete the only
   * super_admin, same rule `revokeRole` applies to removing the role
   * outright.
   */
  async updateAdmin(actingAdminId: string, targetAdminId: string, data: { fullName?: string; status?: AdminRow['status'] }): Promise<AdminRow> {
    const target = await this.identityRepo.findAdminById(targetAdminId);
    if (!target) {
      throw new NotFoundException({ code: IDENTITY_ERROR_CODES.ADMIN_NOT_FOUND, message: 'Admin not found.' });
    }

    const isDeactivating = data.status !== undefined && data.status !== 'active';
    if (isDeactivating) {
      const [holdsSuperAdmin, holders] = await Promise.all([
        this.accessRepo.holdsRoleCode(targetAdminId, 'super_admin'),
        this.accessRepo.countSuperAdminHolders(),
      ]);
      if (holdsSuperAdmin && holders <= 1) {
        throw new ConflictException({ code: IDENTITY_ERROR_CODES.LAST_SUPER_ADMIN, message: 'Cannot deactivate the last super_admin.' });
      }
    }

    return this.db.transaction(async (tx) => {
      const updated = await this.identityRepo.updateAdmin(targetAdminId, data, tx);
      if (!updated) {
        throw new NotFoundException({ code: IDENTITY_ERROR_CODES.ADMIN_NOT_FOUND, message: 'Admin not found.' });
      }
      if (isDeactivating) {
        await this.identityRepo.bumpTokenVersion('admin', targetAdminId, tx);
      }
      await this.audit.write(
        {
          actorType: 'admin',
          actorId: actingAdminId,
          action: 'update',
          entityType: IDENTITY_AUDIT_ENTITY_TYPES.ADMIN,
          entityId: targetAdminId,
          metadata: { ...data },
        },
        tx,
      );
      return updated;
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Role assignment (RBAC)                                                  */
  /* ---------------------------------------------------------------------- */

  async assignRole(actingAdminId: string, targetAdminId: string, roleId: string): Promise<void> {
    this.assertNotSelf(actingAdminId, targetAdminId);
    const role = await this.accessRepo.findRoleById(roleId);
    if (!role) {
      throw new NotFoundException({ code: IDENTITY_ERROR_CODES.ROLE_NOT_FOUND, message: 'Role not found.' });
    }

    await this.db.transaction(async (tx) => {
      await this.accessRepo.assignRole(targetAdminId, roleId, actingAdminId, tx);
      await this.audit.write(
        {
          actorType: 'admin',
          actorId: actingAdminId,
          action: 'create',
          entityType: IDENTITY_AUDIT_ENTITY_TYPES.ADMIN_ROLE,
          entityId: targetAdminId,
          metadata: { roleCode: role.code, roleId },
        },
        tx,
      );
    });
  }

  async revokeRole(actingAdminId: string, targetAdminId: string, roleId: string): Promise<void> {
    this.assertNotSelf(actingAdminId, targetAdminId);
    const role = await this.accessRepo.findRoleById(roleId);
    if (!role) {
      throw new NotFoundException({ code: IDENTITY_ERROR_CODES.ROLE_NOT_FOUND, message: 'Role not found.' });
    }

    if (role.code === 'super_admin') {
      const [targetHolds, holders] = await Promise.all([
        this.accessRepo.holdsRoleCode(targetAdminId, 'super_admin'),
        this.accessRepo.countSuperAdminHolders(),
      ]);
      if (targetHolds && holders <= 1) {
        throw new ConflictException({ code: IDENTITY_ERROR_CODES.LAST_SUPER_ADMIN, message: 'Cannot remove the last super_admin.' });
      }
    }

    await this.db.transaction(async (tx) => {
      await this.accessRepo.revokeRole(targetAdminId, roleId, tx);
      await this.audit.write(
        {
          actorType: 'admin',
          actorId: actingAdminId,
          action: 'delete',
          entityType: IDENTITY_AUDIT_ENTITY_TYPES.ADMIN_ROLE,
          entityId: targetAdminId,
          metadata: { roleCode: role.code, roleId },
        },
        tx,
      );
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Direct permission grants (ABAC)                                         */
  /* ---------------------------------------------------------------------- */

  async grantPermission(actingAdminId: string, targetAdminId: string, permissionId: string, reason?: string): Promise<void> {
    this.assertNotSelf(actingAdminId, targetAdminId);
    const permission = await this.accessRepo.findPermissionById(permissionId);
    if (!permission) {
      throw new NotFoundException({ code: IDENTITY_ERROR_CODES.PERMISSION_NOT_FOUND, message: 'Permission not found.' });
    }

    await this.db.transaction(async (tx) => {
      await this.accessRepo.grantPermission(targetAdminId, permissionId, actingAdminId, reason, tx);
      await this.audit.write(
        {
          actorType: 'admin',
          actorId: actingAdminId,
          action: 'create',
          entityType: IDENTITY_AUDIT_ENTITY_TYPES.ADMIN_PERMISSION_GRANT,
          entityId: targetAdminId,
          metadata: { permissionKey: permission.key, permissionId, reason },
        },
        tx,
      );
    });
  }

  async revokePermission(actingAdminId: string, targetAdminId: string, permissionId: string): Promise<void> {
    this.assertNotSelf(actingAdminId, targetAdminId);
    const permission = await this.accessRepo.findPermissionById(permissionId);
    if (!permission) {
      throw new NotFoundException({ code: IDENTITY_ERROR_CODES.PERMISSION_NOT_FOUND, message: 'Permission not found.' });
    }

    await this.db.transaction(async (tx) => {
      await this.accessRepo.revokePermissionGrant(targetAdminId, permissionId, tx);
      await this.audit.write(
        {
          actorType: 'admin',
          actorId: actingAdminId,
          action: 'delete',
          entityType: IDENTITY_AUDIT_ENTITY_TYPES.ADMIN_PERMISSION_GRANT,
          entityId: targetAdminId,
          metadata: { permissionKey: permission.key, permissionId },
        },
        tx,
      );
    });
  }

  /** The primary containment for an additive-only model without deny-overrides: an admin can never touch their own access. */
  private assertNotSelf(actingAdminId: string, targetAdminId: string): void {
    if (actingAdminId === targetAdminId) {
      throw new ForbiddenException({
        code: IDENTITY_ERROR_CODES.CANNOT_MODIFY_SELF,
        message: 'You cannot change your own roles or permissions.',
      });
    }
  }
}
