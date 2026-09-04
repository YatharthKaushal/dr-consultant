import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  Inject,
} from '@nestjs/common';
import { DATABASE } from '../../config/db/database.module';
import type { Database, DatabaseTransaction } from '../../config/db/database.config';
import { getEnv } from '../../config/env/env.validation';
import type { AffiliatePartnerRow } from '../../schema/affiliate-partners.schema';
import type { AffiliateCommissionRow } from '../../schema/affiliate-commissions.schema';
import type { DiscountRedemptionRow } from '../../schema/discount-redemptions.schema';
import type { AffiliateCommissionBase, AffiliatePartnerStatus, DiscountValueKind } from '../../schema/enums.schema';
import { AuditService } from '../../shared/audit/audit.service';
import { paiseToRupees, rupeesToPaise } from '../../shared/money/money.util';
import { AffiliateRepository, type CommissionListFilter, type PartnerListFilter } from './affiliate.repository';
import { computeCommission, subtractFloorZero } from './promotion-discount.util';
import { isUniqueConstraintViolation } from '../../shared/errors/postgres-error.util';
import { PromotionConfigService, type ResolvedPromotionConfig } from './promotion-config.service';
import {
  PROMOTION_AUDIT_ENTITY_TYPES,
  PROMOTION_CONSULTATION_FEE_COMPONENT_HINTS,
  PROMOTION_CONVENIENCE_FEE_COMPONENT_HINTS,
  PROMOTION_ERROR_CODES,
} from './promotion.constants';

/** The two captured figures this module cares about, pulled out of pricing's component list. Both `null` when the caller did not supply them. */
export interface CapturedComponents {
  consultationFee: string | null;
  convenienceFee: string | null;
}

export interface CreatePartnerInput {
  doctorId: string;
  linkSlug: string | null;
  commissionValueKind: DiscountValueKind;
  commissionRate: string | null;
  commissionFlat: string | null;
  commissionBase: AffiliateCommissionBase;
  commissionMax: string | null;
  agreementReference: string | null;
  note: string | null;
}

export interface SettlePartnerInput {
  partnerId: string;
  method: 'in_system' | 'off_system';
  periodStart: Date | null;
  periodEnd: Date | null;
  reference: string | null;
  note: string | null;
}

/**
 * *** THE DOCTOR AFFILIATE MECHANISM. IT SHIPS SWITCHED OFF. ***
 *
 * ══════════════════════════════════════════════════════════════════════════
 * *** REGULATORY EXPOSURE — READ BEFORE ENABLING ANY OF THIS. ***
 *
 * India's NMC Registered Medical Practitioner (Professional Conduct)
 * Regulations, 2023 prohibit a registered practitioner from giving, soliciting
 * or receiving any gift, gratuity, COMMISSION or bonus in consideration of, or
 * return for, referring, recommending or procuring a patient. The NMC issued a
 * specific crackdown on referral commissions; the stated penalty is suspension,
 * up to removal from the register.
 *
 * Paying a doctor a commission when a patient they referred books a consult is,
 * on its face, the arrangement that regulation names — AND THE EXPOSURE LANDS ON
 * THE DOCTOR, not only the platform.
 *
 * The product owner has confirmed the decision: BUILD IT, SHIP IT DISABLED.
 * `promotion.affiliate_enabled` defaults to `false` and every partner row
 * defaults to `paused` (`affiliate_partners.status`). Enabling it is the
 * CLIENT'S LEGAL ADVISOR's decision, recorded in writing, in the same way
 * `docs/SRS.md` §8 assigns the GST treatment to the client's CA. It is not a
 * developer's call, and it must not become one by default.
 *
 * Every gate in this file therefore reads the config key rather than trusting a
 * caller, and `promotion-config.service.ts` fails the switch CLOSED on any
 * malformed value.
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── THE COMMISSION BASE, AND WHY THE DEFAULT KEEPS FR-7.4 LITERALLY TRUE ──
 *
 * `net_platform_margin` — the captured convenience fee less the discount the
 * platform absorbed, EXCLUDING tax — is the only base that structurally cannot
 * pay out more than the booking earned, and the only one that never reads the
 * doctor's consultation fee. FR-7.4 constrains DEDUCTION, not basis, so a
 * commission computed off platform revenue is a platform EXPENSE and
 * "consultation fee 500, platform deduction 0, doctor earning 500" stays
 * literally true.
 *
 * *** GST IS NEVER A BASE. *** Paying commission out of collected tax is not
 * ours to do, and there is deliberately no enum value that would let it be
 * configured.
 *
 * ── ACCRUAL: `pending` AT CAPTURE, `accrued` AT THE QUALIFYING STATUS ──────
 *
 * That two-step is the whole anti-clawback design. Accruing at capture would
 * need a "payment refunded" signal to claw back, and no such event exists on
 * `payment.contract.ts` today. Gating on the qualifying status means a booking
 * cancelled and refunded before completion NEVER BECOMES PAYABLE IN THE FIRST
 * PLACE.
 */
@Injectable()
export class AffiliateService {
  private readonly logger = new Logger(AffiliateService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly repo: AffiliateRepository,
    private readonly config: PromotionConfigService,
    private readonly audit: AuditService,
  ) {}

  /* ====================================================================== */
  /* Commission accrual                                                     */
  /* ====================================================================== */

