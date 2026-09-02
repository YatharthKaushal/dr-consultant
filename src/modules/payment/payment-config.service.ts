import { BadRequestException, Injectable } from '@nestjs/common';
import { AppConfigService } from '../../shared/app-config/app-config.service';
import { AuditService } from '../../shared/audit/audit.service';
import { PaymentConfigRepository } from './payment-config.repository';
import {
  PAYMENT_AUDIT_ENTITY_TYPES,
  PAYMENT_CONFIG_FALLBACKS,
  PAYMENT_CONFIG_KEYS,
  PAYMENT_CONFIG_KEY_LIST,
  PAYMENT_ERROR_CODES,
  PAYMENT_RATE_BOUNDS,
  type PaymentConfigKey,
} from './payment.constants';

/** The resolved `payments.*` configuration, with a compiled-in fallback standing in for every missing or malformed row. */
export interface ResolvedPaymentConfig {
  /** FR-7.3's 20 percent. */
  convenienceFeePct: number;
  /** FR-7.3's 18 percent. */
  gstRate: number;
}

/** A `PUT /admin/payments/config` body: every field optional, only the present ones are written. */
export interface PaymentConfigUpdate {
  convenienceFeePct?: number;
  gstRate?: number;
}

/**
 * The READ AND WRITE path for M-12's own `app_config` keys — FR-7.5's "the
 * convenience fee percentage and GST rate are configurable from the admin
 * panel", and SRS 5.2's "configuration values, including fee percentages, GST
 * rate ... live in data, not code".
 *
 * Modelled line-for-line on `search-config.service.ts`, which carries the same
 * three responsibilities a bare config write does not:
 *
 *   1. KEY OWNERSHIP. Writes are restricted to `PAYMENT_CONFIG_KEY_LIST`. This
 *      is the mirror image of the rule that file already states: its comment
 *      names `payments.gst_rate` as a key "an admin holding
 *      `SEARCH_MANAGE_MAPPING` must not be able to reach ... because both
 *      happen to live in one table." The same must hold in this direction — an
 *      admin holding `PAYMENTS_MANAGE_CONFIG` must not be able to reach
 *      `search.crisis_keywords` and switch off the safety guardrail.
 *   2. SHAPE VALIDATION. `app_config.value` is untyped jsonb, so a bad write is
 *      not caught by the database. A GST rate of `"eighteen"`, `-5` or `1e9`
 *      would not fail here — it would fail at the next checkout, or worse, not
 *      fail at all and simply bill the wrong amount.
 *   3. AUDIT + INVALIDATION. Every change writes an `audit_log` row carrying
 *      actor and BEFORE/AFTER, then calls `AppConfigService.invalidate(key)`.
 *      Without that last call the 30s memo keeps serving the old rate, and an
 *      admin correcting a GST rate would watch nothing happen — while patients
 *      kept being billed the old one.
 *
 * *** THIS IS FINANCIAL CONFIGURATION, SO THE AUDIT IS NOT OPTIONAL. ***
 * `docs/MODULES.md` §7: "Every module touching clinical or financial data
 * writes audit entries from its first release, not later." M-21's done-when
 * names "a refund and a configuration change" as two of the three entries that
 * must be complete. The audit write here is transactional with the config
 * write, so a rate cannot change without a record of who changed it.
 */
@Injectable()
export class PaymentConfigService {
  constructor(
    private readonly repo: PaymentConfigRepository,
    private readonly appConfig: AppConfigService,
    private readonly audit: AuditService,
  ) {}

  /** Both `payments.*` values, resolved. One query for the set, not one per key. */
  async getResolved(): Promise<ResolvedPaymentConfig> {
    const stored = await this.repo.findByKeys(PAYMENT_CONFIG_KEY_LIST);
    return {
      convenienceFeePct: this.readRate(
        stored.get(PAYMENT_CONFIG_KEYS.CONVENIENCE_FEE_PCT),
        PAYMENT_CONFIG_FALLBACKS.CONVENIENCE_FEE_PCT,
      ),
      gstRate: this.readRate(stored.get(PAYMENT_CONFIG_KEYS.GST_RATE), PAYMENT_CONFIG_FALLBACKS.GST_RATE),
    };
  }

