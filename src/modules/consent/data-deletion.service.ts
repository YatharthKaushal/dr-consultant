import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Database } from '../../config/db/database.config';
import { DATABASE } from '../../config/db/database.module';
import type { DeletableAccountType, DeletionStatus } from '../../schema/enums.schema';
import { AppConfigService } from '../../shared/app-config/app-config.service';
import { AuditService } from '../../shared/audit/audit.service';
import {
  DATA_DELETION_AUDIT_ENTITY_TYPES,
  DATA_DELETION_CONFIG_KEYS,
  DATA_DELETION_DEFAULT_GRACE_PERIOD_DAYS,
  DATA_DELETION_ERROR_CODES,
} from './data-deletion.constants';
import { DataDeletionRepository } from './data-deletion.repository';
import { toDataDeletionRequestRecord } from './data-deletion.mapper';
import type { DataDeletionRequestRecord, DeletionAccountRef } from './data-deletion.types';

/** The reviewable state — everything except the two M-21 owns, plus the sweep's own retry path. See `reviewRequest`. */
export type DataDeletionReviewStatus = Extract<DeletionStatus, 'in_review' | 'approved' | 'rejected'>;

/**
 * *** THE STATE MACHINE THIS MODULE OWNS — AND WHERE IT DELIBERATELY STOPS. ***
 *
 * `enums.schema.ts#DELETION_STATUSES` is `requested -> in_review ->
 * approved | rejected -> executed | failed`, plus `cancelled` (reachable
 * from `requested`/`in_review`/`approved`, but ONLY through `cancelRequest`
 * below — never through this table, which is why `cancelled` is not a
 * value `DataDeletionReviewStatus` admits). `executed`/`failed` are NOT
 * reachable through THIS table or `reviewRequest` either — see that
 * method's own header. (M-21/data rights execution added the one legal way
 * to reach them, `recordExecutionOutcome` below.) Within what remains here:
 *   - `requested` -> `in_review`, `approved`, or `rejected` (an admin may
 *     decide outright without first marking it under review).
 *   - `in_review` -> `approved` or `rejected`.
 *   - `approved`/`rejected` are terminal FROM THIS MODULE'S SIDE — reopening a
 *     decided request is not a status edit, it is a new request.
 *   - `failed` -> `approved` *** THE RETRY PATH (account-deletion lifecycle
 *     round). *** A partial execution failure used to be a genuine dead
 *     end — no transition existed out of `failed` back to `approved`, so a
 *     retry needed a manual database intervention. An admin re-approving a
 *     `failed` request through the SAME `PATCH :id/review` route
 *     (`status: 'approved'`) is that fix: `executeForRequest` may then be
 *     called again, and `DataRightsService#executeForRequest`'s own
 *     per-step outcome recording means a retry only re-attempts whichever
 *     steps actually failed last time, not the whole sequence blindly.
 */
const LEGAL_REVIEW_TRANSITIONS: Record<DeletionStatus, readonly DataDeletionReviewStatus[]> = {
  requested: ['in_review', 'approved', 'rejected'],
  in_review: ['approved', 'rejected'],
  approved: [],
  rejected: [],
  cancelled: [],
  executed: [],
  failed: ['approved'],
};

/** The account itself may cancel from any of these — right up until execution actually runs. */
const CANCELLABLE_STATUSES = new Set<DeletionStatus>(['requested', 'in_review', 'approved']);

/**
 * FR-2.5: a patient's OR a doctor's right to request deletion of their
 * data, and an admin's review of that request. See
 * `src/schema/data-deletion-requests.schema.ts`'s header for why
 * `executed`/`failed` plus `execution_outcome` are one jsonb column rather
 * than several — combined because they are written once, together, at
 * execution, which is NOT this module's job.
 */
