import { BadRequestException, Injectable } from '@nestjs/common';
import { AppConfigService } from '../../shared/app-config/app-config.service';
import { AuditService } from '../../shared/audit/audit.service';
import {
  INSTANT_AUDIT_ENTITY_TYPES,
  INSTANT_CONFIG_BOUNDS,
  INSTANT_CONFIG_FALLBACKS,
  INSTANT_CONFIG_KEYS,
  INSTANT_CONFIG_KEY_LIST,
  INSTANT_ERROR_CODES,
  type InstantConfigKey,
} from './instant.constants';
import { InstantRepository } from './instant.repository';

/** The resolved `instant.*` configuration, with a compiled-in fallback standing in for every missing or malformed row. */
export interface ResolvedInstantConfig {
  /** FR-10.6's acceptance window. */
  acceptanceWindowSeconds: number;
  /** FR-10.2's accept-then-pay window. See `instant.constants.ts` for why it is NOT `booking.slot_hold_minutes`. */
  paymentWindowSeconds: number;
}

/** A `PUT /admin/instant-consults/config` body: every field optional, only the present ones are written. */
export interface InstantConfigUpdate {
  acceptanceWindowSeconds?: number;
  paymentWindowSeconds?: number;
}

/**
 * The READ AND WRITE path for M-13's own `app_config` keys.
 *
 * Modelled line-for-line on `payment-config.service.ts`, which carries the
 * same three responsibilities a bare config write does not:
 *
 *   1. KEY OWNERSHIP. Writes are restricted to `INSTANT_CONFIG_KEY_LIST`.
 *      `app_config` is one shared table, and one shared table must not become
 *      one shared permission — `search-config.service.ts` states the rule
 *      first and `payment-config.service.ts` mirrors it. An admin holding
 *      `appointments.manage` must not be able to reach `search.crisis_keywords`
 *      and switch off the safety guardrail, or `payments.gst_rate` and change
 *      what every patient is billed.
 *   2. SHAPE VALIDATION. `app_config.value` is untyped jsonb, so a bad write
 *      is not caught by the database. An acceptance window of `"sixty"`, `-5`
 *      or `1e9` would not fail here — it would fail at the next instant
 *      request, or worse, not fail at all and quietly turn every request into
 *      an immediate timeout.
 *   3. AUDIT + INVALIDATION. Every change writes an `audit_log` row carrying
 *      actor and BEFORE/AFTER, then calls `AppConfigService.invalidate(key)`.
 *      Without that last call the 30s memo keeps serving the old window, and
 *      an operator correcting it in the middle of an incident would watch
 *      nothing happen.
 *
 * The hot path — the router and both sweeps — reads through `AppConfigService`
 * (memoized 30s) rather than `getResolved` here, because it runs on every
 * routing decision and every sweep tick. This service's own reads are for the
 * admin screen and the write path.
 */
@Injectable()
export class InstantConfigService {
  constructor(
    private readonly repo: InstantRepository,
    private readonly appConfig: AppConfigService,
    private readonly audit: AuditService,
  ) {}

  /** FR-10.6's acceptance window, in seconds. The hot-path read — memoized 30s by `AppConfigService`, with the compiled-in fallback on a missing or malformed row. */
  async getAcceptanceWindowSeconds(): Promise<number> {
    return this.readBoundedNumber(
      INSTANT_CONFIG_KEYS.ACCEPTANCE_WINDOW_SECONDS,
      INSTANT_CONFIG_FALLBACKS.ACCEPTANCE_WINDOW_SECONDS,
    );
  }

  /** FR-10.2's accept-then-pay window, in seconds. Same read discipline as above. */
  async getPaymentWindowSeconds(): Promise<number> {
    return this.readBoundedNumber(
      INSTANT_CONFIG_KEYS.PAYMENT_WINDOW_SECONDS,
      INSTANT_CONFIG_FALLBACKS.PAYMENT_WINDOW_SECONDS,
    );
  }

  /** Both values, resolved. One query for the set, not one per key — for the admin screen. */
  async getResolved(): Promise<ResolvedInstantConfig> {
    const stored = await this.repo.findConfigByKeys(INSTANT_CONFIG_KEY_LIST);
    return {
      acceptanceWindowSeconds: this.coerce(
        INSTANT_CONFIG_KEYS.ACCEPTANCE_WINDOW_SECONDS,
        stored.get(INSTANT_CONFIG_KEYS.ACCEPTANCE_WINDOW_SECONDS),
        INSTANT_CONFIG_FALLBACKS.ACCEPTANCE_WINDOW_SECONDS,
      ),
      paymentWindowSeconds: this.coerce(
        INSTANT_CONFIG_KEYS.PAYMENT_WINDOW_SECONDS,
        stored.get(INSTANT_CONFIG_KEYS.PAYMENT_WINDOW_SECONDS),
        INSTANT_CONFIG_FALLBACKS.PAYMENT_WINDOW_SECONDS,
      ),
    };
  }

