import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, gt, inArray, isNull, lte, sql, sum, type SQL } from 'drizzle-orm';
import { DATABASE } from '../../config/db/database.module';
import type { Database, DatabaseTransaction } from '../../config/db/database.config';
import {
  affiliateAttributionsTable,
  type AffiliateAttributionRow,
  type NewAffiliateAttributionRow,
} from '../../schema/affiliate-attributions.schema';
import {
  affiliateCommissionsTable,
  type AffiliateCommissionRow,
  type NewAffiliateCommissionRow,
} from '../../schema/affiliate-commissions.schema';
import {
  affiliatePartnersTable,
  type AffiliatePartnerRow,
  type NewAffiliatePartnerRow,
} from '../../schema/affiliate-partners.schema';
import {
  affiliateSettlementsTable,
  type AffiliateSettlementRow,
} from '../../schema/affiliate-settlements.schema';
import type { AffiliateCommissionStatus, AffiliatePartnerStatus } from '../../schema/enums.schema';

type Executor = Database | DatabaseTransaction;

export interface PartnerListFilter {
  status?: AffiliatePartnerStatus;
  limit: number;
  offset: number;
}

export interface CommissionListFilter {
  partnerId?: string;
  status?: AffiliateCommissionStatus;
  limit: number;
  offset: number;
}

/**
 * All SQL against the four affiliate tables.
 *
 * *** SEE `affiliate-partners.schema.ts` FOR THE NMC REGULATORY WARNING THAT
 * GOVERNS WHETHER ANY OF THIS MAY BE SWITCHED ON AT ALL. *** Nothing in this
 * file checks `promotion.affiliate_enabled` — that gate lives in
 * `affiliate.service.ts`, once, where it can be audited, rather than being
 * re-asserted in every query and eventually forgotten in one.
 */
