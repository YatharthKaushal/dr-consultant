import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, inArray, type SQL } from 'drizzle-orm';
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

  async findEventById(id: string, executor: Executor = this.db): Promise<ReferralEventRow | null> {
    const [row] = await executor.select().from(referralEventsTable).where(eq(referralEventsTable.id, id)).limit(1);
    return row ?? null;
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

  async findEventByConsultation(consultationId: string, executor: Executor = this.db): Promise<ReferralEventRow | null> {
    const [row] = await executor
      .select()
      .from(referralEventsTable)
      .where(eq(referralEventsTable.consultationId, consultationId))
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

  async countForReferrerByStatus(
    referrerPatientId: string,
    status: ReferralEventStatus,
    executor: Executor = this.db,
  ): Promise<number> {
    const [row] = await executor
      .select({ value: count() })
      .from(referralEventsTable)
      .where(
        and(eq(referralEventsTable.referrerPatientId, referrerPatientId), eq(referralEventsTable.status, status)),
      );
    return row?.value ?? 0;
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
}
