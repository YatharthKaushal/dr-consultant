import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { DATABASE } from '../../config/db/database.module';
import type { Database, DatabaseTransaction } from '../../config/db/database.config';
import {
  doctorClinicalTemplatesTable,
  type DoctorClinicalTemplateRow,
  type NewDoctorClinicalTemplateRow,
} from '../../schema/doctor-clinical-templates.schema';

/** Either a pooled handle or an open transaction. Same convention as `clinical.repository.ts`. */
type Executor = Database | DatabaseTransaction;

/**
 * All of this module's SQL against `doctor_clinical_templates` (FR-9.6).
 *
 * Dumb CRUD. The prescribing gate on a template's `medicines`, and the
 * ownership check that a template belongs to the calling doctor, both live in
 * `clinical-template.service.ts`.
 *
 * *** NO SOFT DELETE AND NO USAGE COUNTER *** — `doctor-clinical-templates
 * .schema.ts` settles both: nothing references a template row (applying one is
 * a COPY, not a link), so delete is a hard delete; and the picker orders by
 * `updated_at desc`, an ordering no requirement asks a write-on-every-use
 * counter to produce.
 */
@Injectable()
export class ClinicalTemplateRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** One template, scoped to its owner in SQL — there is no "find by id" that could return another doctor's row. */
  async findByIdForDoctor(
    templateId: string,
    doctorId: string,
    executor: Executor = this.db,
  ): Promise<DoctorClinicalTemplateRow | null> {
    const [row] = await executor
      .select()
      .from(doctorClinicalTemplatesTable)
      .where(and(eq(doctorClinicalTemplatesTable.id, templateId), eq(doctorClinicalTemplatesTable.doctorId, doctorId)))
      .limit(1);
    return row ?? null;
  }

  /** The picker: this doctor's templates, most recently touched first. Optionally narrowed to one specialty tag. */
  async listForDoctor(
    doctorId: string,
    specialtyId: string | undefined,
    executor: Executor = this.db,
  ): Promise<DoctorClinicalTemplateRow[]> {
    const conditions = [eq(doctorClinicalTemplatesTable.doctorId, doctorId)];
    if (specialtyId) conditions.push(eq(doctorClinicalTemplatesTable.specialtyId, specialtyId));

    return executor
      .select()
      .from(doctorClinicalTemplatesTable)
      .where(and(...conditions))
      .orderBy(desc(doctorClinicalTemplatesTable.updatedAt));
  }

  async create(data: NewDoctorClinicalTemplateRow, executor: Executor = this.db): Promise<DoctorClinicalTemplateRow> {
    const [row] = await executor.insert(doctorClinicalTemplatesTable).values(data).returning();
    if (!row) {
      throw new Error('doctor_clinical_templates insert returned no row — should be unreachable.');
    }
    return row;
  }

  /** Owner-scoped update. Returns `null` when the id is unknown or belongs to another doctor — the caller cannot tell those apart, and must not be able to. */
  async updateForDoctor(
    templateId: string,
    doctorId: string,
    patch: Partial<NewDoctorClinicalTemplateRow>,
    executor: Executor = this.db,
  ): Promise<DoctorClinicalTemplateRow | null> {
    const [row] = await executor
      .update(doctorClinicalTemplatesTable)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(doctorClinicalTemplatesTable.id, templateId), eq(doctorClinicalTemplatesTable.doctorId, doctorId)))
      .returning();
    return row ?? null;
  }

  /** Owner-scoped hard delete. Returns `false` when nothing matched. */
  async deleteForDoctor(templateId: string, doctorId: string, executor: Executor = this.db): Promise<boolean> {
    const rows = await executor
      .delete(doctorClinicalTemplatesTable)
      .where(and(eq(doctorClinicalTemplatesTable.id, templateId), eq(doctorClinicalTemplatesTable.doctorId, doctorId)))
      .returning({ id: doctorClinicalTemplatesTable.id });
    return rows.length > 0;
  }
}
