/**
 * *** REAL-DATABASE TEST for `listAdminIdsWithPermission` — new SQL added
 * post-merge to close M-16's `ADMIN_DIRECTORY_PORT` gap (FR-13.4's red-alert
 * fan-out to admins). ***
 *
 * `identity-access.repository.spec.ts` (if it existed) could only assert
 * this method was CALLED with the right arguments — that proves nothing
 * about whether the three-way join (super_admin / role / direct grant) and
 * the `admins.status = 'active'` filter on each branch are actually correct
 * SQL. This proves it against real rows, following
 * `consent/consent.current-version.integration.spec.ts`'s fixture and
 * teardown conventions.
 *
 * Every fixture is per-run namespaced (`RUN_ID` in every mobile number and
 * role/permission code) and deleted in reverse-FK order in `afterAll`, so
 * this is safe to run against the shared dev database and repeatable.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { connectDatabase, disconnectDatabase, type Database } from '../../config/db/database.config';
import { loadEnvFiles } from '../../config/env/env.validation';
import { adminPermissionGrantsTable } from '../../schema/admin-permission-grants.schema';
import { adminRolesTable } from '../../schema/admin-roles.schema';
import { adminsTable } from '../../schema/admins.schema';
import { permissionsTable } from '../../schema/permissions.schema';
import { rolePermissionsTable } from '../../schema/role-permissions.schema';
import { rolesTable } from '../../schema/roles.schema';
import { IdentityAccessRepository } from './identity-access.repository';

const RUN_ID = randomUUID().slice(0, 8);
const permKey = (suffix: string) => `test.${RUN_ID}.${suffix}`;
const mobile = (suffix: string) => `+9199${RUN_ID.slice(0, 4)}${suffix}`;

describe('IdentityAccessRepository#listAdminIdsWithPermission (real database)', () => {
  let db: Database;
  let repo: IdentityAccessRepository;

  let permissionId: string;
  let otherPermissionId: string;
  let roleId: string;

  let superAdminId: string; // via the seeded super_admin role — proves the unconditional-grant branch
  let roleHolderAdminId: string; // via role_permissions -> admin_roles
  let directGrantAdminId: string; // via admin_permission_grants
  let suspendedRoleHolderId: string; // role holder, but status='suspended' — must be excluded
  let unrelatedAdminId: string; // holds neither the role nor the grant — must be excluded

  beforeAll(async () => {
    loadEnvFiles();
    db = await connectDatabase();
    repo = new IdentityAccessRepository(db);

    const [permission] = await db
      .insert(permissionsTable)
      .values({ key: permKey('act_alerts'), module: 'test', description: 'fixture' })
      .returning();
    const [otherPermission] = await db
      .insert(permissionsTable)
      .values({ key: permKey('unrelated'), module: 'test', description: 'fixture' })
      .returning();
    permissionId = permission!.id;
    otherPermissionId = otherPermission!.id;

    const [role] = await db
      .insert(rolesTable)
      .values({ code: `test_role_${RUN_ID}`, name: 'fixture role' })
      .returning();
    roleId = role!.id;
    await db.insert(rolePermissionsTable).values({ roleId, permissionId });

    const [superAdmin] = await db
      .select({ adminId: adminRolesTable.adminId })
      .from(adminRolesTable)
      .innerJoin(rolesTable, eq(rolesTable.id, adminRolesTable.roleId))
      .innerJoin(adminsTable, eq(adminsTable.id, adminRolesTable.adminId))
      .where(and(eq(rolesTable.code, 'super_admin'), eq(adminsTable.status, 'active')))
      .limit(1);
    if (!superAdmin) throw new Error('Fixture precondition failed: no active super_admin found — run identity.seed.ts first.');
    superAdminId = superAdmin.adminId;

    const [roleHolder] = await db
      .insert(adminsTable)
      .values({ mobileNumber: mobile('1'), fullName: 'Role Holder' })
      .returning();
    roleHolderAdminId = roleHolder!.id;
    await db.insert(adminRolesTable).values({ adminId: roleHolderAdminId, roleId });

    const [directGrantAdmin] = await db
      .insert(adminsTable)
      .values({ mobileNumber: mobile('2'), fullName: 'Direct Grant Holder' })
      .returning();
    directGrantAdminId = directGrantAdmin!.id;
    await db.insert(adminPermissionGrantsTable).values({ adminId: directGrantAdminId, permissionId });

    const [suspended] = await db
      .insert(adminsTable)
      .values({ mobileNumber: mobile('3'), fullName: 'Suspended Role Holder', status: 'suspended' })
      .returning();
    suspendedRoleHolderId = suspended!.id;
    await db.insert(adminRolesTable).values({ adminId: suspendedRoleHolderId, roleId });

    const [unrelated] = await db
      .insert(adminsTable)
      .values({ mobileNumber: mobile('4'), fullName: 'Unrelated Admin' })
      .returning();
    unrelatedAdminId = unrelated!.id;
    await db.insert(adminPermissionGrantsTable).values({ adminId: unrelatedAdminId, permissionId: otherPermissionId });
  });

  afterAll(async () => {
    const adminIds = [roleHolderAdminId, directGrantAdminId, suspendedRoleHolderId, unrelatedAdminId].filter(Boolean);
    if (adminIds.length > 0) {
      await db.delete(adminPermissionGrantsTable).where(inArray(adminPermissionGrantsTable.adminId, adminIds));
      await db.delete(adminRolesTable).where(inArray(adminRolesTable.adminId, adminIds));
      await db.delete(adminsTable).where(inArray(adminsTable.id, adminIds));
    }
    if (roleId) await db.delete(rolePermissionsTable).where(eq(rolePermissionsTable.roleId, roleId));
    if (roleId) await db.delete(rolesTable).where(eq(rolesTable.id, roleId));
    if (permissionId) await db.delete(permissionsTable).where(eq(permissionsTable.id, permissionId));
    if (otherPermissionId) await db.delete(permissionsTable).where(eq(permissionsTable.id, otherPermissionId));
    await disconnectDatabase();
  });

  it('includes the active super_admin, the active role holder and the active direct-grant holder', async () => {
    const key = (await db.select().from(permissionsTable).where(eq(permissionsTable.id, permissionId)))[0]!.key;
    const ids = await repo.listAdminIdsWithPermission(key as never);

    expect(ids).toEqual(expect.arrayContaining([superAdminId, roleHolderAdminId, directGrantAdminId]));
  });

  it('excludes a suspended admin who holds the role', async () => {
    const key = (await db.select().from(permissionsTable).where(eq(permissionsTable.id, permissionId)))[0]!.key;
    const ids = await repo.listAdminIdsWithPermission(key as never);

    expect(ids).not.toContain(suspendedRoleHolderId);
  });

  it('POSITIVE CONTROL: excludes an admin who holds neither the role nor a direct grant for this permission', async () => {
    const key = (await db.select().from(permissionsTable).where(eq(permissionsTable.id, permissionId)))[0]!.key;
    const ids = await repo.listAdminIdsWithPermission(key as never);

    expect(ids).not.toContain(unrelatedAdminId);
  });

  it('a DIFFERENT permission resolves to its OWN holders, not the first permission\'s — super_admin plus whoever holds this one directly', async () => {
    const otherKey = (await db.select().from(permissionsTable).where(eq(permissionsTable.id, otherPermissionId)))[0]!.key;
    const ids = await repo.listAdminIdsWithPermission(otherKey as never);

    expect(ids.sort()).toEqual([superAdminId, unrelatedAdminId].sort());
  });

  /**
   * *** THE super_admin BRANCH MUST REQUIRE THE PERMISSION TO ACTUALLY
   * EXIST. *** `listEffectivePermissions` (the forward direction: "what can
   * THIS admin do") grants super_admin every permission unconditionally, but
   * only by selecting every row that genuinely exists in `permissions` — a
   * key with no such row contributes nothing. `listAdminIdsWithPermission`
   * (the reverse direction) must be consistent with that: a permission key
   * that does not exist in the catalog at all — a typo, a key removed by a
   * migration, a stale constant left over after a rename — must resolve to
   * `[]`, the same as any other unmatched key, NOT to every active
   * super_admin. Before this test, the super_admin branch's `WHERE` clause
   * never referenced `key` at all, so ANY string (real permission or not)
   * matched every active super_admin — silently over-broad in exactly the
   * direction a permission check must never be.
   */
  it('resolves to [] for a permission key that does not exist in the catalog at all — including for super_admin, not just role/grant holders', async () => {
    const ids = await repo.listAdminIdsWithPermission(permKey('does-not-exist') as never);
    expect(ids).toEqual([]);
  });
});
