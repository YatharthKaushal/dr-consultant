import { index, pgTable, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core';
import { permissionsTable } from './permissions.schema';
import { rolesTable } from './roles.schema';

/**
 * The RBAC half: which permissions each seeded role bundles. Pure derived
 * policy — fully rebuilt by `identity.seed.ts` on every deploy (insert what
 * code says should exist, delete what no longer should), never edited by
 * hand, so `on delete cascade` on both sides is safe: a dangling row here
 * would mean the role or permission itself is gone, not evidence worth
 * keeping.
 *
 * Composite primary key, unlike `doctor_specialties`'s surrogate `id`: this
 * table carries no payload column (`doctor_specialties.is_primary` is why
 * that one needs a real id) and nothing points at this table with a
 * composite FK, so a surrogate key would exist only to exist.
 */
export const rolePermissionsTable = pgTable(
  'role_permissions',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => rolesTable.id, { onDelete: 'cascade' }),
    permissionId: uuid('permission_id')
      .notNull()
      .references(() => permissionsTable.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.roleId, table.permissionId] }),
    // Reverse lookup — "which roles grant permission X" on the catalog screen.
    index().on(table.permissionId),
  ],
);

export type RolePermissionRow = typeof rolePermissionsTable.$inferSelect;
export type NewRolePermissionRow = typeof rolePermissionsTable.$inferInsert;
