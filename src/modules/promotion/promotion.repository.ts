import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, gte, inArray, isNull, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import { DATABASE } from '../../config/db/database.module';
import type { Database, DatabaseTransaction } from '../../config/db/database.config';
import {
  discountInstrumentsTable,
  type DiscountInstrumentRow,
  type NewDiscountInstrumentRow,
} from '../../schema/discount-instruments.schema';
import {
  discountRedemptionsTable,
  type DiscountRedemptionRow,
  type NewDiscountRedemptionRow,
} from '../../schema/discount-redemptions.schema';
import { promotionCodeAttemptsTable } from '../../schema/promotion-code-attempts.schema';
import type {
  DiscountInstrumentKind,
  DiscountInstrumentStatus,
  DiscountRedemptionStatus,
} from '../../schema/enums.schema';

/** A Drizzle db handle or an open transaction. Every method takes either, so a caller can compose a mutation into one transaction. */
type Executor = Database | DatabaseTransaction;

/** The two statuses that HOLD a redemption against every cap. A `released` row is back in the pool. */
export const LIVE_REDEMPTION_STATUSES = ['reserved', 'consumed'] as const satisfies readonly DiscountRedemptionStatus[];

export interface InstrumentListFilter {
  kind?: DiscountInstrumentKind;
  status?: DiscountInstrumentStatus;
  /** Matches the stored, normalised form — the caller normalises first. */
  code?: string;
  affiliatePartnerId?: string;
  limit: number;
  offset: number;
}

/** What the sweep's first tier needs about one expired reservation, without a second query per row. */
export interface ExpiredReservationCandidate {
  redemptionId: string;
  instrumentId: string;
  consultationId: string;
  patientId: string;
  expiresAt: Date;
}

/**
 * All SQL against `discount_instruments`, `discount_redemptions` and
 * `promotion_code_attempts`. No other module reads or writes these tables
 * (`backend/README.md` §2), and nothing in this module writes them except
 * through here.
 *
 * *** THERE IS NO `redeemed_count` COLUMN AND THIS FILE DOES NOT INVENT ONE. ***
 * `discount-instruments.schema.ts` is explicit: "A denormalised counter is a
 * second source of truth that drifts from the redemption rows, silently and
 * unrecoverably." Every cap is answered by a COUNT taken under the instrument's
 * `SELECT ... FOR UPDATE` — the same decision `RefundService` makes for the
 * refund ceiling, for the same reason: a unique index cannot express a sum.
 *
 * The cost objection dissolves on inspection: a count is only ever taken when a
 * cap EXISTS, and the cap bounds the number of matching rows. A 100-redemption
 * coupon means at most 100 index entries, and
 * `discount_redemptions(instrument_id, status)` is the index that serves it.
 */