  /**
   * Pulls the two figures this module needs out of pricing's component list.
   *
   * *** PRICING OWNS THE COMPONENT VOCABULARY AND THE FROZEN PORT DOES NOT
   * DEFINE ITS VALUES. *** So the match is TOLERANT — substring,
   * case-insensitive, against `PROMOTION_*_COMPONENT_HINTS` — rather than an
   * exact-equality table that would break silently on a rename. A miss returns
   * `null` and the caller falls back or skips; it never guesses.
   */
  readCapturedComponents(components?: ReadonlyArray<{ code: string; amount: string }>): CapturedComponents {
    if (!components || components.length === 0) return { consultationFee: null, convenienceFee: null };

    const find = (hints: readonly string[]): string | null => {
      const match = components.find((component) => {
        const code = component.code.toLowerCase();
        return hints.some((hint) => code.includes(hint));
      });
      return match?.amount ?? null;
    };

    return {
      consultationFee: find(PROMOTION_CONSULTATION_FEE_COMPONENT_HINTS),
      convenienceFee: find(PROMOTION_CONVENIENCE_FEE_COMPONENT_HINTS),
    };
  }

  /**
   * Creates the `pending` commission for a consultation that redeemed a code
   * carrying an attribution.
   *
   * *** `ON CONFLICT DO NOTHING` AGAINST
   * `affiliate_commissions_consultation_unique_idx`. *** One commission per
   * consultation, ever. A replayed capture, a sweep pass and an explicit confirm
   * can all race to create this row; the index decides and every writer tolerates
   * losing.
   *
   * Takes the caller's `tx` so the commission and the redemption's `consumed`
   * transition commit or roll back together — a commission recorded against a
   * redemption that was never burnt would be a payable with no bill behind it.
   */
  async recordCommissionForRedemption(
    input: {
      redemption: DiscountRedemptionRow;
      paymentId: string;
      captured: CapturedComponents;
      config: ResolvedPromotionConfig;
    },
    tx: DatabaseTransaction,
  ): Promise<AffiliateCommissionRow | null> {
    if (!input.config.affiliateEnabled) return null;
    if (input.redemption.affiliatePartnerId === null) return null;

    return this.createPendingCommission(
      {
        partnerId: input.redemption.affiliatePartnerId,
        consultationId: input.redemption.consultationId,
        paymentId: input.paymentId,
        redemptionId: input.redemption.id,
        attributionSource: input.redemption.attributionSource ?? 'code',
        captured: input.captured,
        discountAmount: input.redemption.discountAmount,
        currency: input.redemption.currency,
      },
      tx,
    );
  }

  /**
   * The LINK-ONLY case: the patient used no code at all, but arrived through a
   * partner's link.
   *
   * *** THE DOCTOR'S COMMISSION MUST NOT DEPEND ON THE PATIENT ALSO USING A
   * COUPON. *** Without this path, a link attribution would only ever pay out
   * when a discount happened to be applied, which is an accident of the
   * patient's behaviour rather than a rule anybody agreed.
   *
   * *** WHY IT IS NOT REACHED FROM `confirm`, AND WHAT THE COORDINATOR MUST
   * WIRE. *** `DiscountContract.confirm` is FROZEN and carries no `patientId`,
   * and with no redemption row there is nothing to look an attribution up by.
   * This module also may not read `payments` or `consultations`
   * (`backend/README.md` §2), so it cannot fetch one. So this is exposed on
   * `PromotionFacade` BEYOND the frozen contract — adding a parameter to
   * `confirm` would break the structural match with pricing's local mirror — for
   * the coordinator to call at capture from wherever the patient id is known.
   *
   * Nothing is silently lost meanwhile: affiliates ship OFF, and a code-carried
   * attribution (the `code` source, and a `link` source copied onto a redemption
   * at reserve time) is handled by `recordCommissionForRedemption` on the
   * ordinary path.
   *
   * Requires `capturedComponents` to carry a convenience fee. So does the
   * ordinary redemption path — see `resolveBasePaise` on why there is no longer
   * a fallback on either. A caller that omits them gets a logged skip rather
   * than a guessed base.
   */
  async recordLinkOnlyCommissionForPatient(input: {
    patientId: string;
    doctorId: string | null;
    consultationId: string;
    paymentId: string;
    capturedComponents?: ReadonlyArray<{ code: string; amount: string }>;
  }): Promise<AffiliateCommissionRow | null> {
    const config = await this.config.getResolved();
    if (!config.affiliateEnabled) return null;

    const captured = this.readCapturedComponents(input.capturedComponents);
    if (captured.convenienceFee === null) {
      this.logger.warn(
        `Consultation ${input.consultationId} has no convenience-fee component, so no link-only commission base can be derived. Skipped.`,
      );
      return null;
    }

    const attribution = await this.repo.findActiveAttribution(input.patientId, new Date());
    if (!attribution) return null;

    const partner = await this.repo.findPartnerById(attribution.partnerId);
    if (!partner || partner.status !== 'active') return null;
    // A doctor never earns a commission on a booking with themselves — the same
    // rule `SELF_AFFILIATE` states for a typed code.
    if (input.doctorId !== null && partner.doctorId === input.doctorId) return null;

    return this.db.transaction(async (tx) =>
      this.createPendingCommission(
        {
          partnerId: partner.id,
          consultationId: input.consultationId,
          paymentId: input.paymentId,
          redemptionId: null,
          attributionSource: 'link',
          captured,
          discountAmount: '0.00',
          currency: 'INR',
        },
        tx,
      ),
    );
  }

