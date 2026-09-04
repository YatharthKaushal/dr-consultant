import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
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

  /**
   * ADDITIVE (M-15): the newest non-deleted file of one category on one
   * consultation.
   *
   * *** THIS IS `writePrescriptionPdf`'S IDEMPOTENCY CHECK. *** A consultation
   * has at most one live `prescription_pdf`, and this is the query that makes
   * that true: the service consults it BEFORE storing bytes, so a retried
   * finalise cannot leave a patient holding two prescriptions for one consult.
   * Indexed — `patient_files` already carries `index().on(consultationId)`.
   */
  async findByConsultationAndCategory(
    consultationId: string,
    category: PatientFileCategory,
    executor: Executor = this.db,
  ): Promise<PatientFileRow | null> {
    const [row] = await executor
      .select()
      .from(patientFilesTable)
      .where(
        and(
          eq(patientFilesTable.consultationId, consultationId),
          eq(patientFilesTable.fileCategory, category),
          isNull(patientFilesTable.deletedAt),
        ),
      )
      .orderBy(desc(patientFilesTable.createdAt))
      .limit(1);
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

  /**
   * ADDITIVE (M-21/data rights execution): a patient data-deletion preview
   * needs a row count for `patient_files` without touching any of them —
   * `patient_files` is RETAIN in the M-21 compliance survey (SRS §5.3), so
   * this is a pure `SELECT COUNT`, never a delete. Excludes soft-deleted rows
   * (`deleted_at IS NULL`), the same default every other read in this class
   * applies unless its own comment says otherwise — a row the patient
   * already can't see is not part of the live count the preview reports.
   */
  async countByPatient(patientId: string, executor: Executor = this.db): Promise<number> {
    const [row] = await executor
      .select({ count: sql<string>`count(*)` })
      .from(patientFilesTable)
      .where(and(eq(patientFilesTable.patientId, patientId), isNull(patientFilesTable.deletedAt)));
    return Number(row?.count ?? 0);
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
