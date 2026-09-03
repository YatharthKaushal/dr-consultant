import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { DATABASE } from '../../config/db/database.module';
import type { Database, DatabaseTransaction } from '../../config/db/database.config';
import type { DiscountInstrumentRow } from '../../schema/discount-instruments.schema';
import type { AffiliatePartnerRow } from '../../schema/affiliate-partners.schema';
import { AuditService } from '../../shared/audit/audit.service';
import { MoneyFormatError, paiseToRupees, rupeesToPaise } from '../../shared/money/money.util';
import { AffiliateRepository } from './affiliate.repository';
import { AffiliateService } from './affiliate.service';
import { computeDiscount } from './promotion-discount.util';
import { normalisePromotionCode, isValidPromotionCode } from './promotion-code.util';
import { refusalForUniqueViolation } from './promotion-conflict.util';
import { PromotionConfigService, type ResolvedPromotionConfig } from './promotion-config.service';
import { PromotionRepository } from './promotion.repository';
import { ReferralRepository } from './referral.repository';
import type { PromotionBookingLookupPort } from './promotion-booking.contract';
import {
  DISCOUNT_REFUSAL_MESSAGES,
  type DiscountEvaluation,
  type DiscountOrderContext,
  type DiscountQuote,
  type DiscountRefusal,
  type DiscountRefusalReason,
  type DiscountReservation,
  type DiscountReservationResult,
} from './promotion.contract';
import {
  PROMOTION_AUDIT_ENTITY_TYPES,
  PROMOTION_BOOKING_LOOKUP_PORT,
  PROMOTION_ERROR_CODES,
} from './promotion.constants';

/** How long the enumeration throttle's rolling window is. One hour, matching both `promotion.code_attempts_*_per_hour` key names and `otp_request_attempts`' window. */
const ATTEMPT_WINDOW_MS = 60 * 60 * 1000;

/** Everything one evaluation needs that is NOT the instrument itself, gathered before any lock is taken. */
interface EvaluationInputs {
  now: Date;
  config: ResolvedPromotionConfig;
  /** Non-null only for a `kind = 'affiliate'` instrument. */
  partner: AffiliatePartnerRow | null;
  /** `'unknown'` SKIPS the first-consultation rule — see `promotion-booking.contract.ts` for why this `unknown` points the opposite way from the sweep's. */
  priorConsultations: number | 'unknown';
  /** Whether this patient has ever been a referee. Advisory: `referral_events_referee_once_idx` is the authority. */
  alreadyReferred: boolean;
}

/** The three counted caps, read together. `null` when no cap exists on this instrument and therefore no count was taken. */
interface CapCounts {
  total: number;
  distinctRedeemers: number;
  forPatient: number;
}

/**
 * *** THE MODULE'S CORE. RESOLVE, RESERVE, CONFIRM, RELEASE. ***
 *
 * ── THE CORRECTNESS CLAIM, AND WHERE IT LIVES ─────────────────────────────
 *
 * *** A CAPPED COUPON CANNOT BE OVER-REDEEMED UNDER CONCURRENT CHECKOUT. ***
 *
 * That claim does not rest on anything in this file being careful. It rests on
 * `SELECT ... FOR UPDATE` on the INSTRUMENT row, taken by
 * `PromotionRepository.findInstrumentByIdForUpdate`, with the cap counts read
 * UNDER that lock — the same decision `RefundService` makes for the refund
 * ceiling, and for the same stated reason: a CHECK constraint sees one row and
 * a unique index cannot express a sum, so the total is read under the row lock.
 *
 * There is deliberately NO `redeemed_count` column
 * (`discount-instruments.schema.ts`). A denormalised counter is a second source
 * of truth that drifts from the redemption rows, silently and unrecoverably.
 * The cost objection dissolves on inspection: a count is only ever taken when a
 * cap EXISTS, and the cap bounds the matching rows.
 *
 * `promotion.redemption-race.integration.spec.ts` proves this against a real
 * database with genuinely concurrent callers. It is not a unit test and it
 * cannot be — a mock cannot demonstrate that Postgres actually serialises two
 * transactions on that row.
 *
 * ── NOTHING THAT TOUCHES THE NETWORK RUNS INSIDE THE LOCK ─────────────────
 *
 * Every config read, every port call and every code resolution happens in
 * PHASE 0, before the transaction opens. `refund.service.ts` states the
 * principle for its gateway call: holding a row lock across a network call
 * would block every other caller for its duration, and one hung call would
 * stall the queue. Here the "network" is a DI port that becomes a TCP client
 * the day this module is extracted (`backend/README.md` §1), so the rule is
 * enforced now rather than discovered then.
 *
 * ── WHY A UNION AND NOT AN EXCEPTION ──────────────────────────────────────
 *
 * `preview` and `reserve` return a discriminated union. State can legitimately
 * change between them — somebody took the last redemption while the patient was
 * typing their card number — and that is the system working, not an error. A
 * union makes it impossible for the caller to forget. Genuine faults (a
 * malformed stored row, a database outage) still throw.
 */
@Injectable()
export class PromotionService {
  private readonly logger = new Logger(PromotionService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly repo: PromotionRepository,
    private readonly referrals: ReferralRepository,
    private readonly affiliateRepo: AffiliateRepository,
    private readonly affiliates: AffiliateService,
    private readonly config: PromotionConfigService,
    @Inject(PROMOTION_BOOKING_LOOKUP_PORT) private readonly booking: PromotionBookingLookupPort,
    private readonly audit: AuditService,
  ) {}

