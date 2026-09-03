import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../shared/app-config/app-config.service';
import { AuditService } from '../../shared/audit/audit.service';
import { PromotionConfigRepository } from './promotion-config.repository';
import {
  PROMOTION_AUDIT_ENTITY_TYPES,
  PROMOTION_CONFIG_BOUNDS,
  PROMOTION_CONFIG_FALLBACKS,
  PROMOTION_CONFIG_KEYS,
  PROMOTION_CONFIG_KEY_LIST,
  PROMOTION_DEFAULT_REFERRAL_PROGRAM,
  PROMOTION_ERROR_CODES,
  type PromotionConfigKey,
  type ReferralProgramConfig,
  type ReferralRewardConfig,
} from './promotion.constants';

/** The resolved `promotion.*` configuration, with a compiled-in fallback standing in for every missing or malformed row. */
export interface ResolvedPromotionConfig {
  referralProgram: ReferralProgramConfig;
  /** *** THE DEPLOYMENT TRAP, DEFUSED. *** See `PROMOTION_DEFAULT_QUALIFYING_STATUSES`. */
  referralQualifyingStatuses: readonly string[];
  /** *** SHIPS `false`. *** The master switch for the entire doctor-affiliate mechanism. */
  affiliateEnabled: boolean;
  affiliateAttributionDays: number;
  reservationGraceMinutes: number;
  codeAttemptsPerPatientPerHour: number;
  codeAttemptsPerIpPerHour: number;
}

/** A `PUT /admin/promotions/config` body: every field optional, only the present ones are written. */
export interface PromotionConfigUpdate {
  referralProgram?: unknown;
  referralQualifyingStatuses?: string[];
  affiliateEnabled?: boolean;
  affiliateAttributionDays?: number;
  reservationGraceMinutes?: number;
  codeAttemptsPerPatientPerHour?: number;
  codeAttemptsPerIpPerHour?: number;
}

/**
 * The READ AND WRITE path for M-13's own `app_config` keys.
 *
 * Modelled line-for-line on `payment-config.service.ts`, which carries the same
 * three responsibilities a bare config write does not:
 *
 *   1. KEY OWNERSHIP. Writes are restricted to `PROMOTION_CONFIG_KEY_LIST`. An
 *      admin holding `promotions.manage` must not be able to reach
 *      `payments.gst_rate` or `search.crisis_keywords` just because all three
 *      live in one table.
 *   2. SHAPE VALIDATION. `app_config.value` is untyped jsonb, so a bad write is
 *      not caught by the database. A referral programme with a `percent` reward
 *      and no `maxDiscountAmount` would not fail here — it would fail LATER, at
 *      `discount_instruments_value_check`, when a reward mint tries to insert
 *      an uncapped percentage instrument, inside a sweep, hours after the edit.
 *   3. AUDIT + INVALIDATION. Every change writes an `audit_log` row carrying
 *      actor and BEFORE/AFTER, then calls `AppConfigService.invalidate(key)`.
 *      Without that last call the 30s memo keeps serving the old value.
 *
 * *** THIS IS FINANCIAL CONFIGURATION, SO THE AUDIT IS NOT OPTIONAL. ***
 * `docs/MODULES.md` §7: "Every module touching clinical or financial data
 * writes audit entries from its first release, not later." A discount is money
 * leaving the platform, and switching the affiliate mechanism on is a decision
 * with a regulator attached — see `affiliate-partners.schema.ts`.
 */
@Injectable()
export class PromotionConfigService {
  private readonly logger = new Logger(PromotionConfigService.name);

