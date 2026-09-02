import type { DoctorDocumentRow } from '../../schema/doctor-documents.schema';
import type { DoctorRow } from '../../schema/doctors.schema';
import type { ListedDoctorSummary, PublicDoctorProfile, PublicDoctorSpecialty } from './doctor.contract';

/** A `doctor_specialties` row enriched with catalogue-owned `code`/`name` — assembled by the service layer via `CatalogueFacade`, never read directly off a join (see `doctor-specialty.repository.ts`). */
export interface DoctorSpecialtyWithDetails {
  id: string;
  specialtyId: string;
  code: string;
  name: string;
  isPrimary: boolean;
}

/**
 * Safe to return to ANY client — strips the identity-owned auth internal
 * (`tokenVersion`) and the M-13/M-15-owned runtime state (`presence`,
 * `blockedByConsultationId`) this module must not expose or edit, plus the
 * identity-owned `pushToken`/`deviceId`.
 */
export type SafeDoctorRow = Omit<DoctorRow, 'tokenVersion' | 'pushToken' | 'deviceId' | 'presence' | 'blockedByConsultationId'>;

export function toSafeDoctorRow(row: DoctorRow): SafeDoctorRow {
  const {
    tokenVersion: _tokenVersion,
    pushToken: _pushToken,
    deviceId: _deviceId,
    presence: _presence,
    blockedByConsultationId: _blockedByConsultationId,
    ...rest
  } = row;
  return rest;
}

/** Safe to return to ANY client — `storageKey` is an internal object-store key, "never exposed to the client" per `doctor-documents.schema.ts`. */
export type SafeDoctorDocumentRow = Omit<DoctorDocumentRow, 'storageKey'>;

export function toSafeDoctorDocumentRow(row: DoctorDocumentRow): SafeDoctorDocumentRow {
  const { storageKey: _storageKey, ...rest } = row;
  return rest;
}

export function toPublicDoctorSpecialties(specialties: DoctorSpecialtyWithDetails[]): PublicDoctorSpecialty[] {
  return specialties.map((s) => ({ id: s.specialtyId, code: s.code, name: s.name, isPrimary: s.isPrimary }));
}

/**
 * ADDITIVE (M-09/search): the listing projection — `PublicDoctorProfile`
 * minus `bio`. See `ListedDoctorSummary` in `doctor.contract.ts` for why
 * that one field is the whole difference. Specialties arrive already
 * enriched (and already filtered of any that no longer resolve), so this
 * stays a pure field projection.
 */
export function toListedDoctorSummary(doctor: DoctorRow, specialties: PublicDoctorSpecialty[]): ListedDoctorSummary {
  return {
    id: doctor.id,
    fullName: doctor.fullName,
    languages: doctor.languages,
    qualification: doctor.qualification,
    registrationNumber: doctor.registrationNumber,
    yearsOfExperience: doctor.yearsOfExperience,
    consultationFeeInr: doctor.consultationFeeInr,
    consultationDurationMinutes: doctor.consultationDurationMinutes,
    specialties,
  };
}

export function toPublicDoctorProfile(doctor: DoctorRow, specialties: DoctorSpecialtyWithDetails[]): PublicDoctorProfile {
  return {
    id: doctor.id,
    fullName: doctor.fullName,
    bio: doctor.bio,
    languages: doctor.languages,
    qualification: doctor.qualification,
    registrationNumber: doctor.registrationNumber,
    yearsOfExperience: doctor.yearsOfExperience,
    consultationFeeInr: doctor.consultationFeeInr,
    consultationDurationMinutes: doctor.consultationDurationMinutes,
    specialties: toPublicDoctorSpecialties(specialties),
  };
}
