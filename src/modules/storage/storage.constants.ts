/**
 * Every blob-storage backend this build can actually talk to. The single
 * runtime source of truth: `storage_providers.provider` is validated against
 * it in `storage.seed.ts` (the only writer), and `StorageProviderRegistry` is
 * typed `Record<StorageProviderCode, StorageProviderAdapter>` so TypeScript
 * refuses to compile a build that adds a code here without also registering
 * an adapter for it — same trick `LlmProviderRegistry` uses for `ProviderCode`.
 *
 * Adding a third backend (Azure Blob, GCS, Cloudflare R2 are the plausible
 * ones) is: one entry here, one adapter class implementing
 * `StorageProviderAdapter`, one line in `StorageProviderRegistry`, one row in
 * `storage.seed.ts`. No migration — see `storage-providers.schema.ts`'s
 * comment on why `provider` is a bare `varchar`.
 */
export const STORAGE_PROVIDER_CODES = ['s3', 'cloudinary'] as const;
export type StorageProviderCode = (typeof STORAGE_PROVIDER_CODES)[number];

/**
 * The normalised failure taxonomy `S3Classifier`/`CloudinaryClassifier` map
 * their vendor's error shape onto. Deliberately smaller than `LlmFailureKind`
 * — this module has two adapters, not four, and a blob store's failure modes
 * are genuinely narrower than an LLM vendor's (no `context_length`, no
 * `content_filtered`; a PUT/GET/DELETE either reaches the object or it does
 * not). `storage-rotation.service.ts`'s policy table is written against these
 * alone; it never sees a vendor error.
 *
 *   - `network_or_timeout` — no answer in time, or the connection never
 *     completed (DNS, TLS, reset, 5xx). Says nothing about this provider's
 *     credentials or config. One retry on the SAME provider, then rotate —
 *     no cooldown, so a blip does not sideline a healthy provider.
 *   - `invalid_credentials` — the access key/secret (S3) or API key/secret
 *     (Cloudinary) is wrong. Will not fix itself; rotate immediately, cool
 *     down.
 *   - `access_denied`       — the credentials are valid but lack permission
 *     (wrong IAM policy, wrong Cloudinary API key scope). Same handling as
 *     `invalid_credentials` — both need a human to fix the deployment.
 *   - `not_found`           — the configured bucket/cloud name itself does not
 *     exist (a `config` typo), or the specific object does not exist. Same
 *     rotate-and-cooldown handling: distinguishing "bucket missing" from
 *     "object missing" does not change what rotation should DO with it.
 *   - `unknown`             — unrecognised. Never assumed benign: rotates and
 *     cools down, exactly like `ai.constants.ts`'s `LlmFailureKind.unknown`.
 */
export const STORAGE_FAILURE_KINDS = [
  'network_or_timeout',
  'invalid_credentials',
  'access_denied',
  'not_found',
  'unknown',
] as const;
export type StorageFailureKind = (typeof STORAGE_FAILURE_KINDS)[number];

/** `audit_log.entity_type` value this module writes. */
export const STORAGE_AUDIT_ENTITY_TYPES = {
  STORAGE_PROVIDER: 'storage_provider',
} as const;

