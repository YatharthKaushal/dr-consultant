import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { Database, DatabaseTransaction } from '../../config/db/database.config';
import { DATABASE } from '../../config/db/database.module';
import {
  checkinResponsesTable,
  type CheckinResponseRow,
  type NewCheckinResponseRow,
} from '../../schema/checkin-responses.schema';
import type { FollowupStatus, SafetyAlertType } from '../../schema/enums.schema';
import {
  followupAssignmentsTable,
  type FollowupAssignmentRow,
  type NewFollowupAssignmentRow,
} from '../../schema/followup-assignments.schema';
import { safetyAlertsTable, type NewSafetyAlertRow, type SafetyAlertRow } from '../../schema/safety-alerts.schema';

type Executor = Database | DatabaseTransaction;

/**
 * All of this module's SQL against `followup_assignments`, `checkin_responses`
 * and `safety_alerts` (`backend/README.md` §2: "repositories hold the SQL").
 * Scoring, alerting and notification rules live in `followup.service.ts` and
 * `followup-checkin-sweep.service.ts`, never here.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────
 *
 *   `consultations`        M-11's. Reads go through `BookingFacade`.
 *   `followup_pathways`    This module's too, but a SEPARATE table with its
 *                          own admin lifecycle — see `followup-pathway
 *                          .repository.ts`.
 *   `clinical_records`     M-15's. Reads go through `ClinicalFacade`.
 */
