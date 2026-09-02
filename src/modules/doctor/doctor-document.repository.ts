import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DATABASE } from '../../config/db/database.module';
import type { Database } from '../../config/db/database.config';
import { doctorDocumentsTable, type DoctorDocumentRow } from '../../schema/doctor-documents.schema';
import type { DoctorDocumentType, DocumentReviewStatus } from '../../schema/enums.schema';
import type { Executor } from '../identity/identity.repository';

export interface CreateDoctorDocumentData {
  doctorId: string;
  documentType: DoctorDocumentType;
  storageKey: string;
  fileName: string;
}

export interface ReviewDoctorDocumentData {
  reviewStatus: DocumentReviewStatus;
  verifiedByAdminId: string;
  verifiedAt: Date;
  rejectionReason: string | null;
}

/**
 * `doctor_documents` CRUD. This module owns the METADATA/review-workflow
 * row only — not the upload mechanism (M-10 doesn't exist yet); `storageKey`
 * arrives already-uploaded from the caller and is never returned to a
 * client (see the schema comment on that column).
 */
@Injectable()
export class DoctorDocumentRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async findById(id: string, executor: Executor = this.db): Promise<DoctorDocumentRow | null> {
    const [row] = await executor.select().from(doctorDocumentsTable).where(eq(doctorDocumentsTable.id, id)).limit(1);
    return row ?? null;
  }

  async findByIdForDoctor(id: string, doctorId: string, executor: Executor = this.db): Promise<DoctorDocumentRow | null> {
    const [row] = await executor
      .select()
      .from(doctorDocumentsTable)
      .where(and(eq(doctorDocumentsTable.id, id), eq(doctorDocumentsTable.doctorId, doctorId)))
      .limit(1);
    return row ?? null;
  }

  async listByDoctor(doctorId: string, executor: Executor = this.db): Promise<DoctorDocumentRow[]> {
    return executor
      .select()
      .from(doctorDocumentsTable)
      .where(eq(doctorDocumentsTable.doctorId, doctorId))
      .orderBy(doctorDocumentsTable.createdAt);
  }

  async create(data: CreateDoctorDocumentData, executor: Executor = this.db): Promise<DoctorDocumentRow> {
    const [row] = await executor.insert(doctorDocumentsTable).values(data).returning();
    if (!row) {
      throw new Error('doctor_documents insert returned no row — should be unreachable.');
    }
    return row;
  }

  async review(id: string, data: ReviewDoctorDocumentData, executor: Executor = this.db): Promise<DoctorDocumentRow | null> {
    const [row] = await executor.update(doctorDocumentsTable).set(data).where(eq(doctorDocumentsTable.id, id)).returning();
    return row ?? null;
  }
}
