import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, inArray, lte, or } from 'drizzle-orm';
import { DATABASE } from '../../config/db/database.module';
import type { Database, DatabaseTransaction } from '../../config/db/database.config';
import { doctorAvailabilityTable, type DoctorAvailabilityRow } from '../../schema/doctor-availability.schema';

/** A Drizzle db handle or an open transaction — every method here accepts either, defaulting to the module's own pooled connection. */
type Executor = Database | DatabaseTransaction;

export interface WeeklyRuleInput {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}

export interface OverrideRuleInput {
  specificDate: string;
  startTime: string;
  endTime: string;
}

export interface BlockRuleInput {
  specificDate: string;
  /** Both present (partial-day block) or both absent/null (full-day block) — enforced by the caller (`availability-rule.service.ts`), not this repository. */
  startTime?: string | null;
  endTime?: string | null;
}

/** `doctor_availability` table CRUD. */
@Injectable()
export class AvailabilityRuleRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async findById(id: string, executor: Executor = this.db): Promise<DoctorAvailabilityRow | null> {
    const [row] = await executor.select().from(doctorAvailabilityTable).where(eq(doctorAvailabilityTable.id, id)).limit(1);
    return row ?? null;
  }

  /** Every rule for this doctor, any type — the admin "view everything" read. */
  async listByDoctor(doctorId: string, executor: Executor = this.db): Promise<DoctorAvailabilityRow[]> {
    return executor.select().from(doctorAvailabilityTable).where(eq(doctorAvailabilityTable.doctorId, doctorId));
  }

  async listWeeklyByDoctor(doctorId: string, executor: Executor = this.db): Promise<DoctorAvailabilityRow[]> {
    return executor
      .select()
      .from(doctorAvailabilityTable)
      .where(and(eq(doctorAvailabilityTable.doctorId, doctorId), eq(doctorAvailabilityTable.ruleType, 'weekly')));
  }

  /**
   * Weekly rules (unbounded by date — there are at most a handful) PLUS any
   * `custom_hours`/`blocked` row whose `specific_date` falls within
   * `[fromIsoDate, toIsoDate]` inclusive. This is exactly what the slot
   * engine needs to compute bookable slots for that range — see
   * `availability-slot.engine.ts`.
   */
  async listForRange(doctorId: string, fromIsoDate: string, toIsoDate: string, executor: Executor = this.db): Promise<DoctorAvailabilityRow[]> {
    return executor
      .select()
      .from(doctorAvailabilityTable)
      .where(
        and(
          eq(doctorAvailabilityTable.doctorId, doctorId),
          or(
            eq(doctorAvailabilityTable.ruleType, 'weekly'),
            and(gte(doctorAvailabilityTable.specificDate, fromIsoDate), lte(doctorAvailabilityTable.specificDate, toIsoDate)),
          ),
        ),
      );
  }

  /**
   * ADDITIVE (M-09/search): `listForRange` for MANY doctors in one
   * statement, backing `getEarliestBookableSlots`. Identical predicate with
   * `doctor_id IN (...)`; the caller groups the rows by `doctorId` itself.
   */
  async listForRangeForMany(
    doctorIds: readonly string[],
    fromIsoDate: string,
    toIsoDate: string,
    executor: Executor = this.db,
  ): Promise<DoctorAvailabilityRow[]> {
    if (doctorIds.length === 0) return [];
    return executor
      .select()
      .from(doctorAvailabilityTable)
      .where(
        and(
          inArray(doctorAvailabilityTable.doctorId, [...doctorIds]),
          or(
            eq(doctorAvailabilityTable.ruleType, 'weekly'),
            and(gte(doctorAvailabilityTable.specificDate, fromIsoDate), lte(doctorAvailabilityTable.specificDate, toIsoDate)),
          ),
        ),
      );
  }

  /**
   * Atomic delete-then-insert of every `weekly` row for this doctor — a
   * doctor sets their WHOLE week at once (FR-10.1's "sets weekly... slots"),
   * not rule-by-rule. The caller MUST pass an open transaction, so the
   * delete and the insert commit or roll back together.
   */
  async replaceWeekly(doctorId: string, rules: WeeklyRuleInput[], executor: DatabaseTransaction): Promise<DoctorAvailabilityRow[]> {
    await executor
      .delete(doctorAvailabilityTable)
      .where(and(eq(doctorAvailabilityTable.doctorId, doctorId), eq(doctorAvailabilityTable.ruleType, 'weekly')));

    if (rules.length === 0) {
      return [];
    }

    return executor
      .insert(doctorAvailabilityTable)
      .values(
        rules.map((r) => ({
          doctorId,
          ruleType: 'weekly' as const,
          dayOfWeek: r.dayOfWeek,
          specificDate: null,
          startTime: r.startTime,
          endTime: r.endTime,
        })),
      )
      .returning();
  }

  async addOverride(doctorId: string, data: OverrideRuleInput, executor: Executor = this.db): Promise<DoctorAvailabilityRow> {
    const [row] = await executor
      .insert(doctorAvailabilityTable)
      .values({
        doctorId,
        ruleType: 'custom_hours',
        dayOfWeek: null,
        specificDate: data.specificDate,
        startTime: data.startTime,
        endTime: data.endTime,
      })
      .returning();
    if (!row) {
      throw new Error('doctor_availability (custom_hours) insert returned no row — should be unreachable.');
    }
    return row;
  }

  async addBlock(doctorId: string, data: BlockRuleInput, executor: Executor = this.db): Promise<DoctorAvailabilityRow> {
    const [row] = await executor
      .insert(doctorAvailabilityTable)
      .values({
        doctorId,
        ruleType: 'blocked',
        dayOfWeek: null,
        specificDate: data.specificDate,
        startTime: data.startTime ?? null,
        endTime: data.endTime ?? null,
      })
      .returning();
    if (!row) {
      throw new Error('doctor_availability (blocked) insert returned no row — should be unreachable.');
    }
    return row;
  }

  /** Returns whether a row was actually deleted, scoped to `doctorId` so a doctor can never delete another doctor's rule by guessing an id. */
  async removeById(id: string, doctorId: string, executor: Executor = this.db): Promise<boolean> {
    const deleted = await executor
      .delete(doctorAvailabilityTable)
      .where(and(eq(doctorAvailabilityTable.id, id), eq(doctorAvailabilityTable.doctorId, doctorId)))
      .returning({ id: doctorAvailabilityTable.id });
    return deleted.length > 0;
  }
}
