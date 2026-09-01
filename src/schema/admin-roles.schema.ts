import { index, pgTable, primaryKey, timestamp, uuid } from 'drizzle-orm/pg-core';
import { adminsTable } from './admins.schema';
import { rolesTable } from './roles.schema';

/**
 * Which roles a given admin holds — many-to-many, because RBAC here means
 * an admin can hold more than one role at once (the reason `roles` is a
 * table and not an enum column). Composite primary key, same reasoning as
 * `role_permissions`: no payload beyond the grant metadata below, nothing
 * points at this pair.
 *
 * `on delete cascade` on `admin_id` (an admin row's deletion takes its
 * grants with it) but NOT on `role_id` — roles are never deleted, so a FK
 * violation there is a bug worth surfacing, not state to clean up quietly.
 *
 * `granted_by_admin_id` is kept even though `audit_log` records the same
 * event, for the same reason `doctors.verified_by_admin_id` is kept:
 * `audit_log` is append-only history, this column is CURRENT STATE, and the
 * admin access screen reads it directly without scanning the log. Null =
 * seeded by the bootstrap script, not granted by a person.
 */
export const adminRolesTable = pgTable(
  'admin_roles',
  {
    adminId: uuid('admin_id')
      .notNull()
      .references(() => adminsTable.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => rolesTable.id),
    grantedByAdminId: uuid('granted_by_admin_id').references(() => adminsTable.id),
    grantedAt: timestamp('granted_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.adminId, table.roleId] }),
    // "Who holds super_admin" — read by the last-super_admin guardrail before a revoke.
    index().on(table.roleId),
  ],
);

export type AdminRoleRow = typeof adminRolesTable.$inferSelect;
export type NewAdminRoleRow = typeof adminRolesTable.$inferInsert;