  /**
   * Builds and inserts one `pending` commission.
   *
   * Every term — the rate, the base kind and the ceiling — is SNAPSHOTTED onto
   * the row. `affiliate-commissions.schema.ts`: "Renegotiating a partner's deal
   * next quarter must not restate what last quarter's bookings earned.
   * `base_amount` is stored too, even though it is derived, because that is what
   * makes the finance report reproducible without re-deriving a figure from rows
   * that may since have changed."
   */
  private async createPendingCommission(
    input: {
      partnerId: string;
      consultationId: string;
      paymentId: string;
      redemptionId: string | null;
      attributionSource: string;
      captured: CapturedComponents;
      discountAmount: string;
      currency: string;
    },
    tx: DatabaseTransaction,
  ): Promise<AffiliateCommissionRow | null> {
    const partner = await this.repo.findPartnerById(input.partnerId, tx);
    if (!partner || partner.status !== 'active') return null;

    const basePaise = this.resolveBasePaise(partner.commissionBase, input);
    if (basePaise === null) {
      this.logger.warn(
        `Consultation ${input.consultationId}: no ${partner.commissionBase} base could be derived for partner ${partner.id}; commission skipped.`,
      );
      return null;
    }

    const { commissionPaise, commissionAmount } = computeCommission(
      {
        valueKind: partner.commissionValueKind,
        flatAmount: partner.commissionFlat,
        percentRate: partner.commissionRate,
        maxAmount: partner.commissionMax,
      },
      basePaise,
    );

    const row = await this.repo.insertCommissionIfAbsent(
      {
        partnerId: partner.id,
        consultationId: input.consultationId,
        paymentId: input.paymentId,
        redemptionId: input.redemptionId,
        status: 'pending',
        attributionSource: input.attributionSource,
        commissionValueKind: partner.commissionValueKind,
        commissionRate: partner.commissionRate,
        commissionFlat: partner.commissionFlat,
        commissionBase: partner.commissionBase,
        commissionMax: partner.commissionMax,
        baseAmount: paiseToRupees(basePaise),
        commissionAmount,
        currency: input.currency,
      },
      tx,
    );

    // `null` = somebody already recorded it. A SUCCESS, not an error — that is
    // what the unique index is for.
    if (!row) return null;

    await this.audit.write(
      {
        actorType: 'system',
        actorId: null,
        action: 'create',
        entityType: PROMOTION_AUDIT_ENTITY_TYPES.AFFILIATE_COMMISSION,
        entityId: row.id,
        consultationId: input.consultationId,
        metadata: {
          change: 'pending',
          partnerId: partner.id,
          doctorId: partner.doctorId,
          attributionSource: input.attributionSource,
          commissionBase: partner.commissionBase,
          baseAmount: paiseToRupees(basePaise),
          commissionAmount,
          commissionPaise: commissionPaise.toString(),
          // The flag that makes every affiliate payout findable in the audit log
          // by predicate rather than by reading everything.
          nmcRegulatedArrangement: true,
        },
      },
      tx,
    );

    return row;
  }

  /**
   * What the rate is applied to. Returns `null` when the base cannot be derived,
   * which is a SKIP rather than a guess.
   *
   * *** THE ASSUMPTION AT THE PRICING SEAM, STATED. ***
   *
   * `net_platform_margin` is defined as the captured convenience fee less the
   * discount the platform absorbed. That subtraction is performed here
   * unconditionally, which is exactly right if `capturedComponents` carries
   * GROSS component amounts — and CONSERVATIVE (it under-states the margin, so
   * it under-pays the commission) if pricing has already netted the discount off
   * before handing them over.
   *
   * Under-paying is the correct direction to err for a commission whose legality
   * the client's lawyer has not yet signed off, and the alternative — assuming
   * net and being wrong — over-pays. CONFIRM WHICH CONVENTION PRICING USES AT
   * MERGE; the blast radius is confined to a commission figure, because this
   * module never computes tax or fees and never touches a patient's bill.
   *
   * ── *** THERE IS NO `discountable_base` FALLBACK, AND THERE MUST NOT BE. *** ──
   *
   * This function once fell back to the redemption's own `discountable_base`
   * when no convenience-fee component was supplied, on the stated grounds that
   * "pricing declared that amount discountable, which for this platform IS the
   * convenience fee". *** THAT WAS WRONG, AND IT IS THE SAME CLASS OF DEFECT AS
   * THE `line_total`-FOR-`gross_amount` MIX-UP THIS FILE ALREADY WARNS ABOUT. ***
   *
   * `pricing-discount.contract.ts` names `discountableAmount` explicitly as THE
   * WHOLE ORDER'S GROSS — every component before discount and before tax — and
   * `pricing.service.ts` fills it from `discountableBasePaise`, which
   * `pricing.engine.ts` sets to `grossTotalPaise`. On the seeded catalogue that
   * is 600.00 (a 500.00 doctor fee plus a 100.00 convenience fee), NOT the
   * 100.00 convenience fee. Pricing states its reasoning: a minimum-order rule
   * is a statement about the ORDER, and "20% off" means 20% of what the patient
   * pays.
   *
   * So the fallback silently put THE DOCTOR'S OWN CONSULTATION FEE inside a
   * commission base this module swears never contains it (FR-7.4), and it did it
   * on `net_platform_margin` — the DEFAULT base, and the only one
   * `affiliate_partners_nondefault_base_needs_cap` lets ship with NO ceiling,
   * precisely because it is supposed to be structurally incapable of paying out
   * more than the booking earned. With the fallback it could: on a 600.00 order
   * with a 100.00 convenience fee and a 100.00 discount the true margin is 0.00
   * and the fallback computed 500.00.
   *
   * Nothing in this module can tell the two conventions apart — both arrive as a
   * `numeric(10,2)` string — so the answer is to REFUSE TO GUESS. A missing
   * convenience-fee component now SKIPS the commission and logs, which is this
   * file's own stated discipline ("A miss returns `null` and the caller falls
   * back or skips; it never guesses") and errs in the direction the header
   * already argues for: under-paying a commission whose legality the client's
   * lawyer has not yet signed off.
   */
  private resolveBasePaise(
    base: AffiliateCommissionBase,
    input: { captured: CapturedComponents; discountAmount: string },
  ): bigint | null {
    switch (base) {
      case 'net_platform_margin': {
        const gross = input.captured.convenienceFee;
        if (gross === null) return null;
        return subtractFloorZero(rupeesToPaise(gross), rupeesToPaise(input.discountAmount));
      }

      case 'convenience_fee': {
        const gross = input.captured.convenienceFee;
        return gross === null ? null : rupeesToPaise(gross);
      }

      case 'consultation_fee': {
        // The only base that reads the doctor's fee. Permitted, but it REQUIRES a
        // ceiling (`affiliate_partners_nondefault_base_needs_cap`) and it is the
        // base that makes FR-7.4's "platform deduction 0" argument harder to
        // make. Never defaulted to.
        return input.captured.consultationFee === null ? null : rupeesToPaise(input.captured.consultationFee);
      }

      default:
        // *** GST IS NEVER A BASE. *** There is no enum value for it, and if one
        // is ever added, it must not silently fall through to a number.
        return null;
    }
  }

