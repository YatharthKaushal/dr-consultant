import { ConflictException, Injectable } from '@nestjs/common';
import { AuditService } from '../../shared/audit/audit.service';
import type {
  UpdateDoctorExpertRoleDto,
  UpdateDoctorFeeDto,
  UpdateDoctorListingDto,
  UpdateDoctorVerificationDto,
} from './doctor-admin.dto';
import { DOCTOR_AUDIT_ENTITY_TYPES, DOCTOR_ERROR_CODES } from './doctor.constants';
import { toSafeDoctorRow, type SafeDoctorRow } from './doctor.mapper';
import { doctorNotFound } from './doctor.service';
import { DoctorRepository } from './doctor.repository';
// IdentityModule is `@Global()`, so this is a normal cross-module facade
// injection (`backend/README.md` §2), not a deep import — same pattern the
// task brief calls out ("IdentityFacade (global, inject directly)").
import { IdentityFacade } from '../identity/identity.facade';

/** Verification/listing/fee/expert-role transitions — each gated by its own permission (`DOCTORS_VERIFY`, `DOCTORS_MANAGE_LISTING`, `DOCTORS_MANAGE_FEE`, `DOCTORS_MANAGE_EXPERT_ROLE`). Kept out of `doctor.service.ts` because these carry distinct side-effect rules the plain profile edit does not. */
@Injectable()
export class DoctorVerificationService {
  constructor(
    private readonly repo: DoctorRepository,
    private readonly audit: AuditService,
    private readonly identity: IdentityFacade,
  ) {}

  /**
   * Sets `verificationStatus`. Moving TO `verified`/`rejected` also sets
   * `verifiedByAdminId`/`verifiedAt`. Moving to `rejected`/`suspended` also:
   * forces `isListed = false` in the SAME update (structural enforcement of
   * "an unapproved doctor cannot use the doctor experience" — MODULES.md
   * M-05's done-when bar — rather than trusting the admin to also flip
   * listing separately) and revokes every live session for the doctor.
   *
   * A no-op call (new status === current status) skips the update, the
   * session revocation and the audit write entirely — same "don't write a
   * misleading audit entry for a state change that didn't happen" discipline
   * as `identity-access.service.ts`'s RBAC mutations.
   */
  async setVerificationStatus(actingAdminId: string, doctorId: string, dto: UpdateDoctorVerificationDto): Promise<SafeDoctorRow> {
    const doctor = await this.repo.findById(doctorId);
    if (!doctor) throw doctorNotFound();

    const beforeStatus = doctor.verificationStatus;
    const afterStatus = dto.status;
    if (beforeStatus === afterStatus) {
      return toSafeDoctorRow(doctor);
    }

    const demoting = afterStatus === 'rejected' || afterStatus === 'suspended';
    const now = new Date();

    const updated = await this.repo.updateVerification(doctorId, {
      verificationStatus: afterStatus,
      ...(afterStatus === 'verified' || afterStatus === 'rejected'
        ? { verifiedByAdminId: actingAdminId, verifiedAt: now }
        : {}),
      ...(demoting ? { isListed: false } : {}),
    });
    if (!updated) throw doctorNotFound();

    if (demoting) {
      // Attribute the session-revocation audit entry to the acting admin,
      // not the doctor being suspended/rejected — see
      // `IdentityContract.revokeAllSessions`'s doc comment.
      await this.identity.revokeAllSessions('doctor', doctorId, { actorType: 'admin', actorId: actingAdminId });
    }

    await this.audit.write({
      actorType: 'admin',
      actorId: actingAdminId,
      action: 'verify',
      entityType: DOCTOR_AUDIT_ENTITY_TYPES.DOCTOR,
      entityId: doctorId,
      metadata: { before: { status: beforeStatus }, after: { status: afterStatus } },
    });
    return toSafeDoctorRow(updated);
  }

