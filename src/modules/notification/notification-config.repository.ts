import { Inject, Injectable } from '@nestjs/common';
import { inArray } from 'drizzle-orm';
import { DATABASE } from '../../config/db/database.module';
import type { Database, DatabaseTransaction } from '../../config/db/database.config';
import { appConfigTable } from '../../schema/app-config.schema';

type Executor = Database | DatabaseTransaction;

/**
 * `app_config` access for the `notifications.*` keys, and ONLY those.
 *
 * A direct counterpart of `search-config.repository.ts` and
 * `payment-config.repository.ts`, for the same reason they give:
 * `app_config` is not owned by any one module, so the boundary rule that
 * applies is `docs/MODULES.md` §7 — "Configuration lives with its owning
 * module and is edited from the admin panel." `docs/erd.sql`'s `app_config`
 * comment lists `notifications.templates` in its inventory of admin-editable
 * keys, so M-08 owns that key and nothing else, and
 * `notification-template.service.ts` refuses to write anything outside that
 * set rather than trusting its caller.
 *
 * The READ half is `AppConfigService` (shared, memoized 30s). This exists for
 * the WRITE half, which that service deliberately does not provide.
 */
@Injectable()
export class NotificationConfigRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Raw current values for the given keys. A key with no row is simply absent — the caller substitutes the compiled-in default copy. */
  async findByKeys(keys: readonly string[], executor: Executor = this.db): Promise<Map<string, unknown>> {
    if (keys.length === 0) return new Map();
    const rows = await executor
      .select({ key: appConfigTable.key, value: appConfigTable.value })
      .from(appConfigTable)
      .where(inArray(appConfigTable.key, [...keys]));
    return new Map(rows.map((row) => [row.key, row.value]));
  }

  /**
   * The same read, but taking a ROW LOCK — for the read-modify-write an
   * edit to one template performs against the whole `notifications.templates`
   * map.
   *
   * Payments and search each store one scalar per key, so their edits are a
   * single `upsert` and cannot lose data. Template copy is one JSON OBJECT
   * under one key, so editing `booking_confirmed` means reading nine
   * templates, replacing one, and writing nine back. Two admins editing two
   * DIFFERENT templates at the same moment would otherwise have the later
   * write silently discard the earlier one.
   *
   * `FOR UPDATE` on the existing row serialises them. A key with no row yet
   * has nothing to lock; the concurrent inserts then race to
   * `onConflictDoUpdate`, which is the same window `search-config` and
   * `payment-config` already accept, and it closes permanently the first time
   * either the seed or any edit writes the row.
   */
  async findByKeysForUpdate(keys: readonly string[], executor: Executor): Promise<Map<string, unknown>> {
    if (keys.length === 0) return new Map();
    const rows = await executor
      .select({ key: appConfigTable.key, value: appConfigTable.value })
      .from(appConfigTable)
      .where(inArray(appConfigTable.key, [...keys]))
      .for('update');
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