export const STORAGE_ERROR_CODES = {
  /**
   * 503. `store()` tried every usable provider (or found none configured/
   * active/out of cooldown) and all failed. Same reasoning as AI's
   * `AI_UNAVAILABLE`: nothing is broken in OUR service, a third party is
   * unusable right now, and the condition is expected to clear on its own.
   */
  STORAGE_UNAVAILABLE: 'STORAGE_UNAVAILABLE',
  /**
   * 400. `store()`'s hard, non-admin-configurable safety ceiling
   * (`STORAGE_MAX_FILE_SIZE_BYTES`) was exceeded. Defence in depth only — the
   * real enforcement point is the calling module's own `@fastify/multipart`
   * limits, upstream of this module entirely.
   */
  STORAGE_FILE_TOO_LARGE: 'STORAGE_FILE_TOO_LARGE',
  /**
   * 503. `getSignedUrl`/`delete` resolved a key to a provider that is
   * currently inactive, missing its environment credentials, or cooling down.
   * Distinct from `STORAGE_UNAVAILABLE` on purpose: these two operations
   * target one SPECIFIC existing object whose provider is fixed by the key's
   * prefix, so there is genuinely no fallback to rotate to — see the comment
   * on `storage-rotation.service.ts#getSignedUrl`.
   */
  STORAGE_PROVIDER_UNAVAILABLE_FOR_KEY: 'STORAGE_PROVIDER_UNAVAILABLE_FOR_KEY',
  /**
   * 400. A `storageKey` given to `getSignedUrl`/`delete` does not parse —
   * missing/unknown provider prefix, or a malformed path. See
   * `storage-key.util.ts`.
   */
  STORAGE_KEY_INVALID: 'STORAGE_KEY_INVALID',
  /**
   * 502. The provider was usable (active, configured, not cooling down) but
   * the specific `getSignedUrl`/`delete` call still failed — e.g. the object
   * does not exist, or a genuine mid-call transient error. Distinct from
   * `STORAGE_PROVIDER_UNAVAILABLE_FOR_KEY`: that one means we never even
   * attempted the call; this one means we did, and the third party said no.
   */
  STORAGE_OPERATION_FAILED: 'STORAGE_OPERATION_FAILED',
  /** 404. No `storage_providers` row with that id — the admin endpoints. */
  STORAGE_PROVIDER_NOT_FOUND: 'STORAGE_PROVIDER_NOT_FOUND',
  /**
   * 400. `PATCH /admin/storage/providers/:id`'s `config` carried a key that
   * does not belong to the target row's provider (e.g. `cloudName` on the
   * `s3` row). `provider` is immutable (no POST/DELETE — see
   * `storage-providers.schema.ts`), so the shape `config` must take is known
   * from the row alone; this is what enforces it rather than accepting
   * arbitrary jsonb.
   */
  STORAGE_PROVIDER_CONFIG_INVALID: 'STORAGE_PROVIDER_CONFIG_INVALID',
} as const;
export type StorageErrorCode = (typeof STORAGE_ERROR_CODES)[keyof typeof STORAGE_ERROR_CODES];

/**
 * Hard ceiling on what `store()` will accept, in bytes — Layer A's ONLY
 * validation. Not admin-configurable: this module is domain-agnostic and
 * must accept "any and every type" a consuming module hands it, but a truly
 * unbounded accept-anything is its own risk (memory pressure, a client
 * script gone wrong). The BUSINESS-RULE size cap that varies by what is being
 * uploaded (a patient file vs. a doctor credential document) belongs to the
 * calling domain module, not here — exported so a consuming module's own
 * `@fastify/multipart` limits can be set at or below it.
 */
export const STORAGE_MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024;

/** Default lifetime of a signed URL when the caller omits `expirySeconds`. Matches this codebase's general "short-lived" language for signed URLs elsewhere. */
export const STORAGE_DEFAULT_SIGNED_URL_EXPIRY_SECONDS = 300;

/**
 * Cooldown applied on an `invalid_credentials`/`access_denied`/`not_found`/
 * `unknown` failure — the "auth/config-shaped, will not fix itself on a
 * per-minute timescale" bucket. Not admin-configurable in this pass: with
 * only two possible providers and no per-provider dial anyone has asked for
 * yet, an `app_config` key would be one more row to explain for a value that
 * has never needed tuning. Revisit if a third provider or an operational
 * incident makes a tunable cooldown worth the cost.
 */
export const STORAGE_COOLDOWN_SECONDS = 300;

/** Base delay for the ONE same-provider retry a `network_or_timeout` failure earns, jittered in `storage-rotation.service.ts`. Mirrors `AI_TRANSIENT_RETRY_BASE_MS`. */
export const STORAGE_TRANSIENT_RETRY_BASE_MS = 250;

/** Upper bound on the jittered retry delay. Mirrors `AI_TRANSIENT_RETRY_MAX_MS`. */
export const STORAGE_TRANSIENT_RETRY_MAX_MS = 1_000;

/**
 * Defensive ceiling on how many providers one `store()` call will attempt.
 * Only ever 2 today (nothing in this module can create a third row — see
 * `storage-providers.schema.ts`), but bounding it costs nothing and means a
 * future build with more providers configured cannot turn one upload into an
 * unbounded chain of upstream attempts. Mirrors `AI_MAX_ATTEMPTS_PER_REQUEST`.
 */
export const STORAGE_MAX_ATTEMPTS_PER_REQUEST = 5;