  /**
   * Sets `isListed`/`allowInstantConsult`. MUST reject setting `isListed:
   * true` while `verificationStatus !== 'verified'` (409) — this is the
   * OTHER endpoint that can flip `isListed`, so it enforces the same
   * completion gate as `setVerificationStatus`'s forced `isListed: false`.
   * Audits only when a value actually changes.
   */
  async setListing(actingAdminId: string, doctorId: string, dto: UpdateDoctorListingDto): Promise<SafeDoctorRow> {
    const doctor = await this.repo.findById(doctorId);
    if (!doctor) throw doctorNotFound();

    const nextIsListed = dto.isListed ?? doctor.isListed;
    const nextAllowInstantConsult = dto.allowInstantConsult ?? doctor.allowInstantConsult;

    if (nextIsListed && doctor.verificationStatus !== 'verified') {
      throw new ConflictException({
        code: DOCTOR_ERROR_CODES.CANNOT_LIST_UNVERIFIED_DOCTOR,
        message: 'Only a verified doctor can be listed.',
      });
    }

    if (nextIsListed === doctor.isListed && nextAllowInstantConsult === doctor.allowInstantConsult) {
      return toSafeDoctorRow(doctor);
    }

    const updated = await this.repo.updateListing(doctorId, {
      isListed: nextIsListed,
      allowInstantConsult: nextAllowInstantConsult,
    });
    if (!updated) throw doctorNotFound();

    await this.audit.write({
      actorType: 'admin',
      actorId: actingAdminId,
      action: 'update',
      entityType: DOCTOR_AUDIT_ENTITY_TYPES.DOCTOR,
      entityId: doctorId,
      metadata: {
        before: { isListed: doctor.isListed, allowInstantConsult: doctor.allowInstantConsult },
        after: { isListed: nextIsListed, allowInstantConsult: nextAllowInstantConsult },
      },
    });
    return toSafeDoctorRow(updated);
  }

  /** Sets `consultationFeeInr`. `UpdateDoctorFeeDto` already validates a positive number. Skips the update/audit when the fee is unchanged. */
  async setFee(actingAdminId: string, doctorId: string, dto: UpdateDoctorFeeDto): Promise<SafeDoctorRow> {
    const doctor = await this.repo.findById(doctorId);
    if (!doctor) throw doctorNotFound();

    const nextFee = dto.consultationFeeInr.toFixed(2);
    if (Number(doctor.consultationFeeInr) === Number(nextFee)) {
      return toSafeDoctorRow(doctor);
    }

    const updated = await this.repo.updateFee(doctorId, nextFee);
    if (!updated) throw doctorNotFound();

    await this.audit.write({
      actorType: 'admin',
      actorId: actingAdminId,
      action: 'update',
      entityType: DOCTOR_AUDIT_ENTITY_TYPES.DOCTOR,
      entityId: doctorId,
      metadata: { before: { consultationFeeInr: doctor.consultationFeeInr }, after: { consultationFeeInr: nextFee } },
    });
    return toSafeDoctorRow(updated);
  }

  /**
   * FR-1.5 — grants/revokes the expert (case-clarification) flag. Audited on
   * EVERY call, even when `seniorityLevel` doesn't actually change — this is
   * a named compliance-relevant action, an explicit exception to the
   * no-misleading-no-op-audit discipline applied everywhere else in this
   * service (see the task brief for M-05).
   */
  async setExpertRole(actingAdminId: string, doctorId: string, dto: UpdateDoctorExpertRoleDto): Promise<SafeDoctorRow> {
    const doctor = await this.repo.findById(doctorId);
    if (!doctor) throw doctorNotFound();

    const updated = await this.repo.updateSeniority(doctorId, dto.seniorityLevel);
    if (!updated) throw doctorNotFound();

    await this.audit.write({
      actorType: 'admin',
      actorId: actingAdminId,
      action: 'update',
      entityType: DOCTOR_AUDIT_ENTITY_TYPES.DOCTOR,
      entityId: doctorId,
      metadata: { before: { seniorityLevel: doctor.seniorityLevel }, after: { seniorityLevel: dto.seniorityLevel } },
    });
    return toSafeDoctorRow(updated);
  }
}