  /**
   * Writes only the fields present in `update`. A no-op call writes nothing
   * and audits nothing — no misleading audit entry, the same discipline
   * `payment-config.service.ts`, `search-config.service.ts` and
   * `doctor.service.ts` use.
   */
  async update(actingAdminId: string, update: InstantConfigUpdate): Promise<ResolvedInstantConfig> {
    const changes = this.toKeyedChanges(update);
    if (changes.length === 0) {
      return this.getResolved();
    }

    for (const change of changes) {
      this.assertOwnedKey(change.key);
      this.assertValidValue(change.key, change.value);
    }

    const before = await this.repo.findConfigByKeys(changes.map((change) => change.key));

    for (const change of changes) {
      await this.repo.upsertConfig(change.key, change.value);
      // *** Without this the 30s memo keeps routing on the previous window. ***
      this.appConfig.invalidate(change.key);

      await this.audit.write({
        actorType: 'admin',
        actorId: actingAdminId,
        action: 'update',
        entityType: INSTANT_AUDIT_ENTITY_TYPES.CONFIG,
        // The key IS the entity — `app_config` rows are identified by key, and
        // an auditor asking who last widened the acceptance window should not
        // have to know a uuid.
        entityId: change.key,
        metadata: { before: before.get(change.key) ?? null, after: change.value },
      });
    }

    return this.getResolved();
  }

  private toKeyedChanges(update: InstantConfigUpdate): Array<{ key: InstantConfigKey; value: unknown }> {
    const changes: Array<{ key: InstantConfigKey; value: unknown }> = [];
    if (update.acceptanceWindowSeconds !== undefined) {
      changes.push({ key: INSTANT_CONFIG_KEYS.ACCEPTANCE_WINDOW_SECONDS, value: update.acceptanceWindowSeconds });
    }
    if (update.paymentWindowSeconds !== undefined) {
      changes.push({ key: INSTANT_CONFIG_KEYS.PAYMENT_WINDOW_SECONDS, value: update.paymentWindowSeconds });
    }
    return changes;
  }

  /**
   * Structurally unreachable from the controller (the DTO has no free-form
   * key), and enforced anyway — this is the guard that keeps one shared
   * `app_config` table from becoming one shared permission.
   */
  private assertOwnedKey(key: string): void {
    if (!(INSTANT_CONFIG_KEY_LIST as readonly string[]).includes(key)) {
      throw new BadRequestException({
        code: INSTANT_ERROR_CODES.CONFIG_KEY_NOT_OWNED,
        message: `${key} is not an instant-consult configuration key.`,
      });
    }
  }

  /** Defensive re-check of the DTO's own bounds — services hold the rules, per `backend/README.md`, not just the HTTP layer. */
  private assertValidValue(key: InstantConfigKey, value: unknown): void {
    const bounds = INSTANT_CONFIG_BOUNDS[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw this.invalid(`${key} must be a number of seconds.`);
    }
    // Both windows are whole seconds: `expires_at` is a timestamp and a
    // fractional second buys nothing, while `30.5` in a panel is a typo.
    if (!Number.isInteger(value)) {
      throw this.invalid(`${key} must be a whole number of seconds.`);
    }
    if (value < bounds.min || value > bounds.max) {
      throw this.invalid(`${key} must be between ${bounds.min} and ${bounds.max} seconds.`);
    }
  }

  private invalid(message: string): BadRequestException {
    return new BadRequestException({ code: INSTANT_ERROR_CODES.CONFIG_INVALID, message });
  }

  /**
   * Tolerant hot-path reader. A missing, malformed or out-of-range row
   * degrades to the compiled-in default rather than throwing: routing at the
   * documented default is a defensible outcome, and refusing every instant
   * request because one config row is malformed is not.
   */
  private async readBoundedNumber(key: InstantConfigKey, fallback: number): Promise<number> {
    const value = await this.appConfig.getNumber(key, fallback);
    return this.coerce(key, value, fallback);
  }

  private coerce(key: InstantConfigKey, value: unknown, fallback: number): number {
    const bounds = INSTANT_CONFIG_BOUNDS[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    if (!Number.isInteger(value)) return fallback;
    if (value < bounds.min || value > bounds.max) return fallback;
    return value;
  }
}
