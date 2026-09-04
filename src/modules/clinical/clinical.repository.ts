import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, isNotNull, isNull } from 'drizzle-orm';
import { DATABASE } from '../../config/db/database.module';
import type { Database, DatabaseTransaction } from '../../config/db/database.config';
import { auditLogTable } from '../../schema/audit-log.schema';
import {
  clinicalRecordsTable,
  type ClinicalRecordRow,
  type NewClinicalRecordRow,
} from '../../schema/clinical-records.schema';

/** Either a pooled handle or an open transaction — every method takes one so a caller can compose it into its own transaction (`shared/audit/audit.service.ts`'s pattern). */
type Executor = Database | DatabaseTransaction;

/** One `audit_log` row for the FR-11.6 consultation trail. */
export interface ConsultationAuditRow {
  /** `audit_log.id` is a `bigserial`, not a uuid — a monotonically increasing number. */
  id: number;
  actorType: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  metadata: unknown;
  createdAt: Date;
}

/**
 * All of this module's SQL against `clinical_records` (`backend/README.md` §2:
 * "repositories hold the SQL"). Business rules — the completion gate, the
 * prescribing gate, ownership — live in `clinical.service.ts`, never here.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────
 *
 *   `consultations`  is M-11's. Reads and the move to `completed` both go
 *                    through `CLINICAL_BOOKING_PORT`.
 *   `doctors`        is M-05's. The completion gate is read and cleared
 *                    through `InstantFacade`.
 *   `specialties`    is M-06's. `can_prescribe` comes from
 *                    `CatalogueFacade.getSpecialtyById`.
 *   `patient_files`  is M-10's. The prescription PDF is written through
 *                    `DocumentFacade`.
 *
 * ── THE ONE EXCEPTION, ARGUED ──────────────────────────────────────────────
 *
 * `listConsultationAuditTrail` reads `audit_log`. That table is owned by no
 * module: `shared/audit/audit.service.ts` is "the audit entry writer used by
 * every module", every module writes it, and there is no `modules/audit` to ask
 * (M-22 is unbuilt). The read is narrowed to ONE consultation id, which is
 * precisely the lookup `audit_log.consultation_id`'s index exists for, and it
 * serves FR-11.6's "each consultation has a consultation ID that ties together
 * booking, video session metadata, prescription and case summary for audit" —
 * a requirement no other module can satisfy, since the point is that it spans
 * all of them. Same standing as the `app_config` reads
 * `payment-config.repository.ts` and `instant.repository.ts` both argue for.
 */
@Injectable()
export class ClinicalRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /* ── Reads ────────────────────────────────────────────────────────────── */

  /** The record for one consultation, draft or finalised, or `null`. `consultation_id` is UNIQUE, so this is 1:1. */
  async findByConsultationId(consultationId: string, executor: Executor = this.db): Promise<ClinicalRecordRow | null> {
    const [row] = await executor
      .select()
      .from(clinicalRecordsTable)
      .where(eq(clinicalRecordsTable.consultationId, consultationId))
      .limit(1);
    return row ?? null;
  }

  /**
   * *** THE ROW LOCK. *** `SELECT ... FOR UPDATE` on one record, inside the
   * caller's transaction — which is why `tx` is required and not defaulted,
   * exactly as `booking.repository.ts#findByIdForUpdate` requires one.
   *
   * Finalisation takes it first and re-reads `finalised_at` through it, so two
   * concurrent finalise calls serialise: the second waits here, sees the
   * first's committed timestamp, and fails its own guard instead of
   * overwriting it.
   */
  async findByConsultationIdForUpdate(
    consultationId: string,
    tx: DatabaseTransaction,
  ): Promise<ClinicalRecordRow | null> {
    const [row] = await tx
      .select()
      .from(clinicalRecordsTable)
      .where(eq(clinicalRecordsTable.consultationId, consultationId))
      .limit(1)
      .for('update');
    return row ?? null;
  }

  /* ── Writes ───────────────────────────────────────────────────────────── */

  async create(data: NewClinicalRecordRow, executor: Executor = this.db): Promise<ClinicalRecordRow> {
    const [row] = await executor.insert(clinicalRecordsTable).values(data).returning();
    if (!row) {
      throw new Error('clinical_records insert returned no row — should be unreachable.');
    }
    return row;
  }

  /**
   * Patches a DRAFT. The `finalised_at IS NULL` predicate is in the WHERE
   * clause, not a read-then-write check above it: a finalised clinical record
   * is immutable, and making that a condition of the UPDATE itself means there
   * is no window in which a concurrent finalise can be overwritten. Returns
   * `null` when the guard did not match.
   */
  async updateDraft(
    consultationId: string,
    patch: Partial<NewClinicalRecordRow>,
    executor: Executor = this.db,
  ): Promise<ClinicalRecordRow | null> {
    const [row] = await executor
      .update(clinicalRecordsTable)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(clinicalRecordsTable.consultationId, consultationId), isNull(clinicalRecordsTable.finalisedAt)))
      .returning();
    return row ?? null;
  }

  /**
   * *** THE COMPLETION GATE, WRITTEN. *** Sets `finalised_at`, guarded on it
   * still being NULL, so finalising is exactly-once even under concurrency and
   * even without the row lock above it. Returns `null` when the record was
   * already finalised.
   */
  async finalise(
    consultationId: string,
    finalisedAt: Date,
    executor: Executor = this.db,
  ): Promise<ClinicalRecordRow | null> {
    const [row] = await executor
      .update(clinicalRecordsTable)
      .set({ finalisedAt, updatedAt: finalisedAt })
      .where(and(eq(clinicalRecordsTable.consultationId, consultationId), isNull(clinicalRecordsTable.finalisedAt)))
      .returning();
    return row ?? null;
  }

  /* ── The reconciling sweep ────────────────────────────────────────────── */

  /**
   * The sweep's candidate query: records finalised at or after `since`, newest
   * first, bounded.
   *
   * Indexed — `clinical-records.schema.ts` declares `index().on(finalisedAt)`,
   * which is exactly this predicate and this ordering. See
   * `CLINICAL_GATE_SWEEP_LOOKBACK_MS` for why the window is bounded at all and
   * what that costs.
   */
  async listFinalisedSince(since: Date, limit: number, executor: Executor = this.db): Promise<ClinicalRecordRow[]> {
    return executor
      .select()
      .from(clinicalRecordsTable)
      .where(and(isNotNull(clinicalRecordsTable.finalisedAt), gte(clinicalRecordsTable.finalisedAt, since)))
      .orderBy(desc(clinicalRecordsTable.finalisedAt))
      .limit(limit);
  }

  /* ── FR-11.6: the consultation trail ──────────────────────────────────── */

  /** Every audit entry any module wrote against one consultation, oldest first. See the class doc comment for why this module is allowed to read `audit_log`. */
  async listConsultationAuditTrail(
    consultationId: string,
    limit: number,
    executor: Executor = this.db,
  ): Promise<ConsultationAuditRow[]> {
    return executor
      .select({
        id: auditLogTable.id,
        actorType: auditLogTable.actorType,
        actorId: auditLogTable.actorId,
        action: auditLogTable.action,
        entityType: auditLogTable.entityType,
        entityId: auditLogTable.entityId,
        metadata: auditLogTable.metadata,
        createdAt: auditLogTable.createdAt,
      })
      .from(auditLogTable)
      .where(eq(auditLogTable.consultationId, consultationId))
      .orderBy(auditLogTable.createdAt)
      .limit(limit);
  }
}
