import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import type { Database, DatabaseTransaction } from '../../config/db/database.config';
import { DATABASE } from '../../config/db/database.module';
import { deletedAccountsTable, type DeletedAccountRow } from '../../schema/deleted-accounts.schema';
import type { DeletableAccountType } from '../../schema/enums.schema';

/** A Drizzle db handle or an open transaction — every method here accepts either, defaulting to the module's own pooled connection. */
type Executor = Database | DatabaseTransaction;

/** `deleted_accounts` CRUD — see the table's own header (`schema/deleted-accounts.schema.ts`) for why nothing here ever hard-deletes a row. */
@Injectable()
export class DeletedAccountsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async insert(
    data: {
      accountType: DeletableAccountType;
      accountId: string;
      deletionRequestId: string;
      snapshot: Record<string, unknown>;
      originalMobileNumber: string;
      deletedByAdminId: string | null;
    },
    executor: Executor = this.db,
  ): Promise<DeletedAccountRow> {
    const [row] = await executor.insert(deletedAccountsTable).values(data).returning();
    if (!row) {
      throw new Error('deleted_accounts insert returned no row — should be unreachable.');
    }
    return row;
  }

  async findById(id: string, executor: Executor = this.db): Promise<DeletedAccountRow | null> {
    const [row] = await executor.select().from(deletedAccountsTable).where(eq(deletedAccountsTable.id, id)).limit(1);
    return row ?? null;
  }

  /** The one LIVE (not-yet-restored) snapshot for an account, if any — `deleted_accounts_live_account_idx` guarantees at most one. */
  async findLiveByAccount(accountType: DeletableAccountType, accountId: string, executor: Executor = this.db): Promise<DeletedAccountRow | null> {
    const [row] = await executor
      .select()
      .from(deletedAccountsTable)
      .where(and(eq(deletedAccountsTable.accountType, accountType), eq(deletedAccountsTable.accountId, accountId), isNull(deletedAccountsTable.restoredAt)))
      .limit(1);
    return row ?? null;
  }

  async list(
    input: { accountType?: DeletableAccountType; restored?: boolean; limit: number; offset: number },
    executor: Executor = this.db,
  ): Promise<DeletedAccountRow[]> {
    const conditions = [];
    if (input.accountType) conditions.push(eq(deletedAccountsTable.accountType, input.accountType));
    if (input.restored !== undefined) {
      conditions.push(input.restored ? isNotNull(deletedAccountsTable.restoredAt) : isNull(deletedAccountsTable.restoredAt));
    }
    return executor
      .select()
      .from(deletedAccountsTable)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(deletedAccountsTable.deletedAt))
      .limit(input.limit)
      .offset(input.offset);
  }

  /** The un-do — sets `restoredAt`/`restoredByAdminId`. Guarded on `restoredAt IS NULL` so a double-restore is refused (`null` return) rather than silently overwriting who restored it first. */
  async markRestored(id: string, restoredByAdminId: string, executor: Executor = this.db): Promise<DeletedAccountRow | null> {
    const [row] = await executor
      .update(deletedAccountsTable)
      .set({ restoredAt: new Date(), restoredByAdminId })
      .where(and(eq(deletedAccountsTable.id, id), isNull(deletedAccountsTable.restoredAt)))
      .returning();
    return row ?? null;
  }
}
