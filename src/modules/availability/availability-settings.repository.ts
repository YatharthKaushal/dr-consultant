import { Inject, Injectable } from '@nestjs/common';
import { eq, inArray } from 'drizzle-orm';
import { DATABASE } from '../../config/db/database.module';
import type { Database, DatabaseTransaction } from '../../config/db/database.config';
import { doctorSchedulingSettingsTable, type DoctorSchedulingSettingsRow } from '../../schema/doctor-scheduling-settings.schema';

/** A Drizzle db handle or an open transaction — every method here accepts either, defaulting to the module's own pooled connection. */
type Executor = Database | DatabaseTransaction;

export interface SchedulingSettingsUpsert {
  minNoticeMinutes?: number | null;
  bookingHorizonDays?: number | null;
  slotIntervalMinutes?: number | null;
}

/** `doctor_scheduling_settings` CRUD. A doctor with no overrides has NO ROW — see the table's own doc comment. */
@Injectable()
export class AvailabilitySettingsRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async findByDoctor(doctorId: string, executor: Executor = this.db): Promise<DoctorSchedulingSettingsRow | null> {
    const [row] = await executor
      .select()
      .from(doctorSchedulingSettingsTable)
      .where(eq(doctorSchedulingSettingsTable.doctorId, doctorId))
      .limit(1);
    return row ?? null;
  }

  /** ADDITIVE (M-09/search): overrides for many doctors in one statement, backing `getEarliestBookableSlots`. Doctors with no overrides simply have no row — the caller falls back to the platform default for those. */
  async listByDoctorIds(doctorIds: readonly string[], executor: Executor = this.db): Promise<DoctorSchedulingSettingsRow[]> {
    if (doctorIds.length === 0) return [];
    return executor
      .select()
      .from(doctorSchedulingSettingsTable)
      .where(inArray(doctorSchedulingSettingsTable.doctorId, [...doctorIds]));
  }

  /** Insert-or-update in one statement — `doctorId` is both the PK and the FK, so there is at most one row per doctor. */
  async upsert(doctorId: string, data: SchedulingSettingsUpsert, executor: Executor = this.db): Promise<DoctorSchedulingSettingsRow> {
    const [row] = await executor
      .insert(doctorSchedulingSettingsTable)
      .values({ doctorId, ...data })
      .onConflictDoUpdate({
        target: doctorSchedulingSettingsTable.doctorId,
        set: { ...data, updatedAt: new Date() },
      })
      .returning();
    if (!row) {
      throw new Error('doctor_scheduling_settings upsert returned no row — should be unreachable.');
    }
    return row;
  }
}