  /**
   * `pending` -> `accrued`. The consultation reached a qualifying status, so the
   * money is genuinely owed. Called only by the sweep.
   *
   * *** THE MASTER SWITCH IS READ HERE TOO, AND THAT IS NOT BELT-AND-BRACES. ***
   * A `pending` row can only have been created while `promotion.affiliate_enabled`
   * was `true`, but it OUTLIVES the switch: turn the mechanism off after a
   * commission is recorded and, without this gate, the sweep goes on turning
   * those rows into money owed to a doctor on its own timer. "Switched off"
   * would then mean "stops taking new ones", which is not what an admin who
   * flips a regulatory kill switch is asking for. `settle` already takes exactly
   * this position ("the affiliate mechanism is switched off, so there is nothing
   * to settle"); this is the same stance one step earlier, where the liability
   * is actually created. The rows stay `pending` and accrue the moment the
   * switch comes back on.
   */
  async accrueCommission(commissionId: string, consultationId: string): Promise<boolean> {
    const config = await this.config.getResolved();
    if (!config.affiliateEnabled) return false;

    return this.db.transaction(async (tx) => {
      const accrued = await this.repo.accrueCommissionIfPending(commissionId, new Date(), tx);
      if (!accrued) return false;

      await this.audit.write(
        {
          actorType: 'system',
          actorId: null,
          action: 'update',
          entityType: PROMOTION_AUDIT_ENTITY_TYPES.AFFILIATE_COMMISSION,
          entityId: accrued.id,
          consultationId,
          metadata: {
            change: 'accrued',
            before: 'pending',
            after: 'accrued',
            partnerId: accrued.partnerId,
            commissionAmount: accrued.commissionAmount,
            nmcRegulatedArrangement: true,
          },
        },
        tx,
      );
      return true;
    });
  }

  /** `pending` -> `void`. The consultation died, so nothing is owed and nothing ever will be. Composable into a caller's transaction. */
  async voidPendingCommissionForConsultation(
    consultationId: string,
    reason: string,
    tx: DatabaseTransaction,
  ): Promise<boolean> {
    const existing = await this.repo.findCommissionByConsultation(consultationId, tx);
    if (!existing || existing.status !== 'pending') return false;
    return this.voidPendingCommissionIn(existing.id, consultationId, reason, tx);
  }

  /** The same, opening its own transaction — what the sweep calls, since it already holds the commission id. */
  async voidPendingCommissionById(commissionId: string, consultationId: string, reason: string): Promise<boolean> {
    return this.db.transaction(async (tx) => this.voidPendingCommissionIn(commissionId, consultationId, reason, tx));
  }

  private async voidPendingCommissionIn(
    commissionId: string,
    consultationId: string,
    reason: string,
    tx: DatabaseTransaction,
  ): Promise<boolean> {
    const voided = await this.repo.voidCommissionIfPending(commissionId, reason, tx);
    if (!voided) return false;

    await this.audit.write(
      {
        actorType: 'system',
        actorId: null,
        action: 'update',
        entityType: PROMOTION_AUDIT_ENTITY_TYPES.AFFILIATE_COMMISSION,
        entityId: voided.id,
        consultationId,
        metadata: { change: 'void', before: 'pending', after: 'void', reason },
      },
      tx,
    );
    return true;
  }

  /* ====================================================================== */
  /* Link attribution — the signed, self-expiring token                     */
  /* ====================================================================== */

