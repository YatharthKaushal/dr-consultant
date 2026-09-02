import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DATABASE } from '../../config/db/database.module';
import type { Database, DatabaseTransaction } from '../../config/db/database.config';
import { specialtiesTable, type SpecialtyRow } from '../../schema/specialties.schema';

/** A Drizzle db handle or an open transaction — every method here accepts either, defaulting to the module's own pooled connection. */
type Executor = Database | DatabaseTransaction;

export interface SpecialtyGeneralFieldsUpdate {
  name?: string;
  description?: string | null;
  canPrescribe?: boolean;
  intakeForm?: unknown;
  firstConsultForm?: unknown;
  requiredDocuments?: string[];
  isActive?: boolean;
}

export interface SpecialtyTemplatesUpdate {
  prescriptionTemplate?: unknown;
  adviceTemplate?: unknown;
}

/** `specialties` table CRUD. */
@Injectable()
export class SpecialtyRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async findById(id: string, executor: Executor = this.db): Promise<SpecialtyRow | null> {
    const [row] = await executor.select().from(specialtiesTable).where(eq(specialtiesTable.id, id)).limit(1);
    return row ?? null;
  }

  async findByCode(code: string, executor: Executor = this.db): Promise<SpecialtyRow | null> {
    const [row] = await executor.select().from(specialtiesTable).where(eq(specialtiesTable.code, code)).limit(1);
    return row ?? null;
  }

  /** Every specialty, active or not — the admin management list. */
  async list(executor: Executor = this.db): Promise<SpecialtyRow[]> {
    return executor.select().from(specialtiesTable).orderBy(specialtiesTable.name);
  }

  /** Active specialties only — the "what can I book" list. */
  async listActive(executor: Executor = this.db): Promise<SpecialtyRow[]> {
    return executor.select().from(specialtiesTable).where(eq(specialtiesTable.isActive, true)).orderBy(specialtiesTable.name);
  }

  async create(
    data: {
      code: string;
      name: string;
      description?: string;
      canPrescribe: boolean;
      intakeForm?: unknown;
      firstConsultForm?: unknown;
      requiredDocuments?: string[];
    },
    executor: Executor = this.db,
  ): Promise<SpecialtyRow> {
    const [row] = await executor.insert(specialtiesTable).values(data).returning();
    if (!row) {
      throw new Error('specialties insert returned no row — should be unreachable.');
    }
    return row;
  }

  async updateGeneralFields(
    id: string,
    data: SpecialtyGeneralFieldsUpdate,
    executor: Executor = this.db,
  ): Promise<SpecialtyRow | null> {
    const [row] = await executor
      .update(specialtiesTable)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(specialtiesTable.id, id))
      .returning();
    return row ?? null;
  }

  async updateTemplates(id: string, data: SpecialtyTemplatesUpdate, executor: Executor = this.db): Promise<SpecialtyRow | null> {
    const [row] = await executor
      .update(specialtiesTable)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(specialtiesTable.id, id))
      .returning();
    return row ?? null;
  }
}
