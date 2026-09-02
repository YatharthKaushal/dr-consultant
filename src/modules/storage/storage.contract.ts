/**
 * One file to store. Domain-agnostic on purpose — `modules/storage` knows
 * nothing about patients, doctors or consultations (`backend/README.md` §2;
 * see this module's own design notes). `category` is the only hint of what a
 * file is FOR, and it is purely organisational.
 */
export interface StoreFileInput {
  buffer: Buffer;
  fileName: string;
  contentType: string;
  /** Logical namespace for key prefixing only, e.g. 'patient-files', 'doctor-documents' — never exposed to any client, purely organizational within the key path. */
  category: string;
}

export interface StoredFileResult {
  storageKey: string;
  sizeBytes: number;
}

/**
 * The blob-storage gateway's public surface — every other module talks to it
 * through this, never through `storage_providers`, an adapter, or the
 * rotation service directly (`backend/README.md` §2). Provider-agnostic: a
 * caller stores a buffer and gets a key back, and later resolves that key to
 * a signed URL or deletes it, without ever knowing or choosing which backend
 * served it.
 *
 * `modules/storage` is a pure, domain-agnostic "store bytes, get a signed
 * URL, delete" primitive. It knows nothing about patients, doctors,
 * consultations or ownership — `modules/document` (patient files, report
 * requests) and `modules/doctor` (credential documents) each layer their own,
 * DIFFERENT ownership and business rules on top of this contract. That
 * boundary is deliberate, not an oversight: see `content_items.
 * cover_storage_key`'s own schema comment, which is content media going
 * through this same storage layer with NO patient owner at all — proof that
 * ownership cannot live here, because different consumers have different
 * (sometimes nonexistent) ownership rules.
 */
export interface StorageContract {
  /** Tries active, usable providers in priority order; returns as soon as any succeeds. Throws with code STORAGE_UNAVAILABLE only once every usable provider has failed or none are configured/active. */
  store(input: StoreFileInput): Promise<StoredFileResult>;
  /** Provider is resolved from the key prefix — no separate parameter. */
  getSignedUrl(storageKey: string, expirySeconds?: number): Promise<string>;
  delete(storageKey: string): Promise<void>;
  /** Cheap probe — true if at least one provider is currently usable (active + has env credentials + not in cooldown). Never throws. */
  isAvailable(): Promise<boolean>;
}