  /* ====================================================================== */
  /* preview                                                                */
  /* ====================================================================== */

  /**
   * What this code would be worth on this order, writing nothing.
   *
   * The cap check here is ADVISORY — counted without a lock, because a preview
   * has nothing to protect. `reserve` re-counts under the lock and is the
   * authority. That split is exactly `SLOT_NOT_BOOKABLE` (advisory pre-check)
   * versus `SLOT_ALREADY_TAKEN` (the index refusing) in `booking.constants.ts`,
   * and it exists for the same reason: showing a patient a clean "this code is
   * used up" before checkout is worth a query, and being wrong about it
   * occasionally costs nothing because the reserve is what decides.
   */
  async preview(code: string, context: DiscountOrderContext): Promise<DiscountEvaluation> {
    return this.previewForPatient(code, context, null);
  }

  /**
   * `preview` plus a request IP.
   *
   * A SEPARATE METHOD rather than a third optional parameter on `preview`: the
   * frozen `DiscountContract` declares `preview(code, context)`, and this
   * module's structural match with pricing's local mirror is the one thing that
   * must not be clever. This is the entry point this module's OWN controller
   * uses, where an IP genuinely exists.
   */
  async previewForPatient(
    code: string,
    context: DiscountOrderContext,
    ipAddress: string | null,
  ): Promise<DiscountEvaluation> {
    const outcome = await this.evaluateCode(code, context, ipAddress);
    // *** EXACTLY ONE ATTEMPT ROW PER CALL, WHATEVER THE OUTCOME. *** Recording
    // in each branch instead would double-count some paths and under-count
    // others, and a throttle whose arithmetic depends on which refusal fired is
    // a throttle an attacker can steer.
    await this.recordAttempt(context.patientId, ipAddress, outcome.applicable ? 'resolved' : 'refused');
    return outcome;
  }

  /** The evaluation half of `preview`, without the attempt bookkeeping — so `reserve` can reuse the refusal wording without recording a second attempt. */
  private async evaluateCode(
    code: string,
    context: DiscountOrderContext,
    ipAddress: string | null,
  ): Promise<DiscountEvaluation> {
    const basePaise = this.parseDiscountableBase(context.discountableAmount);
    const normalised = normalisePromotionCode(code);

    const throttled = await this.checkThrottle(context.patientId, ipAddress);
    if (throttled) return throttled;

    const resolution = await this.resolve(normalised, context);
    if (!resolution.ok) return resolution.refusal;

    const evaluation = this.evaluate(resolution.instrument, context, basePaise, resolution.inputs, null);
    if (!evaluation.applicable) return evaluation;

    // Advisory cap check, unlocked. `reserve` re-counts under the lock and is
    // the authority; this exists so a patient sees "this code is used up" before
    // checkout rather than at it.
    const capped = await this.checkCapsIfAny(resolution.instrument, context.patientId);
    return capped ?? evaluation;
  }

  /* ====================================================================== */
  /* reserve                                                                */
  /* ====================================================================== */

  /**
   * Pins the discount for a consultation. THE ONE PATH THAT TAKES THE LOCK.
   *
   * PHASE 0 (no lock, no transaction): normalise, throttle, resolve the code by
   *   its unique index, read config, read the partner, ask the booking port.
   *   Everything that could be slow or remote happens here.
   *
   * PHASE 1 (one transaction): `SELECT ... FOR UPDATE` the instrument BY ID ->
   *   re-read status and validity UNDER the lock -> count the three caps ->
   *   insert the redemption -> insert the referral event if this is a referral
   *   -> transactional `AuditService.write(entry, tx)`.
   *
   * *** THE RE-READ UNDER THE LOCK IS NOT REDUNDANT. *** The instrument was
   * resolved in Phase 0 without a lock, and an admin can pause or archive a
   * campaign in the microseconds between. The Phase 0 read is for the code
   * lookup; the Phase 1 read is for the decision.
   */
  async reserve(input: {
    code: string;
    context: DiscountOrderContext;
    consultationId: string;
    holdExpiresAt: Date;
  }): Promise<DiscountReservationResult> {
    const outcome = await this.attemptReserve(input);
    await this.recordAttempt(input.context.patientId, null, outcome.reserved ? 'resolved' : 'refused');
    return outcome;
  }

