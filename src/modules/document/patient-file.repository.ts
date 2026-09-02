import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import { DATABASE } from '../../config/db/database.module';
import type { Database, DatabaseTransaction } from '../../config/db/database.config';
import { patientFilesTable, type NewPatientFileRow, type PatientFileRow } from '../../schema/patient-files.schema';
import type { PatientFileCategory } from '../../schema/enums.schema';

/** A Drizzle db handle or an open transaction — every method here accepts either, defaulting to the module's own pooled connection. Same pattern as `search-config.repository.ts`. */
type Executor = Database | DatabaseTransaction;

/**
 * `patient_files` CRUD. Every read here EXCLUDES soft-deleted rows
 * (`deleted_at IS NULL`) unless a method's own doc comment says otherwise —
 * `findById` is the one deliberate exception, since a caller occasionally
 * needs to see a deleted row's shape (e.g. to return a clean 404 rather than
 * a 500 when it's already gone). Business rules — ownership, the
 * `uploaded_by_doctor_id` delete carve-out, the completed-consultation delete
 * block — all live in `patient-file.service.ts`, not here; this repository
 * is dumb CRUD, matching `doctor-document.repository.ts`'s own division of
 * labour.
 */
@Injectable()
export class PatientFileRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async create(data: NewPatientFileRow, executor: Executor = this.db): Promise<PatientFileRow> {
    const [row] = await executor.insert(patientFilesTable).values(data).returning();
    if (!row) {
      throw new Error('patient_files insert returned no row — should be unreachable.');
    }
    return row;
  }

  /** Any row by id, INCLUDING a soft-deleted one — the caller decides what a set `deletedAt` means for its own purpose. */
  async findById(id: string, executor: Executor = this.db): Promise<PatientFileRow | null> {
    const [row] = await executor.select().from(patientFilesTable).where(eq(patientFilesTable.id, id)).limit(1);
    return row ?? null;
  }

  /** Own non-deleted files, newest first, optionally narrowed to one category. */
  async listByPatient(
    patientId: string,
    category: PatientFileCategory | undefined,
    executor: Executor = this.db,
  ): Promise<PatientFileRow[]> {
    const conditions = [eq(patientFilesTable.patientId, patientId), isNull(patientFilesTable.deletedAt)];
    if (category) conditions.push(eq(patientFilesTable.fileCategory, category));

    return executor
      .select()
      .from(patientFilesTable)
      .where(and(...conditions))
      .orderBy(desc(patientFilesTable.createdAt));
  }

  /**
   * The treating-doctor cross-consultation history read (`docs/MODULES.md`'s
   * M-10 section): every `medical_history` file for `patientId` regardless
   * of which consultation it is attached to (or none), UNIONED with every
   * file attached to any consultation in `consultationIds` — the ids of
   * every consultation this doctor has ever had with this patient, resolved
   * by the caller via `ConsultationLookupPort#listConsultationIdsBetween`
   * before calling this. A single `OR`, not two queries plus an in-memory
   * merge, so a file that is BOTH `medical_history` AND attached to one of
   * this doctor's own consultations is still returned exactly once.
   *
   * `consultationIds` empty is handled explicitly rather than trusted to
   * `inArray([])` — that branch of the `OR` is simply dropped, so the query
   * still returns the `medical_history` rows on their own.
   */
  async listForDoctorHistory(patientId: string, consultationIds: string[], executor: Executor = this.db): Promise<PatientFileRow[]> {
    const medicalHistoryBranch = and(eq(patientFilesTable.fileCategory, 'medical_history'), eq(patientFilesTable.patientId, patientId));

    const scopeCondition = consultationIds.length > 0 ? or(medicalHistoryBranch, inArray(patientFilesTable.consultationId, consultationIds)) : medicalHistoryBranch;

    return executor
      .select()
      .from(patientFilesTable)
      .where(and(isNull(patientFilesTable.deletedAt), scopeCondition))
      .orderBy(desc(patientFilesTable.createdAt));
  }

  /** Soft-deletes one row (`deletedAt = now()`), only if it is not already deleted. Returns the updated row, or `null` if `id` doesn't exist or was already deleted (idempotent-safe: a second delete attempt reports "not found", not a silent no-op success). */
  async softDelete(id: string, executor: Executor = this.db): Promise<PatientFileRow | null> {
    const [row] = await executor
      .update(patientFilesTable)
      .set({ deletedAt: new Date() })
      .where(and(eq(patientFilesTable.id, id), isNull(patientFilesTable.deletedAt)))
      .returning();
    return row ?? null;
  }
}
