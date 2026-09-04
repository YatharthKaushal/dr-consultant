import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Database } from '../../config/db/database.config';
import { DATABASE } from '../../config/db/database.module';
import type { DeletionStatus } from '../../schema/enums.schema';
import { AuditService } from '../../shared/audit/audit.service';
import { DATA_DELETION_AUDIT_ENTITY_TYPES, DATA_DELETION_ERROR_CODES } from './data-deletion.constants';
import { DataDeletionRepository } from './data-deletion.repository';
import { toDataDeletionRequestRecord } from './data-deletion.mapper';
import type { DataDeletionRequestRecord } from './data-deletion.types';

/** The reviewable state — everything except the two M-21 owns. See `reviewRequest`. */
export type DataDeletionReviewStatus = Extract<DeletionStatus, 'in_review' | 'approved' | 'rejected'>;

/**
 * *** THE STATE MACHINE THIS MODULE OWNS — AND WHERE IT DELIBERATELY STOPS. ***
 *
 * `enums.schema.ts#DELETION_STATUSES` is `requested -> in_review -> approved |
 * rejected -> executed | failed`. `executed`/`failed` are NOT reachable
 * through THIS table or `reviewRequest` — see that method's own header.
 * (M-21/data rights execution added the one legal way to reach them,
 * `recordExecutionOutcome` below — a deliberately separate method with its
 * own guard, not a widening of this table or `reviewRequest`.) Within what
 * remains here:
 *   - `requested` -> `in_review`, `approved`, or `rejected` (an admin may
 *     decide outright without first marking it under review).
 *   - `in_review` -> `approved` or `rejected`.
 *   - `approved`/`rejected` are terminal FROM THIS MODULE'S SIDE — reopening a
 *     decided request is not a status edit, it is a new request.
 */
const LEGAL_REVIEW_TRANSITIONS: Record<DeletionStatus, readonly DataDeletionReviewStatus[]> = {
  requested: ['in_review', 'approved', 'rejected'],
  in_review: ['approved', 'rejected'],
  approved: [],
  rejected: [],
  executed: [],
  failed: [],
};

/**
 * FR-2.5: a patient's right to request deletion of their data, and an admin's
 * review of that request. See `src/schema/data-deletion-requests.schema.ts`'s
 * header for why `executed`/`failed` plus `execution_outcome` are one jsonb
 * column rather than several — combined because they are written once,
 * together, at execution, which is NOT this module's job.
 */
