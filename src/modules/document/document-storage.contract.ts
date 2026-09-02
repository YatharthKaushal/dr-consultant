/**
 * *** THE M-10 -> STORAGE-MODULE SEAM. READ BEFORE TOUCHING. ***
 *
 * `modules/storage` (a domain-agnostic "store bytes, get a signed URL,
 * delete" primitive over S3 primary / Cloudinary secondary-failover) is
 * being built in a parallel worktree and does not exist in this one, so a
 * direct `import from '../storage/storage.contract'` would not compile.
 * This file declares the interface LOCALLY and binds it to the
 * `DOCUMENT_STORAGE_PORT` DI token (`document.constants.ts`) — the same
 * pattern `search-ai.contract.ts` uses for `SearchAiPort`/`SEARCH_AI_PORT`
 * (itself modelled on `availability.contract.ts`'s `BusyIntervalProvider`).
 *
 * The four types below are a VERBATIM mirror of `modules/storage`'s own
 * fixed shape — this exact shape was handed to both worktrees and is
 * non-negotiable, precisely so it lines up without an adapter. Because
 * TypeScript is structural, the real `StorageFacade` will satisfy
 * `DocumentStoragePort` with no adapter and no cast — the coordinator binds
 * it at the token and this file can then be deleted or kept as
 * documentation. Do NOT "fix" this into a cross-module import of
 * `modules/storage`: `backend/README.md` §2 says a module's only public
 * surface is its facade, resolved through DI, and that is exactly what the
 * token gives us. If `modules/storage`'s signature ever changes, change it
 * HERE too — a structural mismatch will surface as a `tsc` error at the
 * binding in `document.module.ts`, which is the point.
 *
 * *** POST-MERGE WIRING (the coordinator's one job here) ***
 * Today `DOCUMENT_STORAGE_PORT` is bound to `UnavailableDocumentStorageProvider`
 * — a placeholder that reports unavailable and throws `STORAGE_PORT_UNAVAILABLE`
 * for every method, so this module is fully buildable/testable with no
 * storage module present (every upload/download simply surfaces this
 * module's own `DOCUMENT_STORAGE_UNAVAILABLE`, never a raw storage error —
 * see `patient-file.service.ts`'s `wrapStorageError`). Once `modules/storage`
 * is merged, change ONE entry in `document.module.ts`:
 *
 *   imports:   [..., StorageModule]
 *   providers: [..., { provide: DOCUMENT_STORAGE_PORT, useExisting: StorageFacade }]
 *
 * and delete the `UnavailableDocumentStorageProvider` binding (it can stay
 * in the tree, unbound, as the null-object this module was built and tested
 * against — same reasoning `search-ai-null.provider.ts`'s own doc comment
 * gives for keeping `SearchAiNullProvider` around post-merge). Nothing else
 * in this module, and none of its tests, needs to change.
 */

export interface StoreFileInput {
  buffer: Buffer;
  fileName: string;
  contentType: string;
  category: string;
}

export interface StoredFileResult {
  storageKey: string;
  sizeBytes: number;
}

export interface DocumentStoragePort {
  store(input: StoreFileInput): Promise<StoredFileResult>;
  getSignedUrl(storageKey: string, expirySeconds?: number): Promise<string>;
  delete(storageKey: string): Promise<void>;
  isAvailable(): Promise<boolean>;
}
