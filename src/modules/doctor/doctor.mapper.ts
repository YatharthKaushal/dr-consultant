import type { DoctorDocumentRow } from '../../schema/doctor-documents.schema';
import type { DoctorRow } from '../../schema/doctors.schema';
import type { DoctorPresence } from '../../schema/enums.schema';
import { deriveDoctorStage, type DoctorOnboardingStage } from './doctor-stage';
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

/**
 * The ADMIN projection: `SafeDoctorRow` plus the two things an admin panel
 * needs that a generic client must not get.
 *
 * `stage` is derived (see `doctor-stage.ts`) — computed here rather than in
 * the client so the badge and the `?stage=` filter can never disagree.
 *
 * `presence` is added back deliberately. `toSafeDoctorRow` strips it because
 * M-13 owns that state and THIS module must not let anyone edit it — but
 * "must not edit" is not "must not read", and an admin list that shows
 * whether a doctor is online is exactly what `docs/ADMIN_FRONTEND.md` §6.1
 * asks for. The alternative was a per-row call to the instant-consults
 * presence endpoint, i.e. an N+1 to recover a column we already selected.
 */
export interface AdminDoctorListItem extends SafeDoctorRow {
  stage: DoctorOnboardingStage;
  presence: DoctorPresence;
  /**
   * Included on the LIST as well as the detail. The admin list offers a
   * specialty filter, and a filter on a column you can't see is a guess —
   * so the service batch-loads these for the page rather than leaving the
   * client to N+1 the detail route per row.
   */
  specialties: PublicDoctorSpecialty[];
}

export function toAdminDoctorListItem(
  row: DoctorRow,
  specialties: PublicDoctorSpecialty[],
): AdminDoctorListItem {
  return {
    ...toSafeDoctorRow(row),
    stage: deriveDoctorStage(row),
    presence: row.presence,
    specialties,
  };
}

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
    // Overwritten by `doctor.service.ts#getPublicProfile`, which alone
    // knows `deletedAt` and applies masking — this mapper stays a pure,
    // unmasked projection, same discipline `PatientFacade.getProfileSummary`
    // keeps its own repository read separate from its masking decision.
    isDeleted: false,
  };
}