@Injectable()
export class DataDeletionService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly repo: DataDeletionRepository,
    private readonly audit: AuditService,
  ) {}

  /* ---------------------------------------------------------------------- */
  /* Patient-facing                                                          */
  /* ---------------------------------------------------------------------- */

  /**
   * Raises a new request. Idempotent in spirit rather than by a unique index:
   * a patient who already has an OPEN request (`requested`/`in_review`) gets
   * that same row back rather than a second one — there is no
   * `data_deletion_requests` constraint preventing duplicates (the schema
   * does not add one), so this is an application-level guard, not a database
   * one. A patient whose LAST request was `approved`/`rejected` may raise a
   * fresh one; that is a new decision, not a duplicate.
   */
  async raiseRequest(patientId: string, reason: string | null): Promise<DataDeletionRequestRecord> {
    const existing = await this.repo.findOpenByPatient(patientId);
    if (existing) return toDataDeletionRequestRecord(existing);

    const row = await this.db.transaction(async (tx) => {
      const created = await this.repo.create({ patientId, reason }, tx);

      await this.audit.write(
        {
          actorType: 'patient',
          actorId: patientId,
          action: 'create',
          entityType: DATA_DELETION_AUDIT_ENTITY_TYPES.DATA_DELETION_REQUEST,
          entityId: created.id,
          metadata: { reason },
        },
        tx,
      );

      return created;
    });

    return toDataDeletionRequestRecord(row);
  }

  /** The caller's own request history — FR-2.5's "see the status of their request". */
  async listOwnRequests(patientId: string): Promise<DataDeletionRequestRecord[]> {
    const rows = await this.repo.listByPatient(patientId);
    return rows.map(toDataDeletionRequestRecord);
  }

  /** One of the caller's own requests. 404 (never 403) on a mismatch — same ownership discipline `booking.controller.ts` states for its own routes. */
  async getOwnRequest(patientId: string, requestId: string): Promise<DataDeletionRequestRecord> {
    const row = await this.repo.findById(requestId);
    if (!row || row.patientId !== patientId) throw this.notFound();
    return toDataDeletionRequestRecord(row);
  }

  /* ---------------------------------------------------------------------- */
  /* Admin-facing                                                            */
  /* ---------------------------------------------------------------------- */

  /** The admin queue, optionally narrowed to one status — `requested` is the pending queue itself. */
  async listForAdmin(input: { status?: DeletionStatus; limit: number; offset: number }): Promise<DataDeletionRequestRecord[]> {
    const rows = await this.repo.listForAdmin(input);
    return rows.map(toDataDeletionRequestRecord);
  }

  async getForAdmin(requestId: string): Promise<DataDeletionRequestRecord> {
    const row = await this.repo.findById(requestId);
    if (!row) throw this.notFound();
    return toDataDeletionRequestRecord(row);
  }

  /**
   * Records an admin's review: `status`, `reviewedByAdminId`, `reviewedAt`,
   * an optional `reviewNote`.
   *
   * *** `executedAt` AND `executionOutcome` ARE NEVER TOUCHED HERE, AND MUST
   * STAY NULL. *** This method — this whole module — owns the REQUEST and its
   * REVIEW STATUS only. Actually deleting (or lawfully retaining) the
   * patient's data is M-21's job, which does not exist yet in this codebase.
   * Do not "finish the feature" by writing an execution routine into this
   * method: `approved` here means "an admin decided this may proceed", not
   * "the data is gone". The next person to touch this file should read this
   * paragraph before adding anything that writes `executed_at`.
   */
  async reviewRequest(
    actingAdminId: string,
    requestId: string,
    input: { status: DataDeletionReviewStatus; reviewNote?: string | null },
  ): Promise<DataDeletionRequestRecord> {
    const existing = await this.repo.findById(requestId);
    if (!existing) throw this.notFound();

    this.assertLegalTransition(existing.status, input.status);

    const reviewedAt = new Date();
    const updated = await this.db.transaction(async (tx) => {
      const row = await this.repo.updateReview(
        requestId,
        { status: input.status, reviewedByAdminId: actingAdminId, reviewedAt, reviewNote: input.reviewNote ?? null },
        tx,
      );
      if (!row) throw this.notFound();

      await this.audit.write(
        {
          actorType: 'admin',
          actorId: actingAdminId,
          action: 'update',
          entityType: DATA_DELETION_AUDIT_ENTITY_TYPES.DATA_DELETION_REQUEST,
          entityId: requestId,
          metadata: { transition: { from: existing.status, to: input.status }, reviewNote: input.reviewNote ?? null },
        },
        tx,
      );

      return row;
    });

    return toDataDeletionRequestRecord(updated);
  }

  /* ---------------------------------------------------------------------- */
  /* M-21 (data rights execution) — see data-deletion-execution.contract.ts  */
  /* ---------------------------------------------------------------------- */

  /**
   * ADDITIVE (M-21/data rights execution). Like `getForAdmin`, but returns
   * `null` instead of throwing on a missing id — this is a trusted
   * module-to-module read (`DataDeletionExecutionFacade#getRequest`), and a
   * caller composing a preview/execution flow needs to distinguish "does not
   * exist" from every other outcome itself, not catch a `NotFoundException`.
   */
  async findForExecution(requestId: string): Promise<DataDeletionRequestRecord | null> {
    const row = await this.repo.findById(requestId);
    return row ? toDataDeletionRequestRecord(row) : null;
  }

  /**
   * ADDITIVE (M-21/data rights execution). *** THE TRANSITION
   * `reviewRequest` DELIBERATELY CANNOT MAKE. *** See that method's header
   * and `LEGAL_REVIEW_TRANSITIONS`'s: `executed`/`failed` are unreachable
   * from every review state on purpose, because deciding a request may
   * proceed (review) and actually acting on the patient's data (execution)
   * are different acts with different authors in time — a request can sit
   * `approved` for a while before an admin actually runs execution.
   *
   * Refuses (`ConflictException`) unless the request is CURRENTLY
   * `approved` — never `requested`/`in_review`/`rejected`, and never a
   * SECOND time once it is already `executed`/`failed`. A caller that needs
   * to retry a partial failure re-approves the request first (a fresh
   * admin decision), rather than this method silently allowing a replay.
   *
   * Writes `executed_at`/`execution_outcome` and the target `status`
   * together, and a `data_deletion_request`-entity audit entry for the
   * transition — the same pairing `reviewRequest` makes for its own writes.
   */
  async recordExecutionOutcome(
    actingAdminId: string,
    requestId: string,
    input: { status: Extract<DeletionStatus, 'executed' | 'failed'>; executionOutcome: unknown },
  ): Promise<DataDeletionRequestRecord> {
    const existing = await this.repo.findById(requestId);
    if (!existing) throw this.notFound();

    if (existing.status !== 'approved') {
      throw new ConflictException({
        code: DATA_DELETION_ERROR_CODES.DATA_DELETION_NOT_APPROVED,
        message: `A request in "${existing.status}" may not be executed — only an "approved" request may.`,
        currentStatus: existing.status,
      });
    }

    const executedAt = new Date();
    const updated = await this.db.transaction(async (tx) => {
      const row = await this.repo.recordExecutionOutcome(
        requestId,
        { status: input.status, executionOutcome: input.executionOutcome, executedAt },
        tx,
      );
      if (!row) throw this.notFound();

      await this.audit.write(
        {
          actorType: 'admin',
          actorId: actingAdminId,
          action: 'update',
          entityType: DATA_DELETION_AUDIT_ENTITY_TYPES.DATA_DELETION_REQUEST,
          entityId: requestId,
          metadata: { transition: { from: existing.status, to: input.status }, executionOutcome: input.executionOutcome },
        },
        tx,
      );

      return row;
    });

    return toDataDeletionRequestRecord(updated);
  }

  /* ---------------------------------------------------------------------- */

  private assertLegalTransition(from: DeletionStatus, to: DataDeletionReviewStatus): void {
    const allowed = LEGAL_REVIEW_TRANSITIONS[from];
    if (!allowed.includes(to)) {
      throw new ConflictException({
        code: DATA_DELETION_ERROR_CODES.DATA_DELETION_ILLEGAL_TRANSITION,
        message: `A request in "${from}" may not be moved to "${to}".`,
        currentStatus: from,
      });
    }
  }

  private notFound(): NotFoundException {
    return new NotFoundException({
      code: DATA_DELETION_ERROR_CODES.DATA_DELETION_REQUEST_NOT_FOUND,
      message: 'That data-deletion request does not exist.',
    });
  }
}
