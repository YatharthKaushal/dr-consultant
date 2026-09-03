import { Injectable } from '@nestjs/common';
import type { AffiliateCommissionRow } from '../../schema/affiliate-commissions.schema';
import { AffiliateService } from './affiliate.service';
import { PromotionService } from './promotion.service';
import { ReferralService } from './referral.service';
import type {
  DiscountEvaluation,
  DiscountOrderContext,
  DiscountReservation,
  DiscountReservationResult,
  PatientReferralSummary,
  PromotionContract,
} from './promotion.contract';

/**
 * M-13's only public surface (`backend/README.md` §2). Thin by design — every
 * rule lives in `PromotionService`, `ReferralService` and `AffiliateService`,
 * and this class exists to be the one type another module imports, so swapping
 * the local implementation for a TCP client later changes nothing at any call
 * site. Mirrors `PaymentFacade`, `StorageFacade` and `AiFacade`.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * *** `modules/pricing` IS BEING BUILT IN A PARALLEL WORKTREE AGAINST A LOCAL
 * MIRROR OF `DiscountContract`, AND IT CANNOT SEE THIS FILE. ***
 *
 * `implements PromotionContract` — which `extends DiscountContract` — is what
 * makes that safe. Because TypeScript is structural, `PromotionFacade`
 * satisfies pricing's `DISCOUNT_PORT` with NO ADAPTER AND NO CAST, and the
 * coordinator's whole handover post-merge is one line in pricing's `providers`
 * array:
 *
 *     { provide: DISCOUNT_PORT, useExisting: PromotionFacade }
 *
 * A signature drift on the frozen half surfaces HERE as a `tsc` error, which is
 * the point. Do not rename a field or add a required argument to any of the
 * five contract methods below — see `promotion.contract.ts`'s header.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── THE THREE METHODS BEYOND THE FROZEN CONTRACT ──────────────────────────
 *
 * `getOrCreateReferralCode`, `recordAffiliateAttribution` and
 * `recordLinkOnlyAffiliateCommission` are this module's own, on
 * `PromotionContract` rather than `DiscountContract`. They are deliberately NOT
 * pushed into the frozen interface: pricing does not need them, and adding them
 * there would break the structural match with the mirror pricing declares.
 */
@Injectable()
export class PromotionFacade implements PromotionContract {
  constructor(
    private readonly promotions: PromotionService,
    private readonly referrals: ReferralService,
    private readonly affiliates: AffiliateService,
  ) {}

  /* ---- The FROZEN DiscountContract ------------------------------------ */

  /** What this code would be worth on this order, writing nothing. Advisory: `reserve` re-decides under a row lock and is the authority. */
  async preview(code: string, context: DiscountOrderContext): Promise<DiscountEvaluation> {
    return this.promotions.preview(code, context);
  }

  /**
   * Pins the discount for a consultation, under the instrument's
   * `SELECT ... FOR UPDATE`. THE ONE CALL THAT CAN OVER-REDEEM A CAPPED COUPON
   * IF IT IS WRONG, and the reason `promotion.redemption-race.integration.spec.ts`
   * exists.
   */
  async reserve(input: {
    code: string;
    context: DiscountOrderContext;
    consultationId: string;
    holdExpiresAt: Date;
  }): Promise<DiscountReservationResult> {
    return this.promotions.reserve(input);
  }

  /** The payment was captured — burn the reservation. Idempotent by the `status = 'reserved'` guard, not by a flag. */
  async confirm(input: {
    consultationId: string;
    paymentId: string;
    capturedComponents?: ReadonlyArray<{ code: string; amount: string }>;
  }): Promise<{ reservationId: string; status: 'consumed' } | null> {
    return this.promotions.confirm(input);
  }

  /** Returns a reservation to the pool. NEVER FORCES: if a confirm won the race, this returns `null` and leaves the consumed row alone. */
  async release(input: { consultationId: string; reason: string }): Promise<{ reservationId: string; status: 'released' } | null> {
    return this.promotions.release(input);
  }

  /** The discount currently attached to a consultation — `reserved` or `consumed`. */
  async getForConsultation(consultationId: string): Promise<DiscountReservation | null> {
    return this.promotions.getForConsultation(consultationId);
  }

  /* ---- This module's own surface -------------------------------------- */

  /** A patient's referral code, minted LAZILY on first ask — most patients never refer anyone. */
  async getOrCreateReferralCode(patientId: string): Promise<PatientReferralSummary> {
    return this.referrals.getOrCreateReferralCode(patientId);
  }

  /**
   * Records a link attribution from a signed, self-expiring token, on the FIRST
   * AUTHENTICATED request that carries one. Returns `null` — never throws — for
   * a bad or stale token, or a switched-off mechanism.
   */
  async recordAffiliateAttribution(input: { patientId: string; token: string }): Promise<{ partnerId: string; expiresAt: Date } | null> {
    return this.affiliates.recordAttribution(input);
  }

  /** Every code this patient may redeem right now. Unlisted campaigns are NEVER returned — that is what `is_publicly_listed` is for. */
  async listRedeemableInstrumentsForPatient(
    patientId: string,
  ): Promise<ReadonlyArray<{ code: string; label: string; description: string | null; validTo: string | null }>> {
    return this.promotions.listRedeemableForPatient(patientId);
  }

  /**
   * *** THE SEAM THE COORDINATOR MUST WIRE. ***
   *
   * A consultation that carries a LINK attribution but redeemed NO CODE still
   * owes the partner a commission — the doctor's commission must not depend on
   * the patient also happening to use a coupon. `DiscountContract.confirm` is
   * frozen and carries no `patientId`, so it cannot reach this case; call this
   * at capture instead, from wherever the patient id is known.
   *
   * A no-op while `promotion.affiliate_enabled` is `false`, which is how it
   * ships.
   */
  async recordLinkOnlyAffiliateCommission(input: {
    patientId: string;
    doctorId: string | null;
    consultationId: string;
    paymentId: string;
    capturedComponents?: ReadonlyArray<{ code: string; amount: string }>;
  }): Promise<AffiliateCommissionRow | null> {
    return this.affiliates.recordLinkOnlyCommissionForPatient(input);
  }
}
