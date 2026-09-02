import { Module } from '@nestjs/common';
import { ConcernAdminController } from './concern-admin.controller';
import { ConcernController } from './concern.controller';
import { ConcernRepository } from './concern.repository';
import { ConcernService } from './concern.service';
import { SpecialtyAdminController } from './specialty-admin.controller';
import { SpecialtyController } from './specialty.controller';
import { SpecialtyRepository } from './specialty.repository';
import { SpecialtyService } from './specialty.service';
import { CatalogueFacade } from './catalogue.facade';

/**
 * Not `@Global()` — like `DoctorModule`, nothing outside this module resolves
 * a DI token from here; other modules consume `CatalogueFacade` via normal
 * constructor injection after importing `CatalogueModule`.
 *
 * `DATABASE` and `AuditService` are both `@Global()` (`DatabaseModule`,
 * `AuditModule`), so no `imports` are needed here — same as `DoctorModule`
 * needs none for those two.
 */
@Module({
  controllers: [SpecialtyController, SpecialtyAdminController, ConcernController, ConcernAdminController],
  providers: [SpecialtyRepository, ConcernRepository, SpecialtyService, ConcernService, CatalogueFacade],
  exports: [CatalogueFacade],
})
export class CatalogueModule {}
