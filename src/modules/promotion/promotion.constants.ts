/**
 * M-13's constants: the `app_config` keys it OWNS, their compiled-in
 * fallbacks, its error-code vocabulary, its `audit_log.entity_type` values and
 * its DI tokens.
 *
 * Structure copied from `payment.constants.ts` and `identity.constants.ts` —
 * keys + defaults + seed source in one place, so the admin write path, the read
 * fallbacks and `promotion.seed.ts` can never drift apart.
 */

import type { ConsultationStatus } from '../../schema/enums.schema';

/* -------------------------------------------------------------------------- */
/* Audit                                                                       */
/* -------------------------------------------------------------------------- */

/** `audit_log.entity_type` values this module writes. */
export const PROMOTION_AUDIT_ENTITY_TYPES = {
  /** One `promotion.*` `app_config` key, edited from the admin panel. `entity_id` is the key itself. */
  CONFIG: 'promotion_config',
  /** A `discount_instruments` row — a coupon, voucher, referral code, minted reward or affiliate code. */
  INSTRUMENT: 'discount_instrument',
  /** A `discount_redemptions` row: reserved, consumed or released. */
  REDEMPTION: 'discount_redemption',
  /** A `referral_events` row. */
  REFERRAL_EVENT: 'referral_event',
  /** An `affiliate_partners` row. */
  AFFILIATE_PARTNER: 'affiliate_partner',
  /** An `affiliate_attributions` row — which partner a patient is attributed to. */
  AFFILIATE_ATTRIBUTION: 'affiliate_attribution',
  /** An `affiliate_commissions` row. */
  AFFILIATE_COMMISSION: 'affiliate_commission',
  /** An `affiliate_settlements` row — a human recording that a partner was paid. */
  AFFILIATE_SETTLEMENT: 'affiliate_settlement',
  /** A CSV export (`promotions.export`). */
  EXPORT: 'promotion_export',
} as const;

/* -------------------------------------------------------------------------- */
/* Error codes                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Error codes this module returns in `{ code, message }` bodies for the
 * surfaces that genuinely THROW — the admin write path, and malformed input.
 *
 * *** THE PATIENT-FACING RESOLVE PATH DOES NOT THROW. *** `preview`/`reserve`
 * return a discriminated union (`DiscountEvaluation` /
 * `DiscountReservationResult`) whose refusal reasons are the frozen
 * `DiscountRefusalReason` list in `promotion.contract.ts`. State can legitimately
 * change between a preview and a reserve — somebody took the last redemption —
 * and a union makes that impossible for the caller to forget. Genuine faults
 * (a malformed row, a database outage) still throw.
 */
