/** `audit_log.entity_type` values this module writes. */
export const DOCUMENT_AUDIT_ENTITY_TYPES = {
  PATIENT_FILE: 'patient_file',
  REPORT_REQUEST: 'report_request',
} as const;

export const DOCUMENT_ERROR_CODES = {
  /** `prescription_pdf`/`clarification_attachment`, or anything else outside `PATIENT_UPLOADABLE_CATEGORIES`, on the patient upload path. */
  CATEGORY_NOT_UPLOADABLE: 'DOCUMENT_CATEGORY_NOT_UPLOADABLE',
  /** MIME type not on `DOCUMENT_MIME_ALLOWLIST` for the given category. */
  INVALID_FILE_TYPE: 'DOCUMENT_INVALID_FILE_TYPE',
  /** Over `documents.max_file_size_mb` (business cap) or the transport hard ceiling. */
  FILE_TOO_LARGE: 'DOCUMENT_FILE_TOO_LARGE',
  /** A supplied `consultationId` does not exist, or exists but is not the caller's — collapsed into one code/404 so neither case leaks which is true. */
  CONSULTATION_NOT_FOUND: 'DOCUMENT_CONSULTATION_NOT_FOUND',
  /** Both `consultationId` and `reportRequestId` were given and disagree about which consultation the upload belongs to. */
  CONSULTATION_MISMATCH: 'DOCUMENT_CONSULTATION_MISMATCH',
  /** A supplied `reportRequestId` does not exist, or exists but is not reachable from the caller's own consultations. */
  REPORT_REQUEST_NOT_FOUND: 'DOCUMENT_REPORT_REQUEST_NOT_FOUND',
  /** Uploading against, or cancelling, a report request that is not `status: 'open'`. */
  REPORT_REQUEST_NOT_OPEN: 'DOCUMENT_REPORT_REQUEST_NOT_OPEN',
  /** A file id that does not exist, is already soft-deleted, or is not visible/owned by the caller — one code for all three so a non-owner cannot distinguish them. */
  FILE_NOT_FOUND: 'DOCUMENT_FILE_NOT_FOUND',
  /** Patient delete attempted on a file attached to a `completed` consultation. */
  DELETE_BLOCKED_COMPLETED: 'DOCUMENT_DELETE_BLOCKED_COMPLETED',
  /** The `DocumentStoragePort` threw for any reason — never surfaced to a client with its original code/message. See `document-storage.contract.ts`. */
  STORAGE_UNAVAILABLE: 'DOCUMENT_STORAGE_UNAVAILABLE',
} as const;
export type DocumentErrorCode = (typeof DOCUMENT_ERROR_CODES)[keyof typeof DOCUMENT_ERROR_CODES];

/**
 * The three categories `POST /documents` accepts from a patient directly.
 * Deliberately a SUBSET of `PATIENT_FILE_CATEGORIES` (`schema/enums.schema.ts`):
 * `prescription_pdf` is system/doctor-generated (a future M-15 writes it
 * through this module's facade, not HTTP — see `document.contract.ts`), and
 * `clarification_attachment` is a de-identified copy nothing produces yet
 * (M-17, explicitly out of scope for this pass — see `report-request.
 * service.ts`'s header comment). Both are rejected by name, not just
 * "whatever isn't in this list", so the 400 a patient sees explains why.
 */
export const PATIENT_UPLOADABLE_CATEGORIES = ['medical_history', 'report', 'photo'] as const;
export type PatientUploadableCategory = (typeof PATIENT_UPLOADABLE_CATEGORIES)[number];

/**
 * Per-category MIME allowlist. A CODE-LEVEL SECURITY BASELINE, not
 * admin-configurable in this pass — unlike `DOCUMENT_CONFIG_KEYS` below,
 * there is no `app_config` row backing this; loosening it is a code change
 * with a review, which is the correct amount of friction for what is
 * ultimately a content-sniffing/attack-surface decision, not a business
 * policy one. All three uploadable categories share the same allowlist
 * today (photos and scanned reports are realistically the same file types);
 * split per-category if that ever stops being true.
 *
 * `image/heic` AND `image/heif` are both listed for the one real-world HEIC
 * quirk worth handling: iOS reports a HEIC photo's `Content-Type` as either
 * depending on the OS version and upload path.
 */
