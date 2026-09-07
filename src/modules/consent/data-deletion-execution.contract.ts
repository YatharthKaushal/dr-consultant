import type { DeletionStatus } from '../../schema/enums.schema';
import type { DataDeletionRequestRecord } from './data-deletion.types';

/**
 * *** ADDITIVE (M-21/data rights execution). ***
 *
 * M-21's narrow read/write into M-03's `data_deletion_requests` table —
 * deliberately kept OFF `ConsentContract` rather than widened onto it.
 * `consent.contract.ts`'s own header calls that surface *** FROZEN ***
 * because M-14 binds a structural mirror of it; execution is a distinct
 * concern (a different table, a different lifecycle stage) that this module
 * already owns, so it gets its own small facade instead.
 *
 * `data-deletion.service.ts#reviewRequest`'s own header states the module's
 * boundary precisely: that method's state machine can reach
 * `in_review`/`approved`/`rejected` and NOTHING ELSE — `executed`/`failed`
 * plus `executed_at`/`execution_outcome` are explicitly named as "M-21's
 * job, which does not exist yet". This file is that job arriving. It does
 * not touch `reviewRequest`, `LEGAL_REVIEW_TRANSITIONS`, or any existing
 * method — see `data-deletion.service.ts#recordExecutionOutcome` for the
 * new, additive method this facade delegates to.
 */
export interface DataDeletionExecutionContract {
  /**
   * One request by id, or `null` if it does not exist. No ownership
   * check — a trusted module-to-module read; the calling admin route has
   * already authorized via its own `compliance.manage_deletion_requests`
   * permission guard, the same rule `ClinicalContract`/`BookingContract`
   * state for their own single-id reads.
   */
  getRequest(requestId: string): Promise<DataDeletionRequestRecord | null>;

  /**
   * *** THE ONLY WRITER OF `executed_at`/`execution_outcome` IN THIS
   * CODEBASE. *** Refuses (`ConflictException`) unless the request is
   * currently `approved` — an admin must review and approve a request
   * before it may be executed, and a request already `executed`/`failed`
   * may not be executed a second time through this method (the caller
   * decides whether a RETRY of a partial failure is safe; see
   * `data-rights.service.ts`).
   *
   * `executionOutcome` is written EXACTLY as given — this facade applies no
   * shape of its own to it. `data-deletion-requests.schema.ts`'s own
   * comment on the column already states the contract: "per-table counts,
   * lawful retention grounds, or a failure reason."
   *
   * `actor` is `{actorType:'admin', actorId}` for an explicit admin action
   * (`POST admin/data-deletion-requests/:id/execute`), or
   * `{actorType:'system', actorId:null}` for the grace-period sweep
   * (ADDITIVE, account-deletion lifecycle round) — widened from a bare
   * admin id so a sweep-driven execution's audit trail honestly says the
   * system acted, never a fabricated admin.
   */
  recordExecutionOutcome(
    actor: { actorType: 'admin' | 'system'; actorId: string | null },
    requestId: string,
    input: { status: Extract<DeletionStatus, 'executed' | 'failed'>; executionOutcome: unknown },
  ): Promise<DataDeletionRequestRecord>;

  /**
   * ADDITIVE (M-21/data rights execution). READ-ONLY row count of `consents`
   * for this patient — `consents` is RETAIN in the M-21 survey (append-only
   * legal evidence of acceptance, `consents.schema.ts`, SRS §5.2), so this is
   * a pure count for the preview report; nothing here is ever written.
   */
  countConsentsForPatient(patientId: string): Promise<number>;

  /**
   * ADDITIVE (account-deletion lifecycle round). The grace-period sweep's
   * own read — every request whose `scheduled_for` has elapsed and is
   * still `requested`/`in_review`/`approved`. Lives here (not a new,
   * separate M-03 surface) because it is squarely execution-adjacent, the
   * same reasoning `recordExecutionOutcome` above already applies.
   */
  listDueForSweep(limit: number): Promise<DataDeletionRequestRecord[]>;

  /**
   * ADDITIVE (account-deletion lifecycle round). `requested`/`in_review` ->
   * `approved` on the SYSTEM'S authority, when no admin decided within the
   * grace period — see `data-deletion.service.ts#autoApproveForSweep`'s
   * own header for the idempotency contract.
   */
  autoApproveForSweep(requestId: string): Promise<DataDeletionRequestRecord>;
}
