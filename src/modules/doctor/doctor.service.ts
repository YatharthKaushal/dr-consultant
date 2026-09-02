import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../../shared/audit/audit.service';
import type { AuthContext } from '../../shared/auth/auth.types';
import { CatalogueFacade } from '../catalogue/catalogue.facade';
import { DoctorDocumentRepository } from './doctor-document.repository';
import { DoctorSpecialtyRepository } from './doctor-specialty.repository';
import type { CreateDoctorDto, UpdateDoctorDto } from './doctor-admin.dto';
import type { UpdateOwnDoctorProfileDto } from './doctor.dto';
import { DOCTOR_AUDIT_ENTITY_TYPES, DOCTOR_ERROR_CODES } from './doctor.constants';
import type { PublicDoctorProfile } from './doctor.contract';
import {
  toPublicDoctorProfile,
  toPublicDoctorSpecialties,
  toSafeDoctorDocumentRow,
  toSafeDoctorRow,
  type DoctorSpecialtyWithDetails,
  type SafeDoctorDocumentRow,
  type SafeDoctorRow,
} from './doctor.mapper';
import { normalizeMobileNumber } from './doctor-phone.util';
import { DoctorRepository, type DoctorProfileFieldsUpdate } from './doctor.repository';
import type { DoctorSpecialtyRow } from '../../schema/doctor-specialties.schema';

export interface DoctorProfileWithDetails extends SafeDoctorRow {
  specialties: PublicDoctorProfile['specialties'];
  documents: SafeDoctorDocumentRow[];
}

/** Shared 404 shape — also used by `doctor-document.service.ts`, `doctor-specialty.service.ts`, etc. for a missing doctor id. */
export function doctorNotFound(): NotFoundException {
  return new NotFoundException({ code: DOCTOR_ERROR_CODES.DOCTOR_NOT_FOUND, message: 'Doctor not found.' });
}

/**
 * Core `doctors` entity operations: self-service profile, admin CRUD, and
 * the public-ish single-doctor read. Verification/listing/fee/expert-role
 * transitions live in `doctor-verification.service.ts` (each is its own
 * permission and its own set of side effects); specialty assignment lives in
 * `doctor-specialty.service.ts`; document workflow in
 * `doctor-document.service.ts`; reliability metrics in
 * `doctor-reliability.service.ts` — mirroring how `identity.service.ts`
 * stays scoped to the OTP flow while `identity-access.service.ts` owns
 * RBAC/admin management.
 */
@Injectable()
export class DoctorService {
  constructor(
    private readonly repo: DoctorRepository,
    private readonly specialtyRepo: DoctorSpecialtyRepository,
    private readonly documentRepo: DoctorDocumentRepository,
    private readonly audit: AuditService,
    private readonly catalogue: CatalogueFacade,
  ) {}