const IMAGE_AND_PDF_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/pdf',
] as const;

export const DOCUMENT_MIME_ALLOWLIST: Record<PatientUploadableCategory, readonly string[]> = {
  medical_history: IMAGE_AND_PDF_MIME_TYPES,
  report: IMAGE_AND_PDF_MIME_TYPES,
  photo: IMAGE_AND_PDF_MIME_TYPES,
};

/**
 * `app_config` key this module owns (`docs/MODULES.md` §7 — configuration
 * lives with its owning module), read via `AppConfigService.getNumber(key,
 * fallback)`, same pattern as `AVAILABILITY_CONFIG_FALLBACKS`. This is the
 * BUSINESS-RULE cap a patient actually hits; it sits below
 * `DOCUMENT_UPLOAD_HARD_CEILING_BYTES` so an admin can raise it later
 * without a redeploy, up to that hard ceiling.
 */
export const DOCUMENT_CONFIG_KEYS = {
  MAX_FILE_SIZE_MB: 'documents.max_file_size_mb',
} as const;

/** Compiled-in fallback for the key above, used when the `app_config` row is missing or malformed (`AppConfigService`'s own contract). SRS is silent on an exact number — this is a stated assumption, not a spec value. */
export const DOCUMENT_CONFIG_FALLBACKS = {
  MAX_FILE_SIZE_MB: 15,
} as const;

/**
 * The transport-level HARD ceiling — registered as `@fastify/multipart`'s
 * `limits.fileSize` in `main.ts`, not admin-configurable, and always ABOVE
 * the business-rule cap above (a request over this never reaches this
 * module's own size check at all; busboy aborts it first).
 *
 * `modules/storage` (a parallel worktree, S3/Cloudinary primitive) is
 * expected to enforce its own hard ceiling too. This value MUST STAY <=
 * that module's own `STORAGE_HARD_SIZE_CEILING_BYTES` — reconcile the two at
 * merge if they differ; there is no way to read the other worktree's actual
 * exported constant from here today.
 */
export const DOCUMENT_UPLOAD_HARD_CEILING_BYTES = 25 * 1024 * 1024;

/**
 * How long a minted download URL is asked to stay valid for. Reported back
 * to the client as `expiresAt` alongside the URL itself — an ESTIMATE of
 * what was requested from the storage port, not a guarantee the port
 * honoured exactly (the real expiry is whatever the signed URL itself
 * encodes, which this module never parses back out).
 */
export const DOCUMENT_DOWNLOAD_URL_TTL_SECONDS = 300;

/**
 * DI token for the `DocumentStoragePort` implementation, bound in
 * `document.module.ts` — mirrors `search.constants.ts`'s `SEARCH_AI_PORT`.
 * See `document-storage.contract.ts` for the full seam story and the
 * post-merge rebinding instructions.
 */
export const DOCUMENT_STORAGE_PORT = Symbol('DOCUMENT_STORAGE_PORT');

/**
 * DI token for the `ConsultationLookupPort` implementation, bound in
 * `document.module.ts` — mirrors `availability.constants.ts`'s
 * `BUSY_INTERVAL_PROVIDER`. Currently bound to `ConsultationLookupProvider`
 * (a placeholder reading `consultations` directly, since M-11/Booking
 * doesn't exist yet); swapped for a `BookingFacade`-backed implementation
 * once it does, with no change to either service in this module. See
 * `consultation-lookup.provider.ts`.
 */
export const CONSULTATION_LOOKUP_PROVIDER = Symbol('CONSULTATION_LOOKUP_PROVIDER');
