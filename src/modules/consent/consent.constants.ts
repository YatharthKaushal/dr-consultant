/**
 * M-03's error vocabulary and its `audit_log.entity_type` values.
 *
 * Structure copied from `catalogue.constants.ts` — a small, admin-configured
 * module keeps its codes in one place so the service, the tests and the client
 * all name a refusal the same way.
 */

/** `audit_log.entity_type` values this module writes. */
export const CONSENT_AUDIT_ENTITY_TYPES = {
  LEGAL_DOCUMENT: 'legal_document',
  CONSENT: 'consent',
} as const;

export const CONSENT_ERROR_CODES = {
  LEGAL_DOCUMENT_NOT_FOUND: 'LEGAL_DOCUMENT_NOT_FOUND',
  /** `legal_documents_document_type_version_index` — a new version is a NEW ROW, and a version string is used once per type, forever. */
  LEGAL_DOCUMENT_VERSION_TAKEN: 'LEGAL_DOCUMENT_VERSION_TAKEN',
  /** No row for this `document_type` carries `is_current` — nothing is published, so there is nothing to read or to accept. */
  NO_CURRENT_LEGAL_DOCUMENT: 'NO_CURRENT_LEGAL_DOCUMENT',
  /**
   * Consent was offered against a version that is no longer current. Refused
   * rather than stored: SRS §6.2 requires consent before teleconsultation and a
   * superseded version is not that, so a row recording it would be legal
   * evidence of something nobody asked for. The client re-fetches the current
   * document and asks again.
   */
  SUPERSEDED_LEGAL_DOCUMENT: 'SUPERSEDED_LEGAL_DOCUMENT',
  /** A patient offered `doctor_agreement`, or a doctor offered anything else. */
  DOCUMENT_TYPE_NOT_ACCEPTABLE_BY_ACTOR: 'DOCUMENT_TYPE_NOT_ACCEPTABLE_BY_ACTOR',
  /** A patient asked to read `doctor_agreement` — the platform's contract with its doctors, not patient-facing legal text. */
  DOCUMENT_TYPE_NOT_READABLE_BY_ACTOR: 'DOCUMENT_TYPE_NOT_READABLE_BY_ACTOR',
  /** A `document_type` path segment that is not a `legal_document_type` value. */
  UNKNOWN_DOCUMENT_TYPE: 'UNKNOWN_DOCUMENT_TYPE',
} as const;
export type ConsentErrorCode = (typeof CONSENT_ERROR_CODES)[keyof typeof CONSENT_ERROR_CODES];

/**
 * *** THE ADVISORY LOCK BEHIND "EXACTLY ONE CURRENT VERSION PER TYPE". ***
 *
 * `legal_documents` carries a PLAIN index on `(document_type, is_current)`, not
 * a partial unique one — the table is already migrated and this module owns no
 * migration. The invariant therefore spans rows (demote whoever is current,
 * promote this one) with no single row that represents "the current privacy
 * policy", so no unique constraint expresses it and no row lock serialises it.
 *
 * Two admins publishing two versions of the same type at the same instant would
 * otherwise both read "v1 is current", both demote v1 and both promote their
 * own row — leaving two current versions, and a pre-consult check whose answer
 * depends on which row `limit 1` happens to return.
 *
 * Same `pg_advisory_xact_lock(hashtext(...))` pattern, and the same stated
 * reasoning ("the invariant spans rows, so no unique index can express it"), as
 * `referral.repository.ts#lockReferrerGuard` and
 * `availability-rule.service.ts#lockDateGuard`.
 */
export const LEGAL_DOCUMENT_CURRENT_LOCK_PREFIX = 'consent.legal_document_current';
