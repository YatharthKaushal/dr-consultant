import { Injectable, NotFoundException } from '@nestjs/common';
import type { AccountStatus } from '../../schema/enums.schema';
import type { PatientRow } from '../../schema/patients.schema';
import { AuditService } from '../../shared/audit/audit.service';
import { IdentityFacade } from '../identity/identity.facade';
import type { DeletionActor, PatientDeletionSnapshot } from './patient.contract';
import { PATIENT_AUDIT_ENTITY_TYPES, PATIENT_ERROR_CODES } from './patient.constants';
import type { UpdatePatientProfileDto } from './patient.dto';
import { PatientRepository } from './patient.repository';

/** `patients` row shape safe to return from the API — `tokenVersion` is an internal revocation counter, not something a client needs. */
export type PublicPatientRow = Omit<PatientRow, 'tokenVersion'>;

function toPublicPatient(row: PatientRow): PublicPatientRow {
  const { tokenVersion: _tokenVersion, ...rest } = row;
  return rest;
}

const REVOKING_STATUSES = new Set<AccountStatus>(['suspended', 'deleted']);

/**
 * Patient's own profile (get/update, including the OTP-signup "profile
 * completion" transition) and the admin moderation surface (list/get/status
 * change). "Doctor can read an assigned patient" is deferred to when M-11
 * (consultations) lands — there is no consultation table yet to scope that
 * ownership rule against.
 */
@Injectable()
export class PatientService {
  constructor(
    private readonly repo: PatientRepository,
    private readonly identity: IdentityFacade,
    private readonly audit: AuditService,
  ) {}

  async getOwnProfile(patientId: string): Promise<PublicPatientRow> {
    const row = await this.findOrThrow(patientId);
    return toPublicPatient(row);
  }

  /**
   * Partial profile update. FR-1.1/FR-2.2 "profile completion": a patient
   * row is created bare (status 'pending') at OTP signup — the moment the
   * row has both a non-empty `fullName` and a `dateOfBirth`, status flips to
   * 'active' in the same write. That transition is audited; routine edits
   * after the account is already active are not.
   */
  async updateOwnProfile(patientId: string, dto: UpdatePatientProfileDto): Promise<PublicPatientRow> {
    const existing = await this.findOrThrow(patientId);

    const nextFullName = dto.fullName !== undefined ? dto.fullName : existing.fullName;
    const nextDateOfBirth = dto.dateOfBirth !== undefined ? dto.dateOfBirth : existing.dateOfBirth;
    const completesProfile =
      existing.status === 'pending' && !!nextFullName && nextFullName.trim().length > 0 && !!nextDateOfBirth;

    const updated = await this.repo.updateProfile(patientId, {
      ...dto,
      ...(completesProfile ? { status: 'active' as const } : {}),
    });
    if (!updated) {
      throw new NotFoundException({ code: PATIENT_ERROR_CODES.PATIENT_NOT_FOUND, message: 'Patient not found.' });
    }

    if (completesProfile) {
      // Best-effort — a profile update succeeding matters more than its log line.
      await this.audit.write({
        actorType: 'patient',
        actorId: patientId,
        action: 'update',
        entityType: PATIENT_AUDIT_ENTITY_TYPES.PATIENT,
        entityId: patientId,
        metadata: { reason: 'profile_completed', from: 'pending', to: 'active' },
      });
    }

    return toPublicPatient(updated);
  }

  async listForAdmin(): Promise<PublicPatientRow[]> {
    const rows = await this.repo.findAll();
    return rows.map(toPublicPatient);
  }

  async getForAdmin(patientId: string): Promise<PublicPatientRow> {
    const row = await this.findOrThrow(patientId);
    return toPublicPatient(row);
  }

  /**
   * Status update first, then session revocation for suspend/delete only —
   * not the same DB transaction: a legitimate suspension shouldn't be
   * blocked by session-kill failing, but if the status update itself fails,
   * no revocation is attempted. Reactivation to 'active' never revokes.
   */
  async updateStatus(actingAdminId: string, patientId: string, status: AccountStatus): Promise<PublicPatientRow> {
    const existing = await this.findOrThrow(patientId);
    const previousStatus = existing.status;

    const updated = await this.repo.updateStatus(patientId, status);
    if (!updated) {
      throw new NotFoundException({ code: PATIENT_ERROR_CODES.PATIENT_NOT_FOUND, message: 'Patient not found.' });
    }

    if (REVOKING_STATUSES.has(status)) {
      // Attribute the session-revocation audit entry to the acting admin,
      // not the patient being suspended/deleted — see
      // `IdentityContract.revokeAllSessions`'s doc comment.
      await this.identity.revokeAllSessions('patient', patientId, { actorType: 'admin', actorId: actingAdminId });
    }

    await this.audit.write({
      actorType: 'admin',
      actorId: actingAdminId,
      action: 'update',
      entityType: PATIENT_AUDIT_ENTITY_TYPES.PATIENT,
      entityId: patientId,
      metadata: { from: previousStatus, to: status },
    });

    return toPublicPatient(updated);
  }