export const PROMOTION_ERROR_CODES = {
  /** No instrument with this id. Admin surface only — the patient path collapses this into `CODE_NOT_USABLE`. */
  INSTRUMENT_NOT_FOUND: 'PROMOTION_INSTRUMENT_NOT_FOUND',
  /** `discount_instruments.code` is UNIQUE across every kind. A second instrument with this code is a conflict. */
  CODE_ALREADY_EXISTS: 'PROMOTION_CODE_ALREADY_EXISTS',
  /** The code did not survive normalisation as `^[A-Z0-9]{4,32}$` — see `promotion-code.util.ts`. */
  CODE_INVALID: 'PROMOTION_CODE_INVALID',
  /** A create/update body that fails this module's own shape rules (percentage with no cap, flat with a rate, and so on). */
  INSTRUMENT_INVALID: 'PROMOTION_INSTRUMENT_INVALID',
  /** An edit that a live instrument's own state forbids — e.g. re-pricing an `archived` campaign. */
  INSTRUMENT_NOT_EDITABLE: 'PROMOTION_INSTRUMENT_NOT_EDITABLE',
  /** A money or percentage field that `money.util.ts` refused. */
  AMOUNT_INVALID: 'PROMOTION_AMOUNT_INVALID',
  /** A `PUT /admin/promotions/config` body whose value fails this module's own shape check. */
  CONFIG_INVALID: 'PROMOTION_CONFIG_INVALID',
  /** A `PUT /admin/promotions/config` naming a key this module does not own. */
  CONFIG_KEY_NOT_OWNED: 'PROMOTION_CONFIG_KEY_NOT_OWNED',
  /** No `affiliate_partners` row with this id. */
  PARTNER_NOT_FOUND: 'PROMOTION_PARTNER_NOT_FOUND',
  /** `affiliate_partners.doctor_id` is UNIQUE — one arrangement per doctor. */
  PARTNER_ALREADY_EXISTS: 'PROMOTION_PARTNER_ALREADY_EXISTS',
  /** `affiliate_partners.link_slug` is UNIQUE and shaped `^[a-z0-9-]{6,40}$`. */
  PARTNER_SLUG_INVALID: 'PROMOTION_PARTNER_SLUG_INVALID',
  /** A partner body that fails the commission shape rules (percent with no rate, non-default base with no ceiling). */
  PARTNER_INVALID: 'PROMOTION_PARTNER_INVALID',
  /**
   * *** THE REGULATORY GATE. *** `promotion.affiliate_enabled` is `false`, so
   * the affiliate mechanism refuses to do anything that could pay a doctor. See
   * `affiliate-partners.schema.ts` for the NMC 2023 reasoning.
   */
  AFFILIATE_DISABLED: 'PROMOTION_AFFILIATE_DISABLED',
  /** A settlement that would settle nothing: `affiliate_settlements_amount_check` requires `commission_count > 0`. */
  SETTLEMENT_EMPTY: 'PROMOTION_SETTLEMENT_EMPTY',
  /** No `affiliate_settlements` row with this id. */
  SETTLEMENT_NOT_FOUND: 'PROMOTION_SETTLEMENT_NOT_FOUND',
  /** The affiliate link token did not verify, or has expired. */
  ATTRIBUTION_TOKEN_INVALID: 'PROMOTION_ATTRIBUTION_TOKEN_INVALID',
  /** The enumeration throttle refused — see `promotion_code_attempts.schema.ts`. */
  TOO_MANY_ATTEMPTS: 'PROMOTION_TOO_MANY_ATTEMPTS',
  /** The referral programme is switched off in `promotion.referral_program`. */
  REFERRAL_DISABLED: 'PROMOTION_REFERRAL_DISABLED',
  /** `generatePromotionCode` could not find a free code in a bounded number of tries. A SERVER-side transient, not anything the caller did. */
  CODE_ALLOCATION_FAILED: 'PROMOTION_CODE_ALLOCATION_FAILED',
} as const;
export type PromotionErrorCode = (typeof PROMOTION_ERROR_CODES)[keyof typeof PROMOTION_ERROR_CODES];

/* -------------------------------------------------------------------------- */
/* app_config                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The `app_config` keys M-13 OWNS.
 *
 * `docs/MODULES.md` §7: "Configuration lives with its owning module and is
 * edited from the admin panel." `promotion-config.service.ts` enforces this
 * list as an allow-list in both directions, exactly as
 * `payment-config.service.ts` does — one shared `app_config` table must never
 * become one shared permission.
 */
export const PROMOTION_CONFIG_KEYS = {
  /** The refer-and-earn programme: whether each SIDE is rewarded, and by how much, independently. See `ReferralProgramConfig`. */
  REFERRAL_PROGRAM: 'promotion.referral_program',
  /**
   * *** THE DEPLOYMENT TRAP, DEFUSED. *** Which consultation statuses count as
   * "the consult actually happened", for both referral qualification and
   * affiliate accrual. See `PROMOTION_CONFIG_FALLBACKS` for why this cannot be
   * hard-coded.
   */
  REFERRAL_QUALIFYING_STATUSES: 'promotion.referral_qualifying_statuses',
  /** *** SHIPS `false`. *** The master switch for the entire doctor-affiliate mechanism. Read `affiliate-partners.schema.ts` before changing it. */
  AFFILIATE_ENABLED: 'promotion.affiliate_enabled',
  /** How long a link attribution stays live for a patient, in days. */
  AFFILIATE_ATTRIBUTION_DAYS: 'promotion.affiliate_attribution_days',
  /** Added to BOOKING's own hold expiry to set `discount_redemptions.expires_at`, so a discount is never released while the slot it priced is still held. */
  RESERVATION_GRACE_MINUTES: 'promotion.reservation_grace_minutes',
  /** The enumeration throttle, per patient, over a rolling hour. */
  CODE_ATTEMPTS_PER_PATIENT_PER_HOUR: 'promotion.code_attempts_per_patient_per_hour',
  /** The enumeration throttle, per IP, over a rolling hour. Per-patient alone is useless against unauthenticated probing; per-IP alone punishes a shared NAT. */
  CODE_ATTEMPTS_PER_IP_PER_HOUR: 'promotion.code_attempts_per_ip_per_hour',
} as const;
export type PromotionConfigKey = (typeof PROMOTION_CONFIG_KEYS)[keyof typeof PROMOTION_CONFIG_KEYS];

