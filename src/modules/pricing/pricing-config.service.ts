import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { DATABASE } from '../../config/db/database.module';
import type { Database } from '../../config/db/database.config';
import { AppConfigService } from '../../shared/app-config/app-config.service';
import { AuditService } from '../../shared/audit/audit.service';
import { isSelectableGstStateCode } from './pricing-gst.constants';
import { PricingConfigRepository } from './pricing-config.repository';
import { PricingEngineError, validateCatalogue } from './pricing.engine';
import {
  PRICING_AUDIT_ENTITY_TYPES,
  PRICING_CONFIG_KEYS,
  PRICING_CONFIG_KEY_LIST,
  PRICING_DEFAULT_COMPONENTS,
  PRICING_DEFAULT_QUOTE_TTL_MINUTES,
  PRICING_DEFAULT_TAX_PROFILE,
  PRICING_ERROR_CODES,
  PRICING_QUOTE_TTL_BOUNDS,
  type PricingComponentSpec,
  type PricingConfigKey,
  type PricingTaxProfile,
} from './pricing.constants';

/** The resolved `pricing.*` configuration, with a compiled-in fallback standing in for every missing or malformed row. */
export interface ResolvedPricingConfig {
  components: PricingComponentSpec[];
  taxProfile: PricingTaxProfile;
  quoteTtlMinutes: number;
  /**
   * True when the stored catalogue was unusable and the compiled-in default was
   * substituted. Surfaced so the admin screen can say so out loud — billing at
   * the documented default is defensible, billing at it SILENTLY is not.
   */
  componentsFellBack: boolean;
  taxProfileFellBack: boolean;
}

/** A `PUT /admin/pricing/config` body: every field optional, only the present ones are written. */
export interface PricingConfigUpdate {
  components?: unknown;
  taxProfile?: unknown;
  quoteTtlMinutes?: number;
}

/**
 * The READ AND WRITE path for M-12.5's own `app_config` keys.
 *
 * Modelled line-for-line on `payment-config.service.ts`, which carries the same
 * three responsibilities a bare config write does not:
 *
 *   1. KEY OWNERSHIP. Writes are restricted to `PRICING_CONFIG_KEY_LIST`. An
 *      admin holding `payments.manage_config` must not be able to reach
 *      `search.crisis_keywords` and switch off the safety guardrail, and the
 *      rule has to hold in every direction or it holds in none.
 *   2. SHAPE VALIDATION. `app_config.value` is untyped jsonb, so a bad write is
 *      not caught by the database. A catalogue with a duplicate code, a forward
 *      reference, or an exempt-and-inclusive line would not fail here — it would
 *      fail at the next checkout, or worse, not fail at all and simply bill the
 *      wrong amount. The catalogue is run through the ENGINE'S OWN validator, so
 *      the admin screen and the pricing path can never disagree about what is
 *      legal.
 *   3. AUDIT + INVALIDATION. Every change writes an `audit_log` row carrying
 *      actor and BEFORE/AFTER, transactionally, then calls
 *      `AppConfigService.invalidate(key)`. Without that last call the 30s memo
 *      keeps serving the old catalogue, and an admin correcting a GST treatment
 *      would watch nothing happen — while patients kept being billed the old one.
 *
 * *** THIS IS FINANCIAL CONFIGURATION, SO THE AUDIT IS NOT OPTIONAL. ***
 * `docs/MODULES.md` §7: "Every module touching clinical or financial data writes
 * audit entries from its first release, not later."
 */
