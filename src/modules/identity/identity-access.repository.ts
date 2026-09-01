import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DATABASE } from '../../config/db/database.module';
import type { Database } from '../../config/db/database.config';
import { adminPermissionGrantsTable } from '../../schema/admin-permission-grants.schema';
import { adminRolesTable } from '../../schema/admin-roles.schema';
import { permissionsTable } from '../../schema/permissions.schema';
import { rolePermissionsTable } from '../../schema/role-permissions.schema';
import { rolesTable } from '../../schema/roles.schema';
import type { PermissionKey, RoleCode } from '../../shared/auth/permission.catalog';
import type { Executor } from './identity.repository';

/**
 * SQL for the RBAC+ABAC tables. `listEffectivePermissions` deliberately
 * runs as two plain SELECTs merged in application code rather than a single
 * hand-written SQL UNION — the working set is tiny (41 permissions, 6
 * roles, a handful of admins), so the extra round trip is immaterial, and a
 * union query's exact drizzle-orm syntax is easy to get subtly wrong in a
 * way type-checking alone won't catch without a live database to verify
 * against. Correctness over a micro-optimization here.
 */
@Injectable()
export class IdentityAccessRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async holdsRoleCode(adminId: string, code: RoleCode, executor: Executor = this.db): Promise<boolean> {
    const [row] = await executor
      .select({ roleId: adminRolesTable.roleId })
      .from(adminRolesTable)
      .innerJoin(rolesTable, eq(rolesTable.id, adminRolesTable.roleId))
      .where(and(eq(adminRolesTable.adminId, adminId), eq(rolesTable.code, code)))
      .limit(1);
    return row !== undefined;
  }

  /** The super_admin short-circuit: seeded with all 41 permissions, but also granted every permission unconditionally here, so a permission added between deploys can never lock the owner out before the seed re-runs. */
  async listEffectivePermissions(adminId: string, executor: Executor = this.db): Promise<PermissionKey[]> {
    if (await this.holdsRoleCode(adminId, 'super_admin', executor)) {
      const all = await executor.select({ key: permissionsTable.key }).from(permissionsTable);
      return all.map((row) => row.key as PermissionKey);
    }

    const [fromRoles, fromGrants] = await Promise.all([
      executor
        .select({ key: permissionsTable.key })
        .from(rolePermissionsTable)
        .innerJoin(adminRolesTable, eq(adminRolesTable.roleId, rolePermissionsTable.roleId))
        .innerJoin(permissionsTable, eq(permissionsTable.id, rolePermissionsTable.permissionId))
        .where(eq(adminRolesTable.adminId, adminId)),
      executor
        .select({ key: permissionsTable.key })
        .from(adminPermissionGrantsTable)
        .innerJoin(permissionsTable, eq(permissionsTable.id, adminPermissionGrantsTable.permissionId))
        .where(eq(adminPermissionGrantsTable.adminId, adminId)),
    ]);

    const keys = new Set<string>();
    for (const row of fromRoles) keys.add(row.key);
    for (const row of fromGrants) keys.add(row.key);
    return Array.from(keys) as PermissionKey[];
  }

  async hasAllPermissions(adminId: string, keys: readonly PermissionKey[], executor: Executor = this.db): Promise<boolean> {
    if (keys.length === 0) {
      return true;
    }
    const effective = new Set(await this.listEffectivePermissions(adminId, executor));
    return keys.every((key) => effective.has(key));
  }

  async countSuperAdminHolders(executor: Executor = this.db): Promise<number> {
    const rows = await executor
      .select({ adminId: adminRolesTable.adminId })
      .from(adminRolesTable)
      .innerJoin(rolesTable, eq(rolesTable.id, adminRolesTable.roleId))
      .where(eq(rolesTable.code, 'super_admin'));
    return rows.length;
  }

  async listRoles(executor: Executor = this.db) {
    return executor.select().from(rolesTable).orderBy(rolesTable.name);
  }

  async findRoleById(id: string, executor: Executor = this.db) {
    const [row] = await executor.select().from(rolesTable).where(eq(rolesTable.id, id)).limit(1);
    return row ?? null;
  }

  async listPermissions(executor: Executor = this.db) {
    return executor.select().from(permissionsTable).orderBy(permissionsTable.module, permissionsTable.key);
  }

  async findPermissionById(id: string, executor: Executor = this.db) {
    const [row] = await executor.select().from(permissionsTable).where(eq(permissionsTable.id, id)).limit(1);
    return row ?? null;
  }

  async getAdminRoles(adminId: string, executor: Executor = this.db) {
    return executor
      .select({
        roleId: rolesTable.id,
        code: rolesTable.code,
        name: rolesTable.name,
        grantedAt: adminRolesTable.grantedAt,
        grantedByAdminId: adminRolesTable.grantedByAdminId,
      })
      .from(adminRolesTable)
      .innerJoin(rolesTable, eq(rolesTable.id, adminRolesTable.roleId))
      .where(eq(adminRolesTable.adminId, adminId));
  }

  async getAdminPermissionGrants(adminId: string, executor: Executor = this.db) {
    return executor
      .select({
        permissionId: permissionsTable.id,
        key: permissionsTable.key,
        module: permissionsTable.module,
        reason: adminPermissionGrantsTable.reason,
        grantedAt: adminPermissionGrantsTable.grantedAt,
        grantedByAdminId: adminPermissionGrantsTable.grantedByAdminId,
      })
      .from(adminPermissionGrantsTable)
      .innerJoin(permissionsTable, eq(permissionsTable.id, adminPermissionGrantsTable.permissionId))
      .where(eq(adminPermissionGrantsTable.adminId, adminId));
  }

  async assignRole(adminId: string, roleId: string, grantedByAdminId: string | null, executor: Executor = this.db): Promise<void> {
    await executor.insert(adminRolesTable).values({ adminId, roleId, grantedByAdminId }).onConflictDoNothing();
  }

  async revokeRole(adminId: string, roleId: string, executor: Executor = this.db): Promise<void> {
    await executor.delete(adminRolesTable).where(and(eq(adminRolesTable.adminId, adminId), eq(adminRolesTable.roleId, roleId)));
  }

  async grantPermission(
    adminId: string,
    permissionId: string,
    grantedByAdminId: string | null,
    reason: string | undefined,
    executor: Executor = this.db,
  ): Promise<void> {
    await executor
      .insert(adminPermissionGrantsTable)
      .values({ adminId, permissionId, grantedByAdminId, reason })
      .onConflictDoNothing();
  }

  async revokePermissionGrant(adminId: string, permissionId: string, executor: Executor = this.db): Promise<void> {
    await executor
      .delete(adminPermissionGrantsTable)
      .where(and(eq(adminPermissionGrantsTable.adminId, adminId), eq(adminPermissionGrantsTable.permissionId, permissionId)));
  }
}
