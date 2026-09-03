import { Inject, Injectable } from '@nestjs/common';
import { inArray } from 'drizzle-orm';
import { DATABASE } from '../../config/db/database.module';
import type { Database, DatabaseTransaction } from '../../config/db/database.config';
import { appConfigTable } from '../../schema/app-config.schema';

/** A Drizzle db handle or an open transaction, so a caller can compose a config write into one transaction. */
type Executor = Database | DatabaseTransaction;

/**
 * `app_config` access for the `pricing.*` keys, and ONLY those.
 *
 * A direct counterpart of `payment-config.repository.ts` and
 * `search-config.repository.ts`, for the same reason they give: `app_config` is
 * not owned by any one module, so the boundary rule that applies is
 * `docs/MODULES.md` §7 — configuration lives with its owning module. This module
 * owns the `pricing.*` keys and nothing else, and `pricing-config.service.ts`
 * refuses to write anything outside that set rather than trusting its caller.
 *
 * The READ half for hot paths is `AppConfigService` (shared, memoized 30s). This
 * exists for the WRITE half, which that service deliberately does not provide,
 * and for the uncached reads the write path needs for its before/after audit.
 */
@Injectable()
export class PricingConfigRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Raw current values for the given keys. A key with no row is simply absent — the caller substitutes the compiled-in fallback. */
  async findByKeys(keys: readonly string[], executor: Executor = this.db): Promise<Map<string, unknown>> {
    if (keys.length === 0) return new Map();
    const rows = await executor
      .select({ key: appConfigTable.key, value: appConfigTable.value })
      .from(appConfigTable)
      .where(inArray(appConfigTable.key, [...keys]));
    return new Map(rows.map((row) => [row.key, row.value]));
  }

  /** Insert-or-update one key. `key` is unique, so this is a single statement and safe under concurrent admin edits. */
  async upsert(key: string, value: unknown, executor: Executor = this.db): Promise<void> {
    await executor
      .insert(appConfigTable)
      .values({ key, value })
      .onConflictDoUpdate({ target: appConfigTable.key, set: { value, updatedAt: new Date() } });
  }
}