  constructor(
    private readonly repo: PromotionConfigRepository,
    private readonly appConfig: AppConfigService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Every `promotion.*` value, resolved.
   *
   * Read through the SHARED `AppConfigService` rather than this module's own
   * repository, so the 30s memo applies: `preview` and `reserve` are on the
   * checkout path and must not each cost seven extra queries.
   */
  async getResolved(): Promise<ResolvedPromotionConfig> {
    const [
      referralProgram,
      referralQualifyingStatuses,
      affiliateEnabled,
      affiliateAttributionDays,
      reservationGraceMinutes,
      codeAttemptsPerPatientPerHour,
      codeAttemptsPerIpPerHour,
    ] = await Promise.all([
      this.appConfig.getJson<unknown>(PROMOTION_CONFIG_KEYS.REFERRAL_PROGRAM, PROMOTION_CONFIG_FALLBACKS.REFERRAL_PROGRAM),
      this.appConfig.getJson<unknown>(
        PROMOTION_CONFIG_KEYS.REFERRAL_QUALIFYING_STATUSES,
        PROMOTION_CONFIG_FALLBACKS.REFERRAL_QUALIFYING_STATUSES,
      ),
      this.appConfig.getJson<unknown>(PROMOTION_CONFIG_KEYS.AFFILIATE_ENABLED, PROMOTION_CONFIG_FALLBACKS.AFFILIATE_ENABLED),
      this.appConfig.getNumber(
        PROMOTION_CONFIG_KEYS.AFFILIATE_ATTRIBUTION_DAYS,
        PROMOTION_CONFIG_FALLBACKS.AFFILIATE_ATTRIBUTION_DAYS,
      ),
      this.appConfig.getNumber(
        PROMOTION_CONFIG_KEYS.RESERVATION_GRACE_MINUTES,
        PROMOTION_CONFIG_FALLBACKS.RESERVATION_GRACE_MINUTES,
      ),
      this.appConfig.getNumber(
        PROMOTION_CONFIG_KEYS.CODE_ATTEMPTS_PER_PATIENT_PER_HOUR,
        PROMOTION_CONFIG_FALLBACKS.CODE_ATTEMPTS_PER_PATIENT_PER_HOUR,
      ),
      this.appConfig.getNumber(
        PROMOTION_CONFIG_KEYS.CODE_ATTEMPTS_PER_IP_PER_HOUR,
        PROMOTION_CONFIG_FALLBACKS.CODE_ATTEMPTS_PER_IP_PER_HOUR,
      ),
    ]);

    return {
      referralProgram: this.readReferralProgram(referralProgram),
      referralQualifyingStatuses: this.readStatusList(referralQualifyingStatuses),
      // *** ANY MALFORMED VALUE READS AS `false`. *** The affiliate switch fails
      // CLOSED, not open: `typeof value !== 'boolean'` degrades to off. Given
      // what the NMC regulation attaches to a doctor receiving a referral
      // commission, "we could not parse the config so we left it on" is not a
      // sentence anyone should have to say.
      affiliateEnabled: affiliateEnabled === true,
      affiliateAttributionDays: this.readBoundedNumber(
        affiliateAttributionDays,
        PROMOTION_CONFIG_BOUNDS.ATTRIBUTION_DAYS,
        PROMOTION_CONFIG_FALLBACKS.AFFILIATE_ATTRIBUTION_DAYS,
      ),
      reservationGraceMinutes: this.readBoundedNumber(
        reservationGraceMinutes,
        PROMOTION_CONFIG_BOUNDS.RESERVATION_GRACE_MINUTES,
        PROMOTION_CONFIG_FALLBACKS.RESERVATION_GRACE_MINUTES,
      ),
      codeAttemptsPerPatientPerHour: this.readBoundedNumber(
        codeAttemptsPerPatientPerHour,
        PROMOTION_CONFIG_BOUNDS.CODE_ATTEMPTS,
        PROMOTION_CONFIG_FALLBACKS.CODE_ATTEMPTS_PER_PATIENT_PER_HOUR,
      ),
      codeAttemptsPerIpPerHour: this.readBoundedNumber(
        codeAttemptsPerIpPerHour,
        PROMOTION_CONFIG_BOUNDS.CODE_ATTEMPTS,
        PROMOTION_CONFIG_FALLBACKS.CODE_ATTEMPTS_PER_IP_PER_HOUR,
      ),
    };
  }

  /**
   * Writes only the fields present in `update`. A no-op call writes nothing and
   * audits nothing — no misleading audit entry, the same discipline
   * `payment-config.service.ts` and `search-config.service.ts` use.
   */
  async update(actingAdminId: string, update: PromotionConfigUpdate): Promise<ResolvedPromotionConfig> {
    const changes = this.toKeyedChanges(update);
    if (changes.length === 0) return this.getResolved();

    for (const change of changes) {
      this.assertOwnedKey(change.key);
      this.assertValidValue(change.key, change.value);
    }

    const before = await this.repo.findByKeys(changes.map((change) => change.key));

    for (const change of changes) {
      await this.repo.upsert(change.key, change.value);
      // *** Without this the 30s memo keeps serving the previous value. ***
      this.appConfig.invalidate(change.key);

      await this.audit.write({
        actorType: 'admin',
        actorId: actingAdminId,
        action: 'update',
        entityType: PROMOTION_AUDIT_ENTITY_TYPES.CONFIG,
        // The key IS the entity — `app_config` rows are identified by key, and
        // an auditor asking who switched the affiliate mechanism on should not
        // have to know a uuid.
        entityId: change.key,
        metadata: {
          before: before.get(change.key) ?? null,
          after: change.value,
          // *** THE REGULATORY FLAG, ON THE ROW ITSELF. *** So the one audit
          // entry that matters most is findable by a predicate rather than by
          // reading every config change.
          ...(change.key === PROMOTION_CONFIG_KEYS.AFFILIATE_ENABLED
            ? { legalSignOffRequired: true, regulation: 'NMC Registered Medical Practitioner (Professional Conduct) Regulations, 2023' }
            : {}),
        },
      });

      if (change.key === PROMOTION_CONFIG_KEYS.AFFILIATE_ENABLED && change.value === true) {
        this.logger.warn(
          `Admin ${actingAdminId} ENABLED promotion.affiliate_enabled. Doctor affiliate commissions are now live. ` +
            "India's NMC Professional Conduct Regulations 2023 prohibit a registered practitioner from receiving a " +
            'commission for referring or procuring a patient; the exposure lands on the DOCTOR. This must be a ' +
            "recorded decision of the client's legal advisor — see affiliate-partners.schema.ts.",
        );
      }
    }

    return this.getResolved();
  }

  /* ---------------------------------------------------------------------- */

  private toKeyedChanges(update: PromotionConfigUpdate): Array<{ key: PromotionConfigKey; value: unknown }> {
    const changes: Array<{ key: PromotionConfigKey; value: unknown }> = [];
    if (update.referralProgram !== undefined) {
      changes.push({ key: PROMOTION_CONFIG_KEYS.REFERRAL_PROGRAM, value: update.referralProgram });
    }
    if (update.referralQualifyingStatuses !== undefined) {
      changes.push({
        key: PROMOTION_CONFIG_KEYS.REFERRAL_QUALIFYING_STATUSES,
        value: update.referralQualifyingStatuses,
      });
    }
    if (update.affiliateEnabled !== undefined) {
      changes.push({ key: PROMOTION_CONFIG_KEYS.AFFILIATE_ENABLED, value: update.affiliateEnabled });
    }
    if (update.affiliateAttributionDays !== undefined) {
      changes.push({ key: PROMOTION_CONFIG_KEYS.AFFILIATE_ATTRIBUTION_DAYS, value: update.affiliateAttributionDays });
    }
    if (update.reservationGraceMinutes !== undefined) {
      changes.push({ key: PROMOTION_CONFIG_KEYS.RESERVATION_GRACE_MINUTES, value: update.reservationGraceMinutes });
    }
    if (update.codeAttemptsPerPatientPerHour !== undefined) {
      changes.push({
        key: PROMOTION_CONFIG_KEYS.CODE_ATTEMPTS_PER_PATIENT_PER_HOUR,
        value: update.codeAttemptsPerPatientPerHour,
      });
    }
    if (update.codeAttemptsPerIpPerHour !== undefined) {
      changes.push({ key: PROMOTION_CONFIG_KEYS.CODE_ATTEMPTS_PER_IP_PER_HOUR, value: update.codeAttemptsPerIpPerHour });
    }
    return changes;
  }

  /**
   * Structurally unreachable from the controller (the DTO has no free-form
   * key), and enforced anyway — this is the guard that keeps one shared
   * `app_config` table from becoming one shared permission.
   */
  private assertOwnedKey(key: string): void {
    if (!(PROMOTION_CONFIG_KEY_LIST as readonly string[]).includes(key)) {
      throw new BadRequestException({
        code: PROMOTION_ERROR_CODES.CONFIG_KEY_NOT_OWNED,
        message: `${key} is not a promotions configuration key.`,
      });
    }
  }

  /** Defensive re-check of the DTO's own bounds — services hold the rules, per `backend/README.md`, not just the HTTP layer. */
  private assertValidValue(key: PromotionConfigKey, value: unknown): void {
    switch (key) {
      case PROMOTION_CONFIG_KEYS.AFFILIATE_ENABLED:
        if (typeof value !== 'boolean') throw this.invalid('affiliateEnabled must be a boolean.');
        return;

      case PROMOTION_CONFIG_KEYS.REFERRAL_QUALIFYING_STATUSES:
        if (!Array.isArray(value) || value.length === 0 || !value.every((entry) => typeof entry === 'string' && entry.length > 0)) {
          throw this.invalid('referralQualifyingStatuses must be a non-empty array of status names.');
        }
        // *** DELIBERATELY NOT VALIDATED AGAINST `CONSULTATION_STATUSES`. *** The
        // whole reason this key exists is that the status that matters is set by
        // a module that does not exist yet; refusing a value this build's enum
        // has not heard of would reintroduce exactly the deploy-to-change-a-
        // policy problem the key was created to remove. An unknown status simply
        // never matches, which is inert.
        return;

      case PROMOTION_CONFIG_KEYS.REFERRAL_PROGRAM:
        this.assertValidReferralProgram(value);
        return;

      case PROMOTION_CONFIG_KEYS.AFFILIATE_ATTRIBUTION_DAYS:
        this.assertBoundedInteger('affiliateAttributionDays', value, PROMOTION_CONFIG_BOUNDS.ATTRIBUTION_DAYS);
        return;

      case PROMOTION_CONFIG_KEYS.RESERVATION_GRACE_MINUTES:
        this.assertBoundedInteger('reservationGraceMinutes', value, PROMOTION_CONFIG_BOUNDS.RESERVATION_GRACE_MINUTES);
        return;

      case PROMOTION_CONFIG_KEYS.CODE_ATTEMPTS_PER_PATIENT_PER_HOUR:
        this.assertBoundedInteger('codeAttemptsPerPatientPerHour', value, PROMOTION_CONFIG_BOUNDS.CODE_ATTEMPTS);
        return;

      case PROMOTION_CONFIG_KEYS.CODE_ATTEMPTS_PER_IP_PER_HOUR:
        this.assertBoundedInteger('codeAttemptsPerIpPerHour', value, PROMOTION_CONFIG_BOUNDS.CODE_ATTEMPTS);
        return;

      default:
        throw this.invalid(`${String(key)} has no validator.`);
    }
  }

  private assertBoundedInteger(label: string, value: unknown, bounds: { min: number; max: number }): void {
    if (typeof value !== 'number' || !Number.isInteger(value)) throw this.invalid(`${label} must be a whole number.`);
    if (value < bounds.min || value > bounds.max) {
      throw this.invalid(`${label} must be between ${bounds.min} and ${bounds.max}.`);
    }
  }

  /**
   * The programme blob, validated field by field.
   *
   * *** THE `percent` + NO CAP CASE IS THE ONE THAT MATTERS. ***
   * `discount_instruments_value_check` REFUSES an uncapped percentage
   * instrument, because `doctors.consultation_fee_inr` is admin-settable with no
   * ceiling and "50% off" against a number somebody can raise later is an
   * unbounded liability. If that shape were accepted here, nothing would break
   * until a referral qualified — inside a sweep, hours later, with the failure
   * surfacing as a constraint violation nobody can connect back to a config
   * edit. So it is refused at the edit, where the message can name the field.
   */
  private assertValidReferralProgram(value: unknown): void {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw this.invalid('referralProgram must be an object.');
    }
    const program = value as Record<string, unknown>;

    if (typeof program.enabled !== 'boolean') throw this.invalid('referralProgram.enabled must be a boolean.');
    if (typeof program.refereeMustBeFirstConsultation !== 'boolean') {
      throw this.invalid('referralProgram.refereeMustBeFirstConsultation must be a boolean.');
    }
    if (
      program.maxQualifiedReferralsPerReferrer !== null &&
      (typeof program.maxQualifiedReferralsPerReferrer !== 'number' ||
        !Number.isInteger(program.maxQualifiedReferralsPerReferrer) ||
        program.maxQualifiedReferralsPerReferrer < 1)
    ) {
      throw this.invalid('referralProgram.maxQualifiedReferralsPerReferrer must be null or a positive whole number.');
    }

    this.assertValidRewardSide('referrerReward', program.referrerReward);
    this.assertValidRewardSide('refereeReward', program.refereeReward);
  }

