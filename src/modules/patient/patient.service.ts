import { Injectable, NotFoundException } from '@nestjs/common';
import type { AccountStatus } from '../../schema/enums.schema';
import type { PatientRow } from '../../schema/patients.schema';
import { AuditService } from '../../shared/audit/audit.service';
import { IdentityFacade } from '../identity/identity.facade';
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

  private async findOrThrow(patientId: string): Promise<PatientRow> {
    const row = await this.repo.findById(patientId);
    if (!row) {
      throw new NotFoundException({ code: PATIENT_ERROR_CODES.PATIENT_NOT_FOUND, message: 'Patient not found.' });
    }
    return row;
  }
}
