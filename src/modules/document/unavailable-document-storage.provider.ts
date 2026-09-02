import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { DocumentStoragePort, StoreFileInput, StoredFileResult } from './document-storage.contract';

/**
 * The null-object bound to `DOCUMENT_STORAGE_PORT` until `modules/storage` is
 * merged — the direct counterpart of `search-ai-null.provider.ts` (for
 * `SEARCH_AI_PORT`) and `consultation-busy-interval.provider.ts`'s own
 * placeholder role for `BUSY_INTERVAL_PROVIDER`.
 *
 * It reports unavailable and throws `STORAGE_PORT_UNAVAILABLE` if called
 * anyway. Every call site in this module (`patient-file.service.ts`'s
 * `upload`/`getDownloadUrl`) catches ANY throw from this port and rewraps it
 * as this module's own `DOCUMENT_STORAGE_UNAVAILABLE` with a patient-facing
 * message — never this code, never this message, reaching a client
 * unchanged. That rewrap is exercised in every test and in live E2E from
 * day one, rather than being a branch nobody runs until a real outage.
 */
@Injectable()
export class UnavailableDocumentStorageProvider implements DocumentStoragePort {
  async isAvailable(): Promise<boolean> {
    return false;
  }

  async store(_input: StoreFileInput): Promise<StoredFileResult> {
    throw this.unavailable();
  }

  async getSignedUrl(_storageKey: string, _expirySeconds?: number): Promise<string> {
    throw this.unavailable();
  }

  async delete(_storageKey: string): Promise<void> {
    throw this.unavailable();
  }

  private unavailable(): ServiceUnavailableException {
    return new ServiceUnavailableException({
      code: 'STORAGE_PORT_UNAVAILABLE',
      message: 'No storage provider is configured.',
    });
  }
}