  /**
   * *** NO ANONYMOUS CLICK TABLE AND NO DEVICE FINGERPRINTING. ***
   *
   * `affiliate-attributions.schema.ts`: "There is no anonymous-visitor identity
   * in this backend, and inventing one for a mental-health app is a privacy cost
   * with no owner — `docs/SRS.md` §6.2's minimum-necessary principle points the
   * other way. So nothing is stored server-side for an anonymous visitor. Ever."
   *
   * The landing page receives a SIGNED, SELF-EXPIRING token naming the partner,
   * holds it client-side, and the FIRST AUTHENTICATED request carrying it writes
   * one row. From that moment the server is authoritative and the token is never
   * trusted again.
   *
   * ── THE SIGNING KEY, AND WHY IT IS DERIVED RATHER THAN CONFIGURED ─────────
   *
   * A dedicated `PROMOTION_LINK_SECRET` would be better and is deliberately NOT
   * added: `src/config/env/env.validation.ts` and `.env.example` are out of
   * scope for this round, and adding a REQUIRED env var would break every
   * existing deployment's boot on merge. Instead the key is derived from
   * `JWT_ACCESS_SECRET` with a DOMAIN SEPARATOR, which is standard practice and
   * means a token minted here can never be presented as an access token, or the
   * reverse. If a dedicated secret is added later, this is the one function to
   * change.
   */
  private linkTokenKey(): Buffer {
    return createHmac('sha256', getEnv().JWT_ACCESS_SECRET).update('promotion.affiliate_link.v1').digest();
  }

  /** Mints a link token for a partner. Called by the admin surface so a doctor can be handed a URL. */
  mintAttributionToken(partnerId: string, ttlDays: number): { token: string; expiresAt: Date } {
    const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
    const payload = Buffer.from(
      JSON.stringify({ p: partnerId, e: Math.floor(expiresAt.getTime() / 1000) }),
      'utf8',
    ).toString('base64url');
    const signature = createHmac('sha256', this.linkTokenKey()).update(payload).digest('base64url');
    return { token: `v1.${payload}.${signature}`, expiresAt };
  }

  /**
   * Verifies a link token. Returns `null` for anything wrong — a bad signature,
   * a stale token, a malformed one.
   *
   * `timingSafeEqual` rather than `===`: the comparison is against an attacker-
   * supplied value and a byte-by-byte early exit leaks how much of a forged
   * signature was right. Lengths are compared first, because `timingSafeEqual`
   * throws on a length mismatch.
   */
  verifyAttributionToken(token: string): { partnerId: string; expiresAt: Date } | null {
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'v1') return null;

    const expected = createHmac('sha256', this.linkTokenKey()).update(parts[1]).digest();
    let provided: Buffer;
    try {
      provided = Buffer.from(parts[2], 'base64url');
    } catch {
      return null;
    }
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;