  /**
   * ADDITIVE (account-deletion lifecycle round — replaces the earlier
   * `anonymizeForDeletion`). See `PatientContract
   * #softDeleteForDeletionRequest`'s header for the idempotency contract.
   *
   * *** WHY `patients` IS SOFT-DELETED, NEVER HARD-DELETED — AND WHY IT
   * KEEPS `fullName`/`dateOfBirth` NOW, UNLIKE THE OLD `anonymizeForDeletion`. ***
   * The M-21 survey retains `consultations`, `clinical_records`, `payments`,
   * `audit_log` and every other clinical/financial table for a deleted
   * patient — medical-record and financial retention obligations
   * (`docs/SRS.md` §5.3, §8) that a single deletion request does not
   * override; every one of those tables carries a NOT NULL `patient_id` FK
   * to this row, so hard-deleting it would either violate that FK or force
   * cascading through tables this survey deliberately decided NOT to touch.
   * The earlier design ALSO destroyed `fullName`/`dateOfBirth` in place,
   * which made "the admin can restore any deleted account forever" a lie —
   * there was nothing left to restore TO. This version keeps them (a real,
   * separate `deleted_accounts` snapshot exists too, owned by `data-rights`,
   * as the "second copy for safety") and relies on `deleted_at` — not a
   * destroyed name — as the signal other modules mask against
   * (`shared/privacy/mask.util.ts`, applied in `PatientFacade.
   * getProfileSummary`).
   *
   * Returns the PRE-mutation row as `snapshot` (jsonb-safe) plus the
   * account's real `originalMobileNumber` — `data-rights`'s own
   * `DeletedAccountsService` is what persists those into `deleted_accounts`
   * (a table this module does not own and never writes).
   *
   * Four writes, deliberately not one transaction spanning modules
   * (`backend/README.md` §2 forbids a cross-module transaction):
   *   1. `repo.softDelete` — `status` -> `deleted`, `deleted_at` stamped,
   *      `pushToken`/`deviceId` cleared (device hygiene: a deleted account
   *      must stop receiving pushes). Identity fields untouched.
   *   2. Sessions revoked through `IdentityFacade` — the same call
   *      `updateStatus` used to make via `REVOKING_STATUSES`, made
   *      directly here since this method no longer routes through
   *      `updateStatus` (that method's own `update`-action audit entry
   *      would misrepresent this as an ordinary moderation edit).
   *   3. `mobileNumber`, vacated through `IdentityFacade` — identity owns
   *      that column, never this module. THIS is what makes "sign up again
   *      if you try to access the deleted account" true:
   *      `findOrCreatePatientByMobile` sees the real number as free.
   *   4. A `delete`-action audit entry, attributed to `actor` (an admin, or
   *      `system` for the grace-period sweep — see `data-deletion.types.ts
   *      #DeletionExecutionActor`).
   *
   * The caller (`data-rights` module) decides what happens if a later step
   * in ITS OWN sequence fails — this method either completes all four
   * writes or throws; it does not partially apply.
   */
  async softDeleteForDeletionRequest(patientId: string, actor: DeletionActor): Promise<PatientDeletionSnapshot> {
    const existing = await this.findOrThrow(patientId);
    if (existing.deletedAt) {
      return { softDeleted: false, snapshot: null, originalMobileNumber: null };
    }

    const originalMobileNumber = existing.mobileNumber;
    const snapshot: Record<string, unknown> = { ...existing };

    const softDeleted = await this.repo.softDelete(patientId, new Date());
    if (!softDeleted) {
      // Lost a race with a concurrent execution — treat as already done.
      return { softDeleted: false, snapshot: null, originalMobileNumber: null };
    }

    await this.identity.revokeAllSessions('patient', patientId, { actorType: actor.actorType, actorId: actor.actorId ?? patientId });
    await this.identity.anonymizeMobileNumber('patient', patientId);

    await this.audit.write({
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: 'delete',
      entityType: PATIENT_AUDIT_ENTITY_TYPES.PATIENT,
      entityId: patientId,
      metadata: { reason: 'data_deletion_request_executed' },
    });

    return { softDeleted: true, snapshot, originalMobileNumber };
  }

  /**
   * ADDITIVE (account-deletion lifecycle round). The un-do —
   * `deleted-accounts.service.ts#restore`'s patient half. Restores
   * `mobileNumber` (identity's column) and this table's own `status`/
   * `deleted_at` in that order — mobile FIRST, so a unique-constraint
   * failure (the number was reassigned since) leaves the account still
   * cleanly `deleted` rather than half-restored with no working sign-in
   * identifier. `data-rights` orchestrates the ordering; this method is the
   * one call it makes once the mobile write has already succeeded.
   */
  async restoreFromDeletion(patientId: string): Promise<{ restored: boolean }> {
    const row = await this.repo.restore(patientId);
    if (!row) return { restored: false };
    return { restored: true };
  }

  private async findOrThrow(patientId: string): Promise<PatientRow> {
    const row = await this.repo.findById(patientId);
    if (!row) {
      throw new NotFoundException({ code: PATIENT_ERROR_CODES.PATIENT_NOT_FOUND, message: 'Patient not found.' });
    }
    return row;
  }
}