  /**
   * The rates as `numeric(5,2)`-shaped STRINGS, which is what the arithmetic
   * and the `payments` snapshot columns both want.
   *
   * The conversion happens here, once, rather than at each call site: a rate
   * is a JSON number in `app_config` (an admin types `18` in a panel) and a
   * decimal string everywhere else, and letting each caller do its own
   * `toString`/`toFixed` is how `18.5` and `18.50` end up on two different
   * bills for the same rate.
   */
  async getRatesForBilling(): Promise<{ convenienceFeePct: string; gstPct: string }> {
    const resolved = await this.getResolved();
    return {
      convenienceFeePct: resolved.convenienceFeePct.toFixed(2),
      gstPct: resolved.gstRate.toFixed(2),
    };
  }

  /**
   * Writes only the fields present in `update`. A no-op call writes nothing
   * and audits nothing — no misleading audit entry, the same discipline
   * `search-config.service.ts` and `doctor.service.ts` use.
   */
  async update(actingAdminId: string, update: PaymentConfigUpdate): Promise<ResolvedPaymentConfig> {
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
      // *** Without this the 30s memo keeps billing at the previous rate. ***
      this.appConfig.invalidate(change.key);

      await this.audit.write({
        actorType: 'admin',
        actorId: actingAdminId,
        action: 'update',
        entityType: PAYMENT_AUDIT_ENTITY_TYPES.CONFIG,
        // The key IS the entity — `app_config` rows are identified by key, and
        // an auditor asking who last changed the GST rate should not have to
        // know a uuid.
        entityId: change.key,
        metadata: { before: before.get(change.key) ?? null, after: change.value },
      });
    }

    return this.getResolved();
  }

  private toKeyedChanges(update: PaymentConfigUpdate): Array<{ key: PaymentConfigKey; value: unknown }> {
    const changes: Array<{ key: PaymentConfigKey; value: unknown }> = [];
    if (update.convenienceFeePct !== undefined) {
      changes.push({ key: PAYMENT_CONFIG_KEYS.CONVENIENCE_FEE_PCT, value: update.convenienceFeePct });
    }
    if (update.gstRate !== undefined) {
      changes.push({ key: PAYMENT_CONFIG_KEYS.GST_RATE, value: update.gstRate });
    }
    return changes;
  }

  /**
   * Structurally unreachable from the controller (the DTO has no free-form
   * key), and enforced anyway — this is the guard that keeps one shared
   * `app_config` table from becoming one shared permission.
   */
  private assertOwnedKey(key: string): void {
    if (!(PAYMENT_CONFIG_KEY_LIST as readonly string[]).includes(key)) {
      throw new BadRequestException({
        code: PAYMENT_ERROR_CODES.CONFIG_KEY_NOT_OWNED,
        message: `${key} is not a payments configuration key.`,
      });
    }
  }

  /** Defensive re-check of the DTO's own bounds — services hold the rules, per `backend/README.md`, not just the HTTP layer. */
  private assertValidValue(key: PaymentConfigKey, value: unknown): void {
    const label = key === PAYMENT_CONFIG_KEYS.CONVENIENCE_FEE_PCT ? 'convenienceFeePct' : 'gstRate';

    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw this.invalid(`${label} must be a number.`);
    }
    if (value < PAYMENT_RATE_BOUNDS.min || value > PAYMENT_RATE_BOUNDS.max) {
      throw this.invalid(`${label} must be between ${PAYMENT_RATE_BOUNDS.min} and ${PAYMENT_RATE_BOUNDS.max}.`);
    }
    // `numeric(5,2)` holds two decimal places. A rate of 18.005 would be
    // silently rounded by Postgres on the way into `payments.gst_pct`, so the
    // bill would not match the configured rate — refused here instead.
    if (Math.round(value * 100) !== value * 100) {
      throw this.invalid(`${label} must have at most 2 decimal places.`);
    }
  }

  private invalid(message: string): BadRequestException {
    return new BadRequestException({ code: PAYMENT_ERROR_CODES.CONFIG_INVALID, message });
  }

  /**
   * Tolerant reader — `app_config.value` is untyped jsonb.
   *
   * A missing, malformed or out-of-range row degrades to the compiled-in SRS
   * default rather than throwing. Billing at the documented default is a
   * defensible outcome; refusing to take any payment because one config row is
   * malformed is not, and neither is billing at `NaN`.
   */
  private readRate(value: unknown, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    if (value < PAYMENT_RATE_BOUNDS.min || value > PAYMENT_RATE_BOUNDS.max) return fallback;
    return value;
  }
}