@Injectable()
export class DataDeletionService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly repo: DataDeletionRepository,
    private readonly appConfig: AppConfigService,
    private readonly audit: AuditService,
  ) {}

  /* ---------------------------------------------------------------------- */
  /* Patient/doctor-facing                                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * Raises a new request. Idempotent in spirit rather than by a unique index
   * ALONE: a caller who already has an OPEN request (`requested`/
   * `in_review`/`approved`) gets that same row back rather than a second
   * one. Backed by BOTH an application-level check (this method's own read,
   * for the friendly "here is your existing request" response) AND a
   * database-level partial unique index (`data-deletion-requests.
   * schema.ts`) as the actual race guard — two concurrent raises now
   * produce one row and a 500-avoided `isUniqueConstraintViolation` fallback
   * read, never two open requests.
   *
   * `scheduledFor` is computed here, once, from `compliance.
   * deletion_grace_period_days` (default 30) — the grace period is fixed at
   * the moment of request, not re-derived at execution time, so a mid-window
   * config change never retroactively shortens/extends an already-raised
   * request's own deadline.
   */
  async raiseRequest(account: DeletionAccountRef, reason: string | null): Promise<DataDeletionRequestRecord> {
    const existing = await this.repo.findOpenByAccount(account.accountType, account.accountId);
    if (existing) return toDataDeletionRequestRecord(existing);

    const graceDays = await this.appConfig.getNumber(DATA_DELETION_CONFIG_KEYS.GRACE_PERIOD_DAYS, DATA_DELETION_DEFAULT_GRACE_PERIOD_DAYS);
    const scheduledFor = new Date(Date.now() + graceDays * 24 * 60 * 60 * 1000);

    const row = await this.db.transaction(async (tx) => {
      const created = await this.repo.create(
        {
          patientId: account.accountType === 'patient' ? account.accountId : null,
          doctorId: account.accountType === 'doctor' ? account.accountId : null,
          reason,
          scheduledFor,
        },
        tx,
      );

      await this.audit.write(
        {
          actorType: account.accountType,
          actorId: account.accountId,
          action: 'create',
          entityType: DATA_DELETION_AUDIT_ENTITY_TYPES.DATA_DELETION_REQUEST,
          entityId: created.id,
          metadata: { reason, scheduledFor: scheduledFor.toISOString() },
        },
        tx,
      );

      return created;
    });

    return toDataDeletionRequestRecord(row);
  }

  /** The caller's own request history — FR-2.5's "see the status of their request". */
  async listOwnRequests(account: DeletionAccountRef): Promise<DataDeletionRequestRecord[]> {
    const rows = await this.repo.listByAccount(account.accountType, account.accountId);
    return rows.map(toDataDeletionRequestRecord);
  }

  /** One of the caller's own requests. 404 (never 403) on a mismatch — same ownership discipline `booking.controller.ts` states for its own routes. */
  async getOwnRequest(account: DeletionAccountRef, requestId: string): Promise<DataDeletionRequestRecord> {
    const row = await this.repo.findById(requestId);
    if (!row || !this.isOwnedBy(row, account)) throw this.notFound();
    return toDataDeletionRequestRecord(row);
  }

  /**
   * *** THE ONE WRITE THE REQUESTING ACCOUNT ITSELF MAY MAKE. ***
   * (account-deletion lifecycle round.) "The time period between the
   * request and the deletion — the user can access the account and use the
   * platform, and will also see a cancel-deletion option" — this is that
   * option. Legal right up until `approved`; once `executeForRequest` has
   * actually run, there is nothing left to cancel (an admin's `restore` is
   * the equivalent act at that point).
   *
   * 404 on a request that exists but isn't the caller's own — same
   * ownership discipline as `getOwnRequest`.
   */
  async cancelRequest(account: DeletionAccountRef, requestId: string): Promise<DataDeletionRequestRecord> {
    const existing = await this.repo.findById(requestId);
    if (!existing || !this.isOwnedBy(existing, account)) throw this.notFound();

    if (!CANCELLABLE_STATUSES.has(existing.status)) {
      throw new ConflictException({
        code: DATA_DELETION_ERROR_CODES.DATA_DELETION_NOT_CANCELLABLE,
        message: `A request in "${existing.status}" may no longer be cancelled.`,
        currentStatus: existing.status,
      });
    }

    const cancelledAt = new Date();
    const updated = await this.db.transaction(async (tx) => {
      const row = await this.repo.cancel(requestId, cancelledAt, tx);
      if (!row) {
        // The race loser — a concurrent execution or admin decision moved
        // this request out of a cancellable status between our read and
        // this write. Report it exactly like any other refusal, never a
        // silent success.
        const current = await this.repo.findById(requestId, tx);
        throw new ConflictException({
          code: DATA_DELETION_ERROR_CODES.DATA_DELETION_NOT_CANCELLABLE,
          message: `A request in "${current?.status ?? 'unknown'}" may no longer be cancelled.`,
          currentStatus: current?.status ?? 'unknown',
        });
      }

      await this.audit.write(
        {
          actorType: account.accountType,
          actorId: account.accountId,
          action: 'update',
          entityType: DATA_DELETION_AUDIT_ENTITY_TYPES.DATA_DELETION_REQUEST,
          entityId: requestId,
          metadata: { transition: { from: existing.status, to: 'cancelled' } },
        },
        tx,
      );

      return row;
    });

    return toDataDeletionRequestRecord(updated);
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
   * an optional `reviewNote`. Also the RETRY path for a `failed` execution —
   * see `LEGAL_REVIEW_TRANSITIONS`'s header.
   *
   * *** `executedAt` AND `executionOutcome` ARE NEVER TOUCHED HERE, AND MUST
   * STAY NULL/UNCHANGED. *** This method — this whole module — owns the
   * REQUEST and its REVIEW STATUS only. Actually deleting (or lawfully
   * retaining) the account's data is M-21's job (`data-rights` module). Do
   * not "finish the feature" by writing an execution routine into this
   * method: `approved` here means "an admin decided this may proceed", not
   * "the data is gone".
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
  /* The sweep (`data-rights-execution-sweep.service.ts`)                    */
  /* ---------------------------------------------------------------------- */

  /** Every request whose grace period has elapsed and is still open — the sweep's own read. */
  async listDueForSweep(limit: number): Promise<DataDeletionRequestRecord[]> {
    const rows = await this.repo.listDueForSweep(new Date(), limit);
    return rows.map(toDataDeletionRequestRecord);
  }

  /**
   * `requested`/`in_review` -> `approved`, on the SYSTEM'S authority, when
   * no admin decided within the grace period. Idempotent: if the request
   * has already moved past `requested`/`in_review` by the time this runs
   * (an admin got there first, or a concurrent sweep tick), this is a
   * no-op that returns the CURRENT row rather than throwing — the sweep's
   * next step (attempt execution) simply finds the request already
   * `approved` or already terminal and behaves accordingly.
   */
  async autoApproveForSweep(requestId: string): Promise<DataDeletionRequestRecord> {
    const reviewedAt = new Date();
    const row = await this.db.transaction(async (tx) => {
      const updated = await this.repo.autoApprove(requestId, reviewedAt, tx);
      if (!updated) {
        const current = await this.repo.findById(requestId, tx);
        if (!current) throw this.notFound();
        return current;
      }

      await this.audit.write(
        {
          actorType: 'system',
          actorId: null,
          action: 'update',
          entityType: DATA_DELETION_AUDIT_ENTITY_TYPES.DATA_DELETION_REQUEST,
          entityId: requestId,
          metadata: { transition: { to: 'approved' }, reason: 'grace_period_elapsed_no_admin_review' },
        },
        tx,
      );

      return updated;
    });

    return toDataDeletionRequestRecord(row);
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
   * proceed (review) and actually acting on the account's data (execution)
   * are different acts with different authors in time — a request can sit
   * `approved` for a while before an admin (or the sweep) actually runs
   * execution.
   *
   * Refuses (`ConflictException`) unless the request is CURRENTLY
   * `approved` — never `requested`/`in_review`/`rejected`/`cancelled`, and
   * never a SECOND time once it is already `executed`/`failed`. A caller
   * that needs to retry a partial failure re-approves the request first (a
   * fresh admin decision via `reviewRequest`, or the sweep's own
   * `autoApproveForSweep`), rather than this method silently allowing a
   * replay.
   *
   * `actor` is `{actorType:'admin', actorId}` for an explicit admin action,
   * or `{actorType:'system', actorId:null}` for the sweep — see
   * `data-deletion.types.ts#DeletionExecutionActor`'s own header for why
   * this is not simply an admin id.
   */
  async recordExecutionOutcome(
    actor: { actorType: 'admin' | 'system'; actorId: string | null },
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
      if (!row) {
        // *** THE RACE LOSER. *** The row exists (we just read it above) but
        // the guarded `UPDATE ... WHERE status = 'approved'` in the
        // repository affected zero rows — a concurrent call on the SAME
        // request already flipped its status to `executed`/`failed` between
        // our read and our write. Report this exactly like any other
        // not-currently-approved attempt, never as a silent success and
        // never as a 404 (the request is very much still there).
        const current = await this.repo.findById(requestId, tx);
        throw new ConflictException({
          code: DATA_DELETION_ERROR_CODES.DATA_DELETION_NOT_APPROVED,
          message: `A request in "${current?.status ?? 'unknown'}" may not be executed — only an "approved" request may.`,
          currentStatus: current?.status ?? 'unknown',
        });
      }

      await this.audit.write(
        {
          actorType: actor.actorType,
          actorId: actor.actorId,
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

  private isOwnedBy(row: { patientId: string | null; doctorId: string | null }, account: DeletionAccountRef): boolean {
    if (account.accountType === 'patient') return row.patientId === account.accountId;
    return row.doctorId === account.accountId;
  }

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