@Injectable()
export class FollowupRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /* ── followup_assignments ────────────────────────────────────────────── */

  async findAssignmentByConsultationId(consultationId: string, executor: Executor = this.db): Promise<FollowupAssignmentRow | null> {
    const [row] = await executor
      .select()
      .from(followupAssignmentsTable)
      .where(eq(followupAssignmentsTable.consultationId, consultationId))
      .limit(1);
    return row ?? null;
  }

  async insertAssignment(data: NewFollowupAssignmentRow, executor: Executor = this.db): Promise<FollowupAssignmentRow> {
    const [row] = await executor.insert(followupAssignmentsTable).values(data).returning();
    if (!row) throw new Error('followup_assignments insert returned no row.');
    return row;
  }

  async updateAssignmentStatus(
    id: string,
    status: FollowupStatus,
    executor: Executor = this.db,
  ): Promise<FollowupAssignmentRow | null> {
    const [row] = await executor.update(followupAssignmentsTable).set({ status }).where(eq(followupAssignmentsTable.id, id)).returning();
    return row ?? null;
  }

  /**
   * Candidate assignments for the missed-check-in sweep: `active`, keyset-paged
   * on `id` for a stable, resumable scan across ticks (the same reason
   * `clinical.repository.ts#listFinalisedSince` pages on `(finalised_at, id)`
   * rather than `OFFSET`). Small expected volume (a follow-up window is at
   * most `duration_days`, typically 7, so "active" is bounded by recent
   * consult volume), so a plain `id` cursor is enough — there is no natural
   * "due at" timestamp to page on the way the gate sweep pages on
   * `finalised_at`.
   */
  async listActiveAssignments(limit: number, afterId: string | null, executor: Executor = this.db): Promise<FollowupAssignmentRow[]> {
    return executor
      .select()
      .from(followupAssignmentsTable)
      .where(
        afterId
          ? and(eq(followupAssignmentsTable.status, 'active'), gt(followupAssignmentsTable.id, afterId))
          : eq(followupAssignmentsTable.status, 'active'),
      )
      .orderBy(asc(followupAssignmentsTable.id))
      .limit(limit);
  }

  /* ── checkin_responses ───────────────────────────────────────────────── */

  async findCheckin(consultationId: string, checkinDate: string, executor: Executor = this.db): Promise<CheckinResponseRow | null> {
    const [row] = await executor
      .select()
      .from(checkinResponsesTable)
      .where(and(eq(checkinResponsesTable.consultationId, consultationId), eq(checkinResponsesTable.checkinDate, checkinDate)))
      .limit(1);
    return row ?? null;
  }

  async listCheckinsForConsultation(consultationId: string, executor: Executor = this.db): Promise<CheckinResponseRow[]> {
    return executor
      .select()
      .from(checkinResponsesTable)
      .where(eq(checkinResponsesTable.consultationId, consultationId))
      .orderBy(desc(checkinResponsesTable.checkinDate));
  }

  /** May throw the raw driver error on a duplicate `(consultation_id, checkin_date)` — the caller (`followup.service.ts#submitCheckin`) converts it via `isUniqueConstraintViolation`, the same pattern `booking.service.ts#insertBooking` uses for its own partial unique index. */
  async insertCheckin(data: NewCheckinResponseRow, executor: Executor = this.db): Promise<CheckinResponseRow> {
    const [row] = await executor.insert(checkinResponsesTable).values(data).returning();
    if (!row) throw new Error('checkin_responses insert returned no row.');
    return row;
  }

  /* ── safety_alerts ───────────────────────────────────────────────────── */

  async insertAlert(data: NewSafetyAlertRow, executor: Executor = this.db): Promise<SafetyAlertRow> {
    const [row] = await executor.insert(safetyAlertsTable).values(data).returning();
    if (!row) throw new Error('safety_alerts insert returned no row.');
    return row;
  }

  /**
   * Dedup check for the missed-check-in sweep: an OPEN `missed_checkin` alert
   * for this consultation whose `reason` names the exact missed date. Exact
   * text match on `reason` rather than a dedicated "missed date" column —
   * there is no such column (`safety_alerts.schema.ts` carries no per-type
   * payload), and the reason IS deterministic per date
   * (`followup-checkin-sweep.service.ts#missedCheckinReason`), so this is a
   * correct and honest dedup key, not a hack reaching past the schema.
   */
  async findOpenMissedCheckinAlertByReason(consultationId: string, reason: string, executor: Executor = this.db): Promise<SafetyAlertRow | null> {
    const [row] = await executor
      .select()
      .from(safetyAlertsTable)
      .where(
        and(
          eq(safetyAlertsTable.consultationId, consultationId),
          eq(safetyAlertsTable.alertType, 'missed_checkin'),
          eq(safetyAlertsTable.reason, reason),
          isNull(safetyAlertsTable.closedAt),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async findAlertById(id: string, executor: Executor = this.db): Promise<SafetyAlertRow | null> {
    const [row] = await executor.select().from(safetyAlertsTable).where(eq(safetyAlertsTable.id, id)).limit(1);
    return row ?? null;
  }

  async listAlertsForConsultation(consultationId: string, executor: Executor = this.db): Promise<SafetyAlertRow[]> {
    return executor
      .select()
      .from(safetyAlertsTable)
      .where(eq(safetyAlertsTable.consultationId, consultationId))
      .orderBy(desc(safetyAlertsTable.createdAt));
  }

  /** The admin queue: open alerts (`acknowledged_at`/`closed_at` both null = open — `safety_alerts.schema.ts`'s own convention), newest first. */
  async listOpenAlerts(limit: number, offset: number, executor: Executor = this.db): Promise<SafetyAlertRow[]> {
    return executor
      .select()
      .from(safetyAlertsTable)
      .where(and(isNull(safetyAlertsTable.acknowledgedAt), isNull(safetyAlertsTable.closedAt)))
      .orderBy(desc(safetyAlertsTable.createdAt))
      .limit(limit)
      .offset(offset);
  }

  /**
   * ADDITIVE (M-20/governance and quality): the dashboard-number companion
   * to `listOpenAlerts` — FR-18.6's "red flags" and "follow-up alerts"
   * figures both come from this ONE `GROUP BY alert_type` query. The
   * governance layer reads `red_flag` as "red flags"/"high-risk alerts" and
   * sums the remaining four types (`amber`, `missed_checkin`,
   * `medication_side_effect`, `followup_due`) as "follow-up alerts" — there
   * is no second table or second query for either number.
   *
   * A type with zero open alerts is simply absent from the map.
   */
  async countOpenAlertsByType(executor: Executor = this.db): Promise<Partial<Record<SafetyAlertType, number>>> {
    const rows = await executor
      .select({ alertType: safetyAlertsTable.alertType, count: sql<string>`count(*)` })
      .from(safetyAlertsTable)
      .where(and(isNull(safetyAlertsTable.acknowledgedAt), isNull(safetyAlertsTable.closedAt)))
      .groupBy(safetyAlertsTable.alertType);

    const result: Partial<Record<SafetyAlertType, number>> = {};
    for (const row of rows) {
      result[row.alertType] = Number(row.count);
    }
    return result;
  }

  async acknowledgeAlert(
    id: string,
    actor: { adminId?: string; doctorId?: string },
    executor: Executor = this.db,
  ): Promise<SafetyAlertRow | null> {
    const [row] = await executor
      .update(safetyAlertsTable)
      .set({
        acknowledgedAt: new Date(),
        ...(actor.adminId ? { acknowledgedByAdminId: actor.adminId } : {}),
        ...(actor.doctorId ? { acknowledgedByDoctorId: actor.doctorId } : {}),
      })
      .where(eq(safetyAlertsTable.id, id))
      .returning();
    return row ?? null;
  }

  async closeAlert(id: string, closingNote: string | null, executor: Executor = this.db): Promise<SafetyAlertRow | null> {
    const [row] = await executor
      .update(safetyAlertsTable)
      .set({ closedAt: new Date(), closingNote })
      .where(eq(safetyAlertsTable.id, id))
      .returning();
    return row ?? null;
  }

  /* ── M-21/data rights (READ-ONLY across all three tables) ───────────────── */

  /**
   * ADDITIVE (M-21/data rights execution): see `FollowupContract
   * #countDataRightsRowsForConsultations`. Three independent `count(*)`s, not
   * a `UNION`/`JOIN` — the tables share no key that would make a single
   * grouped query meaningful, and this is a one-off preview read, not a hot
   * path. Empty `consultationIds` is guarded by the caller
   * (`followup.service.ts`); this method assumes a non-empty array.
   */
  async countDataRightsRowsForConsultations(
    consultationIds: readonly string[],
    executor: Executor = this.db,
  ): Promise<{ checkinResponses: number; safetyAlerts: number; followupAssignments: number }> {
    const ids = [...consultationIds];
    const [checkinRow] = await executor
      .select({ count: sql<string>`count(*)` })
      .from(checkinResponsesTable)
      .where(inArray(checkinResponsesTable.consultationId, ids));
    const [alertRow] = await executor
      .select({ count: sql<string>`count(*)` })
      .from(safetyAlertsTable)
      .where(inArray(safetyAlertsTable.consultationId, ids));
    const [assignmentRow] = await executor
      .select({ count: sql<string>`count(*)` })
      .from(followupAssignmentsTable)
      .where(inArray(followupAssignmentsTable.consultationId, ids));

    return {
      checkinResponses: Number(checkinRow?.count ?? 0),
      safetyAlerts: Number(alertRow?.count ?? 0),
      followupAssignments: Number(assignmentRow?.count ?? 0),
    };
  }
}
