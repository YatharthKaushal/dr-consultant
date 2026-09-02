import { Inject, Injectable } from '@nestjs/common';
import { inArray } from 'drizzle-orm';
import { DATABASE } from '../../config/db/database.module';
import type { Database, DatabaseTransaction } from '../../config/db/database.config';
import { appConfigTable } from '../../schema/app-config.schema';

/** A Drizzle db handle or an open transaction — every method here accepts either, defaulting to the module's own pooled connection. */
type Executor = Database | DatabaseTransaction;

/**
 * `app_config` access for the `search.*` keys, and ONLY those.
 *
 * `app_config` is not owned by any one module, so the boundary rule that
 * applies is `docs/MODULES.md` §7: "Configuration lives with its owning
 * module and is edited from the admin panel: mapping and crisis keywords in
 * M-09". M-09 therefore owns the `search.*` keys and nothing else, which is
 * why `upsert` refuses to write a key outside that set rather than trusting
 * its caller — see `search-config.service.ts`.
 *
 * The READ half of config is `AppConfigService` (shared, memoized 30s). This
 * repository exists for the WRITE half, which that service deliberately does
 * not provide: its own doc comment says "writing config (with a before/after
 * `audit_log` entry) belongs to the module that builds the admin config
 * screen, not here." This is that module.
 */
@Injectable()
export class SearchConfigRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Raw current values for the given keys. A key with no row is simply absent from the map — the caller substitutes the compiled-in fallback. */
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