  private assertValidRewardSide(label: string, value: unknown): void {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw this.invalid(`referralProgram.${label} must be an object.`);
    }
    const reward = value as Record<string, unknown>;

    if (typeof reward.enabled !== 'boolean') throw this.invalid(`referralProgram.${label}.enabled must be a boolean.`);
    if (reward.valueKind !== 'flat' && reward.valueKind !== 'percent') {
      throw this.invalid(`referralProgram.${label}.valueKind must be "flat" or "percent".`);
    }

    if (reward.valueKind === 'flat') {
      if (!isRupeeString(reward.flatAmount)) {
        throw this.invalid(`referralProgram.${label}.flatAmount must be an amount with at most two decimal places.`);
      }
    } else {
      if (!isPercentString(reward.percentRate)) {
        throw this.invalid(`referralProgram.${label}.percentRate must be a percentage with at most two decimal places.`);
      }
      // *** THE CHECK CONSTRAINT, ENFORCED AT THE EDIT. ***
      if (!isRupeeString(reward.maxDiscountAmount)) {
        throw this.invalid(
          `referralProgram.${label}.maxDiscountAmount is REQUIRED for a percentage reward — an uncapped percentage cannot be stored (discount_instruments_value_check).`,
        );
      }
    }

    if (!isRupeeString(reward.minOrderAmount)) {
      throw this.invalid(`referralProgram.${label}.minOrderAmount must be an amount with at most two decimal places.`);
    }
    this.assertBoundedInteger(
      `referralProgram.${label}.validityDays`,
      reward.validityDays,
      PROMOTION_CONFIG_BOUNDS.REWARD_VALIDITY_DAYS,
    );
    if (typeof reward.label !== 'string' || reward.label.trim().length === 0 || reward.label.length > 120) {
      throw this.invalid(`referralProgram.${label}.label must be a non-empty string of at most 120 characters.`);
    }
  }

  private invalid(message: string): BadRequestException {
    return new BadRequestException({ code: PROMOTION_ERROR_CODES.CONFIG_INVALID, message });
  }

  /* ---- Tolerant readers. `app_config.value` is untyped jsonb. ----------- */

  /**
   * A missing, malformed or partially-invalid programme degrades to the
   * compiled-in default rather than throwing.
   *
   * Same reasoning as `payment-config.service.ts#readRate`: running the
   * documented default is a defensible outcome; refusing every checkout because
   * one config row is malformed is not. The write path above makes reaching this
   * branch unlikely, but `app_config` can also be edited by hand in a
   * production incident, and that is exactly when a hard failure is least
   * welcome.
   */
  private readReferralProgram(value: unknown): ReferralProgramConfig {
    try {
      this.assertValidReferralProgram(value);
      return value as ReferralProgramConfig;
    } catch {
      this.logger.warn(
        `${PROMOTION_CONFIG_KEYS.REFERRAL_PROGRAM} is missing or malformed; using the compiled-in default programme.`,
      );
      return PROMOTION_DEFAULT_REFERRAL_PROGRAM;
    }
  }

  private readStatusList(value: unknown): readonly string[] {
    if (Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === 'string' && entry.length > 0)) {
      return value as string[];
    }
    return PROMOTION_CONFIG_FALLBACKS.REFERRAL_QUALIFYING_STATUSES;
  }

  private readBoundedNumber(value: number, bounds: { min: number; max: number }, fallback: number): number {
    if (!Number.isFinite(value) || value < bounds.min || value > bounds.max) return fallback;
    return value;
  }
}

/** A `numeric(10,2)`-shaped rupee string. Deliberately the same pattern `money.util.ts` enforces — a value that would not parse there must not be storable here. */
function isRupeeString(value: unknown): value is string {
  return typeof value === 'string' && /^\d{1,8}(?:\.\d{1,2})?$/.test(value);
}

/** A `numeric(5,2)`-shaped percentage string, strictly greater than zero (`discount_instruments_value_check` requires `percent_rate > 0`). */
function isPercentString(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{1,3}(?:\.\d{1,2})?$/.test(value)) return false;
  const numeric = Number(value);
  return numeric > 0 && numeric <= 100;
}

/** Re-exported so the reward minter can reuse exactly the shape this service validated, rather than re-deriving it. */
export type { ReferralRewardConfig };
