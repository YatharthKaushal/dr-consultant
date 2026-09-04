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

  /**
   * ADDITIVE (M-21/data rights execution). The `patients` half of a
   * data-deletion request's execution — see `patient.service.ts
   * #anonymizeForDeletion` for the full account of what it does and why
   * `patients` is anonymized rather than deleted (every retained
   * clinical/financial table's `patient_id` FK must keep resolving).
   *
   * Idempotent and safe to retry after a partial failure elsewhere in the
   * execution sequence: a patient already `status = 'deleted'` is a no-op,
   * returning `{ anonymized: false }` rather than re-writing already-null
   * columns and a placeholder mobile number that would already be correct.
   *
   * `actorAdminId` is who to attribute the resulting audit trail to — the
   * admin who executed the deletion, never the patient (who cannot act on
   * their own account through this path).
   */
  anonymizeForDeletion(patientId: string, actorAdminId: string): Promise<{ anonymized: boolean }>;
}