@Injectable()
export class PromotionRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /* ---------------------------------------------------------------------- */
  /* discount_instruments                                                    */
  /* ---------------------------------------------------------------------- */

  async insertInstrument(
    values: NewDiscountInstrumentRow,
    executor: Executor = this.db,
  ): Promise<DiscountInstrumentRow> {
    const [row] = await executor.insert(discountInstrumentsTable).values(values).returning();
    return row;
  }

  /**
   * Inserts a minted referral reward, tolerating the race.
   *
   * `discount_instruments_referral_reward_once_idx` is the IDEMPOTENCY
   * GUARANTEE — `discount-instruments.schema.ts`: "A referral mints AT MOST ONE
   * reward per side, however many times the mint path runs. The idempotency
   * guarantee is this index, not a flag — a replayed event, a sweep pass and a
   * manual retry can all race safely."
   *
   * `ON CONFLICT DO NOTHING` is what turns that guarantee into a no-op instead
   * of an error. Returns `null` when somebody else already minted it, which is
   * a SUCCESS from the caller's point of view: the reward exists.
   */
  async insertRewardInstrumentIfAbsent(
    values: NewDiscountInstrumentRow,
    executor: Executor = this.db,
  ): Promise<DiscountInstrumentRow | null> {
    const [row] = await executor
      .insert(discountInstrumentsTable)
      .values(values)
      .onConflictDoNothing()
      .returning();
    return row ?? null;
  }

  /**
   * *** THE RESOLVER. One plain unique-index lookup, OUTSIDE any lock. ***
   *
   * `code` is stored ALREADY NORMALISED, so this is an equality probe on
   * `discount_instruments_code_unique` — not an `ILIKE`, not a `lower(code)`
   * functional index, not `citext`. The caller normalises with
   * `promotion-code.util.ts`, the same function the admin writer used to store
   * it, so the two cannot drift.
   *
   * Deliberately NOT locked: `reserve` resolves here and then locks BY ID. The
   * lookup is a read of an immutable identifier, and holding a lock across it
   * would serialise every checkout in the system on one index probe.
   */
  async findInstrumentByCode(code: string, executor: Executor = this.db): Promise<DiscountInstrumentRow | null> {
    const [row] = await executor
      .select()
      .from(discountInstrumentsTable)
      .where(eq(discountInstrumentsTable.code, code))
      .limit(1);
    return row ?? null;
  }

  async findInstrumentById(id: string, executor: Executor = this.db): Promise<DiscountInstrumentRow | null> {
    const [row] = await executor
      .select()
      .from(discountInstrumentsTable)
      .where(eq(discountInstrumentsTable.id, id))
      .limit(1);
    return row ?? null;
  }

  /**
   * *** THE ROW LOCK EVERY CAP DEPENDS ON. ***
   *
   * `SELECT ... FOR UPDATE` on the INSTRUMENT, by id. Two concurrent checkouts
   * of the same coupon serialise here: the second blocks until the first
   * commits, then counts a total that already includes it. Without this lock
   * both would read the same stale count, both would pass, and a coupon capped
   * at N would be redeemed N+1 times — which is exactly what
   * `promotion.redemption-race.integration.spec.ts` proves against a real
   * database with genuinely concurrent callers.
   *
   * MUST be called inside a transaction. Outside one, `pg` releases the lock at
   * the end of the implicit single-statement transaction and it protects
   * nothing, so this deliberately takes a `DatabaseTransaction` rather than an
   * `Executor` — the same signature `PaymentRepository.findByIdForUpdate` uses,
   * for the same reason.
   *
   * *** BY ID, NEVER BY CODE. *** Locking by code would work, but resolving the
   * code inside the lock puts a second index probe in the critical section for
   * no gain. Resolve outside, lock by primary key inside.
   */
  async findInstrumentByIdForUpdate(id: string, tx: DatabaseTransaction): Promise<DiscountInstrumentRow | null> {
    const [row] = await tx
      .select()
      .from(discountInstrumentsTable)
      .where(eq(discountInstrumentsTable.id, id))
      .limit(1)
      .for('update');
    return row ?? null;
  }

  /** The live referral instrument a patient owns, if they have ever asked for one. Backed by `discount_instruments_one_referral_per_patient_idx`. */
  async findReferralInstrumentForPatient(
    patientId: string,
    executor: Executor = this.db,
  ): Promise<DiscountInstrumentRow | null> {
    const [row] = await executor
      .select()
      .from(discountInstrumentsTable)
      .where(
        and(
          eq(discountInstrumentsTable.kind, 'referral'),
          eq(discountInstrumentsTable.referrerPatientId, patientId),
          ne(discountInstrumentsTable.status, 'archived'),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** Every affiliate code attached to a partner. A doctor may have a code, a link, or both. */
  async listInstrumentsForPartner(
    partnerId: string,
    executor: Executor = this.db,
  ): Promise<DiscountInstrumentRow[]> {
    return executor
      .select()
      .from(discountInstrumentsTable)
      .where(eq(discountInstrumentsTable.affiliatePartnerId, partnerId))
      .orderBy(asc(discountInstrumentsTable.createdAt));
  }

  /**
   * What a patient may redeem right now: their vouchers and minted rewards, plus
   * every publicly listed campaign.
   *
   * *** `is_publicly_listed = false` INSTRUMENTS ARE NEVER RETURNED HERE. ***
   * That is the entire point of the column — hidden but still redeemable — and
   * it is also what makes `promotion_code_attempts`' throttle necessary rather
   * than optional. A listing that leaked unlisted codes would hand an attacker
   * the namespace this module spends a rate limiter defending.
   */
  async listRedeemableForPatient(
    patientId: string,
    now: Date,
    executor: Executor = this.db,
  ): Promise<DiscountInstrumentRow[]> {
    return executor
      .select()
      .from(discountInstrumentsTable)
      .where(
        and(
          eq(discountInstrumentsTable.status, 'active'),
          lte(discountInstrumentsTable.validFrom, now),
          or(isNull(discountInstrumentsTable.validTo), gte(discountInstrumentsTable.validTo, now)),
          or(
            eq(discountInstrumentsTable.assignedPatientId, patientId),
            and(
              eq(discountInstrumentsTable.isPubliclyListed, true),
              isNull(discountInstrumentsTable.assignedPatientId),
            ),
          ),
        ),
      )
      .orderBy(desc(discountInstrumentsTable.createdAt))
      .limit(200);
  }

  async updateInstrument(
    id: string,
    values: Partial<NewDiscountInstrumentRow>,
    executor: Executor = this.db,
  ): Promise<DiscountInstrumentRow | null> {
    const [row] = await executor
      .update(discountInstrumentsTable)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(discountInstrumentsTable.id, id))
      .returning();
    return row ?? null;
  }

  /**
   * Moves an instrument's status, guarded on the statuses it is legal to move
   * FROM — the same `updateStatusIfIn` shape `BookingRepository` uses. Returns
   * `null` when the guard did not match, so a caller can tell "I changed it"
   * from "somebody already had".
   */
  async updateInstrumentStatusIfIn(
    id: string,
    from: readonly DiscountInstrumentStatus[],
    to: DiscountInstrumentStatus,
    executor: Executor = this.db,
  ): Promise<DiscountInstrumentRow | null> {
    const [row] = await executor
      .update(discountInstrumentsTable)
      .set({ status: to, updatedAt: new Date() })
      .where(and(eq(discountInstrumentsTable.id, id), inArray(discountInstrumentsTable.status, [...from])))
      .returning();
    return row ?? null;
  }

  async listInstruments(filter: InstrumentListFilter, executor: Executor = this.db): Promise<DiscountInstrumentRow[]> {
    return executor
      .select()
      .from(discountInstrumentsTable)
      .where(this.buildInstrumentWhere(filter))
      .orderBy(desc(discountInstrumentsTable.createdAt))
      .limit(filter.limit)
      .offset(filter.offset);
  }

  async countInstruments(filter: InstrumentListFilter, executor: Executor = this.db): Promise<number> {
    const [row] = await executor
      .select({ value: count() })
      .from(discountInstrumentsTable)
      .where(this.buildInstrumentWhere(filter));
    return row?.value ?? 0;
  }

  private buildInstrumentWhere(filter: InstrumentListFilter): SQL | undefined {
    const conditions: SQL[] = [];
    if (filter.kind !== undefined) conditions.push(eq(discountInstrumentsTable.kind, filter.kind));
    if (filter.status !== undefined) conditions.push(eq(discountInstrumentsTable.status, filter.status));
    if (filter.code !== undefined) conditions.push(eq(discountInstrumentsTable.code, filter.code));
    if (filter.affiliatePartnerId !== undefined) {
      conditions.push(eq(discountInstrumentsTable.affiliatePartnerId, filter.affiliatePartnerId));
    }
    if (conditions.length === 0) return undefined;
    return conditions.length === 1 ? conditions[0] : and(...conditions);
  }

  /* ---------------------------------------------------------------------- */
  /* discount_redemptions — the counted caps                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * *** CAP 1: TOTAL REDEMPTIONS. Read UNDER the instrument's row lock. ***
   *
   * Counts `reserved` AND `consumed`. Counting only consumed rows would let a
   * second checkout be quoted while a first was still at the gateway, and the
   * two together would exceed the cap — the same reasoning
   * `RefundRepository.listCommittedAmounts` gives for counting in-flight refunds
   * against the capture.
   */
  async countLiveRedemptions(instrumentId: string, executor: Executor = this.db): Promise<number> {
    const [row] = await executor
      .select({ value: count() })
      .from(discountRedemptionsTable)
      .where(
        and(
          eq(discountRedemptionsTable.instrumentId, instrumentId),
          inArray(discountRedemptionsTable.status, [...LIVE_REDEMPTION_STATUSES]),
        ),
      );
    return row?.value ?? 0;
  }

  /** *** CAP 2: DISTINCT REDEEMERS. *** `count(distinct patient_id)`, which no unique index can express — hence the row lock. */
  async countDistinctRedeemers(instrumentId: string, executor: Executor = this.db): Promise<number> {
    const [row] = await executor
      .select({ value: sql<string>`count(distinct ${discountRedemptionsTable.patientId})` })
      .from(discountRedemptionsTable)
      .where(
        and(
          eq(discountRedemptionsTable.instrumentId, instrumentId),
          inArray(discountRedemptionsTable.status, [...LIVE_REDEMPTION_STATUSES]),
        ),
      );
    return Number(row?.value ?? 0);
  }

  /**
   * *** CAP 3: PER USER. ***
   *
   * The single-use case ALSO has an index behind it
   * (`discount_redemptions_single_use_per_user_idx`), which survives a bug in
   * this counting logic — `discount-redemptions.schema.ts` calls it the "second
   * line of defence". Caps of 2 or more have only the count, which is why the
   * count is taken under the lock rather than beside it.
   */
  async countLiveRedemptionsForPatient(
    instrumentId: string,
    patientId: string,
    executor: Executor = this.db,
  ): Promise<number> {
    const [row] = await executor
      .select({ value: count() })
      .from(discountRedemptionsTable)
      .where(
        and(
          eq(discountRedemptionsTable.instrumentId, instrumentId),
          eq(discountRedemptionsTable.patientId, patientId),
          inArray(discountRedemptionsTable.status, [...LIVE_REDEMPTION_STATUSES]),
        ),
      );
    return row?.value ?? 0;
  }

  /**
   * The caps, counted in ONE round trip, inside the lock.
   *
   * *** `needsGlobalCounts` IS WHAT KEEPS THE PROMISE THE SCHEMA MAKES. ***
   * `discount-instruments.schema.ts` argues the count is cheap because "a count
   * is only ever taken when a cap EXISTS, and the cap bounds the number of
   * matching rows". That is true of `max_total_redemptions` and
   * `max_distinct_redeemers`, which are NULLABLE — but `max_redemptions_per_user`
   * is NOT NULL and `> 0` by CHECK, so a per-user cap ALWAYS exists and a
   * per-user count is ALWAYS needed.
   *
   * Counting `count(*)` over every live redemption to satisfy a per-user cap
   * would make an uncapped, wildly popular festival coupon scan its entire
   * redemption history on every checkout — the exact unbounded cost the schema's
   * argument claims cannot arise. So when neither global cap is set, the query
   * additionally filters `patient_id = ?` and rides
   * `discount_redemptions(instrument_id, patient_id, status)`, which is bounded
   * by that patient's own per-user cap.
   *
   * One query rather than three: three `count(*)`s would each re-scan the same
   * index while the lock is held. Nothing here touches the network, which is the
   * rule that actually matters (`refund.service.ts`: the gateway call is outside
   * the lock).
   */
  async countCapsUnderLock(
    instrumentId: string,
    patientId: string,
    needsGlobalCounts: boolean,
    tx: DatabaseTransaction,
  ): Promise<{ total: number; distinctRedeemers: number; forPatient: number }> {
    const conditions: SQL[] = [
      eq(discountRedemptionsTable.instrumentId, instrumentId),
      inArray(discountRedemptionsTable.status, [...LIVE_REDEMPTION_STATUSES]),
    ];
    if (!needsGlobalCounts) conditions.push(eq(discountRedemptionsTable.patientId, patientId));

    const [row] = await tx
      .select({
        total: sql<string>`count(*)`,
        distinctRedeemers: sql<string>`count(distinct ${discountRedemptionsTable.patientId})`,
        forPatient: sql<string>`count(*) filter (where ${discountRedemptionsTable.patientId} = ${patientId})`,
      })
      .from(discountRedemptionsTable)
      .where(and(...conditions));

    return {
      // When the query was narrowed to one patient, `total` and
      // `distinctRedeemers` describe only that patient — which is correct,
      // because the caller only consults them when a global cap exists, and a
      // global cap is exactly what makes `needsGlobalCounts` true.
      total: Number(row?.total ?? 0),
      distinctRedeemers: Number(row?.distinctRedeemers ?? 0),
      forPatient: Number(row?.forPatient ?? 0),
    };
  }

  async insertRedemption(
    values: NewDiscountRedemptionRow,
    executor: Executor = this.db,
  ): Promise<DiscountRedemptionRow> {
    const [row] = await executor.insert(discountRedemptionsTable).values(values).returning();
    return row;
  }

  /** The live discount on a consultation — `reserved` or `consumed`. Backed by `discount_redemptions_live_consultation_unique_idx`, so there is at most one. */
  async findLiveRedemptionForConsultation(
    consultationId: string,
    executor: Executor = this.db,
  ): Promise<DiscountRedemptionRow | null> {
    const [row] = await executor
      .select()
      .from(discountRedemptionsTable)
      .where(
        and(
          eq(discountRedemptionsTable.consultationId, consultationId),
          inArray(discountRedemptionsTable.status, [...LIVE_REDEMPTION_STATUSES]),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * The same, under a row lock — what `confirm` and `release` take before they
   * decide anything.
   *
   * *** THIS IS WHAT MAKES `release` NON-FORCING. *** A confirm and a release can
   * genuinely race (a capture webhook arriving as the sweep runs). Both take
   * this lock; the loser re-reads the status UNDER it and finds the winner's
   * decision already made. `release` then returns `null` and leaves the
   * `consumed` row alone rather than overwriting it — see `promotion.service.ts`.
   */
  async findLiveRedemptionForConsultationForUpdate(
    consultationId: string,
    tx: DatabaseTransaction,
  ): Promise<DiscountRedemptionRow | null> {
    const [row] = await tx
      .select()
      .from(discountRedemptionsTable)
      .where(
        and(
          eq(discountRedemptionsTable.consultationId, consultationId),
          inArray(discountRedemptionsTable.status, [...LIVE_REDEMPTION_STATUSES]),
        ),
      )
      .limit(1)
      .for('update');
    return row ?? null;
  }

  /**
   * Burns a reservation. Guarded on `status = 'reserved'`, so a replayed
   * capture updates zero rows and the caller can tell the difference — the same
   * shape as `PaymentRepository.markPaidIfUnpaid`'s `gateway_payment_id IS NULL`
   * guard, and the reason `confirm` is idempotent without a flag.
   */
  async consumeRedemptionIfReserved(
    id: string,
    values: {
      /**
       * `null` ONLY from the sweep's late-confirm path, which knows the booking
       * went live but not which payment paid for it — this module never reads
       * `payments` (`backend/README.md` §2). `attachPaymentIdIfMissing` backfills
       * it when the real confirm eventually arrives.
       */
      paymentId: string | null;
      consumedAt: Date;
      capturedConsultationFee: string | null;
      capturedConvenienceFee: string | null;
    },
    executor: Executor = this.db,
  ): Promise<DiscountRedemptionRow | null> {
    const [row] = await executor
      .update(discountRedemptionsTable)
      .set({
        status: 'consumed',
        paymentId: values.paymentId,
        consumedAt: values.consumedAt,
        capturedConsultationFee: values.capturedConsultationFee,
        capturedConvenienceFee: values.capturedConvenienceFee,
        updatedAt: new Date(),
      })
      .where(and(eq(discountRedemptionsTable.id, id), eq(discountRedemptionsTable.status, 'reserved')))
      .returning();
    return row ?? null;
  }

  /**
   * Backfills the payment id (and the captured bill) on a row the SWEEP consumed
   * before the real confirm arrived.
   *
   * Guarded on `payment_id IS NULL`, so a genuine confirm can never overwrite a
   * payment id that is already there — a reschedule moves a payment between
   * consultations and the two must not be able to fight over one redemption.
   *
   * Returns the number of rows changed, so the caller can log the repair rather
   * than perform it silently: a redemption that needed backfilling is evidence
   * that a `payment.captured` was lost, and that is worth seeing.
   */
  async attachPaymentIdIfMissing(
    id: string,
    values: { paymentId: string; capturedConsultationFee: string | null; capturedConvenienceFee: string | null },
    executor: Executor = this.db,
  ): Promise<number> {
    const rows = await executor
      .update(discountRedemptionsTable)
      .set({
        paymentId: values.paymentId,
        capturedConsultationFee: values.capturedConsultationFee,
        capturedConvenienceFee: values.capturedConvenienceFee,
        updatedAt: new Date(),
      })
      .where(and(eq(discountRedemptionsTable.id, id), isNull(discountRedemptionsTable.paymentId)))
      .returning({ id: discountRedemptionsTable.id });
    return rows.length;
  }

  /**
   * Returns a reservation to the pool. Guarded on `status = 'reserved'`.
   *
   * *** IT CAN NEVER TOUCH A `consumed` ROW. *** That is not a convention, it is
   * the `WHERE` clause: a confirm that won the race leaves a `consumed` row, and
   * this UPDATE matches nothing. `release` returns `null` in that case and the
   * money-adjacent state stands.
   */
  async releaseRedemptionIfReserved(
    id: string,
    reason: string,
    executor: Executor = this.db,
  ): Promise<DiscountRedemptionRow | null> {
    const [row] = await executor
      .update(discountRedemptionsTable)
      .set({
        status: 'released',
        releasedAt: new Date(),
        releaseReason: reason.slice(0, 80),
        updatedAt: new Date(),
      })
      .where(and(eq(discountRedemptionsTable.id, id), eq(discountRedemptionsTable.status, 'reserved')))
      .returning();
    return row ?? null;
  }

  /**
   * The sweep's candidate query: reservations whose grace has lapsed.
   *
   * *** EXPIRY ALONE IS NOT A REASON TO RELEASE. *** It is only a reason to LOOK.
   * `promotion-sweep.service.ts` then asks `PROMOTION_BOOKING_LOOKUP_PORT` what
   * the consultation is actually doing, and a `pending_payment` one is KEPT —
   * the patient may be mid-3-D-Secure, and releasing a discount under a live
   * payment that already priced with it lets the code be spent twice.
   *
   * Ordered oldest first so a backlog drains in the order it accumulated, and
   * bounded by `limit` so one pass cannot become an unbounded scan.
   */
  async findExpiredReservationCandidates(
    now: Date,
    limit: number,
    executor: Executor = this.db,
  ): Promise<ExpiredReservationCandidate[]> {
    return executor
      .select({
        redemptionId: discountRedemptionsTable.id,
        instrumentId: discountRedemptionsTable.instrumentId,
        consultationId: discountRedemptionsTable.consultationId,
        patientId: discountRedemptionsTable.patientId,
        expiresAt: discountRedemptionsTable.expiresAt,
      })
      .from(discountRedemptionsTable)
      .where(
        and(eq(discountRedemptionsTable.status, 'reserved'), lte(discountRedemptionsTable.expiresAt, now)),
      )
      .orderBy(asc(discountRedemptionsTable.expiresAt))
      .limit(limit);
  }

  /** Every redemption of one instrument, for the admin detail screen and the CSV export. */
  async listRedemptionsForInstrument(
    instrumentId: string,
    limit: number,
    offset: number,
    executor: Executor = this.db,
  ): Promise<DiscountRedemptionRow[]> {
    return executor
      .select()
      .from(discountRedemptionsTable)
      .where(eq(discountRedemptionsTable.instrumentId, instrumentId))
      .orderBy(desc(discountRedemptionsTable.createdAt))
      .limit(limit)
      .offset(offset);
  }

  /**
   * The CSV export feed. Ordered ASCENDING by creation so an export reads as a
   * ledger rather than as a reversed screen, and capped by the caller — the same
   * shape as `PaymentRepository.listForExport`.
   */
  async listRedemptionsForExport(
    filter: { createdFrom?: Date; createdTo?: Date; instrumentId?: string; limit: number },
    executor: Executor = this.db,
  ): Promise<DiscountRedemptionRow[]> {
    const conditions: SQL[] = [];
    if (filter.instrumentId !== undefined) {
      conditions.push(eq(discountRedemptionsTable.instrumentId, filter.instrumentId));
    }
    if (filter.createdFrom !== undefined) conditions.push(gte(discountRedemptionsTable.createdAt, filter.createdFrom));
    if (filter.createdTo !== undefined) conditions.push(lte(discountRedemptionsTable.createdAt, filter.createdTo));

    return executor
      .select()
      .from(discountRedemptionsTable)
      .where(conditions.length === 0 ? undefined : conditions.length === 1 ? conditions[0] : and(...conditions))
      .orderBy(asc(discountRedemptionsTable.createdAt))
      .limit(filter.limit);
  }

  /* ---------------------------------------------------------------------- */
  /* promotion_code_attempts — the enumeration throttle                      */
  /* ---------------------------------------------------------------------- */

  /**
   * One row per ATTEMPT.
   *
   * *** BOTH OUTCOMES ARE RECORDED. *** `promotion-code-attempts.schema.ts`: "A
   * throttle that only counts failures is trivially evaded" — an attacker
   * interleaves known-good codes to keep their failure count under the limit.
   *
   * Written on its OWN executor by default, never inside the reservation
   * transaction: an attempt that was made is a fact, and a reservation that
   * rolls back must not erase the evidence that somebody tried.
   */
  async recordCodeAttempt(
    values: { patientId: string | null; ipAddress: string | null; outcome: 'resolved' | 'refused' },
    executor: Executor = this.db,
  ): Promise<void> {
    await executor.insert(promotionCodeAttemptsTable).values(values);
  }

  /**
   * `count(*) WHERE subject = ? AND created_at >= now() - window` — the same
   * shape `otp_request_attempts` and `search_rate_limits` already use here.
   *
   * *** NO REDIS AND NO IN-PROCESS COUNTER. *** Which is what makes it correct
   * across every instance without sticky routing: two API processes counting the
   * same rows reach the same answer, and a deploy does not reset anybody's
   * budget.
   */
  async countRecentAttemptsByPatient(
    patientId: string,
    since: Date,
    executor: Executor = this.db,
  ): Promise<number> {
    const [row] = await executor
      .select({ value: sql<string>`count(*)` })
      .from(promotionCodeAttemptsTable)
      .where(
        and(eq(promotionCodeAttemptsTable.patientId, patientId), gte(promotionCodeAttemptsTable.createdAt, since)),
      );
    return Number(row?.value ?? 0);
  }

  /** Per-IP, because per-patient alone is useless against unauthenticated probing. */
  async countRecentAttemptsByIp(ipAddress: string, since: Date, executor: Executor = this.db): Promise<number> {
    const [row] = await executor
      .select({ value: sql<string>`count(*)` })
      .from(promotionCodeAttemptsTable)
      .where(
        and(eq(promotionCodeAttemptsTable.ipAddress, ipAddress), gte(promotionCodeAttemptsTable.createdAt, since)),
      );
    return Number(row?.value ?? 0);
  }

  /**
   * Drops attempt rows older than `cutoff`.
   *
   * `promotion-code-attempts.schema.ts`: "Rows are disposable. `created_at` is
   * indexed so a retention sweep can drop old ones cheaply." Bounded per pass so
   * a first run against a large backlog does not take a long-lived lock.
   */
  async deleteAttemptsOlderThan(cutoff: Date, limit: number, executor: Executor = this.db): Promise<number> {
    const deleted = await executor
      .delete(promotionCodeAttemptsTable)
      .where(
        inArray(
          promotionCodeAttemptsTable.id,
          this.db
            .select({ id: promotionCodeAttemptsTable.id })
            .from(promotionCodeAttemptsTable)
            .where(lte(promotionCodeAttemptsTable.createdAt, cutoff))
            .limit(limit),
        ),
      )
      .returning({ id: promotionCodeAttemptsTable.id });
    return deleted.length;
  }
}
