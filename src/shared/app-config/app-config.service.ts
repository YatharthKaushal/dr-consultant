import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DATABASE } from '../../config/db/database.module';
import type { Database } from '../../config/db/database.config';
import { appConfigTable } from '../../schema/app-config.schema';

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

/**
 * Read-only access to `app_config` — the OTP thresholds this module needs
 * (`otp.request.max_per_number_per_hour` and friends, see
 * `identity.constants.ts`) live there rather than in env, per SRS 6.6
 * ("editable from the admin panel without an app release").
 *
 * A 30-second in-process memo keeps the hot OTP-request/verify path from
 * costing one extra query per call; `invalidate()` is exposed for the write
 * side (a later module) to call after an admin edits a value.
 *
 * Every getter takes a compiled-in fallback: a missing or malformed row
 * degrades to that default rather than breaking sign-in. This is
 * deliberately the read-only half only — writing config (with a before/after
 * `audit_log` entry) belongs to the module that builds the admin config
 * screen, not here.
 */
@Injectable()
export class AppConfigService {
  private static readonly TTL_MS = 30_000;

  private readonly cache = new Map<string, CacheEntry>();

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async getNumber(key: string, fallback: number): Promise<number> {
    const value = await this.read(key);
    return typeof value === 'number' ? value : fallback;
  }

  async getJson<T>(key: string, fallback: T): Promise<T> {
    const value = await this.read(key);
    return value === undefined ? fallback : (value as T);
  }

  /** Drops the memoized value for `key`, forcing the next read to hit the database. */
  invalidate(key: string): void {
    this.cache.delete(key);
  }

  private async read(key: string): Promise<unknown> {
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const [row] = await this.db
      .select({ value: appConfigTable.value })
      .from(appConfigTable)
      .where(eq(appConfigTable.key, key))
      .limit(1);

    const value = row?.value;
    this.cache.set(key, { value, expiresAt: Date.now() + AppConfigService.TTL_MS });
    return value;
  }
}
