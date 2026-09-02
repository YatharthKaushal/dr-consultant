export interface PatientProfileSummary {
  id: string;
  fullName: string | null;
  dateOfBirth: string | null;
  gender: string;
  preferredLanguage: string;
}

/**
 * Patient's public surface — every other module talks to patient through
 * this, never through its tables directly (`backend/README.md` §2).
 *   - getProfileSummary: M-09 (personalization), M-11 (booking display) and
 *     M-15 (clinical doctor-view) each need a lightweight read of a
 *     patient's own profile fields, not the full moderation-facing row.
 */
export interface PatientContract {
  getProfileSummary(patientId: string): Promise<PatientProfileSummary | null>;
}
