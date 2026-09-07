export interface PatientProfileSummary {
  id: string;
  fullName: string | null;
  dateOfBirth: string | null;
  gender: string;
  preferredLanguage: string;
  /** ADDITIVE (account-deletion lifecycle round). `true` when this account is soft-deleted — see `mask.util.ts` and `getProfileSummary`'s own header for what a caller must do with a `true` read. */
  isDeleted: boolean;
}

/**
 * Who is executing a data-deletion request. `'admin'` — a human decided,
 * `actorId` names them. `'system'` — the grace-period sweep executed it;
 * `actorId` is `null`, honestly, not a data-entry gap. Structurally
 * identical to `consent`'s own `DeletionExecutionActor`
 * (`data-deletion.types.ts`) by design, not by import — see that file's
 * header for why this module does not import it directly.
 */
export interface DeletionActor {
  actorType: 'admin' | 'system';
  actorId: string | null;
}

/** See `PatientContract#softDeleteForDeletionRequest`. */
export interface PatientDeletionSnapshot {
  /** `false` when the account was already deleted (idempotent retry) or lost a race with a concurrent execution — nothing was written. */
  softDeleted: boolean;
  /** The whole row as it stood immediately before this write, jsonb-safe. `null` when `softDeleted` is `false`. */
  snapshot: Record<string, unknown> | null;
  /** The real mobile number this account had before it was vacated. `null` when `softDeleted` is `false`. */
  originalMobileNumber: string | null;
}

/**
 * Patient's public surface — every other module talks to patient through
 * this, never through its tables directly (`backend/README.md` §2).
 *   - getProfileSummary: M-09 (personalization), M-11 (booking display) and
 *     M-15 (clinical doctor-view) each need a lightweight read of a
 *     patient's own profile fields, not the full moderation-facing row.
 */
export interface PatientContract {
  /**
   * *** MASKED WHEN `isDeleted` IS `true`. *** `fullName`/`dateOfBirth` come
   * back initials-and-endings-masked (`shared/privacy/mask.util.ts`) rather
   * than the real values — a doctor's case history, a booking display, or
   * any other caller reading a soft-deleted patient's summary must never
   * show the real name to someone who isn't that patient or an admin. A
   * caller needing the UNMASKED value for a legitimate admin purpose reads
   * `patient-admin.controller.ts` instead, which is authenticated and
   * permission-gated for exactly that.
   */
  getProfileSummary(patientId: string): Promise<PatientProfileSummary | null>;

  /**
   * ADDITIVE (account-deletion lifecycle round — replaces the earlier
   * `anonymizeForDeletion`). See `patient.service.ts
   * #softDeleteForDeletionRequest` for the full account of what it does,
   * why `patients` is SOFT-deleted (identity fields kept, not nulled) and
   * why that is different from the earlier design.
   *
   * Idempotent and safe to retry after a partial failure elsewhere in the
   * execution sequence: a patient already `deleted_at IS NOT NULL` is a
   * no-op, returning `{ softDeleted: false, snapshot: null,
   * originalMobileNumber: null }`.
   *
   * `actor` is who to attribute the resulting audit trail to — an admin, or
   * `system` for the grace-period sweep. Never the patient, who cannot act
   * on their own account through THIS path (they act through
   * `cancelRequest`, before execution).
   */
  softDeleteForDeletionRequest(patientId: string, actor: DeletionActor): Promise<PatientDeletionSnapshot>;

  /**
   * ADDITIVE (account-deletion lifecycle round). The un-do. Only the
   * `patients`-owned half — `data-rights`'s `DeletedAccountsService`
   * orchestrates the full restore (mobile number first, via
   * `IdentityFacade.restoreMobileNumber`, THEN this call), so a
   * unique-constraint failure on the mobile write never leaves this method
   * having already flipped `status` back to `active`.
   */
  restoreFromDeletion(patientId: string): Promise<{ restored: boolean }>;
}
