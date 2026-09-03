import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsISO8601,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  IsArray,
  ArrayNotEmpty,
} from 'class-validator';
import {
  AFFILIATE_COMMISSION_BASES,
  AFFILIATE_COMMISSION_STATUSES,
  AFFILIATE_PARTNER_STATUSES,
  AFFILIATE_SETTLEMENT_METHODS,
  DISCOUNT_INSTRUMENT_KINDS,
  REFERRAL_EVENT_STATUSES,
  DISCOUNT_INSTRUMENT_STATUSES,
  DISCOUNT_VALUE_KINDS,
} from '../../schema/enums.schema';
import { PROMOTION_CONFIG_BOUNDS, PROMOTION_LIST_MAX_LIMIT } from './promotion.constants';

/** A `numeric(10,2)` rupee amount as a decimal string. Numbers refused on purpose — see `promotion.dto.ts`. */
const RUPEE_STRING = /^\d{1,8}(?:\.\d{1,2})?$/;
/** A `numeric(5,2)` percentage as a decimal string. */
const PERCENT_STRING = /^\d{1,3}(?:\.\d{1,2})?$/;

/**
 * `POST /admin/promotions/instruments`.
 *
 * *** THE ADMIN WRITER'S `code` GOES THROUGH THE SAME NORMALISER AS THE PATIENT
 * RESOLVER. *** So this field is deliberately NOT constrained to `^[A-Z0-9]+$`
 * here: an admin typing `SAVE-ME` gets `SAVEME` stored, which is the same value
 * a patient typing `save me` resolves to. One normaliser, one namespace, no
 * drift — see `promotion-code.util.ts`.
 *
 * Only `coupon` and `voucher` may be created here. `referral` is minted lazily
 * for a patient, `referral_reward` is minted by the qualification sweep, and
 * `affiliate` is created through the partner endpoints — each has invariants
 * (`discount_instruments_kind_shape_check`) that a free-form admin body cannot
 * be trusted to satisfy.
 */
export class CreateInstrumentDto {
  @IsString()
  @Length(4, 64)
  code!: string;

  @IsIn(['coupon', 'voucher'])
  kind!: 'coupon' | 'voucher';

  @IsString()
  @Length(1, 120)
  label!: string;

  @IsOptional()
  @IsString()
  @Length(1, 400)
  description?: string;

  /** `false` = hidden from every listing but STILL REDEEMABLE. This is the requirement that makes the enumeration throttle necessary rather than optional. */
  @IsOptional()
  @IsBoolean()
  isPubliclyListed?: boolean;

  @IsIn([...DISCOUNT_VALUE_KINDS])
  valueKind!: (typeof DISCOUNT_VALUE_KINDS)[number];

  @IsOptional()
  @Matches(RUPEE_STRING, { message: 'flatAmount must be an amount with at most two decimal places.' })
  flatAmount?: string;

  @IsOptional()
  @Matches(PERCENT_STRING, { message: 'percentRate must be a percentage with at most two decimal places.' })
  percentRate?: string;

  /**
   * REQUIRED for a percentage instrument — `discount_instruments_value_check`
   * refuses an uncapped one, because `doctors.consultation_fee_inr` is
   * admin-settable with no ceiling and "50% off" against a number somebody can
   * raise later is an unbounded liability.
   */
  @IsOptional()
  @Matches(RUPEE_STRING, { message: 'maxDiscountAmount must be an amount with at most two decimal places.' })
  maxDiscountAmount?: string;

  @IsOptional()
  @Matches(RUPEE_STRING, { message: 'minOrderAmount must be an amount with at most two decimal places.' })
  minOrderAmount?: string;

  @IsOptional()
  @IsISO8601({}, { message: 'validFrom must be an ISO 8601 timestamp.' })
  validFrom?: string;

  @IsOptional()
  @IsISO8601({}, { message: 'validTo must be an ISO 8601 timestamp.' })
  validTo?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxTotalRedemptions?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxDistinctRedeemers?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxRedemptionsPerUser?: number;

  /** REQUIRED for `voucher` (`discount_instruments_kind_shape_check`), and forbidden for `coupon`. */
  @IsOptional()
  @IsUUID()
  assignedPatientId?: string;
}

/** `PATCH /admin/promotions/instruments/:id` — every field optional, only the present ones are written. */
export class UpdateInstrumentDto {
  @IsOptional()
  @IsString()
  @Length(1, 120)
  label?: string;

  @IsOptional()
  @IsString()
  @Length(1, 400)
  description?: string;

  @IsOptional()
  @IsBoolean()
  isPubliclyListed?: boolean;

