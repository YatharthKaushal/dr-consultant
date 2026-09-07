import { index, jsonb, pgTable, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { adminsTable } from './admins.schema';
import { dataDeletionRequestsTable } from './data-deletion-requests.schema';
import { deletableAccountTypeEnum } from './enums.schema';

/**
 * *** THE "ANOTHER COPY, FOR SAFETY" TABLE. ***
 *
 * The whole account row as it stood the instant a data-deletion request
 * executed, snapshotted BEFORE `patients`/`doctors` is soft-deleted —
 * `deleted-accounts.service.ts#softDelete` writes this row and the account
 * table's own `deleted_at`/identifier-vacating write in the same
 * transaction. Nothing in this codebase ever hard-deletes an account: this
 * table plus `patients.deleted_at`/`doctors.deleted_at` is the entire
 * mechanism, and an admin restore reads this row back — see
 * `deleted-accounts.service.ts#restore`.
 *
 * `account_id` is NOT a foreign key to `patients`/`doctors`: the account
 * table's own row still exists (soft-deleted, not removed), so a real FK
 * would be redundant, not protective — this table's whole reason to exist
 * is to survive independently of whatever the account row's own columns
 * say. `original_mobile_number` is promoted out of `snapshot` (rather than
 * requiring a caller to parse jsonb) because restore's own availability
 * check reads it directly.
 *
 * `deleted_by_admin_id` is nullable — the sweep
 * (`data-rights-execution-sweep.service.ts`) executes on the platform's
 * own behalf when an admin never reviewed a request within its grace
 * period; `null` here is that, honestly, not a data-entry gap.
 */
export const deletedAccountsTable = pgTable(
  'deleted_accounts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    accountType: deletableAccountTypeEnum('account_type').notNull(),
    accountId: uuid('account_id').notNull(),
    deletionRequestId: uuid('deletion_request_id')
      .notNull()
      .references(() => dataDeletionRequestsTable.id),
    /** The whole account row, as `$inferSelect` shaped it, the instant before this execution touched it. */
    snapshot: jsonb('snapshot').$type<Record<string, unknown>>().notNull(),
    /** Promoted out of `snapshot` — restore's own uniqueness check reads this column directly, never parses jsonb for it. */
    originalMobileNumber: varchar('original_mobile_number', { length: 16 }).notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    /** `null` when the sweep executed this, not an admin — see the table's own header. */
    deletedByAdminId: uuid('deleted_by_admin_id').references(() => adminsTable.id),
    restoredAt: timestamp('restored_at', { withTimezone: true, mode: 'date' }),
    restoredByAdminId: uuid('restored_by_admin_id').references(() => adminsTable.id),
  },
  (table) => [
    index().on(table.accountType, table.accountId),
    index().on(table.deletionRequestId),
    /**
     * One LIVE (not-yet-restored) snapshot per account at a time — a
     * delete -> restore -> delete cycle writes a SECOND row rather than
     * reusing the first, so the full history survives, while this index
     * stops two concurrent executions of the same account producing two
     * simultaneously-"current" snapshots.
     */
    uniqueIndex('deleted_accounts_live_account_idx')
      .on(table.accountType, table.accountId)
      .where(sql`${table.restoredAt} is null`),
  ],
);

export type DeletedAccountRow = typeof deletedAccountsTable.$inferSelect;
export type NewDeletedAccountRow = typeof deletedAccountsTable.$inferInsert;
