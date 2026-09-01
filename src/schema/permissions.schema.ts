import { index, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

/**
 * The fine-grained permission catalog — 'doctors.verify', 'payments.refund',
 * and so on. Code-owned: rows are seeded from the `PERMISSION_DEFINITIONS`
 * const in `src/shared/auth/permission.catalog.ts` and never created
 * through an API, same relationship `followup_pathways` has to the client's
 * authored question sets, except this catalog is authored by developers
 * adding a new endpoint, not by an admin.
 *
 * `module` is technically derivable by splitting `key` on '.', and is
 * stored anyway so the grouped catalog listing (the admin access screen
 * groups checkboxes by module) is an indexed scan rather than a per-row
 * string split, and so the group label can be curated independently of the
 * key later.
 */
export const permissionsTable = pgTable(
  'permissions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    /** e.g. 'doctors.verify' — matches a `PermissionKey` in the code-owned catalog. */
    key: varchar('key', { length: 80 }).notNull().unique(),
    /** e.g. 'doctors' — the grouping header on the access screen. */
    module: varchar('module', { length: 40 }).notNull(),
    description: text('description').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [index().on(table.module, table.key)],
);

export type PermissionRow = typeof permissionsTable.$inferSelect;
export type NewPermissionRow = typeof permissionsTable.$inferInsert;
