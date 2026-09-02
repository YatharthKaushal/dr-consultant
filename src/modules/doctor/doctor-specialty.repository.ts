import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DATABASE } from '../../config/db/database.module';
import type { Database } from '../../config/db/database.config';
import { doctorSpecialtiesTable, type DoctorSpecialtyRow } from '../../schema/doctor-specialties.schema';
import { specialtiesTable, type SpecialtyRow } from '../../schema/specialties.schema';
import type { Executor } from '../identity/identity.repository';

export interface DoctorSpecialtyWithDetails {
  id: string;
  specialtyId: string;
  code: string;
  name: string;
  isPrimary: boolean;
}

/**
 * `doctor_specialties` CRUD, plus the read-only `specialties` lookups this
 * module needs (existence check on assign, `canPrescribe` for
 * `getPrescribingEligibility`). `specialties` itself is M-06-owned — writes
 * to it never happen here, per the task brief ("read-only from this module's
 * perspective... you just need to read `canPrescribe`").
 */
@Injectable()
export class DoctorSpecialtyRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async findSpecialtyById(specialtyId: string, executor: Executor = this.db): Promise<SpecialtyRow | null> {
    const [row] = await executor.select().from(specialtiesTable).where(eq(specialtiesTable.id, specialtyId)).limit(1);
    return row ?? null;
  }

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

  async listByDoctor(doctorId: string, executor: Executor = this.db): Promise<DoctorSpecialtyWithDetails[]> {
    return executor
      .select({
        id: doctorSpecialtiesTable.id,
        specialtyId: doctorSpecialtiesTable.specialtyId,
        code: specialtiesTable.code,
        name: specialtiesTable.name,
        isPrimary: doctorSpecialtiesTable.isPrimary,
      })
      .from(doctorSpecialtiesTable)
      .innerJoin(specialtiesTable, eq(specialtiesTable.id, doctorSpecialtiesTable.specialtyId))
      .where(eq(doctorSpecialtiesTable.doctorId, doctorId));
  }

  /** The doctor's primary specialty joined with `specialties.canPrescribe` — `null` if the doctor has none. */
  async findPrimaryByDoctor(
    doctorId: string,
    executor: Executor = this.db,
  ): Promise<{ specialtyId: string; canPrescribe: boolean } | null> {
    const [row] = await executor
      .select({ specialtyId: doctorSpecialtiesTable.specialtyId, canPrescribe: specialtiesTable.canPrescribe })
      .from(doctorSpecialtiesTable)
      .innerJoin(specialtiesTable, eq(specialtiesTable.id, doctorSpecialtiesTable.specialtyId))
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
