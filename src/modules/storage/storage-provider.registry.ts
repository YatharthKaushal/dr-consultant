import { Injectable } from '@nestjs/common';
import { CloudinaryStorageAdapter } from './cloudinary-storage.adapter';
import { S3StorageAdapter } from './s3-storage.adapter';
import { STORAGE_PROVIDER_CODES, type StorageProviderCode } from './storage.constants';
import type { StorageProviderAdapter } from './storage-provider.types';

/**
 * `StorageProviderCode` -> adapter. The single place that knows which class
 * serves which provider. Mirrors `LlmProviderRegistry`.
 *
 * Typed `Record<StorageProviderCode, StorageProviderAdapter>`, so adding a
 * code to `STORAGE_PROVIDER_CODES` without adding a line here is a COMPILE
 * ERROR, not a runtime surprise the first time rotation selects it.
 */
@Injectable()
export class StorageProviderRegistry {
  private readonly adapters: Record<StorageProviderCode, StorageProviderAdapter>;

  constructor(s3: S3StorageAdapter, cloudinary: CloudinaryStorageAdapter) {
    this.adapters = { s3, cloudinary };
  }

  /**
   * The adapter for a stored `storage_providers.provider` string, or `null`
   * if this build has none.
   *
   * Returns `null` rather than throwing — `storage-rotation.service.ts` must
   * SKIP a row it cannot serve and carry on with the rest of the candidate
   * list, exactly as `LlmProviderRegistry.find()`'s own comment explains.
   */
  find(provider: string): StorageProviderAdapter | null {
    return isStorageProviderCode(provider) ? this.adapters[provider] : null;
  }
}

function isStorageProviderCode(value: string): value is StorageProviderCode {
  return (STORAGE_PROVIDER_CODES as readonly string[]).includes(value);
}
