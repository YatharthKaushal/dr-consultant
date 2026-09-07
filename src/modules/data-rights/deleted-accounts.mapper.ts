import type { DeletedAccountRow } from '../../schema/deleted-accounts.schema';
import type { DeletedAccountRecord } from './deleted-accounts.types';

export function toDeletedAccountRecord(row: DeletedAccountRow): DeletedAccountRecord {
  return {
    id: row.id,
    accountType: row.accountType,
    accountId: row.accountId,
    deletionRequestId: row.deletionRequestId,
    snapshot: row.snapshot,
    originalMobileNumber: row.originalMobileNumber,
    deletedAt: row.deletedAt.toISOString(),
    deletedByAdminId: row.deletedByAdminId,
    restoredAt: row.restoredAt?.toISOString() ?? null,
    restoredByAdminId: row.restoredByAdminId,
  };
}