@Injectable()
export class AffiliateRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /* ---------------------------------------------------------------------- */
  /* affiliate_partners                                                      */
  /* ---------------------------------------------------------------------- */

  async insertPartner(values: NewAffiliatePartnerRow, executor: Executor = this.db): Promise<AffiliatePartnerRow> {
    const [row] = await executor.insert(affiliatePartnersTable).values(values).returning();
    return row;
  }

  async findPartnerById(id: string, executor: Executor = this.db): Promise<AffiliatePartnerRow | null> {
    const [row] = await executor
      .select()
      .from(affiliatePartnersTable)
      .where(eq(affiliatePartnersTable.id, id))
      .limit(1);
    return row ?? null;
  }

  /** `affiliate_partners.doctor_id` is UNIQUE — one arrangement per doctor, so this is a probe on that index. */
  async findPartnerByDoctorId(doctorId: string, executor: Executor = this.db): Promise<AffiliatePartnerRow | null> {
    const [row] = await executor
      .select()
      .from(affiliatePartnersTable)
      .where(eq(affiliatePartnersTable.doctorId, doctorId))
      .limit(1);
    return row ?? null;
  }

  /**
   * Resolves a LINK slug.
   *
   * `link_slug` is a DELIBERATELY SEPARATE NAMESPACE from
   * `discount_instruments.code` (`affiliate-partners.schema.ts`): "a slug lives
   * in a URL and a code is typed into a box. A slug typed into the code box
   * resolves to nothing, which is correct — a link carries attribution, not a
   * discount."
   */
  async findPartnerByLinkSlug(linkSlug: string, executor: Executor = this.db): Promise<AffiliatePartnerRow | null> {
    const [row] = await executor
      .select()
      .from(affiliatePartnersTable)
      .where(eq(affiliatePartnersTable.linkSlug, linkSlug))
      .limit(1);
    return row ?? null;
  }

  async updatePartner(
    id: string,
    values: Partial<NewAffiliatePartnerRow>,
    executor: Executor = this.db,
  ): Promise<AffiliatePartnerRow | null> {
    const [row] = await executor
      .update(affiliatePartnersTable)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(affiliatePartnersTable.id, id))
      .returning();
    return row ?? null;
  }

  async listPartners(filter: PartnerListFilter, executor: Executor = this.db): Promise<AffiliatePartnerRow[]> {
    const where = filter.status === undefined ? undefined : eq(affiliatePartnersTable.status, filter.status);
    return executor
      .select()
      .from(affiliatePartnersTable)
      .where(where)
      .orderBy(desc(affiliatePartnersTable.createdAt))
      .limit(filter.limit)
      .offset(filter.offset);
  }

  async countPartners(filter: PartnerListFilter, executor: Executor = this.db): Promise<number> {
    const where = filter.status === undefined ? undefined : eq(affiliatePartnersTable.status, filter.status);
    const [row] = await executor.select({ value: count() }).from(affiliatePartnersTable).where(where);
    return row?.value ?? 0;
  }

  /* ---------------------------------------------------------------------- */
  /* affiliate_attributions — the LINK half. Last touch wins.                */
  /* ---------------------------------------------------------------------- */

  /**
   * Writes a link attribution, superseding whatever was there.
   *
   * *** LAST TOUCH WINS, IN ONE TRANSACTION. ***
   * `affiliate-attributions.schema.ts`: "A later click supersedes the earlier
   * row in the same transaction rather than being rejected." So the supersede
   * and the insert must not be two calls a caller can interleave — they are one
   * method, and the caller passes a `tx`.
   *
   * First-touch would reward whoever INTRODUCED the patient; last-touch rewards
   * whoever CONVERTED them, which for a doctor sending their own patient list is
   * the honest answer.
   */
  async recordAttribution(values: NewAffiliateAttributionRow, tx: DatabaseTransaction): Promise<AffiliateAttributionRow> {
    await tx
      .update(affiliateAttributionsTable)
      .set({ status: 'superseded' })
      .where(
        and(
          eq(affiliateAttributionsTable.patientId, values.patientId),
          eq(affiliateAttributionsTable.status, 'active'),
        ),
      );

    const [row] = await tx.insert(affiliateAttributionsTable).values(values).returning();
    return row;
  }

  /**
   * The patient's live attribution, if any.
   *
   * *** EXPIRY IS CHECKED HERE, NOT IN THE INDEX. ***
   * `affiliate-attributions.schema.ts`: "`now()` is not IMMUTABLE and cannot
   * appear in a partial index predicate, so the index conditions on `status` and
   * the reader additionally filters `expires_at > now()`. Attempting the reverse
   * is a migration that fails."
   */
  async findActiveAttribution(
    patientId: string,
    now: Date,
    executor: Executor = this.db,
  ): Promise<AffiliateAttributionRow | null> {
    const [row] = await executor
      .select()
      .from(affiliateAttributionsTable)
      .where(
        and(
          eq(affiliateAttributionsTable.patientId, patientId),
          eq(affiliateAttributionsTable.status, 'active'),
          gt(affiliateAttributionsTable.expiresAt, now),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /* ---------------------------------------------------------------------- */
  /* affiliate_commissions                                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * *** ONE COMMISSION PER CONSULTATION, EVER. ***
   *
   * `affiliate-commissions.schema.ts`: "A replayed `payment.captured` event, a
   * sweep pass and an explicit confirm can all race to create this row. The
   * index decides and every writer uses `ON CONFLICT DO NOTHING` against it."
   *
   * Returns `null` when somebody else already created it — a SUCCESS for the
   * caller: the commission exists. Never an error, because "this was already
   * recorded" is the correct outcome of a replay.
   */
  async insertCommissionIfAbsent(
    values: NewAffiliateCommissionRow,
    executor: Executor = this.db,
  ): Promise<AffiliateCommissionRow | null> {
    const [row] = await executor
      .insert(affiliateCommissionsTable)
      .values(values)
      .onConflictDoNothing({ target: affiliateCommissionsTable.consultationId })
      .returning();
    return row ?? null;
  }

  async findCommissionByConsultation(
    consultationId: string,
    executor: Executor = this.db,
  ): Promise<AffiliateCommissionRow | null> {
    const [row] = await executor
      .select()
      .from(affiliateCommissionsTable)
      .where(eq(affiliateCommissionsTable.consultationId, consultationId))
      .limit(1);
    return row ?? null;
  }

  /**
   * `pending` -> `accrued`. THE MOMENT MONEY BECOMES OWED.
   *
   * `affiliate-commissions.schema.ts`: "Accruing at capture instead would need a
   * 'payment refunded' signal to claw back, and no such event exists on
   * `payment.contract.ts` today. Gating on the qualifying status means a booking
   * cancelled and refunded before completion NEVER BECOMES PAYABLE IN THE FIRST
   * PLACE."
   *
   * Guarded on `status = 'pending'`, so a second sweep pass matches nothing.
   */
  async accrueCommissionIfPending(
    id: string,
    accruedAt: Date,
    executor: Executor = this.db,
  ): Promise<AffiliateCommissionRow | null> {
    const [row] = await executor
      .update(affiliateCommissionsTable)
      .set({ status: 'accrued', accruedAt, updatedAt: new Date() })
      .where(and(eq(affiliateCommissionsTable.id, id), eq(affiliateCommissionsTable.status, 'pending')))
      .returning();
    return row ?? null;
  }

  /** `pending` -> `void`. The consultation died, so nothing is owed and nothing ever will be. A `settled` row is untouchable here. */
  async voidCommissionIfPending(
    id: string,
    reason: string,
    executor: Executor = this.db,
  ): Promise<AffiliateCommissionRow | null> {
    const [row] = await executor
      .update(affiliateCommissionsTable)
      .set({ status: 'void', voidedAt: new Date(), voidReason: reason.slice(0, 120), updatedAt: new Date() })
      .where(and(eq(affiliateCommissionsTable.id, id), eq(affiliateCommissionsTable.status, 'pending')))
      .returning();
    return row ?? null;
  }

  /** The sweep's candidate query: commissions waiting on a qualifying status. */
  async findPendingCommissions(limit: number, executor: Executor = this.db): Promise<AffiliateCommissionRow[]> {
    return executor
      .select()
      .from(affiliateCommissionsTable)
      .where(eq(affiliateCommissionsTable.status, 'pending'))
      .orderBy(asc(affiliateCommissionsTable.createdAt))
      .limit(limit);
  }

  async listCommissions(filter: CommissionListFilter, executor: Executor = this.db): Promise<AffiliateCommissionRow[]> {
    return executor
      .select()
      .from(affiliateCommissionsTable)
      .where(this.buildCommissionWhere(filter))
      .orderBy(desc(affiliateCommissionsTable.createdAt))
      .limit(filter.limit)
      .offset(filter.offset);
  }

  async countCommissions(filter: CommissionListFilter, executor: Executor = this.db): Promise<number> {
    const [row] = await executor
      .select({ value: count() })
      .from(affiliateCommissionsTable)
      .where(this.buildCommissionWhere(filter));
    return row?.value ?? 0;
  }

  /** What a partner is currently owed — the figure the payout screen shows before anybody settles anything. */
  async sumAccruedForPartner(partnerId: string, executor: Executor = this.db): Promise<string> {
    const [row] = await executor
      .select({ total: sum(affiliateCommissionsTable.commissionAmount) })
      .from(affiliateCommissionsTable)
      .where(
        and(
          eq(affiliateCommissionsTable.partnerId, partnerId),
          eq(affiliateCommissionsTable.status, 'accrued'),
          isNull(affiliateCommissionsTable.settlementId),
        ),
      );
    return row?.total ?? '0.00';
  }

  private buildCommissionWhere(filter: CommissionListFilter): SQL | undefined {
    const conditions: SQL[] = [];
    if (filter.partnerId !== undefined) conditions.push(eq(affiliateCommissionsTable.partnerId, filter.partnerId));
    if (filter.status !== undefined) conditions.push(eq(affiliateCommissionsTable.status, filter.status));
    if (conditions.length === 0) return undefined;
    return conditions.length === 1 ? conditions[0] : and(...conditions);
  }

  /* ---------------------------------------------------------------------- */
  /* affiliate_settlements                                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * *** THE STATUS GUARD THAT MAKES DOUBLE-PAYMENT IMPOSSIBLE. ***
   *
   * `affiliate-settlements.schema.ts` spells out the whole transaction:
   * "`UPDATE affiliate_commissions SET settlement_id = <new>, status = 'settled'
   * WHERE partner_id = ? AND status = 'accrued' AND settlement_id IS NULL
   * RETURNING id`. That last predicate is the status guard... Two admins
   * settling one partner concurrently: the second UPDATE matches zero rows, the
   * service refuses an empty settlement, and no commission is ever paid twice."
   *
   * The `RETURNING` set is the ONLY source for the settlement's `amount` and
   * `commission_count` — never a prior read — so the settlement row cannot
   * disagree with the commissions it claims. That is why this returns the rows
   * rather than a count.
   *
   * `settlementId` is passed in because the settlement row must exist first (the
   * FK points that way), which is also why this takes a `tx`: the insert and
   * this update are one transaction or they are a settlement with no
   * commissions.
   */
  async claimAccruedCommissionsForSettlement(
    partnerId: string,
    settlementId: string,
    window: { periodStart?: Date; periodEnd?: Date },
    tx: DatabaseTransaction,
  ): Promise<Array<{ id: string; commissionAmount: string }>> {
    const conditions: SQL[] = [
      eq(affiliateCommissionsTable.partnerId, partnerId),
      eq(affiliateCommissionsTable.status, 'accrued'),
      // *** THE GUARD. *** Without it, two concurrent settlements both claim the
      // same commissions and the partner is paid twice.
      isNull(affiliateCommissionsTable.settlementId),
    ];
    if (window.periodStart !== undefined) {
      conditions.push(sql`${affiliateCommissionsTable.accruedAt} >= ${window.periodStart}`);
    }
    if (window.periodEnd !== undefined) {
      conditions.push(lte(affiliateCommissionsTable.accruedAt, window.periodEnd));
    }

    return tx
      .update(affiliateCommissionsTable)
      .set({ status: 'settled', settlementId, updatedAt: new Date() })
      .where(and(...conditions))
      .returning({ id: affiliateCommissionsTable.id, commissionAmount: affiliateCommissionsTable.commissionAmount });
  }

  async insertSettlement(
    values: {
      partnerId: string;
      method: 'in_system' | 'off_system';
      amount: string;
      commissionCount: number;
      periodStart: Date | null;
      periodEnd: Date | null;
      reference: string | null;
      note: string | null;
      settledByAdminId: string;
    },
    tx: DatabaseTransaction,
  ): Promise<AffiliateSettlementRow> {
    const [row] = await tx.insert(affiliateSettlementsTable).values(values).returning();
    return row;
  }

  /**
   * Writes the true amount and count back onto the settlement, from the
   * `RETURNING` set.
   *
   * Split from the insert because `affiliate_settlements_amount_check` requires
   * `commission_count > 0` and the count is not known until the claim has run —
   * and the claim needs the settlement's id for its FK. So: insert with the
   * caller's provisional figures, claim, then correct. All three in one
   * transaction, so a settlement whose claim came back empty never commits at
   * all.
   */
  async setSettlementTotals(
    id: string,
    values: { amount: string; commissionCount: number },
    tx: DatabaseTransaction,
  ): Promise<AffiliateSettlementRow | null> {
    const [row] = await tx
      .update(affiliateSettlementsTable)
      .set(values)
      .where(eq(affiliateSettlementsTable.id, id))
      .returning();
    return row ?? null;
  }

  async findSettlementById(id: string, executor: Executor = this.db): Promise<AffiliateSettlementRow | null> {
    const [row] = await executor
      .select()
      .from(affiliateSettlementsTable)
      .where(eq(affiliateSettlementsTable.id, id))
      .limit(1);
    return row ?? null;
  }

  async listSettlements(
    partnerId: string | undefined,
    limit: number,
    offset: number,
    executor: Executor = this.db,
  ): Promise<AffiliateSettlementRow[]> {
    return executor
      .select()
      .from(affiliateSettlementsTable)
      .where(partnerId === undefined ? undefined : eq(affiliateSettlementsTable.partnerId, partnerId))
      .orderBy(desc(affiliateSettlementsTable.settledAt))
      .limit(limit)
      .offset(offset);
  }

  /**
   * Voids a settlement and returns its commissions to `accrued`.
   *
   * `affiliate-settlements.schema.ts`: "`recorded` | `voided`. Voiding returns
   * its commissions to `accrued`." Guarded on the settlement still being
   * `recorded`, so two admins voiding at once cannot double-return anything.
   */
  async voidSettlement(id: string, tx: DatabaseTransaction): Promise<{ settlement: AffiliateSettlementRow | null; restored: number }> {
    const [settlement] = await tx
      .update(affiliateSettlementsTable)
      .set({ status: 'voided' })
      .where(and(eq(affiliateSettlementsTable.id, id), eq(affiliateSettlementsTable.status, 'recorded')))
      .returning();

    if (!settlement) return { settlement: null, restored: 0 };

    const restored = await tx
      .update(affiliateCommissionsTable)
      .set({ status: 'accrued', settlementId: null, updatedAt: new Date() })
      .where(
        and(
          eq(affiliateCommissionsTable.settlementId, id),
          inArray(affiliateCommissionsTable.status, ['settled']),
        ),
      )
      .returning({ id: affiliateCommissionsTable.id });

    return { settlement, restored: restored.length };
  }

  /**
   * M-21/data rights execution, READ-ONLY. See `PromotionContract
   * #countDataRightsRowsForPatient`. `affiliate_commissions` has no direct
   * `patient_id` column — it references `consultation_id` — so it is counted
   * via `consultationIds` instead; an empty array is `0` with no query run,
   * since `inArray` over an empty array is unsafe.
   */
  async countDataRightsRows(
    input: { patientId: string; consultationIds: readonly string[] },
    executor: Executor = this.db,
  ): Promise<{ affiliateAttributions: number; affiliateCommissions: number }> {
    const [attributionsRow] = await executor
      .select({ value: count() })
      .from(affiliateAttributionsTable)
      .where(eq(affiliateAttributionsTable.patientId, input.patientId));

    const affiliateCommissions =
      input.consultationIds.length === 0
        ? 0
        : ((
            await executor
              .select({ value: count() })
              .from(affiliateCommissionsTable)
              .where(inArray(affiliateCommissionsTable.consultationId, [...input.consultationIds]))
          )[0]?.value ?? 0);

    return {
      affiliateAttributions: attributionsRow?.value ?? 0,
      affiliateCommissions,
    };
  }
}
