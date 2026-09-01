import { pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

/**
 * A fixed, seeded set of six roles — super_admin, operations,
 * clinical_governance, care_coordinator, finance, content — the exact names
 * SRS 2.2/4.1 describe. No role-management screen: rows are written once by
 * `identity.seed.ts` from `src/shared/auth/permission.catalog.ts`, the
 * code-owned source of truth, and never created through an API.
 *
 * Promoted from what used to be `admins.permission_level` (a single enum
 * column) to a table for exactly one reason: an admin must be able to hold
 * MORE THAN ONE role (`admin_roles` is many-to-many), which an enum column
 * cannot express.
 *
 * No `is_system` boolean — every row here is seeded, so a column that is
 * always true is not data, same bar `payments` applies to omitting a
 * `gateway` column. No hierarchy/parent column — bundles are flat, expressed
 * entirely through `role_permissions`.
 */
export const rolesTable = pgTable('roles', {
  id: uuid('id').defaultRandom().primaryKey(),
  code: varchar('code', { length: 40 }).notNull().unique(),
  /** Display label shown in the admin access screen. */
  name: varchar('name', { length: 120 }).notNull(),
  description: text('description'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export type RoleRow = typeof rolesTable.$inferSelect;
export type NewRoleRow = typeof rolesTable.$inferInsert;
