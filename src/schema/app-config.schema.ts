import { jsonb, pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';

/**
 * Everything the admin can change without a release, as JSON values — fee
 * and GST percentages, booking policy, search keywords, notification
 * templates, retention policy, video join-token timings, and so on.
 *
 * The LiveKit server URL and gateway secrets are NOT here — they are
 * environment secrets, never admin-editable data. Every change is written as
 * an `audit_log` row carrying actor and before/after value, so this table
 * needs no versions table and no `updated_by_admin_id` of its own.
 */
export const appConfigTable = pgTable('app_config', {
  id: uuid('id').defaultRandom().primaryKey(),
  key: varchar('key', { length: 160 }).notNull().unique(),
  value: jsonb('value').$type<unknown>().notNull(),
  description: text('description'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
});

export type AppConfigRow = typeof appConfigTable.$inferSelect;
export type NewAppConfigRow = typeof appConfigTable.$inferInsert;