export const PROMOTION_CONFIG_KEY_LIST: readonly PromotionConfigKey[] = Object.values(PROMOTION_CONFIG_KEYS);

/** One side of the referral programme. The two sides are configured INDEPENDENTLY — the requirement is "whether both sides are rewarded and how much each". */
export interface ReferralRewardConfig {
  /** `false` = this side gets nothing. The referee's own discount is the referral code itself, so `refereeReward` is off by default. */
  enabled: boolean;
  valueKind: 'flat' | 'percent';
  /** `numeric(10,2)`-shaped rupee string when `valueKind` is `flat`. */
  flatAmount: string | null;
  /** `numeric(5,2)`-shaped percentage string when `valueKind` is `percent`. */
  percentRate: string | null;
  /** REQUIRED for `percent` — `discount_instruments_value_check` refuses an uncapped percentage instrument. */
  maxDiscountAmount: string | null;
  minOrderAmount: string;
  /** How long the minted reward stays redeemable. */
  validityDays: number;
  /** Patient-safe display copy on the minted instrument. Never states a rule — rules are enforced, not advertised. */
  label: string;
}

export interface ReferralProgramConfig {
  enabled: boolean;
  /**
   * Whether a referral code may only be redeemed on a patient's FIRST
   * consultation. Read through `PROMOTION_BOOKING_LOOKUP_PORT`; when that port
   * cannot answer, the check is SKIPPED rather than failed — see
   * `promotion-booking.contract.ts` for why the two `unknown` defaults point in
   * opposite directions.
   */
  refereeMustBeFirstConsultation: boolean;
  /** `null` = unlimited. How many referrals one patient may have QUALIFY, ever. */
  maxQualifiedReferralsPerReferrer: number | null;
  referrerReward: ReferralRewardConfig;
  refereeReward: ReferralRewardConfig;
}

/**
 * *** READ THIS BEFORE ASSUMING REFERRAL REWARDS WORK. ***
 *
 * `referral-events.schema.ts` names the trap explicitly: "The natural
 * qualifying status is `completed`, which is set by M-15 (clinical records) — a
 * module that does not exist yet. Hard-coding it would mean referral rewards
 * SILENTLY NEVER MINT in this release."
 *
 * So the qualifying set is data, not code. This is the COMPILED-IN DEFAULT that
 * stands in when the `app_config` row is missing or malformed; the seed writes
 * the same value, and an admin holding `promotions.manage` can widen it from the
 * panel with no release the day M-15 lands (or before it, if the client accepts
 * the trade).
 *
 * Both defaults are "the consult actually happened" states, and BOTH ARE SET BY
 * M-15. Until M-15 exists, NOTHING in this codebase moves a consultation into
 * either — so with the default set, no referral reward and no affiliate accrual
 * will EVER fire. That is deliberate and it is the safe direction: the
 * alternative default (`scheduled`, which M-11/M-12 do set today) re-opens
 * exactly the farming hole the two-state design exists to close — refer a burner
 * account, book, pay, take the discount, cancel inside the free-cancellation
 * window `booking-policy.engine.ts` already auto-refunds, and the referrer keeps
 * a reward the platform funded out of nothing.
 *
 * *** IF THE CLIENT WANTS REWARDS LIVE BEFORE M-15, THIS KEY IS THE ONE LINE TO
 * CHANGE, AND THE TRADE ABOVE IS THE ONE TO PUT IN FRONT OF THEM. ***
 */
export const PROMOTION_DEFAULT_QUALIFYING_STATUSES = [
  'awaiting_documentation',
  'completed',
] as const satisfies readonly ConsultationStatus[];