@Injectable()
export class PricingConfigService {
  private readonly logger = new Logger(PricingConfigService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly repo: PricingConfigRepository,
    private readonly appConfig: AppConfigService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Everything the engine needs, resolved. Goes through `AppConfigService` so
   * the 30s memo covers the checkout path — this is read on every quote.
   */
  async getResolved(): Promise<ResolvedPricingConfig> {
    const [rawComponents, rawProfile, rawTtl] = await Promise.all([
      this.appConfig.getJson<unknown>(PRICING_CONFIG_KEYS.COMPONENTS, undefined),
      this.appConfig.getJson<unknown>(PRICING_CONFIG_KEYS.TAX_PROFILE, undefined),
      this.appConfig.getNumber(PRICING_CONFIG_KEYS.QUOTE_TTL_MINUTES, PRICING_DEFAULT_QUOTE_TTL_MINUTES),
    ]);

    const components = this.readComponents(rawComponents);
    const taxProfile = this.readTaxProfile(rawProfile);

    return {
      components: components.value,
      componentsFellBack: components.fellBack,
      taxProfile: taxProfile.value,
      taxProfileFellBack: taxProfile.fellBack,
      quoteTtlMinutes: this.readTtl(rawTtl),
    };
  }

  /**
   * *** WHETHER A PRICING CATALOGUE EXISTS AT ALL. ***
   *
   * Distinct from `getResolved`, which always answers with something usable.
   * This asks the narrower question "has anyone configured pricing", and its one
   * caller is `PaymentConfigService.update`, which must refuse to keep editing
   * the superseded convenience-fee/GST screen once the pricing screen is live.
   *
   * Reads the ROW, not the memo: a supersession check that lags 30 seconds
   * behind a seed would let an admin write a rate that is already dead.
   */
  async hasCatalogue(): Promise<boolean> {
    const stored = await this.repo.findByKeys([PRICING_CONFIG_KEYS.COMPONENTS]);
    return stored.has(PRICING_CONFIG_KEYS.COMPONENTS);
  }

  /**
   * Writes only the fields present in `update`. A no-op call writes nothing and
   * audits nothing — no misleading audit entry, the same discipline
   * `payment-config.service.ts` and `search-config.service.ts` use.
   */
  async update(actingAdminId: string, update: PricingConfigUpdate): Promise<ResolvedPricingConfig> {
    const changes = this.toKeyedChanges(update);
    if (changes.length === 0) {
      return this.getResolved();
    }

    for (const change of changes) {
      this.assertOwnedKey(change.key);
      this.assertValidValue(change.key, change.value);
    }

    for (const change of changes) {
      // *** THE AUDIT COMMITS OR ROLLS BACK WITH THE VALUE IT AUDITS. ***
      // A financial configuration value must never change without a record of
      // who changed it, so the before-read, the write and the audit are ONE
      // transaction rather than three statements that could half-succeed and
      // leave a changed rate with no record of who changed it.
      await this.db.transaction(async (tx) => {
        const before = await this.repo.findByKeys([change.key], tx);
        await this.repo.upsert(change.key, change.value, tx);
        await this.audit.write(
          {
            actorType: 'admin',
            actorId: actingAdminId,
            action: 'update',
            entityType: PRICING_AUDIT_ENTITY_TYPES.CONFIG,
            // The key IS the entity — `app_config` rows are identified by key,
            // and an auditor asking who last changed the tax treatment should
            // not have to know a uuid.
            entityId: change.key,
            metadata: { before: before.get(change.key) ?? null, after: change.value },
          },
          tx,
        );
      });

      // *** Without this the 30s memo keeps billing at the previous catalogue. ***
      // After the commit, never inside it: invalidating a memo for a write that
      // then rolls back would re-read the OLD value and cache it as if it were new.
      this.appConfig.invalidate(change.key);
    }

    return this.getResolved();
  }

  /* ---------------------------------------------------------------------- */

  private toKeyedChanges(update: PricingConfigUpdate): Array<{ key: PricingConfigKey; value: unknown }> {
    const changes: Array<{ key: PricingConfigKey; value: unknown }> = [];
    if (update.components !== undefined) {
      changes.push({ key: PRICING_CONFIG_KEYS.COMPONENTS, value: update.components });
    }
    if (update.taxProfile !== undefined) {
      changes.push({ key: PRICING_CONFIG_KEYS.TAX_PROFILE, value: update.taxProfile });
    }
    if (update.quoteTtlMinutes !== undefined) {
      changes.push({ key: PRICING_CONFIG_KEYS.QUOTE_TTL_MINUTES, value: update.quoteTtlMinutes });
    }
    return changes;
  }

  /**
   * Structurally unreachable from the controller (the DTO has no free-form
   * key), and enforced anyway — this is the guard that keeps one shared
   * `app_config` table from becoming one shared permission.
   */
  private assertOwnedKey(key: string): void {
    if (!(PRICING_CONFIG_KEY_LIST as readonly string[]).includes(key)) {
      throw new BadRequestException({
        code: PRICING_ERROR_CODES.CONFIG_KEY_NOT_OWNED,
        message: `${key} is not a pricing configuration key.`,
      });
    }
  }

  /** Defensive re-check of the DTO's own bounds — services hold the rules, per `backend/README.md`, not just the HTTP layer. */
  private assertValidValue(key: PricingConfigKey, value: unknown): void {
    if (key === PRICING_CONFIG_KEYS.COMPONENTS) {
      try {
        // *** THE ENGINE'S OWN VALIDATOR. *** Using a second, looser check here
        // is how an admin screen comes to accept a catalogue the pricing path
        // then refuses — at checkout, for a patient.
        validateCatalogue(value as PricingComponentSpec[]);
      } catch (error) {
        if (error instanceof PricingEngineError) throw this.invalid(error.message);
        throw error;
      }
      return;
    }

    if (key === PRICING_CONFIG_KEYS.TAX_PROFILE) {
      this.assertValidTaxProfile(value);
      return;
    }

    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw this.invalid('quoteTtlMinutes must be a whole number of minutes.');
    }
    if (value < PRICING_QUOTE_TTL_BOUNDS.min || value > PRICING_QUOTE_TTL_BOUNDS.max) {
      throw this.invalid(
        `quoteTtlMinutes must be between ${PRICING_QUOTE_TTL_BOUNDS.min} and ${PRICING_QUOTE_TTL_BOUNDS.max}.`,
      );
    }
  }

