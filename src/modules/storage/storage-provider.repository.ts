import { Inject, Injectable } from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';
import { DATABASE } from '../../config/db/database.module';
import type { Database, DatabaseTransaction } from '../../config/db/database.config';
import {
  storageProvidersTable,
  type StorageProviderConfig,
  type StorageProviderRow,
} from '../../schema/storage-providers.schema';
import type { StorageFailureKind } from './storage.constants';

/** A Drizzle db handle or an open transaction — every method here accepts either, defaulting to the module's own pooled connection. Mirrors `AgentCredentialRepository`. */
type Executor = Database | DatabaseTransaction;

/** Admin-editable fields only. The health columns are NOT here — they are written exclusively by `recordSuccess`/`recordFailure`. `provider` is absent on purpose: it is immutable (no POST/DELETE — see `storage-providers.schema.ts`). */
export interface StorageProviderUpdate {
  config?: StorageProviderConfig;
  isActive?: boolean;
  priority?: number;
}

/** `storage_providers` table reads/updates, plus the rotation candidate query. No `create`/`deleteById` — this table's only two rows are seeded once by `storage.seed.ts` and never created or removed through application code. */
@Injectable()
export class StorageProviderRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async findById(id: string, executor: Executor = this.db): Promise<StorageProviderRow | null> {
    const [row] = await executor.select().from(storageProvidersTable).where(eq(storageProvidersTable.id, id)).limit(1);
    return row ?? null;
  }

  /** Unambiguous because `provider` is UNIQUE — see `storage-providers.schema.ts`. What `getSignedUrl`/`delete` use to resolve a storage key's provider prefix back to its config. */
  async findByProvider(provider: string, executor: Executor = this.db): Promise<StorageProviderRow | null> {
    const [row] = await executor
      .select()
      .from(storageProvidersTable)
      .where(eq(storageProvidersTable.provider, provider))
      .limit(1);
    return row ?? null;
  }

  /** Every provider, active or not, in the order rotation would try them — the admin management list. */
  async list(executor: Executor = this.db): Promise<StorageProviderRow[]> {
    return executor.select().from(storageProvidersTable).orderBy(asc(storageProvidersTable.priority));
  }

  /** Active providers only, in rotation order — what `store()`'s candidate list is built from. */
  async listActive(executor: Executor = this.db): Promise<StorageProviderRow[]> {
    return executor
      .select()
      .from(storageProvidersTable)
      .where(eq(storageProvidersTable.isActive, true))
      .orderBy(asc(storageProvidersTable.priority));
  }

  /** `updated_at` is set here rather than by a DB trigger — same convention as `AgentProfileRepository#update`. */
  async update(id: string, data: StorageProviderUpdate, executor: Executor = this.db): Promise<StorageProviderRow | null> {
    const [row] = await executor
      .update(storageProvidersTable)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(storageProvidersTable.id, id))
      .returning();
    return row ?? null;
  }

  /**
   * Health write after a successful attempt. Clears `cooldown_until` — a
   * provider that just worked is by definition not cooling down. Mirrors
   * `AgentCredentialRepository#recordSuccess`. Never touches `is_active` —
   * see `storage-rotation.service.ts`.
   */
  async recordSuccess(id: string, at: Date, executor: Executor = this.db): Promise<void> {
    await executor
      .update(storageProvidersTable)
      .set({ consecutiveFailures: 0, lastSucceededAt: at, cooldownUntil: null, updatedAt: at })
      .where(eq(storageProvidersTable.id, id));
  }

  /**
   * Health write after a failed attempt. `consecutive_failures` is
   * incremented with a SQL expression, not read-modify-written in JS — two
   * concurrent attempts against the same provider must not lose one of them.
   * `cooldownUntil: null` means "this failure earns no cooldown" (a
   * `network_or_timeout` blip about to be retried), not "clear the existing
   * one" — mirrors `AgentCredentialRepository#recordFailure`'s conditional set.
   */
  async recordFailure(
    id: string,
    params: { at: Date; kind: StorageFailureKind; cooldownUntil: Date | null },
    executor: Executor = this.db,
  ): Promise<void> {
    await executor
      .update(storageProvidersTable)
      .set({
        consecutiveFailures: sql`${storageProvidersTable.consecutiveFailures} + 1`,
        lastFailureAt: params.at,
        lastFailureKind: params.kind,
        ...(params.cooldownUntil ? { cooldownUntil: params.cooldownUntil } : {}),
        updatedAt: params.at,
      })
      .where(eq(storageProvidersTable.id, id));
  }
}
