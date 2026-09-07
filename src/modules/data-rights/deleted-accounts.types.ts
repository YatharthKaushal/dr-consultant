import type { DeletableAccountType } from '../../schema/enums.schema';

/** HTTP-facing shape — timestamps as ISO strings, same reasoning `data-deletion.types.ts` states for its own record. */
export interface DeletedAccountRecord {
  id: string;
  accountType: DeletableAccountType;
  accountId: string;
  deletionRequestId: string;
  /** The pre-delete row, exactly as stored — an admin reviewing a restore candidate needs to see who it actually is. */
  snapshot: Record<string, unknown>;
  originalMobileNumber: string;
  deletedAt: string;
  deletedByAdminId: string | null;
  restoredAt: string | null;
  restoredByAdminId: string | null;
}
