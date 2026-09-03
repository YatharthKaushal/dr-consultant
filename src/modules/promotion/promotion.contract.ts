/**
 * *** M-13's PUBLIC SURFACE. THE FIRST HALF OF THIS FILE IS FROZEN. ***
 *
 * `modules/pricing` is being built in a PARALLEL WORKTREE and declares a LOCAL
 * MIRROR of `DiscountContract`, binding it to its own `DISCOUNT_PORT` token with
 * a null object — precisely the pattern `booking/booking-payment.contract.ts`
 * uses for `BookingPaymentPort`/`BOOKING_PAYMENT_PORT`, and
 * `document/document-storage.contract.ts` uses for `DocumentStoragePort`.
 *
 * *** `PromotionFacade` SATISFIES `DiscountContract` STRUCTURALLY — NO ADAPTER,
 * NO CAST. *** Because TypeScript is structural, the coordinator's whole
 * handover post-merge is one line in pricing's `providers` array. Which means:
 *
 *   DO NOT RENAME A FIELD ON ANY TYPE ABOVE THE "END OF FROZEN SURFACE" MARKER.
 *   DO NOT ADD A REQUIRED ARGUMENT TO ANY `DiscountContract` METHOD.
 *
 * Pricing cannot see this file. A drift here is not a compile error there — it
 * is a runtime surprise after both are merged, on the one seam that decides what
 * a patient is charged. Anything genuinely new goes BELOW the marker, where this
 * module's own controllers and the coordinator can reach it and pricing never
 * has to.
 *
 * ── WHY A DISCRIMINATED UNION AND NOT AN EXCEPTION ─────────────────────────
 *
 * State can legitimately change between `preview` and `reserve`: somebody took
 * the last redemption while the patient was typing their card number. That is
 * not an error, it is the system working — and a union makes it impossible for
 * the caller to forget. Genuine faults (a database outage, a malformed row)
 * still throw, and pricing's own error handling deals with those.
 *
 * ── WHAT THIS MODULE DELIBERATELY DOES NOT DO ─────────────────────────────
 *
 * It does not compute tax, does not read fee configuration, and does not decide
 * which components are discountable. `DiscountOrderContext.discountableAmount`
 * is THE BASE, and PRICING NAMES IT — so this module never has to guess. Pricing
 * also PLACES the discount, applying it to the convenience fee first so the
 * doctor's consultation fee is never reduced (FR-7.4).
 */

import type {
  AffiliateCommissionBase,
  AffiliateCommissionStatus,
  AffiliatePartnerStatus,
  AffiliateSettlementMethod,
  DiscountInstrumentKind,
  DiscountInstrumentStatus,
  DiscountValueKind,
  ReferralEventStatus,
} from '../../schema/enums.schema';

/* ========================================================================== */
/* FROZEN SURFACE — mirrored verbatim by modules/pricing. Do not edit.        */
/* ========================================================================== */

export interface DiscountOrderContext {
  patientId: string;
  doctorId: string | null;
  specialtyId: string | null;
  components: ReadonlyArray<{ code: string; label: string; grossAmount: string }>;
  /** THE BASE. Pricing names it, so you never guess which components are discountable. */
  discountableAmount: string;
  currency: string;
  mode: 'scheduled' | 'instant';
}

export type DiscountRefusalReason =
  | 'CODE_NOT_USABLE'
  | 'MIN_ORDER_NOT_MET'
  | 'TOTAL_LIMIT_REACHED'
  | 'USER_LIMIT_REACHED'
  | 'DISTINCT_USER_LIMIT_REACHED'
  | 'SELF_REFERRAL'
  | 'SELF_AFFILIATE'
  | 'NOT_A_FIRST_CONSULTATION'
  | 'ALREADY_REFERRED'
  | 'CURRENCY_MISMATCH'
  | 'ALREADY_APPLIED'
  | 'TOO_MANY_ATTEMPTS'
  | 'UNAVAILABLE';

export interface DiscountRefusal {
  applicable: false;
  reason: DiscountRefusalReason;
  message: string;
  requiredMinOrder?: string;
}

export interface DiscountQuote {
  applicable: true;
  instrumentId: string;
  kind: 'coupon' | 'voucher' | 'referral' | 'referral_reward' | 'affiliate';
  code: string;
  label: string;
  discountAmount: string;
  residualDiscountable: string;
  attributionOnly: boolean;
  fullyDiscounted: boolean;
}

