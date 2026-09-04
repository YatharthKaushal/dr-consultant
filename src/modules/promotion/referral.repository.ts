import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, inArray, or, sql, type SQL } from 'drizzle-orm';
import { DATABASE } from '../../config/db/database.module';
import type { Database, DatabaseTransaction } from '../../config/db/database.config';
import { referralEventsTable, type NewReferralEventRow, type ReferralEventRow } from '../../schema/referral-events.schema';
import type { ReferralEventStatus } from '../../schema/enums.schema';

type Executor = Database | DatabaseTransaction;

export interface ReferralEventListFilter {
  referrerPatientId?: string;
  status?: ReferralEventStatus;
  limit: number;
  offset: number;
}

/**
 * All SQL against `referral_events`.
 *
 * *** THE ANTI-FARMING GUARANTEES LIVE IN THE DATABASE, NOT HERE. ***
 * `referral_events_referee_once_idx` (a patient may be referred once, ever —
 * which also makes circular referral impossible the moment either party has
 * been a referee) and `referral_events_not_self_check` are enforced by
 * Postgres. This file's job is to write rows that respect them and to hand the
 * `23505` back so the service can name it `ALREADY_REFERRED` rather than let it
 * fall through as a 500.
 */
@Injectable()
export class ReferralRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Records that one patient referred another.
   *
   * Deliberately NOT `onConflictDoNothing`: a conflict here means the referee
   * has already been referred by SOMEBODY, and the patient needs to be told
   * (`ALREADY_REFERRED`) rather than have the row silently swallowed and the
   * reservation succeed as if the referral had been recorded. The caller
   * catches the `23505` and maps it by constraint name.
   */
  async insertEvent(values: NewReferralEventRow, executor: Executor = this.db): Promise<ReferralEventRow> {
    const [row] = await executor.insert(referralEventsTable).values(values).returning();
    return row;
  }

  /** Has this patient ever been a referee? The pre-check in front of the index — advisory, never authoritative. */
  async findEventByReferee(refereePatientId: string, executor: Executor = this.db): Promise<ReferralEventRow | null> {
    const [row] = await executor
      .select()
      .from(referralEventsTable)
      .where(eq(referralEventsTable.refereePatientId, refereePatientId))
      .limit(1);
    return row ?? null;
  }

  async findEventByRedemption(redemptionId: string, executor: Executor = this.db): Promise<ReferralEventRow | null> {
    const [row] = await executor
      .select()
      .from(referralEventsTable)
      .where(eq(referralEventsTable.redemptionId, redemptionId))
      .limit(1);
    return row ?? null;
  }

  /**
   * *** THE PER-REFERRER CAP. *** How many of one patient's referrals have
   * actually QUALIFIED. Counted, never stored — the same reasoning as the
   * instrument caps: a stored counter is a second source of truth that drifts.
   */
  async countQualifiedForReferrer(referrerPatientId: string, executor: Executor = this.db): Promise<number> {
    const [row] = await executor
      .select({ value: count() })
      .from(referralEventsTable)
      .where(
        and(
          eq(referralEventsTable.referrerPatientId, referrerPatientId),
          eq(referralEventsTable.status, 'qualified'),
        ),
      );
    return row?.value ?? 0;
  }

  /**
   * One event, unlocked.
   *
   * Exists so `qualify` can learn WHICH REFERRER an event belongs to before it
   * takes any lock — `referrer_patient_id` is immutable once written, so reading
   * it without a lock is safe, and the lock order that follows
   * (`lockReferrerGuard` -> the event row) is the one that matters.
   */
  async findEventById(id: string, executor: Executor = this.db): Promise<ReferralEventRow | null> {
    const [row] = await executor.select().from(referralEventsTable).where(eq(referralEventsTable.id, id)).limit(1);
    return row ?? null;
  }

  /**
   * *** THE PER-REFERRER LOCK. `maxQualifiedReferralsPerReferrer` DEPENDS ON IT. ***
   *
   * `countQualifiedForReferrer` is a COUNT ACROSS MANY EVENT ROWS, and a row
   * lock on ONE of them serialises nothing: two of the same referrer's referrals
   * qualifying at the same moment lock two DIFFERENT `referral_events` rows,
   * both read a count that excludes the other, and both mint — so a cap of 1
   * pays out twice. That is not hypothetical: two API instances sweep
   * concurrently by design (`promotion-sweep.service.ts`: "Two processes
   * sweeping at once is harmless"), which is exactly the arrangement that
   * produces it.
   *
   * A counted cap needs a lock over the SET it counts, and there is no single
   * row that represents "this referrer". So this takes a NAMED ADVISORY LOCK for
   * the lifetime of the caller's transaction — the same `pg_advisory_xact_lock`
   * pattern `availability-rule.service.ts#lockDateGuard` and
   * `identity-access.repository.ts#lockSuperAdminGuard` use, and for the same
   * stated reason: the invariant spans rows, so no unique index can express it.
   *
   * MUST be taken BEFORE the event's own row lock, and before the count.
   */
  async lockReferrerGuard(referrerPatientId: string, tx: DatabaseTransaction): Promise<void> {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`promotion.referrer_guard:${referrerPatientId}`}))`);
  }

  /** The row lock the qualification transition takes, so two sweeps cannot both mint a reward for one referral. */
  async findEventByIdForUpdate(id: string, tx: DatabaseTransaction): Promise<ReferralEventRow | null> {
    const [row] = await tx
      .select()
      .from(referralEventsTable)
      .where(eq(referralEventsTable.id, id))
      .limit(1)
      .for('update');
    return row ?? null;
  }

  /**
   * `qualifying` -> `qualified`. Guarded on the source status, so a second
   * caller matches zero rows and returns `null`.
   *
   * The reward mint is idempotent on its own index anyway
   * (`discount_instruments_referral_reward_once_idx`), so this guard is the
   * second line of defence rather than the only one — the same layering
   * `discount-redemptions.schema.ts` describes for the per-user cap.
   */
  async markQualifiedIfQualifying(
    id: string,
    qualifiedAt: Date,
    executor: Executor = this.db,
  ): Promise<ReferralEventRow | null> {
    const [row] = await executor
      .update(referralEventsTable)
      .set({ status: 'qualified', qualifiedAt, updatedAt: new Date() })
      .where(and(eq(referralEventsTable.id, id), eq(referralEventsTable.status, 'qualifying')))
      .returning();
    return row ?? null;
  }

  /**
   * `qualifying` -> `void`. The consultation was cancelled, expired or
   * no-showed, so this referral will never earn anything.
   *
   * A `qualified` row is NEVER voided here: the reward has already been minted
   * and taking it back is an admin decision with its own audit trail, not
   * something a sweep does on a timer.
   */
  async markVoidIfQualifying(
    id: string,
    reason: string,
    executor: Executor = this.db,
  ): Promise<ReferralEventRow | null> {
    const [row] = await executor
      .update(referralEventsTable)
      .set({ status: 'void', voidedAt: new Date(), voidReason: reason.slice(0, 80), updatedAt: new Date() })
      .where(and(eq(referralEventsTable.id, id), eq(referralEventsTable.status, 'qualifying')))
      .returning();
    return row ?? null;
  }

  /** The sweep's candidate query: referrals waiting on a qualifying status. Oldest first, bounded. */
  async findQualifyingCandidates(limit: number, executor: Executor = this.db): Promise<ReferralEventRow[]> {
    return executor
      .select()
      .from(referralEventsTable)
      .where(eq(referralEventsTable.status, 'qualifying'))
      .orderBy(asc(referralEventsTable.createdAt))
      .limit(limit);
  }

  async listEvents(filter: ReferralEventListFilter, executor: Executor = this.db): Promise<ReferralEventRow[]> {
    return executor
      .select()
      .from(referralEventsTable)
      .where(this.buildWhere(filter))
      .orderBy(desc(referralEventsTable.createdAt))
      .limit(filter.limit)
      .offset(filter.offset);
  }

  async countEvents(filter: ReferralEventListFilter, executor: Executor = this.db): Promise<number> {
    const [row] = await executor.select({ value: count() }).from(referralEventsTable).where(this.buildWhere(filter));
    return row?.value ?? 0;
  }

  /** Batch status read for the patient-facing referral summary — one query for both counts, not one per status. */
  async countForReferrerGrouped(
    referrerPatientId: string,
    statuses: readonly ReferralEventStatus[],
    executor: Executor = this.db,
  ): Promise<Map<ReferralEventStatus, number>> {
    const rows = await executor
      .select({ status: referralEventsTable.status, value: count() })
      .from(referralEventsTable)
      .where(
        and(
          eq(referralEventsTable.referrerPatientId, referrerPatientId),
          inArray(referralEventsTable.status, [...statuses]),
        ),
      )
      .groupBy(referralEventsTable.status);

    return new Map(rows.map((row) => [row.status, row.value]));
  }

  private buildWhere(filter: ReferralEventListFilter): SQL | undefined {
    const conditions: SQL[] = [];
    if (filter.referrerPatientId !== undefined) {
      conditions.push(eq(referralEventsTable.referrerPatientId, filter.referrerPatientId));
    }
    if (filter.status !== undefined) conditions.push(eq(referralEventsTable.status, filter.status));
    if (conditions.length === 0) return undefined;
    return conditions.length === 1 ? conditions[0] : and(...conditions);
  }

  /**
   * M-21/data rights execution, READ-ONLY. See `PromotionContract
   * #countDataRightsRowsForPatient`. Counts EITHER `referrer_patient_id` OR
   * `referee_patient_id` matching — a patient's own referral history includes
   * both rows they started and the one row where they were referred (the
   * unique index on the latter is exactly what "a patient can be referred once,
   * ever" enforces, and RETAIN means that guarantee must not silently reopen).
   */
  async countDataRightsRows(patientId: string, executor: Executor = this.db): Promise<{ referralEvents: number }> {
    const [row] = await executor
      .select({ value: count() })
      .from(referralEventsTable)
      .where(or(eq(referralEventsTable.referrerPatientId, patientId), eq(referralEventsTable.refereePatientId, patientId)));
    return { referralEvents: row?.value ?? 0 };
  }
}