  private assertValidTaxProfile(value: unknown): void {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw this.invalid('taxProfile must be an object.');
    }
    const profile = value as Partial<PricingTaxProfile>;

    // *** STATE CODES ARE COMPILED IN AND NOT ADMIN-EDITABLE. ***
    // `pricing-gst.constants.ts` explains why at length: an admin who invents
    // code 99 produces an invoice that is invalid, silently, on every bill.
    if (!isSelectableGstStateCode(profile.registeredStateCode)) {
      throw this.invalid('registeredStateCode must be a currently-issued GST state code.');
    }
    if (!isSelectableGstStateCode(profile.defaultPlaceOfSupplyStateCode)) {
      throw this.invalid('defaultPlaceOfSupplyStateCode must be a currently-issued GST state code.');
    }
    if (profile.gstin != null && (typeof profile.gstin !== 'string' || profile.gstin.length !== 15)) {
      throw this.invalid('gstin must be exactly 15 characters, or null until the client supplies one.');
    }
    if (typeof profile.legalName !== 'string' || profile.legalName.length === 0 || profile.legalName.length > 200) {
      throw this.invalid('legalName must be 1-200 characters — it is printed on the tax invoice.');
    }
  }

  private invalid(message: string): BadRequestException {
    return new BadRequestException({ code: PRICING_ERROR_CODES.CONFIG_INVALID, message });
  }

  /**
   * Tolerant reader — `app_config.value` is untyped jsonb.
   *
   * A missing, malformed or unusable catalogue degrades to the compiled-in
   * default rather than throwing. Billing at the documented default is a
   * defensible outcome; refusing to take any payment because one config row is
   * malformed is not. The fallback is LOGGED and reported to the admin screen,
   * because doing it quietly would hide a real misconfiguration behind a bill
   * that still looks plausible.
   */
  private readComponents(value: unknown): { value: PricingComponentSpec[]; fellBack: boolean } {
    if (value === undefined || value === null) {
      return { value: [...PRICING_DEFAULT_COMPONENTS], fellBack: true };
    }
    try {
      return { value: validateCatalogue(value as PricingComponentSpec[]), fellBack: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `pricing.components is unusable and the compiled-in default catalogue is being billed instead: ${message}`,
      );
      return { value: [...PRICING_DEFAULT_COMPONENTS], fellBack: true };
    }
  }

  private readTaxProfile(value: unknown): { value: PricingTaxProfile; fellBack: boolean } {
    try {
      this.assertValidTaxProfile(value);
      const profile = value as PricingTaxProfile;
      return {
        value: {
          registeredStateCode: profile.registeredStateCode,
          gstin: profile.gstin ?? null,
          legalName: profile.legalName,
          defaultPlaceOfSupplyStateCode: profile.defaultPlaceOfSupplyStateCode,
        },
        fellBack: false,
      };
    } catch {
      return { value: { ...PRICING_DEFAULT_TAX_PROFILE }, fellBack: true };
    }
  }

  private readTtl(value: number): number {
    if (!Number.isInteger(value)) return PRICING_DEFAULT_QUOTE_TTL_MINUTES;
    if (value < PRICING_QUOTE_TTL_BOUNDS.min || value > PRICING_QUOTE_TTL_BOUNDS.max) {
      return PRICING_DEFAULT_QUOTE_TTL_MINUTES;
    }
    return value;
  }
}