export type DiscountEvaluation = DiscountQuote | DiscountRefusal;

export interface DiscountReservation {
  reservationId: string;
  instrumentId: string;
  code: string;
  discountAmount: string;
  expiresAt: Date;
}

export type DiscountReservationResult =
  | ({ reserved: true } & DiscountReservation)
  | ({ reserved: false } & DiscountRefusal);

export interface DiscountContract {
  preview(code: string, context: DiscountOrderContext): Promise<DiscountEvaluation>;
  reserve(input: {
    code: string;
    context: DiscountOrderContext;
    consultationId: string;
    holdExpiresAt: Date;
  }): Promise<DiscountReservationResult>;
  confirm(input: {
    consultationId: string;
    paymentId: string;
    /**
     * Each component's GROSS amount — PRE-DISCOUNT and PRE-TAX.
     *
     * *** THE CONVENTION IS LOAD-BEARING AND WAS ONCE WRONG. *** Pricing
     * originally passed `line_total` (taxable value plus tax, already net of
     * discount), which put GST into the affiliate commission base and let
     * `net_platform_margin` subtract the discount a SECOND time, since that base
     * is the convenience fee LESS the discount and `resolveBasePaise` applies
     * that subtraction here. Gross is the only convention that serves all three
     * bases through a port carrying one amount per component.
     */
    capturedComponents?: ReadonlyArray<{ code: string; amount: string }>;
  }): Promise<{ reservationId: string; status: 'consumed' } | null>;
  release(input: { consultationId: string; reason: string }): Promise<{ reservationId: string; status: 'released' } | null>;
  getForConsultation(consultationId: string): Promise<DiscountReservation | null>;
}

/* ========================================================================== */
/* END OF FROZEN SURFACE. Everything below is this module's own.              */
/* ========================================================================== */

/**
 * Patient-safe copy for every refusal.
 *
 * *** THE COLLAPSE IS THE SECURITY PROPERTY. *** Not-found, draft, paused,
 * archived, not-yet-started, expired and assigned-to-someone-else all resolve to
 * ONE `CODE_NOT_USABLE` with ONE message. `booking.constants.ts` states the same
 * reasoning for `BOOKING_NOT_FOUND` ("deliberately the same code for both, so a
 * caller with no relationship cannot probe for existence"), and here it matters
 * more: `is_publicly_listed = false` means "hidden but still redeemable", which
 * is exactly what makes walking the code namespace worth an attacker's time. A
 * distinguishable "that code exists but has expired" is a confirmed hit.
 *
 * `MIN_ORDER_NOT_MET` is the ONE DELIBERATE EXCEPTION, because it is the only
 * refusal a patient can act on — and it leaks nothing an attacker wants, since
 * reaching it already required a valid, live, applicable code.
 */
export const DISCOUNT_REFUSAL_MESSAGES: Record<DiscountRefusalReason, string> = {
  CODE_NOT_USABLE: 'This code cannot be used on this booking.',
  MIN_ORDER_NOT_MET: 'This code needs a higher order value.',
  TOTAL_LIMIT_REACHED: 'This code cannot be used on this booking.',
  USER_LIMIT_REACHED: 'You have already used this code.',
  DISTINCT_USER_LIMIT_REACHED: 'This code cannot be used on this booking.',
  SELF_REFERRAL: 'You cannot use your own referral code.',
  SELF_AFFILIATE: 'This code cannot be used for a booking with this doctor.',
  NOT_A_FIRST_CONSULTATION: 'A referral code can only be used on a first consultation.',
  ALREADY_REFERRED: 'A referral code has already been applied to your account.',
  CURRENCY_MISMATCH: 'This code cannot be used on this booking.',
  ALREADY_APPLIED: 'A code has already been applied to this booking.',
  TOO_MANY_ATTEMPTS: 'Too many code attempts. Please try again later.',
  UNAVAILABLE: 'Discount codes are unavailable right now. Please try again shortly.',
};

/* ---- Referral, patient-facing ----------------------------------------- */

