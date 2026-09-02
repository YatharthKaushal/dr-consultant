import type { DoctorDocumentRow } from '../../schema/doctor-documents.schema';
import type { DoctorRow } from '../../schema/doctors.schema';
import type { DoctorSpecialtyWithDetails } from './doctor-specialty.repository';
import type { PublicDoctorProfile, PublicDoctorSpecialty } from './doctor.contract';

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