/** The reward every referral programme mints for the referrer unless an admin says otherwise. */
const DEFAULT_REFERRER_REWARD: ReferralRewardConfig = {
  enabled: true,
  valueKind: 'flat',
  flatAmount: '100.00',
  percentRate: null,
  maxDiscountAmount: null,
  minOrderAmount: '0.00',
  validityDays: 90,
  label: 'Referral reward',
};

/**
 * *** OFF BY DEFAULT, AND NOT AN OVERSIGHT. ***
 *
 * The referee's discount IS THE REFERRAL CODE ITSELF — they type it at checkout
 * and it comes off that bill. Minting them a SECOND instrument on qualification
 * would pay the same side twice for one referral. This exists because the
 * requirement is that the two sides are configurable independently, so a client
 * who wants "₹100 off now AND ₹100 off next time" can have it.
 */
const DEFAULT_REFEREE_REWARD: ReferralRewardConfig = {
  enabled: false,
  valueKind: 'flat',
  flatAmount: '100.00',
  percentRate: null,
  maxDiscountAmount: null,
  minOrderAmount: '0.00',
  validityDays: 90,
  label: 'Welcome reward',
};

export const PROMOTION_DEFAULT_REFERRAL_PROGRAM: ReferralProgramConfig = {
  enabled: true,
  refereeMustBeFirstConsultation: true,
  maxQualifiedReferralsPerReferrer: null,
  referrerReward: DEFAULT_REFERRER_REWARD,
  refereeReward: DEFAULT_REFEREE_REWARD,
};

/**
 * Compiled-in fallbacks. Every `AppConfigService` read in this module passes one
 * of these, so a missing or not-yet-seeded row degrades to a documented default
 * rather than to `undefined` — the same discipline as
 * `PAYMENT_CONFIG_FALLBACKS` and `IDENTITY_APP_CONFIG_DEFAULTS`.
 */
export const PROMOTION_CONFIG_FALLBACKS = {
  REFERRAL_PROGRAM: PROMOTION_DEFAULT_REFERRAL_PROGRAM,
  REFERRAL_QUALIFYING_STATUSES: [...PROMOTION_DEFAULT_QUALIFYING_STATUSES] as string[],
  /** *** SHIPS OFF. NOT NEGOTIABLE WITHOUT THE CLIENT'S LEGAL ADVISOR. *** */
  AFFILIATE_ENABLED: false,
  AFFILIATE_ATTRIBUTION_DAYS: 30,
  RESERVATION_GRACE_MINUTES: 5,
  CODE_ATTEMPTS_PER_PATIENT_PER_HOUR: 20,
  CODE_ATTEMPTS_PER_IP_PER_HOUR: 60,
} as const;

/** What `promotion.seed.ts` inserts into `app_config` on first run (`ON CONFLICT DO NOTHING` — never overwrites an admin-tuned value). */
export const PROMOTION_APP_CONFIG_DEFAULTS: Record<PromotionConfigKey, unknown> = {
  [PROMOTION_CONFIG_KEYS.REFERRAL_PROGRAM]: PROMOTION_CONFIG_FALLBACKS.REFERRAL_PROGRAM,
  [PROMOTION_CONFIG_KEYS.REFERRAL_QUALIFYING_STATUSES]: PROMOTION_CONFIG_FALLBACKS.REFERRAL_QUALIFYING_STATUSES,
  [PROMOTION_CONFIG_KEYS.AFFILIATE_ENABLED]: PROMOTION_CONFIG_FALLBACKS.AFFILIATE_ENABLED,
  [PROMOTION_CONFIG_KEYS.AFFILIATE_ATTRIBUTION_DAYS]: PROMOTION_CONFIG_FALLBACKS.AFFILIATE_ATTRIBUTION_DAYS,
  [PROMOTION_CONFIG_KEYS.RESERVATION_GRACE_MINUTES]: PROMOTION_CONFIG_FALLBACKS.RESERVATION_GRACE_MINUTES,
  [PROMOTION_CONFIG_KEYS.CODE_ATTEMPTS_PER_PATIENT_PER_HOUR]:
    PROMOTION_CONFIG_FALLBACKS.CODE_ATTEMPTS_PER_PATIENT_PER_HOUR,
  [PROMOTION_CONFIG_KEYS.CODE_ATTEMPTS_PER_IP_PER_HOUR]: PROMOTION_CONFIG_FALLBACKS.CODE_ATTEMPTS_PER_IP_PER_HOUR,
};