/** A patient's own referral code and how it is doing. The code is minted LAZILY on first request — most patients never refer anyone. */
export interface PatientReferralSummary {
  code: string;
  instrumentId: string;
  label: string;
  /** Referrals that have been made and are waiting on a qualifying status. */
  pendingCount: number;
  /** Referrals that qualified, i.e. actually earned something. */
  qualifiedCount: number;
  /** Rewards minted to this patient that are still redeemable. */
  availableRewards: ReadonlyArray<{ code: string; label: string; validTo: string | null }>;
}

/* ---- Affiliate, admin-facing ------------------------------------------ */

export interface AffiliatePartnerSummary {
  id: string;
  doctorId: string;
  status: AffiliatePartnerStatus;
  linkSlug: string | null;
  commissionValueKind: DiscountValueKind;
  commissionRate: string | null;
  commissionFlat: string | null;
  commissionBase: AffiliateCommissionBase;
  commissionMax: string | null;
  agreementReference: string | null;
  /** Affiliate codes attached to this partner. A doctor may have a code, a link, or both. */
  codes: ReadonlyArray<{ instrumentId: string; code: string; status: DiscountInstrumentStatus }>;
  createdAt: string;
}

export interface AffiliateCommissionSummary {
  id: string;
  partnerId: string;
  consultationId: string;
  paymentId: string;
  status: AffiliateCommissionStatus;
  attributionSource: string;
  baseAmount: string;
  commissionAmount: string;
  currency: string;
  accruedAt: string | null;
  settlementId: string | null;
  createdAt: string;
}

/* ---- Instruments, admin-facing ---------------------------------------- */

export interface DiscountInstrumentSummary {
  id: string;
  code: string;
  kind: DiscountInstrumentKind;
  status: DiscountInstrumentStatus;
  label: string;
  description: string | null;
  isPubliclyListed: boolean;
  valueKind: DiscountValueKind;
  flatAmount: string | null;
  percentRate: string | null;
  maxDiscountAmount: string | null;
  minOrderAmount: string;
  currency: string;
  validFrom: string;
  validTo: string | null;
  maxTotalRedemptions: number | null;
  maxDistinctRedeemers: number | null;
  maxRedemptionsPerUser: number;
  /**
   * Counted from `discount_redemptions`, NEVER from a stored counter. There is
   * deliberately no `redeemed_count` column — see `discount-instruments.schema.ts`.
   * This figure is a REPORT, computed on demand; it is not what the caps are
   * enforced against (those are counted under the instrument's row lock).
   */
  redeemedCount: number;
  distinctRedeemerCount: number;
  createdAt: string;
}

/** A referral, as the admin panel shows it. */
export interface ReferralEventSummary {
  id: string;
  referrerPatientId: string;
  refereePatientId: string;
  consultationId: string;
  status: ReferralEventStatus;
  qualifiedAt: string | null;
  createdAt: string;
}

export interface AffiliateSettlementSummary {
  id: string;
  partnerId: string;
  method: AffiliateSettlementMethod;
  amount: string;
  commissionCount: number;
  reference: string | null;
  settledByAdminId: string;
  settledAt: string;
  status: string;
}

/**
 * This module's own surface, on top of the frozen `DiscountContract`.
 *
 * `PromotionFacade implements PromotionContract`, and `PromotionContract extends
 * DiscountContract` — so a drift on the frozen half is a `tsc` error HERE, at
 * the facade, which is exactly where it should surface.
 */
export interface PromotionContract extends DiscountContract {
  /** A patient's referral code, minted on first ask. */
  getOrCreateReferralCode(patientId: string): Promise<PatientReferralSummary>;

  /**
   * Records a link attribution from a signed, self-expiring token. Called by the
   * FIRST AUTHENTICATED request that carries one; from then on the server is
   * authoritative and the token is never trusted again.
   *
   * Returns `null` when the token does not verify, has expired, or affiliates
   * are switched off — never throws for those, because a stale link in a
   * bookmark is not an error the patient can do anything about.
   */
  recordAffiliateAttribution(input: {
    patientId: string;
    token: string;
  }): Promise<{ partnerId: string; expiresAt: Date } | null>;

  /** What a patient may see about their own referral programme, without exposing another patient's identity. */
  listRedeemableInstrumentsForPatient(patientId: string): Promise<ReadonlyArray<{ code: string; label: string; description: string | null; validTo: string | null }>>;
}
