import type { DeletionStatus } from '../../schema/enums.schema';

/**
 * HTTP-facing shape for FR-2.5's data-deletion requests. Deliberately NOT in
 * `consent.contract.ts`: nothing outside this module needs to know about a
 * deletion request today, and the shape crosses a JSON boundary, so
 * timestamps are ISO strings here — same reasoning `consent.types.ts` states
 * for `ConsentRecord`.
 *
 * *** `executedAt`/`executionOutcome` ARE CARRIED HERE AS-IS, ALWAYS NULL. ***
 * This module never sets them — see `data-deletion.service.ts#reviewRequest`.
 * They are included in the view so a client rendering a request's full
 * lifecycle has a stable shape to read from the day M-21 (execution) exists,
 * rather than the response shape changing out from under it later.
 */
export interface DataDeletionRequestRecord {
  id: string;
  patientId: string;
  status: DeletionStatus;
  reason: string | null;
  reviewedByAdminId: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  /** Always null until M-21 (execution) exists. See the header above. */
  executedAt: string | null;
  /** Always null until M-21 (execution) exists. See the header above. */
  executionOutcome: unknown | null;
  createdAt: string;
}
