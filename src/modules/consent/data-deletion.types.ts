import type { DeletableAccountType, DeletionStatus } from '../../schema/enums.schema';

/**
 * HTTP-facing shape for the data-deletion request lifecycle. Deliberately
 * NOT in `consent.contract.ts`: nothing outside this module needs to know
 * about a deletion request's HTTP shape today, and the shape crosses a JSON
 * boundary, so timestamps are ISO strings here — same reasoning
 * `consent.types.ts` states for `ConsentRecord`.
 *
 * *** ADDITIVE (account-deletion lifecycle round). *** Widened from
 * patient-only: exactly one of `patientId`/`doctorId` is set, mirroring the
 * table's own `account_xor_check`. `scheduledFor`/`cancelledAt` are new —
 * see `data-deletion-requests.schema.ts`'s header for both.
 */
export interface DataDeletionRequestRecord {
  id: string;
  patientId: string | null;
  doctorId: string | null;
  status: DeletionStatus;
  reason: string | null;
  reviewedByAdminId: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  executedAt: string | null;
  executionOutcome: unknown | null;
  scheduledFor: string | null;
  cancelledAt: string | null;
  createdAt: string;
}

/** Who raised/owns a request — resolves to exactly one of `patientId`/`doctorId` on the row. */
export interface DeletionAccountRef {
  accountType: DeletableAccountType;
  accountId: string;
}

/**
 * Who is EXECUTING a data-deletion request. `'admin'` — a human decided,
 * `actorId` names them. `'system'` — the grace-period sweep executed it
 * because no admin reviewed it in time; `actorId` is `null`, honestly, not
 * a data-entry gap. Every audit entry an execution writes carries this
 * distinction rather than attributing a system-driven deletion to a
 * fabricated admin id.
 */
export type DeletionExecutionActor = { actorType: 'admin'; actorId: string } | { actorType: 'system'; actorId: null };