/** Bounds enforced in the service as well as the DTO (`backend/README.md`: services hold the rules, not just the HTTP layer). */
export const PROMOTION_CONFIG_BOUNDS = {
  ATTRIBUTION_DAYS: { min: 1, max: 365 },
  RESERVATION_GRACE_MINUTES: { min: 0, max: 120 },
  CODE_ATTEMPTS: { min: 1, max: 10_000 },
  REWARD_VALIDITY_DAYS: { min: 1, max: 3_650 },
} as const;

/* -------------------------------------------------------------------------- */
/* Postgres object names this module reasons about                             */
/* -------------------------------------------------------------------------- */

/**
 * *** THE INDEXES THAT ARE THE AUTHORITY, BY NAME. ***
 *
 * A `23505` carries the constraint that refused it, and each of these means
 * something DIFFERENT to a patient. Mapping them by name is what turns one
 * generic conflict into three specific, correct refusals.
 *
 * Kept as literals here, not imported from the migration (which is SQL, not
 * TS), for the same reason `booking.constants.ts` keeps its own copy of the
 * slot-occupying status list: a change to one must be a visible diff, not
 * silent drift. IF YOU RENAME AN INDEX IN `src/schema/*.schema.ts`, RENAME IT
 * HERE TOO — `promotion.redemption-race.integration.spec.ts` asserts these exact
 * names against a real database, so a rename fails loudly rather than silently
 * degrading every refusal to `CODE_NOT_USABLE`.
 */
export const PROMOTION_INDEXES = {
  /** One live discount per consultation. Re-applying is `ALREADY_APPLIED`, not a second row. */
  LIVE_CONSULTATION_UNIQUE: 'discount_redemptions_live_consultation_unique_idx',
  /** The index-enforced half of the per-user cap, for the overwhelmingly common one-per-customer case. */
  SINGLE_USE_PER_USER: 'discount_redemptions_single_use_per_user_idx',
  /** A patient can be referred once, ever. Kills repeat-referee and circular farming in the database. */
  REFERRAL_REFEREE_ONCE: 'referral_events_referee_once_idx',
  /** A referral mints at most one reward per side, however many times the mint path runs. */
  REFERRAL_REWARD_ONCE: 'discount_instruments_referral_reward_once_idx',
  /** One live referral code per patient, ever. */
  ONE_REFERRAL_PER_PATIENT: 'discount_instruments_one_referral_per_patient_idx',
  /** One commission per consultation, ever. */
  COMMISSION_PER_CONSULTATION: 'affiliate_commissions_consultation_unique_idx',
  /** One active link attribution per patient — last touch wins. */
  ATTRIBUTION_ONE_ACTIVE: 'affiliate_attributions_one_active_idx',
} as const;

/* -------------------------------------------------------------------------- */
/* DI tokens                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * DI token for the `PromotionBookingLookupPort` implementation, bound in
 * `promotion.module.ts` — mirrors `booking.constants.ts`'s
 * `BOOKING_PAYMENT_PORT`, `search.constants.ts`'s `SEARCH_AI_PORT` and
 * `document.constants.ts`'s `DOCUMENT_STORAGE_PORT`.
 *
 * Bound to `UnavailablePromotionBookingLookupProvider` (a null object that
 * reports `unknown` and NEVER THROWS); the COORDINATOR rebinds it to
 * `BookingFacade` post-merge. See `promotion-booking.contract.ts` for why a
 * direct import would close a cycle.
 */
export const PROMOTION_BOOKING_LOOKUP_PORT = Symbol('PROMOTION_BOOKING_LOOKUP_PORT');

/* -------------------------------------------------------------------------- */
/* Sweep                                                                       */
/* -------------------------------------------------------------------------- */

/** How often the sweep runs. See `booking-slot-hold.service.ts`'s `SWEEP_SCHEDULING` comment for why this is a plain interval and not a cron. */
export const PROMOTION_SWEEP_INTERVAL_MS = 60_000;

