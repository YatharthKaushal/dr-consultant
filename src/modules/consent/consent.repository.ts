import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq } from 'drizzle-orm';
import type { Database, DatabaseTransaction } from '../../config/db/database.config';
import { DATABASE } from '../../config/db/database.module';
import { consentsTable, type ConsentRow } from '../../schema/consents.schema';
import type { LegalDocumentType } from '../../schema/enums.schema';
import { legalDocumentsTable } from '../../schema/legal-documents.schema';

/** A Drizzle db handle or an open transaction — every method here accepts either, defaulting to the module's own pooled connection. */
type Executor = Database | DatabaseTransaction;

/**
 * One acceptance with the accepted version resolved. `consents` denormalises
 * `document_type` (so the pre-consult check needs no join) but NOT `version`,
 * which is the thing FR-2.3 requires to be retrievable — so every read that
 * reports a version joins `legal_documents` by the pinned `legal_document_id`.
 */
export interface ConsentAcceptance {
  id: string;
  legalDocumentId: string;
  documentType: LegalDocumentType;
  acceptedAt: Date;
  version: string;
  title: string;
}

/**
 * `consents` — APPEND-ONLY. There is deliberately no update and no delete on
 * this repository: accepting a new version inserts a row, and the row proving
 * acceptance of an older version stays exactly as it was written.
 */
@Injectable()
export class ConsentRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * The most recent acceptance of this type by this patient, whatever version
   * it was. Served by `consents_patient_id_document_type_index` — the index the
   * denormalised `document_type` exists for.
   */
  async findLatestPatientAcceptance(
    patientId: string,
    documentType: LegalDocumentType,
    executor: Executor = this.db,
  ): Promise<ConsentAcceptance | null> {
    const [row] = await executor
      .select(ACCEPTANCE_COLUMNS)
      .from(consentsTable)
      .innerJoin(legalDocumentsTable, eq(consentsTable.legalDocumentId, legalDocumentsTable.id))
      .where(and(eq(consentsTable.patientId, patientId), eq(consentsTable.documentType, documentType)))
      .orderBy(desc(consentsTable.acceptedAt))
      .limit(1);
    return row ?? null;
  }

  /** Whether this patient accepted THIS EXACT version. `consents_patient_id_legal_document_id_index`. */
  async findPatientAcceptanceOfDocument(
    patientId: string,
    legalDocumentId: string,
    executor: Executor = this.db,
  ): Promise<ConsentRow | null> {
    const [row] = await executor
      .select()
      .from(consentsTable)
      .where(and(eq(consentsTable.patientId, patientId), eq(consentsTable.legalDocumentId, legalDocumentId)))
      .limit(1);
    return row ?? null;
  }

  /** Whether this doctor accepted THIS EXACT version. `consents_doctor_id_legal_document_id_index`. */
  async findDoctorAcceptanceOfDocument(
    doctorId: string,
    legalDocumentId: string,
    executor: Executor = this.db,
  ): Promise<ConsentRow | null> {
    const [row] = await executor
      .select()
      .from(consentsTable)
      .where(and(eq(consentsTable.doctorId, doctorId), eq(consentsTable.legalDocumentId, legalDocumentId)))
      .limit(1);
    return row ?? null;
  }

  /** This patient's whole consent history, newest first — FR-2.3's "consent version and time are retrievable". */
  async listPatientAcceptances(patientId: string, executor: Executor = this.db): Promise<ConsentAcceptance[]> {
    return executor
      .select(ACCEPTANCE_COLUMNS)
      .from(consentsTable)
      .innerJoin(legalDocumentsTable, eq(consentsTable.legalDocumentId, legalDocumentsTable.id))
      .where(eq(consentsTable.patientId, patientId))
      .orderBy(desc(consentsTable.acceptedAt));
  }

  /** This doctor's whole consent history, newest first. */
  async listDoctorAcceptances(doctorId: string, executor: Executor = this.db): Promise<ConsentAcceptance[]> {
    return executor
      .select(ACCEPTANCE_COLUMNS)
      .from(consentsTable)
      .innerJoin(legalDocumentsTable, eq(consentsTable.legalDocumentId, legalDocumentsTable.id))
      .where(eq(consentsTable.doctorId, doctorId))
      .orderBy(desc(consentsTable.acceptedAt));
  }

  /**
   * ADDITIVE (M-21/data rights execution). READ-ONLY row count for
   * `DataDeletionExecutionFacade#countConsentsForPatient` — a data-deletion
   * preview needs to report how many `consents` rows this patient has
   * without touching any of them. `consents` is RETAIN in the M-21
   * compliance survey (`consents.schema.ts`: "append-only legal evidence" of
   * acceptance before teleconsultation, SRS §5.2), so this repository still
   * has no update/delete method — that discipline is unchanged.
   */
  async countPatientAcceptances(patientId: string, executor: Executor = this.db): Promise<number> {
    const [row] = await executor.select({ value: count() }).from(consentsTable).where(eq(consentsTable.patientId, patientId));
    return row?.value ?? 0;
  }

  /**
   * `documentType` is passed by the caller from the pinned document's own row,
   * never invented — the composite FK to `legal_documents (id, document_type)`
   * rejects any pair that disagrees, which is exactly what that constraint is
   * there for.
   */
  async create(
    data: {
      patientId?: string | null;
      doctorId?: string | null;
      legalDocumentId: string;
      documentType: LegalDocumentType;
      ipAddress?: string | null;
    },
    executor: Executor = this.db,
  ): Promise<ConsentRow> {
    const [row] = await executor.insert(consentsTable).values(data).returning();
    if (!row) {
      throw new Error('consents insert returned no row — should be unreachable.');
    }
    return row;
  }
}

const ACCEPTANCE_COLUMNS = {
  id: consentsTable.id,
  legalDocumentId: consentsTable.legalDocumentId,
  documentType: consentsTable.documentType,
  acceptedAt: consentsTable.acceptedAt,
  version: legalDocumentsTable.version,
  title: legalDocumentsTable.title,
} as const;