  /** The reservation itself, without the attempt bookkeeping. One record point lives in `reserve` above. */
  private async attemptReserve(input: {
    code: string;
    context: DiscountOrderContext;
    consultationId: string;
    holdExpiresAt: Date;
  }): Promise<DiscountReservationResult> {
    const { context, consultationId, holdExpiresAt } = input;
    const basePaise = this.parseDiscountableBase(context.discountableAmount);
    const normalised = normalisePromotionCode(input.code);

    /* ---- PHASE 0: everything remote, everything slow, outside the lock --- */

    const throttled = await this.checkThrottle(context.patientId, null);
    if (throttled) return { reserved: false, ...throttled };

    const resolution = await this.resolve(normalised, context, consultationId);
    if (!resolution.ok) return { reserved: false, ...resolution.refusal };

    const instrumentId = resolution.instrument.id;
    const expiresAt = new Date(holdExpiresAt.getTime() + resolution.inputs.config.reservationGraceMinutes * 60_000);

    // The LINK attribution, read before the lock. A non-affiliate coupon must
    // NOT destroy it — see `resolveAttribution`.
    const attribution = await this.resolveAttribution(resolution.instrument, resolution.partner, context, resolution.inputs);

    /* ---- PHASE 1: the lock ---------------------------------------------- */

    try {
      return await this.db.transaction(async (tx) => {
        // *** THE LOCK. Everything below is serialised per instrument. ***
        const locked = await this.repo.findInstrumentByIdForUpdate(instrumentId, tx);
        if (!locked) return this.refuseReservation('CODE_NOT_USABLE');

        // Re-read status and validity UNDER the lock. An admin may have paused
        // the campaign since Phase 0.
        const relocked = this.evaluate(locked, context, basePaise, resolution.inputs, null);
        if (!relocked.applicable) return { reserved: false as const, ...relocked };

        // *** THE THREE CAPS, COUNTED UNDER THE LOCK. *** The per-user cap is
        // NOT NULL and always exists, so a count is always taken; the GLOBAL
        // counts are only taken when a global cap exists, which is what keeps
        // the query bounded — see `countCapsUnderLock`.
        const counts = await this.repo.countCapsUnderLock(
          instrumentId,
          context.patientId,
          this.hasGlobalCap(locked),
          tx,
        );
        const capped = this.refusalForCaps(locked, counts);
        if (capped) return { reserved: false as const, ...capped };

        const redemption = await this.repo.insertRedemption(
          {
            instrumentId,
            patientId: context.patientId,
            consultationId,
            status: 'reserved',
            // *** THE RULE SNAPSHOT. *** `discount-redemptions.schema.ts`:
            // "an admin editing a campaign tomorrow cannot restate what a
            // redemption was worth today. The finance report is reproducible
            // from these columns alone."
            valueKind: locked.valueKind,
            flatAmount: locked.flatAmount,
            percentRate: locked.percentRate,
            maxDiscountAmount: locked.maxDiscountAmount,
            discountableBase: paiseToRupees(basePaise),
            discountAmount: relocked.discountAmount,
            currency: locked.currency,
            affiliatePartnerId: attribution.partnerId,
            attributionSource: attribution.source,
            // Denormalised so the partial unique index can condition on it — a
            // partial index predicate cannot read the parent row. Deliberately a
            // SNAPSHOT: raising a cap later must not retroactively unlock an
            // already-reserved row.
            enforcesSingleUsePerUser: locked.maxRedemptionsPerUser === 1,
            expiresAt,
          },
          tx,
        );

        // A referral code redeemed IS a referral. The event is born
        // `qualifying` — nothing is earned until the consultation reaches a
        // qualifying status.
        if (locked.kind === 'referral' && locked.referrerPatientId !== null) {
          await this.referrals.insertEvent(
            {
              referralInstrumentId: locked.id,
              referrerPatientId: locked.referrerPatientId,
              refereePatientId: context.patientId,
              consultationId,
              redemptionId: redemption.id,
              status: 'qualifying',
              // The programme terms in force RIGHT NOW, copied whole. A config
              // edit must not change what an in-flight referral is worth.
              programSnapshot: resolution.inputs.config.referralProgram,
            },
            tx,
          );
        }

        // *** TRANSACTIONAL AUDIT. *** `docs/MODULES.md` §7. A discount is money
        // leaving the platform, so this is `write(entry, tx)` and never
        // best-effort: a redemption must not be able to exist un-audited.
        await this.audit.write(
          {
            actorType: 'patient',
            actorId: context.patientId,
            action: 'create',
            entityType: PROMOTION_AUDIT_ENTITY_TYPES.REDEMPTION,
            entityId: redemption.id,
            consultationId,
            metadata: {
              change: 'reserved',
              instrumentId,
              code: locked.code,
              kind: locked.kind,
              discountableBase: paiseToRupees(basePaise),
              discountAmount: relocked.discountAmount,
              currency: locked.currency,
              expiresAt: expiresAt.toISOString(),
              attributionSource: attribution.source,
              affiliatePartnerId: attribution.partnerId,
            },
          },
          tx,
        );

        return {
          reserved: true as const,
          reservationId: redemption.id,
          instrumentId,
          code: locked.code,
          discountAmount: relocked.discountAmount,
          expiresAt,
        };
      });
    } catch (error) {
      // *** THE INDEXES GET THE LAST WORD. *** Three partial unique indexes can
      // refuse this insert, each meaning something different to a patient. A
      // `23505` that reaches here beat the counted checks, which is exactly what
      // those indexes exist for.
      const refusal = refusalForUniqueViolation(error);
      if (!refusal) throw error;

      if (refusal.reason === 'CODE_NOT_USABLE') {
        this.logger.warn(
          `Reservation for consultation ${consultationId} was refused by an unrecognised unique constraint ` +
            `(${refusal.constraint ?? 'unnamed'}); reported as CODE_NOT_USABLE. If this is a new index, map it in promotion-conflict.util.ts.`,
        );
      }
      return this.refuseReservation(refusal.reason);
    }
  }

  /* ====================================================================== */
  /* confirm                                                                */
  /* ====================================================================== */

