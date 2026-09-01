/**
 * Standalone seed script — no Nest DI, no decorators, run via
 * `npm run db:seed` (see package.json). Writes the RBAC+ABAC catalog from
 * `src/shared/auth/permission.catalog.ts` (the code-owned source of truth)
 * and, when configured, one bootstrap super_admin.
 *
 * A migration is immutable once applied; the permission catalog grows with
 * every future module, so a re-runnable, idempotent seed — not a migration
 * — is the shape that survives that. Run it after every `db:migrate`.
 *
 * Idempotency by table:
 *   - permissions/roles: upsert by their unique key (`key`/`code`).
 *   - role_permissions: FULL SYNC — insert what code now says a role should
 *     have, delete what it no longer says. Safe because this table is
 *     entirely code-owned; `admin_permission_grants` (the human-owned ABAC
 *     table) is never touched here.
 *   - app_config: insert-only, `ON CONFLICT DO NOTHING` — never overwrites
 *     a value an admin has already tuned from the panel.
 *   - the bootstrap admin: `ON CONFLICT DO NOTHING` on mobile_number, then
 *     an idempotent role link. Skipped entirely when
 *     BOOTSTRAP_SUPER_ADMIN_MOBILE is unset.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { connectDatabase, disconnectDatabase, getDb } from '../../config/db/database.config';
import { getEnv, loadEnvFiles } from '../../config/env/env.validation';
import { adminRolesTable } from '../../schema/admin-roles.schema';
import { adminsTable } from '../../schema/admins.schema';
import { appConfigTable } from '../../schema/app-config.schema';
import { auditLogTable } from '../../schema/audit-log.schema';
import { permissionsTable } from '../../schema/permissions.schema';
import { rolePermissionsTable } from '../../schema/role-permissions.schema';
import { rolesTable } from '../../schema/roles.schema';
import { PERMISSION_DEFINITIONS, ROLE_DEFINITIONS, ROLE_PERMISSIONS } from '../../shared/auth/permission.catalog';
import { normalizeMobileNumber } from './identity-phone.util';
import { IDENTITY_APP_CONFIG_DEFAULTS } from './identity.constants';

interface SeedSummary {
  permissions: number;
  roles: number;
  rolePermissionsAdded: number;
  rolePermissionsRemoved: number;
  bootstrapAdminCreated: boolean;
}

async function seed(): Promise<SeedSummary> {
  loadEnvFiles();
  const env = getEnv();
  await connectDatabase();
  const db = getDb();

  const summary: SeedSummary = {
    permissions: 0,
    roles: 0,
    rolePermissionsAdded: 0,
    rolePermissionsRemoved: 0,
    bootstrapAdminCreated: false,
  };

  await db.transaction(async (tx) => {
    // 1. Permissions.
    for (const def of PERMISSION_DEFINITIONS) {
      await tx
        .insert(permissionsTable)
        .values({ key: def.key, module: def.module, description: def.description })
        .onConflictDoUpdate({
          target: permissionsTable.key,
          set: { module: def.module, description: def.description, updatedAt: new Date() },
        });
    }
    summary.permissions = PERMISSION_DEFINITIONS.length;

    // 2. Roles.
    for (const def of ROLE_DEFINITIONS) {
      await tx
        .insert(rolesTable)
        .values({ code: def.code, name: def.name, description: def.description })
        .onConflictDoUpdate({
          target: rolesTable.code,
          set: { name: def.name, description: def.description, updatedAt: new Date() },
        });
    }
    summary.roles = ROLE_DEFINITIONS.length;

    const roleRows = await tx.select().from(rolesTable);
    const roleIdByCode = new Map(roleRows.map((row) => [row.code, row.id]));
    const permissionRows = await tx.select().from(permissionsTable);
    const permissionIdByKey = new Map(permissionRows.map((row) => [row.key, row.id]));

    // 3. role_permissions — full sync.
    for (const def of ROLE_DEFINITIONS) {
      const roleId = roleIdByCode.get(def.code);
      if (!roleId) continue;

      const desiredIds = new Set(
        ROLE_PERMISSIONS[def.code]
          .map((key) => permissionIdByKey.get(key))
          .filter((id): id is string => id !== undefined),
      );

      const existingRows = await tx
        .select({ permissionId: rolePermissionsTable.permissionId })
        .from(rolePermissionsTable)
        .where(eq(rolePermissionsTable.roleId, roleId));
      const existingIds = new Set(existingRows.map((row) => row.permissionId));

      const toAdd = [...desiredIds].filter((id) => !existingIds.has(id));
      const toRemove = [...existingIds].filter((id) => !desiredIds.has(id));

      if (toAdd.length > 0) {
        await tx.insert(rolePermissionsTable).values(toAdd.map((permissionId) => ({ roleId, permissionId })));
        summary.rolePermissionsAdded += toAdd.length;
      }
      if (toRemove.length > 0) {
        await tx
          .delete(rolePermissionsTable)
          .where(and(eq(rolePermissionsTable.roleId, roleId), inArray(rolePermissionsTable.permissionId, toRemove)));
        summary.rolePermissionsRemoved += toRemove.length;
      }
    }

    // 4. app_config — never overwrite an admin-tuned value.
    for (const [key, value] of Object.entries(IDENTITY_APP_CONFIG_DEFAULTS)) {
      await tx.insert(appConfigTable).values({ key, value }).onConflictDoNothing({ target: appConfigTable.key });
    }

    // 5. Bootstrap super_admin.
    if (env.BOOTSTRAP_SUPER_ADMIN_MOBILE) {
      const mobileNumber = normalizeMobileNumber(env.BOOTSTRAP_SUPER_ADMIN_MOBILE);
      await tx
        .insert(adminsTable)
        .values({ mobileNumber, fullName: env.BOOTSTRAP_SUPER_ADMIN_NAME })
        .onConflictDoNothing({ target: adminsTable.mobileNumber });

      const [admin] = await tx
        .select({ id: adminsTable.id })
        .from(adminsTable)
        .where(eq(adminsTable.mobileNumber, mobileNumber))
        .limit(1);
      const superAdminRoleId = roleIdByCode.get('super_admin');

      if (admin && superAdminRoleId) {
        // grantedByAdminId null = seeded, not granted by a person.
        await tx
          .insert(adminRolesTable)
          .values({ adminId: admin.id, roleId: superAdminRoleId, grantedByAdminId: null })
          .onConflictDoNothing();
        summary.bootstrapAdminCreated = true;
      }
    }

    // 6. Audit.
    await tx.insert(auditLogTable).values({
      actorType: 'system',
      actorId: null,
      action: 'update',
      entityType: 'seed',
      entityId: 'permission-catalog',
      metadata: { ...summary },
    });
  });

  return summary;
}

seed()
  .then(async (summary) => {
    process.stdout.write(`identity.seed: done — ${JSON.stringify(summary)}\n`);
    await disconnectDatabase();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`identity.seed: failed — ${message}\n`);
    await disconnectDatabase();
    process.exit(1);
  });
