import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { DATABASE } from '../../config/db/database.module';
import type { Database } from '../../config/db/database.config';
import { doctorSpecialtiesTable, type DoctorSpecialtyRow } from '../../schema/doctor-specialties.schema';
import type { Executor } from '../identity/identity.repository';

/**
 * `doctor_specialties` CRUD — the junction row only. `specialties` is
 * M-06/catalogue-owned; this repository never reads or writes that table
 * (`backend/README.md`: "A module owns its folder, its Postgres schema and
 * its tables. No other module reads or writes them" — that includes
 * read-only joins, which is why this used to inner-join `specialtiesTable`
 * and no longer does). Any code/name/canPrescribe enrichment happens at the
 * service layer via `CatalogueFacade`.
 */
@Injectable()
export class DoctorSpecialtyRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async findByDoctorAndSpecialty(
    doctorId: string,
    specialtyId: string,
    executor: Executor = this.db,
  ): Promise<DoctorSpecialtyRow | null> {
    const [row] = await executor
      .select()
      .from(doctorSpecialtiesTable)
      .where(and(eq(doctorSpecialtiesTable.doctorId, doctorId), eq(doctorSpecialtiesTable.specialtyId, specialtyId)))
      .limit(1);
    return row ?? null;
  }

  async listByDoctor(doctorId: string, executor: Executor = this.db): Promise<DoctorSpecialtyRow[]> {
    return executor.select().from(doctorSpecialtiesTable).where(eq(doctorSpecialtiesTable.doctorId, doctorId));
  }

  /** ADDITIVE (M-09/search): every junction row for a whole page of doctors in one `IN`, so a listing does not pay one round trip per doctor. */
  async listByDoctorIds(doctorIds: readonly string[], executor: Executor = this.db): Promise<DoctorSpecialtyRow[]> {
    if (doctorIds.length === 0) return [];
    return executor.select().from(doctorSpecialtiesTable).where(inArray(doctorSpecialtiesTable.doctorId, [...doctorIds]));
  }

  /** The doctor's primary specialty row — `null` if the doctor has none. `canPrescribe` is catalogue-owned; callers resolve it via `CatalogueFacade.getSpecialtyById(row.specialtyId)`. */
  async findPrimaryByDoctor(doctorId: string, executor: Executor = this.db): Promise<DoctorSpecialtyRow | null> {
    const [row] = await executor
      .select()
      .from(doctorSpecialtiesTable)
      .where(and(eq(doctorSpecialtiesTable.doctorId, doctorId), eq(doctorSpecialtiesTable.isPrimary, true)))
      .limit(1);
    return row ?? null;
  }

  /** Unsets whatever this doctor's current primary specialty is (if any). Call before inserting/promoting a new primary, in the same transaction — see `doctor_specialties_one_primary_idx`. */
  async clearPrimary(doctorId: string, executor: Executor): Promise<void> {
    await executor
      .update(doctorSpecialtiesTable)
      .set({ isPrimary: false })
      .where(and(eq(doctorSpecialtiesTable.doctorId, doctorId), eq(doctorSpecialtiesTable.isPrimary, true)));
  }

  async insert(
    doctorId: string,
    specialtyId: string,
    isPrimary: boolean,
    executor: Executor = this.db,
  ): Promise<DoctorSpecialtyRow> {
    const [row] = await executor.insert(doctorSpecialtiesTable).values({ doctorId, specialtyId, isPrimary }).returning();
    if (!row) {
      throw new Error('doctor_specialties insert returned no row — should be unreachable.');
    }
    return row;
  }

  async setPrimaryFlag(id: string, isPrimary: boolean, executor: Executor = this.db): Promise<DoctorSpecialtyRow | null> {
    const [row] = await executor
      .update(doctorSpecialtiesTable)
      .set({ isPrimary })
      .where(eq(doctorSpecialtiesTable.id, id))
      .returning();
    return row ?? null;
  }

  /** Returns whether a row was actually deleted (`false` when the doctor wasn't assigned that specialty) — the caller must not audit a "remove" that changed nothing. */
  async remove(doctorId: string, specialtyId: string, executor: Executor = this.db): Promise<boolean> {
    const deleted = await executor
      .delete(doctorSpecialtiesTable)
      .where(and(eq(doctorSpecialtiesTable.doctorId, doctorId), eq(doctorSpecialtiesTable.specialtyId, specialtyId)))
      .returning({ id: doctorSpecialtiesTable.id });
    return deleted.length > 0;
  }
}