  /**
   * Enriches raw `doctor_specialties` rows with catalogue-owned `code`/`name`
   * via `CatalogueFacade` — the module never reads `specialties` directly
   * (`backend/README.md`: tables belong to one module only). A doctor holds
   * at most a handful of specialties, so N parallel facade calls stays cheap;
   * a `null` back from the facade means the FK points at a specialty that no
   * longer exists, which should be structurally impossible (specialties are
   * deactivated, never deleted) — treated as a data-integrity error, not a
   * silently-dropped row.
   */
  private async enrichSpecialties(rows: DoctorSpecialtyRow[]): Promise<DoctorSpecialtyWithDetails[]> {
    return Promise.all(
      rows.map(async (row) => {
        const specialty = await this.catalogue.getSpecialtyById(row.specialtyId);
        if (!specialty) {
          throw new Error(`doctor_specialties row ${row.id} references specialty ${row.specialtyId}, which no longer exists.`);
        }
        return { id: row.id, specialtyId: row.specialtyId, code: specialty.code, name: specialty.name, isPrimary: row.isPrimary };
      }),
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Self-service (GET/PATCH /doctors/me)                                    */
  /* ---------------------------------------------------------------------- */

  async getOwnProfile(doctorId: string): Promise<DoctorProfileWithDetails> {
    const doctor = await this.repo.findById(doctorId);
    if (!doctor) {
      throw doctorNotFound();
    }
    const [specialtyRows, documents] = await Promise.all([
      this.specialtyRepo.listByDoctor(doctorId),
      this.documentRepo.listByDoctor(doctorId),
    ]);
    const specialties = await this.enrichSpecialties(specialtyRows);
    return {
      ...toSafeDoctorRow(doctor),
      specialties: toPublicDoctorSpecialties(specialties),
      documents: documents.map(toSafeDoctorDocumentRow),
    };
  }

  /**
   * SELF-EDITABLE FIELDS ONLY: `bio`, `languages` — enforced structurally by
   * `UpdateOwnDoctorProfileDto` only declaring those two fields, and by this
   * method only ever writing them. Not audited: unlike the admin mutations
   * below, a doctor editing their own bio/languages is not a
   * compliance-relevant action the task brief calls out for auditing.
   */
  async updateOwnProfile(doctorId: string, dto: UpdateOwnDoctorProfileDto): Promise<SafeDoctorRow> {
    const fields: { bio?: string; languages?: string[] } = {};
    if (dto.bio !== undefined) fields.bio = dto.bio;
    if (dto.languages !== undefined) fields.languages = dto.languages;

    if (Object.keys(fields).length === 0) {
      const doctor = await this.repo.findById(doctorId);
      if (!doctor) throw doctorNotFound();
      return toSafeDoctorRow(doctor);
    }

    const updated = await this.repo.updateOwnProfile(doctorId, fields);
    if (!updated) throw doctorNotFound();
    return toSafeDoctorRow(updated);
  }

  /* ---------------------------------------------------------------------- */
  /* Public-ish single-doctor read (GET /doctors/:id)                        */
  /* ---------------------------------------------------------------------- */

  /**
   * Visible to a patient/doctor caller only when `verificationStatus ===
   * 'verified' && isListed`; an admin caller sees it regardless. 404 (never
   * 403) when the doctor doesn't exist OR isn't visible to this caller — a
   * 403 would confirm an unlisted doctor's existence to a patient.
   */
  async getListedProfileForCaller(doctorId: string, auth: AuthContext): Promise<PublicDoctorProfile> {
    const doctor = await this.repo.findById(doctorId);
    if (!doctor) throw doctorNotFound();

    const visible = auth.accountType === 'admin' || (doctor.verificationStatus === 'verified' && doctor.isListed);
    if (!visible) {
      throw doctorNotFound();
    }

    const specialtyRows = await this.specialtyRepo.listByDoctor(doctorId);
    const specialties = await this.enrichSpecialties(specialtyRows);
    return toPublicDoctorProfile(doctor, specialties);
  }

  /* ---------------------------------------------------------------------- */
  /* Contract-backing reads (doctor.facade.ts)                               */
  /* ---------------------------------------------------------------------- */

  async getPublicProfile(doctorId: string): Promise<PublicDoctorProfile | null> {
    const doctor = await this.repo.findById(doctorId);
    if (!doctor) return null;
    const specialtyRows = await this.specialtyRepo.listByDoctor(doctorId);
    const specialties = await this.enrichSpecialties(specialtyRows);
    return toPublicDoctorProfile(doctor, specialties);
  }

  async isVerifiedAndListed(doctorId: string): Promise<boolean> {
    const doctor = await this.repo.findById(doctorId);
    return doctor !== null && doctor.verificationStatus === 'verified' && doctor.isListed;
  }

  /* ---------------------------------------------------------------------- */
  /* Admin CRUD (admin/doctors)                                              */
  /* ---------------------------------------------------------------------- */

  async adminList(): Promise<SafeDoctorRow[]> {
    const doctors = await this.repo.list();
    return doctors.map(toSafeDoctorRow);
  }

  async adminGetDetail(doctorId: string): Promise<DoctorProfileWithDetails> {
    const doctor = await this.repo.findById(doctorId);
    if (!doctor) throw doctorNotFound();
    const [specialtyRows, documents] = await Promise.all([
      this.specialtyRepo.listByDoctor(doctorId),
      this.documentRepo.listByDoctor(doctorId),
    ]);
    const specialties = await this.enrichSpecialties(specialtyRows);
    return {
      ...toSafeDoctorRow(doctor),
      specialties: toPublicDoctorSpecialties(specialties),
      documents: documents.map(toSafeDoctorDocumentRow),
    };
  }

  /** FR-1.2: "created ... by an admin only." Rejects a duplicate mobile number, same pattern as identity's `createAdmin`. */
  async adminCreate(actingAdminId: string, dto: CreateDoctorDto): Promise<SafeDoctorRow> {
    const mobileNumber = normalizeMobileNumber(dto.mobileNumber);
    const existing = await this.repo.findByMobile(mobileNumber);
    if (existing) {
      throw new ConflictException({
        code: DOCTOR_ERROR_CODES.MOBILE_NUMBER_TAKEN,
        message: 'A doctor with this mobile number already exists.',
      });
    }

    const doctor = await this.repo.create({ mobileNumber, fullName: dto.fullName });
    await this.audit.write({
      actorType: 'admin',
      actorId: actingAdminId,
      action: 'create',
      entityType: DOCTOR_AUDIT_ENTITY_TYPES.DOCTOR,
      entityId: doctor.id,
    });
    return toSafeDoctorRow(doctor);
  }

  /**
   * Edits fullName/qualification/registrationNumber/yearsOfExperience/
   * consultationDurationMinutes/bufferMinutes. Skips the update AND the
   * audit write entirely when the DTO carries no defined fields (a true
   * no-op call) — no misleading audit entry, same discipline as
   * `identity-access.service.ts`'s RBAC mutations.
   */
  async adminUpdateProfileFields(actingAdminId: string, doctorId: string, dto: UpdateDoctorDto): Promise<SafeDoctorRow> {
    const doctor = await this.repo.findById(doctorId);
    if (!doctor) throw doctorNotFound();

    const fields = this.definedFieldsOnly(dto);
    if (Object.keys(fields).length === 0) {
      return toSafeDoctorRow(doctor);
    }

    if (fields.registrationNumber && fields.registrationNumber !== doctor.registrationNumber) {
      const clash = await this.repo.findByRegistrationNumber(fields.registrationNumber);
      if (clash && clash.id !== doctorId) {
        throw new ConflictException({
          code: DOCTOR_ERROR_CODES.REGISTRATION_NUMBER_TAKEN,
          message: 'This registration number is already in use.',
        });
      }
    }

    const updated = await this.repo.updateProfileFields(doctorId, fields);
    if (!updated) throw doctorNotFound();

    await this.audit.write({
      actorType: 'admin',
      actorId: actingAdminId,
      action: 'update',
      entityType: DOCTOR_AUDIT_ENTITY_TYPES.DOCTOR,
      entityId: doctorId,
      metadata: { ...fields },
    });
    return toSafeDoctorRow(updated);
  }

  /** Used internally by other services in this module that need the raw row (verification/listing/fee/expert-role/reliability). */
  async requireDoctor(doctorId: string) {
    const doctor = await this.repo.findById(doctorId);
    if (!doctor) throw doctorNotFound();
    return doctor;
  }

  private definedFieldsOnly(dto: UpdateDoctorDto): DoctorProfileFieldsUpdate {
    const fields: DoctorProfileFieldsUpdate = {};
    if (dto.fullName !== undefined) fields.fullName = dto.fullName;
    if (dto.qualification !== undefined) fields.qualification = dto.qualification;
    if (dto.registrationNumber !== undefined) fields.registrationNumber = dto.registrationNumber;
    if (dto.yearsOfExperience !== undefined) fields.yearsOfExperience = dto.yearsOfExperience;
    if (dto.consultationDurationMinutes !== undefined) fields.consultationDurationMinutes = dto.consultationDurationMinutes;
    if (dto.bufferMinutes !== undefined) fields.bufferMinutes = dto.bufferMinutes;
    return fields;
  }
}
