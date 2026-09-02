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

  /**
   * ADDITIVE (M-07/availability, forced by M-09): the batch form of
   * `getSchedulingParameters`. Identical semantics, no new rules — it exists
   * because `AvailabilityContract.getEarliestBookableSlots` has to resolve
   * duration/buffer/eligibility for a whole ranked candidate set, and doing
   * that one doctor at a time is the N+1 that method was added to remove.
   * Doctors that do not exist are simply absent from the result.
   */
  getSchedulingParametersForMany(doctorIds: readonly string[]): Promise<DoctorSchedulingParametersById[]>;

  /**
   * ADDITIVE (M-09/search): THE MULTI-DOCTOR READ. Nothing before M-09 ever
   * needed more than one doctor at a time, so no such method existed
   * anywhere; ranking a search result set is the first use case that does.
   *
   * Always filtered to `verificationStatus = 'verified' AND isListed` — the
   * same gate `isVerifiedAndListed` reports, applied in SQL against the
   * composite index `doctors` already carries for it. There is deliberately
   * no "include unlisted" option: this is the patient-facing listing read,
   * and an admin listing that needs unverified doctors already has
   * `admin/doctors`.
   *
   * `specialtyIds`/`languages`/`maxFeeInr` are FR-4.4's filters, applied in
   * SQL so paging is honest — filtering after `limit` would return short
   * pages. Availability (FR-4.4's third filter) is NOT here: it is
   * M-07-owned and cannot be expressed against these tables, so M-09
   * applies it from `getEarliestBookableSlots` after this call.
   */
  listListedDoctors(filter: ListedDoctorFilter): Promise<ListedDoctorSummary[]>;
}

/** See `DoctorContract#getSchedulingParameters`. */
export interface DoctorSchedulingParameters {
  consultationDurationMinutes: number;
  bufferMinutes: number;
  isVerifiedAndListed: boolean;
}

/** See `DoctorContract#getSchedulingParametersForMany`. */
export interface DoctorSchedulingParametersById extends DoctorSchedulingParameters {
  doctorId: string;
}

/** See `DoctorContract#listListedDoctors`. */
export interface ListedDoctorFilter {
  /** Match doctors holding ANY of these specialties (primary or secondary). Omitted/empty means no specialty filter. */
  specialtyIds?: readonly string[];
  /** Match doctors speaking ANY of these languages, compared case-insensitively against the `languages` jsonb array. */
  languages?: readonly string[];
  /** Inclusive ceiling on `consultationFeeInr`, as a decimal string — the column is `numeric`, and a float would round a fee. */
  maxFeeInr?: string;
  limit: number;
  offset: number;
}

/**
 * The LISTING projection — `PublicDoctorProfile` minus `bio`.
 *
 * Why not just reuse `PublicDoctorProfile`? Ranking needs strictly less than
 * it does (fee, languages, and which specialties are primary), while the
 * result CARD needs almost all of it: FR-4.2 puts qualification,
 * registration number, experience, languages, fee and live availability in a
 * listing. So the right projection is very nearly `PublicDoctorProfile` — but
 * not it. `bio` is free text with no length bound, it belongs to FR-4.3's
 * profile screen ("the doctor profile shows the same details IN FULL"), and
 * carrying it multiplies a sixty-row candidate payload for a field no
 * listing renders and no ranking signal reads. Dropping exactly that one
 * field keeps the projection honest about the listing/profile split instead
 * of letting the listing quietly become the profile.
 */
export interface ListedDoctorSummary {
  id: string;
  fullName: string;
  languages: string[];
  qualification: string | null;
  registrationNumber: string | null;
  yearsOfExperience: number | null;
  consultationFeeInr: string;
  consultationDurationMinutes: number;
  specialties: PublicDoctorSpecialty[];
}
