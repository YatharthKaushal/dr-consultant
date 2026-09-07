import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { DeletableAccountType, DoctorVerificationStatus } from '../../schema/enums.schema';
import { AuditService } from '../../shared/audit/audit.service';
import { isUniqueConstraintViolation } from '../../shared/errors/postgres-error.util';
import { DoctorFacade } from '../doctor/doctor.facade';
import { IdentityFacade } from '../identity/identity.facade';
import { PatientFacade } from '../patient/patient.facade';
import { DELETED_ACCOUNTS_AUDIT_ENTITY_TYPES, DELETED_ACCOUNTS_ERROR_CODES } from './deleted-accounts.constants';
import { DeletedAccountsRepository } from './deleted-accounts.repository';
import { toDeletedAccountRecord } from './deleted-accounts.mapper';
import type { DeletedAccountRecord } from './deleted-accounts.types';

/**
 * *** THE "ANOTHER COPY, FOR SAFETY" TABLE'S OWN SERVICE. *** ADDITIVE
 * (account-deletion lifecycle round). Owns `deleted_accounts` — the one
 * table `data-rights` (M-21) writes directly, unlike every other table its
 * survey only READS a count of.
 *
 * `recordSnapshot` is called from `data-rights.service.ts#executeForRequest`,
 * the instant after `PatientFacade`/`DoctorFacade`'s own soft-delete write
 * succeeds, with the pre-mutation row that facade call handed back.
 * `restore` is the entire un-do — the ONE place in this codebase where a
 * soft-deleted account genuinely comes back.
 */
@Injectable()
export class DeletedAccountsService {
  constructor(
    private readonly repo: DeletedAccountsRepository,
    private readonly identity: IdentityFacade,
    private readonly patient: PatientFacade,
    private readonly doctor: DoctorFacade,
    private readonly audit: AuditService,
  ) {}

  /** The write half of "another copy, for safety" — see the class header. Not itself audited (the caller's own `delete`-action audit entry on the account already records this execution). */
  async recordSnapshot(input: {
    accountType: DeletableAccountType;
    accountId: string;
    deletionRequestId: string;
    snapshot: Record<string, unknown>;
    originalMobileNumber: string;
    deletedByAdminId: string | null;
  }): Promise<DeletedAccountRecord> {
    const row = await this.repo.insert(input);
    return toDeletedAccountRecord(row);
  }

  async listForAdmin(input: { accountType?: DeletableAccountType; restored?: boolean; limit: number; offset: number }): Promise<DeletedAccountRecord[]> {
    const rows = await this.repo.list(input);
    return rows.map(toDeletedAccountRecord);
  }

  async getForAdmin(id: string): Promise<DeletedAccountRecord> {
    const row = await this.repo.findById(id);
    if (!row) throw this.notFound();
    return toDeletedAccountRecord(row);
  }

  /**
   * *** THE FULL RESTORE. NOTHING IN THIS CODEBASE EVER HARD-DELETES AN
   * ACCOUNT, SO THIS STAYS POSSIBLE FOREVER. ***
   *
   * Order matters: the mobile number is restored FIRST. If it fails (the
   * number was reassigned to a newer sign-up since — see
   * `deleted-accounts.constants.ts#MOBILE_NUMBER_REASSIGNED`'s own
   * comment), nothing else has been touched yet, and the account is left
   * cleanly `deleted` rather than half-restored with no working sign-in
   * identifier.
   */
  async restore(id: string, actingAdminId: string): Promise<DeletedAccountRecord> {
    const existing = await this.repo.findById(id);
    if (!existing) throw this.notFound();
    if (existing.restoredAt) {
      throw new ConflictException({
        code: DELETED_ACCOUNTS_ERROR_CODES.DELETED_ACCOUNT_ALREADY_RESTORED,
        message: 'This account was already restored.',
      });
    }

    try {
      await this.identity.restoreMobileNumber(existing.accountType, existing.accountId, existing.originalMobileNumber);
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        throw new ConflictException({
          code: DELETED_ACCOUNTS_ERROR_CODES.MOBILE_NUMBER_REASSIGNED,
          message: `The original mobile number is now in use by a newer ${existing.accountType} account — restore is not possible without first resolving that conflict.`,
        });
      }
      throw error;
    }

    if (existing.accountType === 'patient') {
      await this.patient.restoreFromDeletion(existing.accountId);
    } else {
      const verificationStatus = this.readVerificationStatus(existing.snapshot);
      await this.doctor.restoreFromDeletion(existing.accountId, verificationStatus);
    }

    const restored = await this.repo.markRestored(id, actingAdminId);
    if (!restored) {
      // Lost a race with a concurrent restore — the account-level writes
      // above are idempotent-safe to have run twice (both `restore` repo
      // methods are guarded on `deleted_at IS NOT NULL`/similar), so this
      // is reported as the same "already restored" conflict, not a 500.
      throw new ConflictException({
        code: DELETED_ACCOUNTS_ERROR_CODES.DELETED_ACCOUNT_ALREADY_RESTORED,
        message: 'This account was already restored.',
      });
    }

    await this.audit.write({
      actorType: 'admin',
      actorId: actingAdminId,
      action: 'update',
      entityType: DELETED_ACCOUNTS_AUDIT_ENTITY_TYPES.DELETED_ACCOUNT,
      entityId: id,
      metadata: { accountType: existing.accountType, accountId: existing.accountId, reason: 'admin_restore' },
    });

    return toDeletedAccountRecord(restored);
  }

  /* ---------------------------------------------------------------------- */

  /** A doctor's snapshot is a plain jsonb blob — validated defensively rather than trusted, since it crossed a jsonb boundary. Falls back to `'pending'` (the safest, least-bookable status) on anything unrecognised. */
  private readVerificationStatus(snapshot: Record<string, unknown>): DoctorVerificationStatus {
    const value = snapshot.verificationStatus;
    const valid: readonly string[] = ['pending', 'under_review', 'verified', 'rejected', 'suspended'];
    return typeof value === 'string' && valid.includes(value) ? (value as DoctorVerificationStatus) : 'pending';
  }

  private notFound(): NotFoundException {
    return new NotFoundException({
      code: DELETED_ACCOUNTS_ERROR_CODES.DELETED_ACCOUNT_NOT_FOUND,
      message: 'That deleted account does not exist.',
    });
  }
}
