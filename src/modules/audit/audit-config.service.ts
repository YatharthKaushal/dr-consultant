import { BadRequestException, Injectable } from '@nestjs/common';
import { AppConfigService } from '../../shared/app-config/app-config.service';
import { AuditService } from '../../shared/audit/audit.service';
import {
  AUDIT_AUDIT_ENTITY_TYPES,
  AUDIT_CONFIG_FALLBACKS,
  AUDIT_CONFIG_KEYS,
  AUDIT_CONFIG_KEY_LIST,
  AUDIT_ERROR_CODES,
  AUDIT_PURGE_ELIGIBLE_ACTIONS,
  AUDIT_RETENTION_DAYS_BOUNDS,
  type AuditConfigKey,
} from './audit.constants';
import { AuditConfigRepository } from './audit-config.repository';

/** The resolved `audit.*` configuration, with a compiled-in fallback standing in for a missing or malformed row. */
export interface ResolvedAuditConfig {
  /** `0` = retention purging is OFF. */
  retentionDays: number;
  /**
   * Informational, not configurable: the fixed, narrow set of `audit_log.
   * action` values `retentionDays` may ever cause to be deleted — every
   * create/update/delete/read/export/webhook entry is kept regardless of
   * `retentionDays`. See `audit.constants.ts#AUDIT_PURGE_ELIGIBLE_ACTIONS`'s
   * header for the full reasoning against SRS §5.3.
   */
  purgeEligibleActions: readonly string[];
}

/** A `PUT /admin/audit/config` body. */
export interface AuditConfigUpdate {
  /** `0` disables purging. A non-zero value must be within `AUDIT_RETENTION_DAYS_BOUNDS`. */
  retentionDays?: number;
}

/**
 * The READ AND WRITE path for M-21's own `app_config` key — `docs/MODULES
 * .md`'s "Retention rules set by the client". Modelled line-for-line on
 * `search-config.service.ts`/`payment-config.service.ts`: key ownership,
 * shape validation, and an audited before/after with cache invalidation.
 *
 * *** WHAT THIS DOES NOT CONFIGURE. *** `retentionDays` bounds ONLY which
 * `login`/`verify` rows `audit-retention-sweep.service.ts` may delete once
 * they are older than the window. It has no effect on, and cannot be made to
 * have an effect on, any `create`/`update`/`delete`/`read`/`export`/
 * `webhook` row — those are excluded from the sweep at the constant level
 * (`AUDIT_PURGE_ELIGIBLE_ACTIONS`), not by this service's own logic, so a
 * caller of this service cannot widen the sweep's reach by any value passed
 * here.
 */
@Injectable()
export class AuditConfigService {
  constructor(
    private readonly repo: AuditConfigRepository,
    private readonly appConfig: AppConfigService,
    private readonly audit: AuditService,
  ) {}

  async getResolved(): Promise<ResolvedAuditConfig> {
    const stored = await this.repo.findByKeys(AUDIT_CONFIG_KEY_LIST);
    return {
      retentionDays: this.readRetentionDays(stored.get(AUDIT_CONFIG_KEYS.RETENTION_DAYS)),
      purgeEligibleActions: AUDIT_PURGE_ELIGIBLE_ACTIONS,
    };
  }

  /**
   * Writes only the fields present in `update`. A no-op call writes nothing
   * and audits nothing — same discipline `search-config.service.ts` uses.
   *
   * Built as a `{ key, value }` list, like `payment-config.service.ts
   * #toKeyedChanges`, even though there is only one key today: adding a
   * second `audit.*` key later (a purge batch size cap, say) is then a
   * one-line addition to `toKeyedChanges`, not a redesign of `update`.
   */
  async update(actingAdminId: string, update: AuditConfigUpdate): Promise<ResolvedAuditConfig> {
    const changes = this.toKeyedChanges(update);
    if (changes.length === 0) {
      return this.getResolved();
    }

    for (const change of changes) {
      this.assertOwnedKey(change.key);
      this.assertValidValue(change.key, change.value);
    }

    const before = await this.repo.findByKeys(changes.map((change) => change.key));

    for (const change of changes) {
      await this.repo.upsert(change.key, change.value);
      // *** Without this the 30s memo keeps the sweep reading the previous window. ***
      this.appConfig.invalidate(change.key);

      await this.audit.write({
        actorType: 'admin',
        actorId: actingAdminId,
        action: 'update',
        entityType: AUDIT_AUDIT_ENTITY_TYPES.CONFIG,
        // The key IS the entity — `app_config` rows are identified by key.
        entityId: change.key,
        metadata: { before: before.get(change.key) ?? null, after: change.value },
      });
    }

    return this.getResolved();
  }

  private toKeyedChanges(update: AuditConfigUpdate): Array<{ key: AuditConfigKey; value: unknown }> {
    const changes: Array<{ key: AuditConfigKey; value: unknown }> = [];
    if (update.retentionDays !== undefined) {
      changes.push({ key: AUDIT_CONFIG_KEYS.RETENTION_DAYS, value: update.retentionDays });
    }
    return changes;
  }

  /** Structurally unreachable from the controller (the DTO has no free-form key), and enforced anyway — the guard that keeps one shared `app_config` table from becoming one shared permission. */
  private assertOwnedKey(key: string): void {
    if (!(AUDIT_CONFIG_KEY_LIST as readonly string[]).includes(key)) {
      throw new BadRequestException({
        code: AUDIT_ERROR_CODES.CONFIG_KEY_NOT_OWNED,
        message: `${key} is not an audit configuration key.`,
      });
    }
  }

  /** Defensive re-check of the DTO's own bounds — services hold the rules, per `backend/README.md`, not just the HTTP layer. */
  private assertValidValue(key: AuditConfigKey, value: unknown): void {
    if (key !== AUDIT_CONFIG_KEYS.RETENTION_DAYS) return;

    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw this.invalid('retentionDays must be an integer.');
    }
    if (value === 0) return;
    if (value < AUDIT_RETENTION_DAYS_BOUNDS.min || value > AUDIT_RETENTION_DAYS_BOUNDS.max) {
      throw this.invalid(
        `retentionDays must be 0 (disabled) or between ${AUDIT_RETENTION_DAYS_BOUNDS.min} and ${AUDIT_RETENTION_DAYS_BOUNDS.max}.`,
      );
    }
  }

  private invalid(message: string): BadRequestException {
    return new BadRequestException({ code: AUDIT_ERROR_CODES.CONFIG_INVALID, message });
  }

  /** Tolerant reader — `app_config.value` is untyped jsonb. A missing or malformed row degrades to the shipped default (`0`: purging off), never to an unbounded/garbage window. */
  private readRetentionDays(value: unknown): number {
    if (typeof value !== 'number' || !Number.isInteger(value)) return AUDIT_CONFIG_FALLBACKS.RETENTION_DAYS;
    if (value === 0) return 0;
    if (value < AUDIT_RETENTION_DAYS_BOUNDS.min || value > AUDIT_RETENTION_DAYS_BOUNDS.max) {
      return AUDIT_CONFIG_FALLBACKS.RETENTION_DAYS;
    }
    return value;
  }
}
