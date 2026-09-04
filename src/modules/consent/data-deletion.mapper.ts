import type { DataDeletionRequestRow } from '../../schema/data-deletion-requests.schema';
import type { DataDeletionRequestRecord } from './data-deletion.types';

/** Explicit projection, not a row spread — same discipline `consent.mapper.ts` states for `consents`/`legal_documents`. */
export function toDataDeletionRequestRecord(row: DataDeletionRequestRow): DataDeletionRequestRecord {
  return {
    id: row.id,
    patientId: row.patientId,
    status: row.status,
    reason: row.reason,
    reviewedByAdminId: row.reviewedByAdminId,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    reviewNote: row.reviewNote,
    executedAt: row.executedAt?.toISOString() ?? null,
    executionOutcome: row.executionOutcome ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