  /**
   * The payment was captured — burn the reservation.
   *
   * IDEMPOTENT, by the `status = 'reserved'` guard on the UPDATE rather than by
   * a flag. A replayed capture matches zero rows and observes the `consumed`
   * state instead, which is the same second-idempotency-layer shape
   * `PaymentRepository.markPaidIfUnpaid` uses.
   *
   * *** IT ALSO RUNS WHEN THERE IS NO REDEMPTION. *** A patient who typed no
   * code may still carry a LINK attribution, and the doctor's commission must
   * not evaporate because the patient did not also use a coupon. In that case
   * this returns `null` (there is no reservation to report) having recorded a
   * `pending` commission — which is why the return type's `null` does not mean
   * "nothing happened".
   */
  async confirm(input: {
    consultationId: string;
    paymentId: string;
    capturedComponents?: ReadonlyArray<{ code: string; amount: string }>;
  }): Promise<{ reservationId: string; status: 'consumed' } | null> {
    const config = await this.config.getResolved();
    const captured = this.affiliates.readCapturedComponents(input.capturedComponents);

    return this.db.transaction(async (tx) => {
      const row = await this.repo.findLiveRedemptionForConsultationForUpdate(input.consultationId, tx);

      // No code was applied to this consultation, so there is no reservation to
      // burn.
      //
      // *** A LINK ATTRIBUTION MAY STILL OWE A COMMISSION HERE, AND THIS METHOD
      // CANNOT PAY IT. *** `DiscountContract.confirm` is FROZEN and carries no
      // `patientId`, and with no redemption row there is nothing to look an
      // attribution up by — this module may not read `consultations` to find
      // one. `AffiliateService.recordLinkOnlyCommissionForPatient` is the entry
      // point that can, exposed on `PromotionFacade` beyond the frozen contract
      // for the coordinator to wire. Affiliates ship OFF, so nothing is silently
      // lost today; see that method's comment.
      if (!row) return null;

      // A REPLAYED capture — or a row the SWEEP burnt with no payment id, which
      // is the same shape. Both are repaired rather than refused:
      //
      //   - `attachPaymentIdIfMissing` backfills the payment the sweep could not
      //     know, guarded on `payment_id IS NULL` so a genuine id is never
      //     overwritten.
      //   - the commission attempt is `ON CONFLICT DO NOTHING`, so replaying it
      //     also repairs a first confirm that died between the consume and the
      //     commission.
      if (row.status === 'consumed') {
        const backfilled = await this.repo.attachPaymentIdIfMissing(
          row.id,
          {
            paymentId: input.paymentId,
            capturedConsultationFee: captured.consultationFee,
            capturedConvenienceFee: captured.convenienceFee,
          },
          tx,
        );
        if (backfilled > 0) {
          this.logger.warn(
            `Redemption ${row.id} was consumed by the sweep with no payment id and has now been reconciled to payment ${input.paymentId}. A payment.captured was probably lost.`,
          );
        }
        await this.affiliates.recordCommissionForRedemption(
          { redemption: { ...row, paymentId: input.paymentId }, paymentId: input.paymentId, captured, config },
          tx,
        );
        return { reservationId: row.id, status: 'consumed' as const };
      }

      const consumed = await this.repo.consumeRedemptionIfReserved(
        row.id,
        {
          paymentId: input.paymentId,
          consumedAt: new Date(),
          capturedConsultationFee: captured.consultationFee,
          capturedConvenienceFee: captured.convenienceFee,
        },
        tx,
      );
      // Unreachable while the row lock is held — the status cannot change under
      // us — but a guarded UPDATE that returns nothing is never assumed away.
      if (!consumed) return null;

      await this.affiliates.recordCommissionForRedemption(
        { redemption: consumed, paymentId: input.paymentId, captured, config },
        tx,
      );

      await this.audit.write(
        {
          actorType: 'system',
          actorId: null,
          action: 'update',
          entityType: PROMOTION_AUDIT_ENTITY_TYPES.REDEMPTION,
          entityId: consumed.id,
          consultationId: input.consultationId,
          metadata: {
            change: 'consumed',
            before: 'reserved',
            after: 'consumed',
            paymentId: input.paymentId,
            instrumentId: consumed.instrumentId,
            discountAmount: consumed.discountAmount,
            capturedConvenienceFee: captured.convenienceFee,
          },
        },
        tx,
      );

      return { reservationId: consumed.id, status: 'consumed' as const };
    });
  }