  @IsOptional()
  @IsISO8601({}, { message: 'validTo must be an ISO 8601 timestamp.' })
  validTo?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxTotalRedemptions?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxDistinctRedeemers?: number;
}

/** `PUT /admin/promotions/instruments/:id/status`. */
export class SetInstrumentStatusDto {
  @IsIn([...DISCOUNT_INSTRUMENT_STATUSES])
  status!: (typeof DISCOUNT_INSTRUMENT_STATUSES)[number];
}

export class ListInstrumentsDto {
  @IsOptional()
  @IsIn([...DISCOUNT_INSTRUMENT_KINDS])
  kind?: (typeof DISCOUNT_INSTRUMENT_KINDS)[number];

  @IsOptional()
  @IsIn([...DISCOUNT_INSTRUMENT_STATUSES])
  status?: (typeof DISCOUNT_INSTRUMENT_STATUSES)[number];

  @IsOptional()
  @IsString()
  @Length(1, 64)
  code?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PROMOTION_LIST_MAX_LIMIT)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

/**
 * `PUT /admin/promotions/config`.
 *
 * `referralProgram` is `IsObject` only — its shape is validated by
 * `PromotionConfigService.assertValidReferralProgram`, field by field, with
 * messages that name the offending field. Duplicating that as decorators would
 * be two rule sets to keep in step, and the service one is the one that also
 * guards a hand-edited `app_config` row.
 */
export class UpdatePromotionConfigDto {
  @IsOptional()
  @IsObject()
  referralProgram?: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  referralQualifyingStatuses?: string[];

  /** *** THE REGULATORY SWITCH. *** Read `affiliate-partners.schema.ts` before setting this `true`. */
  @IsOptional()
  @IsBoolean()
  affiliateEnabled?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(PROMOTION_CONFIG_BOUNDS.ATTRIBUTION_DAYS.min)
  @Max(PROMOTION_CONFIG_BOUNDS.ATTRIBUTION_DAYS.max)
  affiliateAttributionDays?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(PROMOTION_CONFIG_BOUNDS.RESERVATION_GRACE_MINUTES.min)
  @Max(PROMOTION_CONFIG_BOUNDS.RESERVATION_GRACE_MINUTES.max)
  reservationGraceMinutes?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(PROMOTION_CONFIG_BOUNDS.CODE_ATTEMPTS.min)
  @Max(PROMOTION_CONFIG_BOUNDS.CODE_ATTEMPTS.max)
  codeAttemptsPerPatientPerHour?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(PROMOTION_CONFIG_BOUNDS.CODE_ATTEMPTS.min)
  @Max(PROMOTION_CONFIG_BOUNDS.CODE_ATTEMPTS.max)
  codeAttemptsPerIpPerHour?: number;
}

/* -------------------------------------------------------------------------- */
/* Affiliate                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * `POST /admin/affiliates/partners`.
 *
 * *** `status` IS ABSENT ON PURPOSE. *** A partner is ALWAYS born `paused`
 * (`affiliate_partners.status`'s default, re-asserted by
 * `AffiliateService.createPartner`). Activating one is a second, separate,
 * audited act — which is the least a mechanism carrying the NMC 2023 exposure
 * should require, and which is what makes "who turned this on, and when"
 * answerable.
 */
export class CreatePartnerDto {
  @IsUUID()
  doctorId!: string;

  /** URL-safe, and long enough not to be guessable by hand (`affiliate_partners_link_slug_shape`). */
  @IsOptional()
  @Matches(/^[a-z0-9-]{6,40}$/, {
    message: 'linkSlug must be 6-40 characters of lower-case letters, digits and hyphens.',
  })
  linkSlug?: string;

  @IsIn([...DISCOUNT_VALUE_KINDS])
  commissionValueKind!: (typeof DISCOUNT_VALUE_KINDS)[number];

  @IsOptional()
  @Matches(PERCENT_STRING, { message: 'commissionRate must be a percentage with at most two decimal places.' })
  commissionRate?: string;

  @IsOptional()
  @Matches(RUPEE_STRING, { message: 'commissionFlat must be an amount with at most two decimal places.' })
  commissionFlat?: string;

  /** Defaults to `net_platform_margin` — the only base that never reads the doctor's consultation fee, which is what keeps FR-7.4 literally true. */
  @IsOptional()
  @IsIn([...AFFILIATE_COMMISSION_BASES])
  commissionBase?: (typeof AFFILIATE_COMMISSION_BASES)[number];

