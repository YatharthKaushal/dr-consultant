import type { AffiliateCommissionRow } from '../../schema/affiliate-commissions.schema';
import type { AffiliatePartnerRow } from '../../schema/affiliate-partners.schema';
import type { AffiliateSettlementRow } from '../../schema/affiliate-settlements.schema';
import type { DiscountInstrumentRow } from '../../schema/discount-instruments.schema';
import type { ReferralEventRow } from '../../schema/referral-events.schema';
import type {
  AffiliateCommissionSummary,
  AffiliatePartnerSummary,
  AffiliateSettlementSummary,
  DiscountInstrumentSummary,
  ReferralEventSummary,
} from './promotion.contract';

/**
 * Row -> DTO. `backend/README.md` §4: "mappers keep DTOs and rows out of each
 * other's layers."
 *
 * Two rules run through every function here:
 *
 *   1. *** DATES GO OUT AS ISO STRINGS. *** Facade methods "pass plain
 *      JSON-safe objects, so a local call can become a network call untouched"
 *      (`backend/README.md` §2). A `Date` survives an in-process call and
 *      silently becomes a string over TCP, so it is converted HERE, once, rather
 *      than working locally and breaking on extraction.
 *
 *      The exception is `DiscountReservation.expiresAt`, which the FROZEN
 *      `DiscountContract` declares as a `Date`. That is pricing's call, not
 *      ours, and it is not this mapper's to second-guess.
 *
 *   2. *** `numeric` COLUMNS STAY STRINGS. *** `pg` returns them as strings
 *      precisely so no precision is lost, and `money.util.ts` takes string in,
 *      not number in. Nothing here calls `Number()` on money.
 */

/**
 * `redeemedCount` and `distinctRedeemerCount` are passed IN rather than read
 * here, because they are COUNTED from `discount_redemptions` — there is
 * deliberately no `redeemed_count` column to map from
 * (`discount-instruments.schema.ts`). Keeping the query in the service and the
 * shaping here is what stops this mapper from needing a database handle.
 */
export function toInstrumentSummary(
  row: DiscountInstrumentRow,
  redeemedCount: number,
  distinctRedeemerCount: number,
): DiscountInstrumentSummary {
  return {
    id: row.id,
    code: row.code,
    kind: row.kind,
    status: row.status,
    label: row.label,
    description: row.description,
    isPubliclyListed: row.isPubliclyListed,
    valueKind: row.valueKind,
    flatAmount: row.flatAmount,
    percentRate: row.percentRate,
    maxDiscountAmount: row.maxDiscountAmount,
    minOrderAmount: row.minOrderAmount,
    currency: row.currency,
    validFrom: row.validFrom.toISOString(),
    validTo: row.validTo?.toISOString() ?? null,
    maxTotalRedemptions: row.maxTotalRedemptions,
    maxDistinctRedeemers: row.maxDistinctRedeemers,
    maxRedemptionsPerUser: row.maxRedemptionsPerUser,
    redeemedCount,
    distinctRedeemerCount,
    createdAt: row.createdAt.toISOString(),
  };
}

/** `codes` is passed in because a partner's affiliate codes live in `discount_instruments`, a different table this mapper does not query. */
export function toPartnerSummary(
  row: AffiliatePartnerRow,
  codes: ReadonlyArray<{ instrumentId: string; code: string; status: DiscountInstrumentRow['status'] }>,
): AffiliatePartnerSummary {
  return {
    id: row.id,
    doctorId: row.doctorId,
    status: row.status,
    linkSlug: row.linkSlug,
    commissionValueKind: row.commissionValueKind,
    commissionRate: row.commissionRate,
    commissionFlat: row.commissionFlat,
    commissionBase: row.commissionBase,
    commissionMax: row.commissionMax,
    agreementReference: row.agreementReference,
    codes,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toCommissionSummary(row: AffiliateCommissionRow): AffiliateCommissionSummary {
  return {
    id: row.id,
    partnerId: row.partnerId,
    consultationId: row.consultationId,
    paymentId: row.paymentId,
    status: row.status,
    attributionSource: row.attributionSource,
    baseAmount: row.baseAmount,
    commissionAmount: row.commissionAmount,
    currency: row.currency,
    accruedAt: row.accruedAt?.toISOString() ?? null,
    settlementId: row.settlementId,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toSettlementSummary(row: AffiliateSettlementRow): AffiliateSettlementSummary {
  return {
    id: row.id,
    partnerId: row.partnerId,
    method: row.method,
    amount: row.amount,
    commissionCount: row.commissionCount,
    reference: row.reference,
    settledByAdminId: row.settledByAdminId,
    settledAt: row.settledAt.toISOString(),
    status: row.status,
  };
}

/**
 * *** THIS IS AN ADMIN-ONLY SHAPE. ***
 *
 * It carries BOTH patient ids, which names who referred whom. That is a
 * patient-to-patient relationship, and `docs/SRS.md` §6.2's minimum-necessary
 * principle is why `PatientReferralSummary` — the shape a PATIENT sees — carries
 * counts instead. A referrer learns how many of their referrals qualified; they
 * never learn which of their friends did or did not attend a consultation.
 *
 * Do not reuse this on a patient-facing route.
 */
export function toReferralEventSummary(row: ReferralEventRow): ReferralEventSummary {
  return {
    id: row.id,
    referrerPatientId: row.referrerPatientId,
    refereePatientId: row.refereePatientId,
    consultationId: row.consultationId,
    status: row.status,
    qualifiedAt: row.qualifiedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
