import { Module } from '@nestjs/common';
import { CloudinaryStorageAdapter } from './cloudinary-storage.adapter';
import { S3StorageAdapter } from './s3-storage.adapter';
import { StorageAdminController } from './storage-admin.controller';
import { StorageProviderRegistry } from './storage-provider.registry';
import { StorageProviderRepository } from './storage-provider.repository';
import { StorageProviderService } from './storage-provider.service';
import { StorageRotationService } from './storage-rotation.service';
import { StorageFacade } from './storage.facade';

/**
 * Not `@Global()` — like `DoctorModule`/`CatalogueModule`/`AiModule`, nothing
 * outside this module resolves a DI token from here; a consuming module
 * (`modules/document`, later `modules/doctor`) imports `StorageModule` and
 * injects `StorageFacade` through a normal constructor.
 *
 * `StorageFacade` is the ONLY export. `StorageRotationService`, the
 * adapters, the registry and the repository are all deliberately internal: a
 * module that could inject `StorageRotationService` could route around the
 * facade, and this module's whole reason to exist — "any consumer just
 * stores bytes and gets a key back, without knowing which provider served
 * it" — is a structural property of the export list, not a convention.
 *
 * No `imports`: `DATABASE` and `AuditService` come from `DatabaseModule` and
 * `AuditModule`, both `@Global()` — same as `AiModule` needs neither for
 * those two.
 *
 * The two adapters are registered as providers so Nest can inject them into
 * `StorageProviderRegistry`. Adding a third provider (Azure Blob, GCS, R2) is
 * one line here and one in the registry — the registry's
 * `Record<StorageProviderCode, ...>` typing makes forgetting the second a
 * compile error rather than a runtime surprise.
 */
@Module({
  controllers: [StorageAdminController],
  providers: [
    S3StorageAdapter,
    CloudinaryStorageAdapter,
    StorageProviderRegistry,
    StorageProviderRepository,
    StorageRotationService,
    StorageProviderService,
    StorageFacade,
  ],
  exports: [StorageFacade],
})
export class StorageModule {}
