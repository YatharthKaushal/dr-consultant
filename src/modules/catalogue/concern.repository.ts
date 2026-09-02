import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { DATABASE } from '../../config/db/database.module';
import type { Database, DatabaseTransaction } from '../../config/db/database.config';
import { concernsTable, type ConcernRow } from '../../schema/concerns.schema';

/** A Drizzle db handle or an open transaction — every method here accepts either, defaulting to the module's own pooled connection. */
type Executor = Database | DatabaseTransaction;

export interface ConcernGeneralFieldsUpdate {
  name?: string;
  isActive?: boolean;
  specialtyId?: string;
}

export interface ConcernMappingUpdate {
  matchPhrases?: string[];
  matchWeight?: number;
}

/** `concerns` table CRUD. Ordered by name always — schema's own doc comment: "never by a hand-set position." */
@Injectable()
export class ConcernRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async findById(id: string, executor: Executor = this.db): Promise<ConcernRow | null> {
    const [row] = await executor.select().from(concernsTable).where(eq(concernsTable.id, id)).limit(1);
    return row ?? null;
  }

  async findBySpecialtyAndCode(specialtyId: string, code: string, executor: Executor = this.db): Promise<ConcernRow | null> {
    const [row] = await executor
      .select()
      .from(concernsTable)
      .where(and(eq(concernsTable.specialtyId, specialtyId), eq(concernsTable.code, code)))
      .limit(1);
    return row ?? null;
  }

  /** Every concern, active or not, optionally filtered by specialty — the admin management list. */
  async list(specialtyId: string | undefined, executor: Executor = this.db): Promise<ConcernRow[]> {
    const query = executor.select().from(concernsTable);
    if (specialtyId) {
      return query.where(eq(concernsTable.specialtyId, specialtyId)).orderBy(concernsTable.name);
    }
    return query.orderBy(concernsTable.name);
  }

  /** Active concerns only, optionally filtered by specialty — the public list. */
  async listActive(specialtyId: string | undefined, executor: Executor = this.db): Promise<ConcernRow[]> {
    const conditions = specialtyId
      ? and(eq(concernsTable.isActive, true), eq(concernsTable.specialtyId, specialtyId))
      : eq(concernsTable.isActive, true);
    return executor.select().from(concernsTable).where(conditions).orderBy(concernsTable.name);
  }

  /**
   * ADDITIVE (M-09/search): one round trip for a list of ids. NOT filtered by
   * `isActive` — see `CatalogueContract.getConcernsByIds`. An empty `ids`
   * short-circuits rather than emitting `in ()`, which Postgres rejects.
   */
  async listByIds(ids: readonly string[], executor: Executor = this.db): Promise<ConcernRow[]> {
    if (ids.length === 0) return [];
    return executor
      .select()
      .from(concernsTable)
      .where(inArray(concernsTable.id, [...ids]))
      .orderBy(concernsTable.id);
  }

  async create(
    data: { specialtyId: string; code: string; name: string; matchPhrases?: string[]; matchWeight?: number; isActive?: boolean },
    executor: Executor = this.db,
  ): Promise<ConcernRow> {
    const [row] = await executor.insert(concernsTable).values(data).returning();
    if (!row) {
      throw new Error('concerns insert returned no row — should be unreachable.');
    }
    return row;
  }

  async updateGeneralFields(id: string, data: ConcernGeneralFieldsUpdate, executor: Executor = this.db): Promise<ConcernRow | null> {
    const [row] = await executor.update(concernsTable).set(data).where(eq(concernsTable.id, id)).returning();
    return row ?? null;
  }

  async updateMapping(id: string, data: ConcernMappingUpdate, executor: Executor = this.db): Promise<ConcernRow | null> {
    const [row] = await executor.update(concernsTable).set(data).where(eq(concernsTable.id, id)).returning();
    return row ?? null;
  }
}