/** Candidates examined per pass, per tier. Bounds one pass's work so a backlog drains steadily instead of in one spike. */
export const PROMOTION_SWEEP_BATCH_SIZE = 100;

/**
 * How long a `promotion_code_attempts` row is kept.
 *
 * Far longer than the throttle's one-hour window, on purpose: the counter never
 * looks back further than an hour, but the rows are ALSO the only evidence that
 * somebody walked the code namespace — and a probe is a pattern across days, not
 * within an hour. Thirty days is long enough to see one and short enough that
 * the table stays small.
 */
export const PROMOTION_ATTEMPT_RETENTION_DAYS = 30;

/**
 * Consultation statuses that mean the booking is DEAD, so a reservation held
 * against it can be released with no risk of releasing a discount under a live
 * payment. Anything not in this list — including a status this module does not
 * recognise, and including `unknown` from an unbound port — means KEEP.
 */
export const PROMOTION_TERMINAL_CONSULTATION_STATUSES = [
  'cancelled',
  'no_show',
  'expired',
] as const satisfies readonly ConsultationStatus[];

/**
 * Consultation statuses that mean the money arrived and the booking went live.
 * Reaching one of these CONFIRMS a still-`reserved` redemption — the durable
 * backstop for a lost `payment.captured`, exactly as
 * `booking-slot-hold.service.ts` reconciles a Tier 2 hold rather than trusting
 * a clock.
 */
export const PROMOTION_PAID_CONSULTATION_STATUSES = [
  'scheduled',
  'awaiting_doctor',
  'in_progress',
  'awaiting_documentation',
  'completed',
] as const satisfies readonly ConsultationStatus[];

/* -------------------------------------------------------------------------- */
/* Pricing seam                                                                */
/* -------------------------------------------------------------------------- */

/**
 * *** AN ASSUMPTION ABOUT PRICING'S COMPONENT VOCABULARY. FLAGGED, NOT HIDDEN. ***
 *
 * `DiscountOrderContext.components` and `confirm`'s `capturedComponents` both
 * carry a `code`, and pricing owns that vocabulary — the frozen port does not
 * define its values. This module needs to recognise exactly ONE of them: the
 * convenience fee, which is what `net_platform_margin` is computed from.
 *
 * Matching is therefore TOLERANT (substring, case-insensitive) rather than an
 * exact-equality table that would break silently on a rename. And when no
 * component matches, the commission is SKIPPED — see
 * `affiliate.service.ts#resolveBasePaise`.
 *
 * *** IT MUST NOT FALL BACK TO `discount_redemptions.discountable_base`. *** It
 * once did, and that was a defect: pricing names `discountableAmount` as the
 * WHOLE ORDER'S GROSS (doctor fee INCLUDED), not the convenience fee, so the
 * fallback put the doctor's own fee into a commission base FR-7.4 keeps it out
 * of. That reasoning is written out in full at `resolveBasePaise`.
 *
 * CONFIRM THESE AT MERGE. A mismatch cannot mis-price a patient's bill (this
 * module never computes tax or fees) — the blast radius is confined to an
 * affiliate commission base, and affiliates ship switched off.
 */
export const PROMOTION_CONVENIENCE_FEE_COMPONENT_HINTS = ['convenience', 'platform_fee', 'platform-fee'] as const;

/** Same tolerance, for the doctor's consultation fee — recognised only so it can be EXCLUDED from every commission base. FR-7.4. */
export const PROMOTION_CONSULTATION_FEE_COMPONENT_HINTS = ['consultation', 'doctor_fee', 'doctor-fee'] as const;

/** ISO 4217 currency this release prices in. Mirrors `PAYMENT_DEFAULT_CURRENCY`; the column is defaulted in the schema so multi-currency stays a data change. */
export const PROMOTION_DEFAULT_CURRENCY = 'INR';

/* -------------------------------------------------------------------------- */
/* Listing                                                                     */
/* -------------------------------------------------------------------------- */

export const PROMOTION_LIST_DEFAULT_LIMIT = 50;
export const PROMOTION_LIST_MAX_LIMIT = 200;
/** Hard cap on rows in one CSV export, so an admin cannot ask for a stream the process has to hold in memory. */
export const PROMOTION_EXPORT_MAX_ROWS = 50_000;
