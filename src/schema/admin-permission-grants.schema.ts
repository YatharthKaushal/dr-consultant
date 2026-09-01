import { index, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { adminsTable } from './admins.schema';
import { permissionsTable } from './permissions.schema';

/**
 * The ABAC half: a permission attached directly to a PERSON, independent of
 * any role — "or even individual attribute can perform the respective
 * task". An admin's effective permissions are the union of every role's
 * bundle (`role_permissions` via `admin_roles`) and this table.
 *
 * Additive only, deliberately: there is no `effect` column, so a row here
 * can only ever widen what an admin may do, never narrow a role's grant. A
 * future deny-override is one enum column plus one EXCEPT clause in the
 * resolution query — not built now because nothing in FR-18 asks to take a
 * permission away from a role holder.
 *
 * `reason` exists because a grant sitting outside every role bundle is
 * exactly the row a reviewer asks "why does this person have this?" about,
 * and the answer must be visible on the access screen, not only inferable
 * from `audit_log`. No `expires_at` — nothing in the SRS asks for temporary
 * elevation, and an unused nullable timestamp invites a half-built expiry
 * sweeper nobody asked for.
 */
export const adminPermissionGrantsTable = pgTable(
  'admin_permission_grants',
  {
    adminId: uuid('admin_id')
      .notNull()
      .references(() => adminsTable.id, { onDelete: 'cascade' }),
    permissionId: uuid('permission_id')
      .notNull()
      .references(() => permissionsTable.id),
    grantedByAdminId: uuid('granted_by_admin_id').references(() => adminsTable.id),
    /** Why this admin has this one-off permission, shown beside the grant on the access screen. */
    reason: text('reason'),
    grantedAt: timestamp('granted_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.adminId, table.permissionId] }),
    index().on(table.permissionId),
  ],
);

export type AdminPermissionGrantRow = typeof adminPermissionGrantsTable.$inferSelect;
export type NewAdminPermissionGrantRow = typeof adminPermissionGrantsTable.$inferInsert;
