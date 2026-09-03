import { DOCTOR_DOCUMENT_TYPES, type DoctorDocumentType } from '../../schema/enums.schema';

/** `audit_log.entity_type` values this module writes. */
export const DOCTOR_AUDIT_ENTITY_TYPES = {
  DOCTOR: 'doctor',
  DOCTOR_SPECIALTY: 'doctor_specialty',
  DOCTOR_DOCUMENT: 'doctor_document',
  /**
   * ADDITIVE (M-13/presence). A `doctors.presence` transition. `entity_id` is
   * the doctor id; the before/after states are in `metadata`.
   *
   * Split from `DOCTOR` deliberately: presence changes several times an hour
   * per live doctor, and mixing them into the `doctor` entity stream would
   * bury the profile/verification/fee history an auditor actually opens that
   * stream to read.
   */
  DOCTOR_PRESENCE: 'doctor_presence',
  /**
   * ADDITIVE (M-13/presence). *** THE COMPLETION GATE *** —
   * `doctors.blocked_by_consultation_id` being set or cleared (FR-10.5).
   * `entity_id` is the doctor id and `consultation_id` names the gating
   * consultation, so "why could this doctor take no instant request between
   * 14:05 and 14:40" is one query.
   */
  DOCTOR_COMPLETION_GATE: 'doctor_completion_gate',
} as const;

export const DOCTOR_ERROR_CODES = {
  DOCTOR_NOT_FOUND: 'DOCTOR_NOT_FOUND',
  MOBILE_NUMBER_TAKEN: 'MOBILE_NUMBER_TAKEN',
  REGISTRATION_NUMBER_TAKEN: 'REGISTRATION_NUMBER_TAKEN',
  SPECIALTY_NOT_FOUND: 'SPECIALTY_NOT_FOUND',
  DOCTOR_SPECIALTY_NOT_FOUND: 'DOCTOR_SPECIALTY_NOT_FOUND',
  DOCUMENT_NOT_FOUND: 'DOCUMENT_NOT_FOUND',
  /** Structural enforcement of "an unapproved doctor cannot use the doctor experience" (MODULES.md M-05 done-when bar). */
  CANNOT_LIST_UNVERIFIED_DOCTOR: 'CANNOT_LIST_UNVERIFIED_DOCTOR',
  REJECTION_REASON_REQUIRED: 'REJECTION_REASON_REQUIRED',
  /** `documentType` multipart field missing, or not one of `DOCTOR_DOCUMENT_TYPES`. */
  INVALID_DOCUMENT_TYPE: 'DOCTOR_INVALID_DOCUMENT_TYPE',
  /** Uploaded file's MIME type is not on `DOCTOR_DOCUMENT_MIME_ALLOWLIST` for the given `documentType`. */
  INVALID_FILE_TYPE: 'DOCTOR_INVALID_FILE_TYPE',
  /**
   * `StorageFacade.store()` threw for any reason — never surfaced to a
   * client with its original code/message. Mirrors `modules/document`'s own
   * `DOCUMENT_ERROR_CODES.STORAGE_UNAVAILABLE` precisely (see
   * `patient-file.service.ts#wrapStorageError`): `doctor_documents` consumes
   * `modules/storage` the same way `modules/document` does, so it wraps
   * storage failures the same way too.
   */
  DOCUMENT_UPLOAD_FAILED: 'DOCTOR_DOCUMENT_UPLOAD_FAILED',
} as const;
export type DoctorErrorCode = (typeof DOCTOR_ERROR_CODES)[keyof typeof DOCTOR_ERROR_CODES];

/**
 * Storage namespace for every `doctor_documents` upload — passed as
 * `StoreFileInput.category` (`storage.contract.ts`), which is "purely
 * organisational" key-prefixing only. Matches the illustrative example
 * `storage.contract.ts`'s own header comment and
 * `storage-rotation.service.spec.ts`'s default fixture already use for this
 * exact consumer, rather than splitting by `documentType` the way
 * `modules/document` splits patient uploads by `PatientFileCategory` — a
 * doctor's eight credential-document types are all the same trust tier (the
 * doctor's own verification paperwork), so one flat namespace is the
 * simpler, equally-correct choice.
 */
export const DOCTOR_DOCUMENT_STORAGE_CATEGORY = 'doctor-documents';

/**
 * Per-`documentType` MIME allowlist — the doctor-module analog of
 * `document.constants.ts`'s `DOCUMENT_MIME_ALLOWLIST`, and, like that one, a
 * CODE-LEVEL SECURITY BASELINE rather than admin-configurable: loosening it
 * is a reviewed code change, not a runtime setting.
 *
 * `profile_photo`/`signature` are IMAGE ONLY — a JPEG/PNG/WEBP scan/photo,
 * never a PDF — matching the task brief precisely. Everything else
 * (certificates, proofs, letters, and the `other` catch-all) accepts a PDF
 * or an image, mirroring `modules/document`'s own `IMAGE_AND_PDF_MIME_TYPES`
 * treatment of scanned paperwork.
 */
const DOCTOR_IMAGE_AND_PDF_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'] as const;
const DOCTOR_IMAGE_ONLY_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

export const DOCTOR_DOCUMENT_MIME_ALLOWLIST: Record<DoctorDocumentType, readonly string[]> = {
  degree_certificate: DOCTOR_IMAGE_AND_PDF_MIME_TYPES,
  registration_certificate: DOCTOR_IMAGE_AND_PDF_MIME_TYPES,
  identity_proof: DOCTOR_IMAGE_AND_PDF_MIME_TYPES,
  address_proof: DOCTOR_IMAGE_AND_PDF_MIME_TYPES,
  experience_letter: DOCTOR_IMAGE_AND_PDF_MIME_TYPES,
  profile_photo: DOCTOR_IMAGE_ONLY_MIME_TYPES,
  signature: DOCTOR_IMAGE_ONLY_MIME_TYPES,
  other: DOCTOR_IMAGE_AND_PDF_MIME_TYPES,
};
