import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { DATABASE } from '../../config/db/database.module';
import type { Database } from '../../config/db/database.config';
import { adminPermissionGrantsTable } from '../../schema/admin-permission-grants.schema';
import { adminRolesTable } from '../../schema/admin-roles.schema';
import { adminsTable } from '../../schema/admins.schema';
import { permissionsTable } from '../../schema/permissions.schema';
import { rolePermissionsTable } from '../../schema/role-permissions.schema';
import { rolesTable } from '../../schema/roles.schema';
import type { PermissionKey, RoleCode } from '../../shared/auth/permission.catalog';
import type { Executor } from './identity.repository';

/**
 * SQL for the RBAC+ABAC tables. `listEffectivePermissions` deliberately
 * runs as two plain SELECTs merged in application code rather than a single
 * hand-written SQL UNION — the working set is tiny (52 permissions, 6
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

  /** The super_admin short-circuit: seeded with all 52 permissions, but also granted every permission unconditionally here, so a permission added between deploys can never lock the owner out before the seed re-runs. */
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

  /**
   * The reverse of `listEffectivePermissions`: every ACTIVE admin who holds
   * `key`, by any of the same three routes — `super_admin` (which
   * `listEffectivePermissions` grants every permission unconditionally),
   * a role carrying it, or a direct grant. `admins.status = 'active'` is
   * checked in every branch for the same reason `countSuperAdminHolders`
   * checks it: a suspended admin's role link is never removed, so an
   * unfiltered query would keep notifying someone who cannot act on it.
   *
   * Built for `followup`'s `ADMIN_DIRECTORY_PORT` (FR-13.4's alert fan-out),
   * but shaped as a general "who can act on this permission" read — nothing
   * about it is follow-up-specific.
   */
  async listAdminIdsWithPermission(key: PermissionKey, executor: Executor = this.db): Promise<string[]> {
    const [superAdmins, fromRoles, fromGrants] = await Promise.all([
      executor
        .select({ adminId: adminRolesTable.adminId })
        .from(adminRolesTable)
        .innerJoin(rolesTable, eq(rolesTable.id, adminRolesTable.roleId))
        .innerJoin(adminsTable, eq(adminsTable.id, adminRolesTable.adminId))
        .where(and(eq(rolesTable.code, 'super_admin'), eq(adminsTable.status, 'active'))),
      executor
        .select({ adminId: adminRolesTable.adminId })
        .from(rolePermissionsTable)
        .innerJoin(permissionsTable, eq(permissionsTable.id, rolePermissionsTable.permissionId))
        .innerJoin(adminRolesTable, eq(adminRolesTable.roleId, rolePermissionsTable.roleId))
        .innerJoin(adminsTable, eq(adminsTable.id, adminRolesTable.adminId))
        .where(and(eq(permissionsTable.key, key), eq(adminsTable.status, 'active'))),
      executor
        .select({ adminId: adminPermissionGrantsTable.adminId })
        .from(adminPermissionGrantsTable)
        .innerJoin(permissionsTable, eq(permissionsTable.id, adminPermissionGrantsTable.permissionId))
        .innerJoin(adminsTable, eq(adminsTable.id, adminPermissionGrantsTable.adminId))
        .where(and(eq(permissionsTable.key, key), eq(adminsTable.status, 'active'))),
    ]);

    const ids = new Set<string>();
    for (const row of superAdmins) ids.add(row.adminId);
    for (const row of fromRoles) ids.add(row.adminId);
    for (const row of fromGrants) ids.add(row.adminId);
    return Array.from(ids);
  }

  /**
   * Counts admins who can ACTUALLY exercise super_admin right now — role
   * link AND `status = 'active'`. Deliberately joined against `admins`
   * rather than counting bare `admin_roles` rows: a suspended or deleted
   * admin's role link is never removed (see `admins.schema.ts` — status is
   * how an account is deactivated, not role revocation), so an unfiltered
   * count would keep reporting "N holders" while every one of them is
   * actually inactive, and the last-super_admin guardrail would never
   * trip even as active coverage silently reaches zero.
   */
  async countSuperAdminHolders(executor: Executor = this.db): Promise<number> {
    const rows = await executor
      .select({ adminId: adminRolesTable.adminId })
      .from(adminRolesTable)
      .innerJoin(rolesTable, eq(rolesTable.id, adminRolesTable.roleId))
      .innerJoin(adminsTable, eq(adminsTable.id, adminRolesTable.adminId))
      .where(and(eq(rolesTable.code, 'super_admin'), eq(adminsTable.status, 'active')));
    return rows.length;
  }

  /**
   * Serializes every mutation that can change who holds `super_admin`
   * (`revokeRole` removing it, `updateAdmin` deactivating a holder) against
   * a single named lock for the lifetime of the caller's transaction —
   * `pg_advisory_xact_lock` auto-releases on commit or rollback. Without
   * this, two concurrent requests each revoking `super_admin` from a
   * DIFFERENT admin could each read "2 holders, safe to remove one" before
   * either commits, leaving zero afterward — the standard TOCTOU gap a
   * check-then-act pattern has under READ COMMITTED. Call this BEFORE
   * counting holders, inside the same transaction as the mutation.
   */
  async lockSuperAdminGuard(executor: Executor): Promise<void> {
    await executor.execute(sql`select pg_advisory_xact_lock(hashtext('identity.super_admin_guard'))`);
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

  /** Returns whether a row was actually inserted (`false` when the admin already held it) — the caller must not audit a "grant" that changed nothing. */
  async assignRole(
    adminId: string,
    roleId: string,
    grantedByAdminId: string | null,
    executor: Executor = this.db,
  ): Promise<boolean> {
    const inserted = await executor
      .insert(adminRolesTable)
      .values({ adminId, roleId, grantedByAdminId })
      .onConflictDoNothing()
      .returning({ adminId: adminRolesTable.adminId });
    return inserted.length > 0;
  }

  /** Returns whether a row was actually deleted (`false` when the admin didn't hold it). */
  async revokeRole(adminId: string, roleId: string, executor: Executor = this.db): Promise<boolean> {
    const deleted = await executor
      .delete(adminRolesTable)
      .where(and(eq(adminRolesTable.adminId, adminId), eq(adminRolesTable.roleId, roleId)))
      .returning({ adminId: adminRolesTable.adminId });
    return deleted.length > 0;
  }

  /** Returns whether a row was actually inserted. */
  async grantPermission(
    adminId: string,
    permissionId: string,
    grantedByAdminId: string | null,
    reason: string | undefined,
    executor: Executor = this.db,
  ): Promise<boolean> {
    const inserted = await executor
      .insert(adminPermissionGrantsTable)
      .values({ adminId, permissionId, grantedByAdminId, reason })
      .onConflictDoNothing()
      .returning({ adminId: adminPermissionGrantsTable.adminId });
    return inserted.length > 0;
  }

  /** Returns whether a row was actually deleted. */
  async revokePermissionGrant(adminId: string, permissionId: string, executor: Executor = this.db): Promise<boolean> {
    const deleted = await executor
      .delete(adminPermissionGrantsTable)
      .where(and(eq(adminPermissionGrantsTable.adminId, adminId), eq(adminPermissionGrantsTable.permissionId, permissionId)))
      .returning({ adminId: adminPermissionGrantsTable.adminId });
    return deleted.length > 0;
  }
}