  /** REQUIRED for any base other than `net_platform_margin` (`affiliate_partners_nondefault_base_needs_cap`). */
  @IsOptional()
  @Matches(RUPEE_STRING, { message: 'commissionMax must be an amount with at most two decimal places.' })
  commissionMax?: string;

  /** The signed arrangement this row implements. The paper trail the regulation makes necessary. */
  @IsOptional()
  @IsString()
  @Length(1, 120)
  agreementReference?: string;

  @IsOptional()
  @IsString()
  @Length(1, 400)
  note?: string;
}

export class UpdatePartnerDto {
  @IsOptional()
  @Matches(/^[a-z0-9-]{6,40}$/, {
    message: 'linkSlug must be 6-40 characters of lower-case letters, digits and hyphens.',
  })
  linkSlug?: string;

  @IsOptional()
  @IsIn([...DISCOUNT_VALUE_KINDS])
  commissionValueKind?: (typeof DISCOUNT_VALUE_KINDS)[number];

  @IsOptional()
  @Matches(PERCENT_STRING, { message: 'commissionRate must be a percentage with at most two decimal places.' })
  commissionRate?: string;

  @IsOptional()
  @Matches(RUPEE_STRING, { message: 'commissionFlat must be an amount with at most two decimal places.' })
  commissionFlat?: string;

  @IsOptional()
  @IsIn([...AFFILIATE_COMMISSION_BASES])
  commissionBase?: (typeof AFFILIATE_COMMISSION_BASES)[number];

  @IsOptional()
  @Matches(RUPEE_STRING, { message: 'commissionMax must be an amount with at most two decimal places.' })
  commissionMax?: string;

  @IsOptional()
  @IsString()
  @Length(1, 120)
  agreementReference?: string;

  @IsOptional()
  @IsString()
  @Length(1, 400)
  note?: string;
}

export class SetPartnerStatusDto {
  @IsIn([...AFFILIATE_PARTNER_STATUSES])
  status!: (typeof AFFILIATE_PARTNER_STATUSES)[number];
}

export class ListPartnersDto {
  @IsOptional()
  @IsIn([...AFFILIATE_PARTNER_STATUSES])
  status?: (typeof AFFILIATE_PARTNER_STATUSES)[number];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PROMOTION_LIST_MAX_LIMIT)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

export class ListCommissionsDto {
  @IsOptional()
  @IsUUID()
  partnerId?: string;

  @IsOptional()
  @IsIn([...AFFILIATE_COMMISSION_STATUSES])
  status?: (typeof AFFILIATE_COMMISSION_STATUSES)[number];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PROMOTION_LIST_MAX_LIMIT)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}

/**
 * `POST /admin/affiliates/partners/:partnerId/settlements`.
 *
 * `off_system` is a FIRST-CLASS value, not a note: automated payouts are out of
 * scope this release (`docs/SRS.md` §11) and a bank transfer made outside the
 * platform is the EXPECTED case. The system records; a person transfers.
 */
export class CreateSettlementDto {
  @IsIn([...AFFILIATE_SETTLEMENT_METHODS])
  method!: (typeof AFFILIATE_SETTLEMENT_METHODS)[number];

  @IsOptional()
  @IsISO8601({}, { message: 'periodStart must be an ISO 8601 timestamp.' })
  periodStart?: string;

  @IsOptional()
  @IsISO8601({}, { message: 'periodEnd must be an ISO 8601 timestamp.' })
  periodEnd?: string;

  /** Bank/UTR reference. Written to the column AND mirrored into the audit metadata — see `affiliate-settlements.schema.ts`. */
  @IsOptional()
  @IsString()
  @Length(1, 120)
  reference?: string;

  @IsOptional()
  @IsString()
  @Length(1, 400)
  note?: string;
}

export class VoidSettlementDto {
  @IsString()
  @Length(1, 200)
  reason!: string;
}

export class ExportRedemptionsDto {
  @IsOptional()
  @IsUUID()
  instrumentId?: string;

  @IsOptional()
  @IsISO8601({}, { message: 'createdFrom must be an ISO 8601 timestamp.' })
  createdFrom?: string;

  @IsOptional()
  @IsISO8601({}, { message: 'createdTo must be an ISO 8601 timestamp.' })
  createdTo?: string;
}

export class ListReferralEventsDto {
  @IsOptional()
  @IsUUID()
  referrerPatientId?: string;

  @IsOptional()
  @IsIn([...REFERRAL_EVENT_STATUSES])
  status?: (typeof REFERRAL_EVENT_STATUSES)[number];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PROMOTION_LIST_MAX_LIMIT)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;
}
