import { Injectable } from '@nestjs/common';
import { StorageRotationService } from './storage-rotation.service';
import type { StorageContract, StoreFileInput, StoredFileResult } from './storage.contract';

/**
 * The blob-storage gateway's only public surface. Thin by design — every
 * decision (candidate ordering, provider selection, rotation, cooldowns,
 * health) lives in `StorageRotationService`, and this class exists to be the
 * one type another module imports, so that swapping the local implementation
 * for a TCP client later changes nothing at any call site
 * (`backend/README.md` §1). Mirrors `AiFacade`.
 */
@Injectable()
export class StorageFacade implements StorageContract {
  constructor(private readonly rotation: StorageRotationService) {}

  async store(input: StoreFileInput): Promise<StoredFileResult> {
    return this.rotation.store(input);
  }

  async getSignedUrl(storageKey: string, expirySeconds?: number): Promise<string> {
    return this.rotation.getSignedUrl(storageKey, expirySeconds);
  }

  async delete(storageKey: string): Promise<void> {
    return this.rotation.delete(storageKey);
  }

  async isAvailable(): Promise<boolean> {
    return this.rotation.isAvailable();
  }
}
