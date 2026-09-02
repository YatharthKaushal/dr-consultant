export interface PublicDoctorSpecialty {
  id: string;
  code: string;
  name: string;
  isPrimary: boolean;
}

/**
 * The listable-profile projection — deliberately narrow (no `bufferMinutes`,
 * no admin/audit fields, no identity- or presence-owned columns). Named
 * consumers: M-09 (search/ranking), M-11 (booking), M-14 (whatever else
 * needs a doctor's public card).
 */
export interface PublicDoctorProfile {
  id: string;
  fullName: string;
  bio: string | null;
  languages: string[];
  qualification: string | null;
  registrationNumber: string | null;
  yearsOfExperience: number | null;
  consultationFeeInr: string;
  consultationDurationMinutes: number;
  specialties: PublicDoctorSpecialty[];
}

/**
 * Doctor's public surface — every other module talks to doctor through this,
 * never through `doctors`/`doctor_specialties`/`doctor_documents` directly
 * (`backend/README.md` §2). Exactly the near-term real consumers named in
 * the M-05 build task, nothing more:
 *   - getPublicProfile: M-09 (search/ranking), M-11 (booking), M-14.
 *   - isVerifiedAndListed: M-07 (availability) / M-11 (booking) gates —
 *     "may this doctor be booked at all right now."
 *   - getPrescribingEligibility: see its own doc comment below.
 */
export interface DoctorContract {
  /**
   * Returns the doctor's public-shaped profile fields, or `null` if the
   * doctor id doesn't exist. Deliberately NOT gated on
   * `verificationStatus`/`isListed` here — that visibility decision is
   * `isVerifiedAndListed`'s job; a caller combines both as its own use case
   * requires (e.g. a booking already in progress may still need this after
   * the doctor's listing was toggled off).
   */
  getPublicProfile(doctorId: string): Promise<PublicDoctorProfile | null>;

  /** `true` only if the doctor exists, `verificationStatus === 'verified'` AND `isListed`. The booking-eligibility gate. */
  isVerifiedAndListed(doctorId: string): Promise<boolean>;

  /**
   * Derived from this doctor's PRIMARY specialty's `specialties.canPrescribe`
   * (`false` if the doctor has no primary specialty or does not exist).
   *
   * IMPORTANT: this is for contexts with NO per-consultation specialty
   * snapshot — e.g. gating a doctor's own personal
   * `doctor_clinical_templates` (M-15, FR-9.6), where there is no
   * consultation to snapshot from. It is explicitly NOT what gates
   * prescribing during an actual consultation — that already correctly
   * reads `consultations.specialtyId -> specialties.canPrescribe` (the
   * booking-time snapshot of which specialty the consultation was actually
   * held under). Do not "fix" that call site into calling this method
   * instead: a doctor's primary specialty can differ from, or change after,
   * the specialty a given past consultation was booked under.
   */
  getPrescribingEligibility(doctorId: string): Promise<boolean>;

  /**
   * ADDITIVE (M-07/availability): the doctor's slot-engine inputs —
   * `consultationDurationMinutes`/`bufferMinutes` (deliberately excluded
   * from `PublicDoctorProfile`, see its own doc comment) plus the same
   * booking-eligibility gate `isVerifiedAndListed` reports, in one read, so
   * `availability-slot.service.ts` doesn't need two round trips per slot
   * lookup. `null` only if the doctor id doesn't exist.
   */
  getSchedulingParameters(doctorId: string): Promise<DoctorSchedulingParameters | null>;
}

/** See `DoctorContract#getSchedulingParameters`. */
export interface DoctorSchedulingParameters {
  consultationDurationMinutes: number;
  bufferMinutes: number;
  isVerifiedAndListed: boolean;
}