    try {
      const decoded = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as {
        p?: unknown;
        e?: unknown;
      };
      if (typeof decoded.p !== 'string' || typeof decoded.e !== 'number') return null;
      const expiresAt = new Date(decoded.e * 1000);
      // SELF-EXPIRING. A stale bookmark stops attributing on its own, with no
      // server-side state to expire it.
      if (expiresAt.getTime() <= Date.now()) return null;
      return { partnerId: decoded.p, expiresAt };
    } catch {
      return null;
    }
  }

  /**
   * The first authenticated request carrying a token writes one attribution row.
   *
   * *** LAST TOUCH WINS. *** The supersede and the insert are one transaction in
   * `AffiliateRepository.recordAttribution`, so `affiliate_attributions_one_active_idx`
   * can never see two active rows even under concurrent clicks.
   *
   * Returns `null` — never throws — for a bad token, an unknown or inactive
   * partner, or a switched-off mechanism. A stale link in a bookmark is not an
   * error the patient can do anything about, and a 4xx would surface as a broken
   * app on a perfectly ordinary journey.
   */
  async recordAttribution(input: { patientId: string; token: string }): Promise<{ partnerId: string; expiresAt: Date } | null> {
    const config = await this.config.getResolved();
    if (!config.affiliateEnabled) return null;

    const verified = this.verifyAttributionToken(input.token);
    if (!verified) return null;

    const partner = await this.repo.findPartnerById(verified.partnerId);
    if (!partner || partner.status !== 'active') return null;

    // The ATTRIBUTION's own window is the configured one, not the token's. The
    // token only carries the claim here; the row is what the server honours, and
    // an admin shortening the window must not be overridden by a long-lived
    // token minted before the change.
    const expiresAt = new Date(Date.now() + config.affiliateAttributionDays * 24 * 60 * 60 * 1000);

    const row = await this.db.transaction(async (tx) =>
      this.repo.recordAttribution({ patientId: input.patientId, partnerId: partner.id, source: 'link', status: 'active', expiresAt }, tx),
    );

    await this.audit.write({
      actorType: 'patient',
      actorId: input.patientId,
      action: 'create',
      entityType: PROMOTION_AUDIT_ENTITY_TYPES.AFFILIATE_ATTRIBUTION,
      entityId: row.id,
      metadata: { partnerId: partner.id, source: 'link', expiresAt: expiresAt.toISOString() },
    });

    return { partnerId: partner.id, expiresAt: row.expiresAt };
  }

  /* ====================================================================== */
  /* Partners                                                               */
  /* ====================================================================== */

  /**
   * Creates a partner arrangement.
   *
   * *** IT IS BORN `paused`, ALWAYS, WHATEVER THE CALLER ASKS. ***
   * `affiliate_partners.status` defaults to `paused` in the schema and this
   * method does not let a caller override it on creation. Activating a partner
   * is a SECOND, separate, audited act — which is what makes "who turned this
   * on, and when" answerable, and which is the least a mechanism carrying the
   * NMC exposure should require.
   */
  async createPartner(actingAdminId: string, input: CreatePartnerInput): Promise<AffiliatePartnerRow> {
    this.assertPartnerShape(input);

    const existing = await this.repo.findPartnerByDoctorId(input.doctorId);
    if (existing) {
      throw new ConflictException({
        code: PROMOTION_ERROR_CODES.PARTNER_ALREADY_EXISTS,
        message: 'This doctor already has an affiliate arrangement.',
      });
    }

    try {
      const row = await this.db.transaction(async (tx) => {
        const created = await this.repo.insertPartner(
          {
            doctorId: input.doctorId,
            // *** NOT NEGOTIABLE FROM THE REQUEST BODY. ***
            status: 'paused',
            linkSlug: input.linkSlug,
            commissionValueKind: input.commissionValueKind,
            commissionRate: input.commissionRate,
            commissionFlat: input.commissionFlat,
            commissionBase: input.commissionBase,
            commissionMax: input.commissionMax,
            agreementReference: input.agreementReference,
            note: input.note,
            createdByAdminId: actingAdminId,
          },
          tx,
        );

        await this.audit.write(
          {
            actorType: 'admin',
            actorId: actingAdminId,
            action: 'create',
            entityType: PROMOTION_AUDIT_ENTITY_TYPES.AFFILIATE_PARTNER,
            entityId: created.id,
            metadata: {
              doctorId: created.doctorId,
              status: created.status,
              commissionBase: created.commissionBase,
              commissionValueKind: created.commissionValueKind,
              agreementReference: created.agreementReference,
              legalSignOffRequired: true,
              regulation: 'NMC Registered Medical Practitioner (Professional Conduct) Regulations, 2023',
            },
          },
          tx,
        );
        return created;
      });
      return row;
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        throw new ConflictException({
          code: PROMOTION_ERROR_CODES.PARTNER_ALREADY_EXISTS,
          message: 'This doctor or link slug is already in use.',
        });
      }
      throw error;
    }
  }

  /**
   * Moves a partner's status.
   *
   * Activating one while `promotion.affiliate_enabled` is `false` is REFUSED,
   * not silently allowed-but-inert. An admin who thinks they have switched a
   * doctor on has made a commitment to that doctor, and discovering months later
   * that nothing accrued is worse than a clear refusal now.
   */
  async setPartnerStatus(
    actingAdminId: string,
    partnerId: string,
    status: AffiliatePartnerStatus,
  ): Promise<AffiliatePartnerRow> {
    const config = await this.config.getResolved();
    const partner = await this.requirePartner(partnerId);

    if (status === 'active' && !config.affiliateEnabled) {
      throw new ForbiddenException({
        code: PROMOTION_ERROR_CODES.AFFILIATE_DISABLED,
        message:
          'The affiliate mechanism is switched off (promotion.affiliate_enabled). Enabling it is a decision for the client\'s legal advisor — see the NMC Professional Conduct Regulations 2023.',
      });
    }

    const updated = await this.db.transaction(async (tx) => {
      const row = await this.repo.updatePartner(partnerId, { status }, tx);
      if (!row) throw this.partnerNotFound();

      await this.audit.write(
        {
          actorType: 'admin',
          actorId: actingAdminId,
          action: 'update',
          entityType: PROMOTION_AUDIT_ENTITY_TYPES.AFFILIATE_PARTNER,
          entityId: partnerId,
          metadata: {
            change: 'status',
            before: partner.status,
            after: status,
            doctorId: row.doctorId,
            nmcRegulatedArrangement: true,
          },
        },
        tx,
      );
      return row;
    });

    if (status === 'active') {
      this.logger.warn(
        `Admin ${actingAdminId} ACTIVATED affiliate partner ${partnerId} (doctor ${updated.doctorId}). ` +
          'Commissions will now accrue on attributed bookings. NMC exposure lands on the DOCTOR.',
      );
    }

    return updated;
  }

  async updatePartner(
    actingAdminId: string,
    partnerId: string,
    input: Partial<CreatePartnerInput>,
  ): Promise<AffiliatePartnerRow> {
    const partner = await this.requirePartner(partnerId);
    const merged: CreatePartnerInput = {
      doctorId: partner.doctorId,
      linkSlug: input.linkSlug !== undefined ? input.linkSlug : partner.linkSlug,
      commissionValueKind: input.commissionValueKind ?? partner.commissionValueKind,
      commissionRate: input.commissionRate !== undefined ? input.commissionRate : partner.commissionRate,
      commissionFlat: input.commissionFlat !== undefined ? input.commissionFlat : partner.commissionFlat,
      commissionBase: input.commissionBase ?? partner.commissionBase,
      commissionMax: input.commissionMax !== undefined ? input.commissionMax : partner.commissionMax,
      agreementReference:
        input.agreementReference !== undefined ? input.agreementReference : partner.agreementReference,
      note: input.note !== undefined ? input.note : partner.note,
    };
    this.assertPartnerShape(merged);

    return this.db.transaction(async (tx) => {
      const row = await this.repo.updatePartner(
        partnerId,
        {
          linkSlug: merged.linkSlug,
          commissionValueKind: merged.commissionValueKind,
          commissionRate: merged.commissionRate,
          commissionFlat: merged.commissionFlat,
          commissionBase: merged.commissionBase,
          commissionMax: merged.commissionMax,
          agreementReference: merged.agreementReference,
          note: merged.note,
        },
        tx,
      );
      if (!row) throw this.partnerNotFound();

      await this.audit.write(
        {
          actorType: 'admin',
          actorId: actingAdminId,
          action: 'update',
          entityType: PROMOTION_AUDIT_ENTITY_TYPES.AFFILIATE_PARTNER,
          entityId: partnerId,
          metadata: {
            change: 'terms',
            before: {
              commissionValueKind: partner.commissionValueKind,
              commissionRate: partner.commissionRate,
              commissionFlat: partner.commissionFlat,
              commissionBase: partner.commissionBase,
              commissionMax: partner.commissionMax,
            },
            after: {
              commissionValueKind: row.commissionValueKind,
              commissionRate: row.commissionRate,
              commissionFlat: row.commissionFlat,
              commissionBase: row.commissionBase,
              commissionMax: row.commissionMax,
            },
            // Existing commissions are UNAFFECTED: every term is snapshotted on
            // the commission row at accrual, so this edit prices future bookings
            // only.
            appliesToFutureBookingsOnly: true,
          },
        },
        tx,
      );
      return row;
    });
  }

  async getPartner(partnerId: string): Promise<AffiliatePartnerRow> {
    return this.requirePartner(partnerId);
  }

  async listPartners(filter: PartnerListFilter): Promise<{ rows: AffiliatePartnerRow[]; total: number }> {
    const [rows, total] = await Promise.all([this.repo.listPartners(filter), this.repo.countPartners(filter)]);
    return { rows, total };
  }

  async listCommissions(filter: CommissionListFilter): Promise<{ rows: AffiliateCommissionRow[]; total: number }> {
    const [rows, total] = await Promise.all([this.repo.listCommissions(filter), this.repo.countCommissions(filter)]);
    return { rows, total };
  }

  async getOutstanding(partnerId: string): Promise<string> {
    await this.requirePartner(partnerId);
    return this.repo.sumAccruedForPartner(partnerId);
  }

  /* ====================================================================== */
  /* Settlement                                                             */
  /* ====================================================================== */

  /**
   * *** A RECORD THAT A HUMAN PAID A PARTNER. THE SYSTEM NEVER MOVES MONEY. ***
   *
   * `affiliate-settlements.schema.ts`: automated payouts are out of scope this
   * release (`docs/SRS.md` §11), and `payments.payout_paid_at` already
   * establishes the shape — the system records and reports, a person transfers.
   *
   * ONE TRANSACTION, in this order:
   *   1. insert the settlement (so its id exists for the FK),
   *   2. claim `accrued` commissions `WHERE ... AND settlement_id IS NULL`,
   *   3. write `amount` and `commission_count` FROM THE `RETURNING` SET.
   *
   * *** STEP 2's `settlement_id IS NULL` IS THE STATUS GUARD. *** Two admins
   * settling one partner concurrently: the second UPDATE matches zero rows, this
   * method refuses an empty settlement, the transaction rolls back, and no
   * commission is ever paid twice.
   *
   * Step 3 reads the `RETURNING` set and never a prior query, so the settlement
   * row cannot disagree with the commissions it claims.
   */
  async settle(actingAdminId: string, input: SettlePartnerInput): Promise<{ settlementId: string; amount: string; commissionCount: number }> {
    const config = await this.config.getResolved();
    if (!config.affiliateEnabled) {
      throw new ForbiddenException({
        code: PROMOTION_ERROR_CODES.AFFILIATE_DISABLED,
        message: 'The affiliate mechanism is switched off, so there is nothing to settle.',
      });
    }
    await this.requirePartner(input.partnerId);

    return this.db.transaction(async (tx) => {
      const settlement = await this.repo.insertSettlement(
        {
          partnerId: input.partnerId,
          method: input.method,
          // Provisional. Corrected from the RETURNING set below, before commit.
          amount: '0.00',
          commissionCount: 1,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          reference: input.reference,
          note: input.note,
          settledByAdminId: actingAdminId,
        },
        tx,
      );

      const claimed = await this.repo.claimAccruedCommissionsForSettlement(
        input.partnerId,
        settlement.id,
        { periodStart: input.periodStart ?? undefined, periodEnd: input.periodEnd ?? undefined },
        tx,
      );

      if (claimed.length === 0) {
        // Rolls the settlement insert back with it. A settlement of nothing is a
        // mistake, not a record — `affiliate_settlements_amount_check` says the
        // same thing with `commission_count > 0`.
        throw new ConflictException({
          code: PROMOTION_ERROR_CODES.SETTLEMENT_EMPTY,
          message: 'There are no accrued commissions to settle for this partner in this period.',
        });
      }

      const totalPaise = claimed.reduce<bigint>((sum, row) => sum + rupeesToPaise(row.commissionAmount), 0n);
      const amount = paiseToRupees(totalPaise);

      await this.repo.setSettlementTotals(settlement.id, { amount, commissionCount: claimed.length }, tx);

      await this.audit.write(
        {
          actorType: 'admin',
          actorId: actingAdminId,
          action: 'create',
          entityType: PROMOTION_AUDIT_ENTITY_TYPES.AFFILIATE_SETTLEMENT,
          entityId: settlement.id,
          metadata: {
            partnerId: input.partnerId,
            method: input.method,
            amount,
            commissionCount: claimed.length,
            // MIRRORED into the audit metadata as well as the column. The
            // `payments` rule ("the admin who marks a payout paid puts the
            // reference in the metadata of that audit_log row") is honoured even
            // though this table legitimately has its own column — see
            // `affiliate-settlements.schema.ts`.
            reference: input.reference,
            commissionIds: claimed.map((row) => row.id),
            nmcRegulatedArrangement: true,
          },
        },
        tx,
      );

      return { settlementId: settlement.id, amount, commissionCount: claimed.length };
    });
  }

  /** Voids a settlement, returning its commissions to `accrued` so they can be settled again. */
  async voidSettlement(actingAdminId: string, settlementId: string, reason: string): Promise<{ restored: number }> {
    return this.db.transaction(async (tx) => {
      const { settlement, restored } = await this.repo.voidSettlement(settlementId, tx);
      if (!settlement) {
        throw new NotFoundException({
          code: PROMOTION_ERROR_CODES.SETTLEMENT_NOT_FOUND,
          message: 'Settlement not found, or already voided.',
        });
      }

      await this.audit.write(
        {
          actorType: 'admin',
          actorId: actingAdminId,
          action: 'update',
          entityType: PROMOTION_AUDIT_ENTITY_TYPES.AFFILIATE_SETTLEMENT,
          entityId: settlementId,
          metadata: { change: 'voided', reason, restoredCommissions: restored, partnerId: settlement.partnerId },
        },
        tx,
      );
      return { restored };
    });
  }

  async listSettlements(partnerId: string | undefined, limit: number, offset: number) {
    return this.repo.listSettlements(partnerId, limit, offset);
  }

  /**
   * Resolves a LINK SLUG from a shared URL into a signed, self-expiring token.
   *
   * *** THIS IS THE ONLY UNAUTHENTICATED ENTRY POINT IN THE MODULE, AND IT
   * RETURNS NOTHING BUT A TOKEN. *** No partner id, no doctor name, no
   * commission terms — a caller learns only that some slug resolves, and the
   * token it gets back is inert until an authenticated request presents it.
   *
   * Why it exists at all: `affiliate_partners.link_slug` is what a doctor
   * actually shares — `/r/dr-smith-clinic` is a link somebody will type, and a
   * 200-character signed token is not. The slug is a DELIBERATELY SEPARATE
   * NAMESPACE from `discount_instruments.code` (`affiliate-partners.schema.ts`:
   * "a slug lives in a URL and a code is typed into a box"), so resolving one
   * here cannot leak anything about the other.
   *
   * `null` for an unknown slug, a paused partner, or a switched-off mechanism —
   * which is every slug today, since affiliates ship off. Collapsed into one
   * answer for the same reason the code resolver collapses its refusals: a
   * distinguishable "that slug exists but the partner is paused" is a confirmed
   * hit for anybody walking the namespace.
   */
  async resolveLinkSlug(linkSlug: string): Promise<{ token: string; expiresAt: Date } | null> {
    const config = await this.config.getResolved();
    if (!config.affiliateEnabled) return null;
    if (!/^[a-z0-9-]{6,40}$/.test(linkSlug)) return null;

    const partner = await this.repo.findPartnerByLinkSlug(linkSlug);
    if (!partner || partner.status !== 'active') return null;

    return this.mintAttributionToken(partner.id, config.affiliateAttributionDays);
  }

  /** Mints a link token for a partner, honouring the master switch. Returns `null` when affiliates are off — an admin must not be handed a URL that cannot work. */
  async issueAttributionLink(partnerId: string): Promise<{ token: string; expiresAt: Date } | null> {
    const config = await this.config.getResolved();
    if (!config.affiliateEnabled) return null;
    const partner = await this.requirePartner(partnerId);
    if (partner.status !== 'active') return null;
    return this.mintAttributionToken(partner.id, config.affiliateAttributionDays);
  }

  /* ====================================================================== */

  private async requirePartner(partnerId: string): Promise<AffiliatePartnerRow> {
    const partner = await this.repo.findPartnerById(partnerId);
    if (!partner) throw this.partnerNotFound();
    return partner;
  }

  private partnerNotFound(): NotFoundException {
    return new NotFoundException({
      code: PROMOTION_ERROR_CODES.PARTNER_NOT_FOUND,
      message: 'Affiliate partner not found.',
    });
  }

  /**
   * The two CHECK constraints on `affiliate_partners`, enforced in the service
   * as well as the database.
   *
   * `backend/README.md`: services hold the rules, not just the HTTP layer. And a
   * CHECK violation surfaces as a driver error with a constraint name; this
   * surfaces as a message naming the field an admin got wrong.
   */
  private assertPartnerShape(input: CreatePartnerInput): void {
    if (input.commissionValueKind === 'flat') {
      if (input.commissionFlat === null || input.commissionRate !== null) {
        throw this.invalidPartner('A flat commission needs commissionFlat and no commissionRate.');
      }
    } else {
      if (input.commissionRate === null || input.commissionFlat !== null) {
        throw this.invalidPartner('A percentage commission needs commissionRate and no commissionFlat.');
      }
      const rate = Number(input.commissionRate);
      if (!Number.isFinite(rate) || rate <= 0 || rate > 100) {
        throw this.invalidPartner('commissionRate must be greater than 0 and at most 100.');
      }
    }

    // *** A BASE OTHER THAN NET MARGIN CAN OUTRUN WHAT THE BOOKING EARNED. ***
    // Permitted, but only with a stated ceiling — `affiliate_partners_
    // nondefault_base_needs_cap`.
    if (input.commissionBase !== 'net_platform_margin' && input.commissionMax === null) {
      throw this.invalidPartner(
        `commissionMax is required for the ${input.commissionBase} base: it can exceed the platform's margin and make an affiliate booking loss-making.`,
      );
    }

    if (input.linkSlug !== null && !/^[a-z0-9-]{6,40}$/.test(input.linkSlug)) {
      throw new BadRequestException({
        code: PROMOTION_ERROR_CODES.PARTNER_SLUG_INVALID,
        message: 'linkSlug must be 6-40 characters of lower-case letters, digits and hyphens.',
      });
    }
  }

  private invalidPartner(message: string): BadRequestException {
    return new BadRequestException({ code: PROMOTION_ERROR_CODES.PARTNER_INVALID, message });
  }
}