  /**
   * The SWEEP's confirm: the booking went live, so the discount was spent, but
   * nobody told us which payment paid for it.
   *
   * *** WHY A SEPARATE METHOD RATHER THAN `confirm(..., paymentId: null)`. ***
   * `DiscountContract.confirm` requires a `paymentId: string` and it is FROZEN.
   * Widening that parameter to `string | null` would change the shape pricing
   * mirrors locally, which is the one thing that must not drift. So the
   * null-payment path lives here, off the contract, reachable only from this
   * module's own sweep.
   *
   * No commission is created on this path: `affiliate_commissions.payment_id` is
   * NOT NULL, so there is genuinely nothing to write. A real `confirm` arriving
   * later backfills the payment id AND creates the commission, because that
   * branch runs `recordCommissionForRedemption` on an already-`consumed` row for
   * exactly this reason.
   */
  async confirmFromSweep(consultationId: string, observedStatus: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const row = await this.repo.findLiveRedemptionForConsultationForUpdate(consultationId, tx);
      if (!row || row.status !== 'reserved') return false;

      const consumed = await this.repo.consumeRedemptionIfReserved(
        row.id,
        { paymentId: null, consumedAt: new Date(), capturedConsultationFee: null, capturedConvenienceFee: null },
        tx,
      );
      if (!consumed) return false;

      await this.audit.write(
        {
          actorType: 'system',
          actorId: null,
          action: 'update',
          entityType: PROMOTION_AUDIT_ENTITY_TYPES.REDEMPTION,
          entityId: consumed.id,
          consultationId,
          metadata: {
            change: 'consumed',
            before: 'reserved',
            after: 'consumed',
            source: 'sweep_backstop',
            observedConsultationStatus: observedStatus,
            // The flag that makes every unreconciled burn findable by predicate.
            // A row with this set and no payment id means a `payment.captured`
            // went missing.
            paymentIdUnknown: true,
          },
        },
        tx,
      );

      this.logger.warn(
        `Redemption ${consumed.id} for consultation ${consultationId} was consumed by the sweep (status ${observedStatus}) ` +
          'with no payment id — a payment.captured was probably lost. It will be reconciled if a confirm arrives.',
      );
      return true;
    });
  }

  /* ====================================================================== */
  /* release                                                                */
  /* ====================================================================== */

  /**
   * Returns a reservation to the pool.
   *
   * *** IT NEVER FORCES. *** If a confirm won the race under the lock, the row
   * is `consumed`, this returns `null`, and the consumed row is left exactly as
   * it is. That is not politeness: releasing a consumed redemption would return
   * a capacity slot to a capped coupon that has ALREADY been spent on a bill the
   * patient has already paid, so the coupon could be redeemed once more than its
   * cap allows. `booking-slot-hold.service.ts#releaseHold` takes the identical
   * position for slots ("returns `false` in that case rather than forcing the
   * release").
   *
   * Idempotent: a second release finds no live row and returns `null`.
   */
  async release(input: { consultationId: string; reason: string }): Promise<{ reservationId: string; status: 'released' } | null> {
    return this.db.transaction(async (tx) => {
      const row = await this.repo.findLiveRedemptionForConsultationForUpdate(input.consultationId, tx);
      if (!row) return null;

      // *** THE CONFIRM WON. Leave it alone. ***
      if (row.status === 'consumed') return null;

      const released = await this.repo.releaseRedemptionIfReserved(row.id, input.reason, tx);
      if (!released) return null;

      // A referral whose redemption was released will never qualify. Voided
      // here, in the same transaction, so the two cannot disagree. A `qualified`
      // event is untouched — its reward is already minted and clawing that back
      // is an admin decision with its own trail, not something a release does.
      const event = await this.referrals.findEventByRedemption(row.id, tx);
      if (event) await this.referrals.markVoidIfQualifying(event.id, input.reason, tx);

      // Same for a commission that was created but never accrued.
      await this.affiliates.voidPendingCommissionForConsultation(input.consultationId, input.reason, tx);

      await this.audit.write(
        {
          actorType: 'system',
          actorId: null,
          action: 'update',
          entityType: PROMOTION_AUDIT_ENTITY_TYPES.REDEMPTION,
          entityId: released.id,
          consultationId: input.consultationId,
          metadata: {
            change: 'released',
            before: 'reserved',
            after: 'released',
            reason: input.reason,
            instrumentId: released.instrumentId,
            referralEventVoided: event?.id ?? null,
          },
        },
        tx,
      );

      return { reservationId: released.id, status: 'released' as const };
    });
  }

  /* ====================================================================== */
  /* getForConsultation                                                     */
  /* ====================================================================== */

  /**
   * The discount currently attached to a consultation — `reserved` OR
   * `consumed`.
   *
   * Consumed rows are included deliberately: pricing re-renders a paid booking's
   * bill and needs to know what came off it. `discount_redemptions_live_
   * consultation_unique_idx` guarantees there is at most one.
   */
  async getForConsultation(consultationId: string): Promise<DiscountReservation | null> {
    const row = await this.repo.findLiveRedemptionForConsultation(consultationId);
    if (!row) return null;

    const instrument = await this.repo.findInstrumentById(row.instrumentId);
    return {
      reservationId: row.id,
      instrumentId: row.instrumentId,
      // The code is on the instrument, not the redemption. An instrument that
      // has vanished is impossible (the FK forbids it), so the fallback is
      // defensive rather than expected.
      code: instrument?.code ?? '',
      discountAmount: row.discountAmount,
      expiresAt: row.expiresAt,
    };
  }

  /* ====================================================================== */
  /* Patient-facing listing                                                 */
  /* ====================================================================== */

  /**
   * Every code this patient may redeem right now: their own vouchers and minted
   * rewards, plus every PUBLICLY LISTED campaign.
   *
   * *** AN UNLISTED CAMPAIGN IS NEVER RETURNED HERE. *** `is_publicly_listed =
   * false` means hidden but still redeemable, which is an explicit product
   * requirement — and a listing that leaked those codes would hand an attacker
   * exactly the namespace `promotion_code_attempts`' throttle spends a rate
   * limiter defending. The repository enforces it in SQL rather than trusting
   * this method to filter.
   */
  async listRedeemableForPatient(
    patientId: string,
  ): Promise<ReadonlyArray<{ code: string; label: string; description: string | null; validTo: string | null }>> {
    const rows = await this.repo.listRedeemableForPatient(patientId, new Date());
    return rows.map((row) => ({
      code: row.code,
      label: row.label,
      description: row.description,
      validTo: row.validTo?.toISOString() ?? null,
    }));
  }

  /* ====================================================================== */
  /* Resolution and evaluation                                              */
  /* ====================================================================== */

  /**
   * Code -> instrument, plus everything the evaluation needs that is not on the
   * instrument. NO LOCK IS TAKEN HERE, and no transaction is open.
   *
   * *** EVERY "no" AT THIS STAGE IS THE SAME "no". *** Not a code at all, no such
   * code, a draft campaign, a paused one, an archived one, one that has not
   * started, one that has expired, one assigned to somebody else — all
   * `CODE_NOT_USABLE`, with one message. `booking.constants.ts` states the
   * reasoning for `BOOKING_NOT_FOUND` ("so a caller with no relationship cannot
   * probe for existence") and it matters more here: `is_publicly_listed = false`
   * means hidden-but-redeemable, which is exactly what makes walking the
   * namespace worth an attacker's time. A distinguishable "that code exists but
   * expired" is a confirmed hit.
   */
  private async resolve(
    normalisedCode: string,
    context: DiscountOrderContext,
    consultationId?: string,
  ): Promise<
    | { ok: true; instrument: DiscountInstrumentRow; partner: AffiliatePartnerRow | null; inputs: EvaluationInputs }
    | { ok: false; refusal: DiscountRefusal }
  > {
    // Not even a well-formed code. Collapsed into the same answer, so an
    // attacker cannot use the shape of the response to learn the code format.
    if (!isValidPromotionCode(normalisedCode)) {
      return { ok: false, refusal: this.refuse('CODE_NOT_USABLE') };
    }

    const instrument = await this.repo.findInstrumentByCode(normalisedCode);
    if (!instrument) return { ok: false, refusal: this.refuse('CODE_NOT_USABLE') };

    const config = await this.config.getResolved();

    const partner =
      instrument.affiliatePartnerId === null
        ? null
        : await this.affiliateRepo.findPartnerById(instrument.affiliatePartnerId);

    // The port reads. OUTSIDE any lock, and only when the kind actually needs
    // them — a coupon never pays for a referral lookup.
    let priorConsultations: number | 'unknown' = 'unknown';
    let alreadyReferred = false;
    if (instrument.kind === 'referral') {
      alreadyReferred = (await this.referrals.findEventByReferee(context.patientId)) !== null;
      if (config.referralProgram.refereeMustBeFirstConsultation) {
        priorConsultations = await this.booking.countPriorConsultations(context.patientId, consultationId ?? null);
      }
    }

    return { ok: true, instrument, partner, inputs: { now: new Date(), config, partner, priorConsultations, alreadyReferred } };
  }

  /**
   * One instrument, one order -> a quote or a refusal. PURE given its inputs,
   * which is what lets `reserve` run it twice — once in Phase 0 and once under
   * the lock — and get the same answer for the same state.
   *
   * `counts` is `null` in Phase 0 and in `preview`'s first pass; the caps are
   * checked separately so this function never needs a database handle.
   */
  private evaluate(
    instrument: DiscountInstrumentRow,
    context: DiscountOrderContext,
    basePaise: bigint,
    inputs: EvaluationInputs,
    counts: CapCounts | null,
  ): DiscountEvaluation {
    /* ---- Usability. Every branch is the same answer. ------------------- */

    if (instrument.status !== 'active') return this.refuse('CODE_NOT_USABLE');
    if (instrument.validFrom.getTime() > inputs.now.getTime()) return this.refuse('CODE_NOT_USABLE');
    if (instrument.validTo !== null && instrument.validTo.getTime() <= inputs.now.getTime()) {
      return this.refuse('CODE_NOT_USABLE');
    }

    /* ---- Currency ------------------------------------------------------ */

    if (instrument.currency !== context.currency) return this.refuse('CURRENCY_MISMATCH');

    /* ---- Kind-specific ownership and eligibility ----------------------- */

    switch (instrument.kind) {
      case 'coupon':
        break;

      case 'voucher':
      case 'referral_reward':
        // Assigned to exactly one patient. "Not yours" is collapsed into
        // `CODE_NOT_USABLE` on purpose: a distinguishable answer would confirm
        // that somebody else's voucher code is real.
        if (instrument.assignedPatientId !== context.patientId) return this.refuse('CODE_NOT_USABLE');
        break;

      case 'referral': {
        if (!inputs.config.referralProgram.enabled) return this.refuse('CODE_NOT_USABLE');
        // Self-referral. `referral_events_not_self_check` refuses it in the
        // database too; this is the answer a patient can read.
        if (instrument.referrerPatientId === context.patientId) return this.refuse('SELF_REFERRAL');
        // Repeat referee, and — because being a referee is once-ever — circular
        // referral too: A refers B, then B cannot refer A back, because A would
        // have to become a referee and B already is one.
        if (inputs.alreadyReferred) return this.refuse('ALREADY_REFERRED');
        if (
          inputs.config.referralProgram.refereeMustBeFirstConsultation &&
          typeof inputs.priorConsultations === 'number' &&
          inputs.priorConsultations > 0
        ) {
          return this.refuse('NOT_A_FIRST_CONSULTATION');
        }
        break;
      }

      case 'affiliate': {
        // *** THE REGULATORY GATE, FIRST. *** With the mechanism switched off,
        // an affiliate code is indistinguishable from a code that does not
        // exist — which is both the safe answer and the honest one.
        if (!inputs.config.affiliateEnabled) return this.refuse('CODE_NOT_USABLE');
        if (inputs.partner === null || inputs.partner.status !== 'active') return this.refuse('CODE_NOT_USABLE');
        // A doctor's own code on a booking with that same doctor. Refused
        // explicitly rather than silently not paying: the patient should not be
        // shown a discount that exists only to route a commission back to the
        // person they are booking.
        if (context.doctorId !== null && inputs.partner.doctorId === context.doctorId) {
          return this.refuse('SELF_AFFILIATE');
        }
        break;
      }

      default:
        return this.refuse('CODE_NOT_USABLE');
    }

    /* ---- Minimum order. THE ONE REFUSAL A PATIENT CAN ACT ON. ---------- */

    const minOrderPaise = rupeesToPaise(instrument.minOrderAmount);
    if (basePaise < minOrderPaise) {
      return {
        applicable: false,
        reason: 'MIN_ORDER_NOT_MET',
        message: DISCOUNT_REFUSAL_MESSAGES.MIN_ORDER_NOT_MET,
        requiredMinOrder: instrument.minOrderAmount,
      };
    }

    /* ---- Caps, when the caller has already counted them ---------------- */

    if (counts !== null) {
      const capped = this.refusalForCaps(instrument, counts);
      if (capped) return capped;
    }

    /* ---- The arithmetic ------------------------------------------------ */

    const computed = computeDiscount(
      {
        valueKind: instrument.valueKind,
        flatAmount: instrument.flatAmount,
        percentRate: instrument.percentRate,
        maxDiscountAmount: instrument.maxDiscountAmount,
      },
      basePaise,
    );

    const quote: DiscountQuote = {
      applicable: true,
      instrumentId: instrument.id,
      kind: instrument.kind,
      code: instrument.code,
      label: instrument.label,
      discountAmount: computed.discountAmount,
      residualDiscountable: computed.residualDiscountable,
      // An affiliate code whose value is zero exists purely to route
      // attribution. Pricing needs to know, because a zero discount that is
      // nonetheless "applied" changes what the checkout screen says.
      attributionOnly: computed.attributionOnly,
      fullyDiscounted: computed.fullyDiscounted,
    };
    return quote;
  }

  /**
   * True when a cap needs counts across ALL patients, rather than just this one.
   *
   * `max_redemptions_per_user` is NOT NULL and `> 0` by CHECK, so a per-user cap
   * ALWAYS exists and a per-patient count is always needed. Only these two are
   * nullable, and only these two require the unbounded-looking global count — so
   * only these two decide whether it is paid for.
   */
  private hasGlobalCap(instrument: DiscountInstrumentRow): boolean {
    return instrument.maxTotalRedemptions !== null || instrument.maxDistinctRedeemers !== null;
  }

  /**
   * The three caps, given counts.
   *
   * *** THE DISTINCT-REDEEMER CHECK IS NOT `>=` ALONE. *** A patient who ALREADY
   * holds a live redemption of this instrument is not a NEW distinct redeemer,
   * so a "first 100 customers" coupon must still let customer 42 redeem their
   * second allowed use after the hundredth customer has arrived. `forPatient > 0`
   * is what expresses that; without it the cap would silently become a total cap
   * for everybody who was not first.
   */
  private refusalForCaps(instrument: DiscountInstrumentRow, counts: CapCounts): DiscountRefusal | null {
    if (instrument.maxTotalRedemptions !== null && counts.total >= instrument.maxTotalRedemptions) {
      return this.refuse('TOTAL_LIMIT_REACHED');
    }
    if (counts.forPatient >= instrument.maxRedemptionsPerUser) {
      return this.refuse('USER_LIMIT_REACHED');
    }
    if (
      instrument.maxDistinctRedeemers !== null &&
      counts.forPatient === 0 &&
      counts.distinctRedeemers >= instrument.maxDistinctRedeemers
    ) {
      return this.refuse('DISTINCT_USER_LIMIT_REACHED');
    }
    return null;
  }

  /**
   * The unlocked, advisory cap check `preview` uses.
   *
   * The global counts are skipped entirely when no global cap exists, for the
   * same bounding reason `countCapsUnderLock` gives — and here it matters more,
   * because `preview` runs on every keystroke-adjacent "apply code" tap while
   * `reserve` runs once per checkout.
   */
  private async checkCapsIfAny(instrument: DiscountInstrumentRow, patientId: string): Promise<DiscountRefusal | null> {
    const forPatient = await this.repo.countLiveRedemptionsForPatient(instrument.id, patientId);
    if (!this.hasGlobalCap(instrument)) {
      return this.refusalForCaps(instrument, { total: 0, distinctRedeemers: 0, forPatient });
    }
    const [total, distinctRedeemers] = await Promise.all([
      this.repo.countLiveRedemptions(instrument.id),
      this.repo.countDistinctRedeemers(instrument.id),
    ]);
    return this.refusalForCaps(instrument, { total, distinctRedeemers, forPatient });
  }

  /* ====================================================================== */
  /* Attribution                                                            */
  /* ====================================================================== */

  /**
   * Which partner, if any, this redemption is attributed to.
   *
   * *** CODE BEATS LINK, AND A NON-AFFILIATE COUPON MUST NOT DESTROY A LINK. ***
   *
   *   affiliate code redeemed        -> that partner, source `code`
   *   any other code + live link     -> the linked partner, source `link`
   *   any other code, no link        -> no attribution
   *
   * The middle row is the one worth stating: a patient who arrived through Dr A's
   * link and then used a festival coupon has still been sent by Dr A, and the
   * commission should not evaporate because they also saved ₹100. The
   * attribution is COPIED onto the redemption at reserve time
   * (`discount-redemptions.schema.ts`: "Attribution frozen here, so a later
   * partner edit cannot rewrite history") rather than re-derived at capture.
   *
   * A link whose partner is the doctor being booked attributes NOTHING — the
   * same rule `SELF_AFFILIATE` states for a typed code, applied silently here
   * because there is no patient-facing decision to report: the coupon is fine,
   * it is only the commission that does not arise.
   */
  private async resolveAttribution(
    instrument: DiscountInstrumentRow,
    partner: AffiliatePartnerRow | null,
    context: DiscountOrderContext,
    inputs: EvaluationInputs,
  ): Promise<{ partnerId: string | null; source: string | null }> {
    if (!inputs.config.affiliateEnabled) return { partnerId: null, source: null };

    if (instrument.kind === 'affiliate' && partner !== null) {
      return { partnerId: partner.id, source: 'code' };
    }

    const link = await this.affiliateRepo.findActiveAttribution(context.patientId, inputs.now);
    if (!link) return { partnerId: null, source: null };

    const linkPartner = await this.affiliateRepo.findPartnerById(link.partnerId);
    if (!linkPartner || linkPartner.status !== 'active') return { partnerId: null, source: null };
    if (context.doctorId !== null && linkPartner.doctorId === context.doctorId) {
      return { partnerId: null, source: null };
    }

    return { partnerId: linkPartner.id, source: 'link' };
  }

  /* ====================================================================== */
  /* The enumeration throttle                                               */
  /* ====================================================================== */

  /**
   * *** WHY THIS EXISTS AT ALL. *** A "resolve this code" endpoint is a machine
   * for discovering valid codes, and "hidden but still redeemable" — an explicit
   * product requirement — is exactly what makes discovering them worthwhile.
   * Without a throttle an attacker walks the namespace and harvests every
   * unlisted campaign.
   *
   * Counted from `promotion_code_attempts` over a rolling hour, the same shape
   * `otp_request_attempts` and `search_rate_limits` already use here. NO REDIS
   * and no in-process counter, which is what makes it correct across every
   * instance without sticky routing.
   *
   * *** `ipAddress` IS NULL ON THE PRICING PATH, AND THAT IS NOT A GAP. ***
   * `DiscountOrderContext` is FROZEN and carries no IP, and adding a required
   * argument to `preview`/`reserve` would break the structural match with
   * pricing's local mirror. So the pricing path throttles per PATIENT — which is
   * always present and always authenticated there — and this module's own
   * controller, which does see a request IP, throttles on both. The
   * unauthenticated probing the IP limit defends against cannot reach the
   * pricing path in the first place, because that path requires a `patientId`.
   */
  private async checkThrottle(patientId: string, ipAddress: string | null): Promise<DiscountRefusal | null> {
    const config = await this.config.getResolved();
    const since = new Date(Date.now() - ATTEMPT_WINDOW_MS);

    const patientCount = await this.repo.countRecentAttemptsByPatient(patientId, since);
    if (patientCount >= config.codeAttemptsPerPatientPerHour) return this.refuse('TOO_MANY_ATTEMPTS');

    if (ipAddress !== null) {
      const ipCount = await this.repo.countRecentAttemptsByIp(ipAddress, since);
      if (ipCount >= config.codeAttemptsPerIpPerHour) return this.refuse('TOO_MANY_ATTEMPTS');
    }

    return null;
  }

  /**
   * Records one attempt, best-effort.
   *
   * Written on this module's own connection, NEVER inside a caller's
   * transaction: an attempt that was made is a fact, and a reservation that
   * rolls back must not erase the evidence that somebody tried — which is
   * precisely the evasion a transactional throttle would permit.
   *
   * A failure here is logged and swallowed. `AuditService`'s best-effort mode
   * gives the reasoning: failing a patient's checkout because a rate-limit
   * bookkeeping row would not insert is a self-inflicted outage, and the
   * throttle degrades to "slightly more permissive for one attempt" rather than
   * to "nothing works".
   */
  private async recordAttempt(
    patientId: string | null,
    ipAddress: string | null,
    outcome: 'resolved' | 'refused',
  ): Promise<void> {
    try {
      await this.repo.recordCodeAttempt({ patientId, ipAddress, outcome });
    } catch (error) {
      this.logger.error(`Could not record a promotion code attempt (best-effort, swallowed): ${describeError(error)}`);
    }
  }

  /* ====================================================================== */
  /* Small helpers                                                          */
  /* ====================================================================== */

  private refuse(reason: DiscountRefusalReason): DiscountRefusal {
    return { applicable: false, reason, message: DISCOUNT_REFUSAL_MESSAGES[reason] };
  }

  private refuseReservation(reason: DiscountRefusalReason): DiscountReservationResult {
    return { reserved: false, ...this.refuse(reason) };
  }

  /**
   * `discountableAmount` -> paise.
   *
   * *** THIS THROWS RATHER THAN REFUSING. *** A malformed base is not a state a
   * patient can do anything about and not a refusal they can act on — it is a
   * caller bug at the pricing seam, and burying it in a `CODE_NOT_USABLE` would
   * make every code look broken while the real fault stayed invisible. The
   * contract's "genuine faults still throw" is exactly this case.
   */
  private parseDiscountableBase(amount: string): bigint {
    try {
      return rupeesToPaise(amount);
    } catch (error) {
      if (error instanceof MoneyFormatError) {
        throw new BadRequestException({
          code: PROMOTION_ERROR_CODES.AMOUNT_INVALID,
          message: 'discountableAmount must be a non-negative amount with at most two decimal places.',
        });
      }
      throw error;
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
