import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DATABASE } from '../../config/db/database.module';
import type { Database, DatabaseTransaction } from '../../config/db/database.config';
import { appConfigTable } from '../../schema/app-config.schema';

/** A Drizzle db handle or an open transaction — every method here accepts either, defaulting to the module's own pooled connection. */
type Executor = Database | DatabaseTransaction;

/**
 * `app_config` access for `release.policy`, and ONLY that key — the same
 * single-key shape `search-config.repository.ts`/`pricing-config.
 * repository.ts` use for their own key sets.
 */
@Injectable()
export class ReleaseConfigRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async find(key: string, executor: Executor = this.db): Promise<unknown> {
    const [row] = await executor.select({ value: appConfigTable.value }).from(appConfigTable).where(eq(appConfigTable.key, key)).limit(1);
    return row?.value;
  }

  async upsert(key: string, value: unknown, executor: Executor = this.db): Promise<void> {
    await executor
      .insert(appConfigTable)
      .values({ key, value })
      .onConflictDoUpdate({ target: appConfigTable.key, set: { value, updatedAt: new Date() } });
  }
}
