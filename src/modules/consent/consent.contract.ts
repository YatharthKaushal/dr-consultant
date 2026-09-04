import type { LegalDocumentType } from '../../schema/enums.schema';

/**
 * M-03's public surface. Every other module reaches consent through
 * `ConsentFacade`, never through `consents`/`legal_documents` directly
 * (`backend/README.md` §2).
 *
 * *** THIS SHAPE IS FROZEN. *** M-14 (video) declares a LOCAL MIRROR of it and
 * binds `ConsentFacade` to its own `CONSENT_PORT` with a refusing null object
 * as the fallback. It cannot see this file, so `ConsentFacade` satisfies that
 * mirror STRUCTURALLY — renaming a field, widening a return type or adding a
 * required argument breaks a module that never imported this one, at its
 * binding rather than here.
 */

export interface ConsentCheck {
  /** True ONLY when this patient has accepted the CURRENT version. */
  hasCurrentConsent: boolean;
  /**
   * The version they did accept, or null. Distinguishes "never consented" from
   * "consented to an older version" — the two need different copy in the app
   * ("please review the updated consent" vs "please consent").
   */
  acceptedVersion: string | null;
  acceptedAt: Date | null;
  /** The version they would need to accept. Null when no current document is published for this type. */
  currentVersion: string | null;
}

export interface ConsentContract {
  /**
   * *** NEVER THROWS, AND FAILS CLOSED. *** Any failure — no current document,
   * database unreachable, anything — answers `hasCurrentConsent: false`. This
   * gates entry to a medical consultation: refusing a join that should have
   * been allowed is a support ticket, allowing one that should have been
   * refused is a compliance breach.
   *
   * `hasCurrentConsent` is true only against the CURRENT version. A patient who
   * accepted v1 while v2 is published has NOT consented — SRS §6.2 requires
   * consent before teleconsultation, and a superseded version is not that.
   */
  checkPatientConsent(input: { patientId: string; documentType: LegalDocumentType }): Promise<ConsentCheck>;
}
