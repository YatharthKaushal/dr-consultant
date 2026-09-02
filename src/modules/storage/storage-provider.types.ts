import type { StorageProviderConfig } from '../../schema/storage-providers.schema';
import type { StoreFileInput } from './storage.contract';
import type { StorageFailureKind, StorageProviderCode } from './storage.constants';

/**
 * What `upload` returns to `storage-rotation.service.ts`. Not the same shape
 * as the public `StoredFileResult` by coincidence — it happens to match today
 * because there is nothing else to add yet — but keeping it a distinct type
 * means a future adapter-only field (e.g. a provider-native ETag) does not
 * have to become part of the public contract to exist.
 */
export interface StoredObjectResult {
  /** The FULL storage key, already including this provider's `<provider>:` prefix — see `storage-key.util.ts#buildStorageKey`. */
  storageKey: string;
  sizeBytes: number;
}

/**
 * One classified failure. This is the ONLY thing rotation ever sees of a
 * vendor error — the vendor's own error object never escapes its adapter's
 * classifier. Mirrors `LlmFailure` (`llm-provider.types.ts`).
 */
export interface StorageFailure {
  kind: StorageFailureKind;
  /** Short, human-readable vendor text, trimmed and whitespace-collapsed by `toDetail()` (`storage-error.util.ts`). For server-side logs only — unlike `agent_credentials`, nothing here is a secret an admin panel needs to redact before echoing back, but it is still not returned to any HTTP caller as-is. */
  detail: string;
}

/**
 * Normalises one provider's error shapes to one `StorageFailureKind`. A
 * separate object rather than a method on the adapter so it can be unit-
 * tested against realistic error fixtures without constructing a real SDK
 * client. Mirrors `ProviderErrorClassifier` (`llm-provider.types.ts`).
 *
 * `classify` must never throw and must never return `undefined`: an
 * unrecognised error shape is `unknown`, which rotation treats as
 * rotate-and-cool-down, never as benign.
 */
export interface StorageErrorClassifier {
  classify(error: unknown): StorageFailure;
}

/**
 * What every storage backend integration implements. Two exist (`s3`,
 * `cloudinary`) and `StorageProviderRegistry` maps `StorageProviderCode` ->
 * instance. Mirrors `LlmProviderAdapter` (`llm-provider.types.ts`).
 */
export interface StorageProviderAdapter {
  readonly provider: StorageProviderCode;
  /** This provider's error normaliser. Held by the adapter so rotation can classify a failure without knowing which provider produced it. */
  readonly classifier: StorageErrorClassifier;

  /**
   * True when this adapter's REQUIRED ENVIRONMENT credentials are present.
   * Synchronous and side-effect free — a capability check, not a live probe
   * (it does not confirm the credentials are actually valid, only that they
   * are configured). A provider `isActive: true` in the database but failing
   * this check is not usable; see `storage-rotation.service.ts`.
   */
  isConfigured(): boolean;

  /**
   * Uploads `input.buffer` and returns the full storage key plus the size
   * stored. `config` is the CURRENT `storage_providers.config` row for this
   * provider (bucket/region/endpoint, or cloudName) — read fresh on every
   * call by the caller, never cached here. See the class comment on
   * `storage-rotation.service.ts` for why.
   */
  upload(input: StoreFileInput, config: StorageProviderConfig): Promise<StoredObjectResult>;

  /**
   * `objectRef` is `parseStorageKey(key).rest` — everything after the
   * `<provider>:` prefix, i.e. this adapter's own addressing of the object
   * (for both providers here, `<category>/<objectId>`).
   */
  getSignedUrl(objectRef: string, expirySeconds: number, config: StorageProviderConfig): Promise<string>;

  delete(objectRef: string, config: StorageProviderConfig): Promise<void>;
}
