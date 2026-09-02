import { Module } from '@nestjs/common';
import { AvailabilityModule } from '../availability/availability.module';
import { CatalogueModule } from '../catalogue/catalogue.module';
import { DoctorModule } from '../doctor/doctor.module';
import { ConcernMatcherService } from './concern-matcher.service';
import { CrisisDetectorService } from './crisis-detector.service';
import { DoctorRankerService } from './doctor-ranker.service';
import { GuidedIntakeService } from './guided-intake.service';
import { QueryInterpreterService } from './query-interpreter.service';
import { ResponseValidatorService } from './response-validator.service';
import { SearchAdminController } from './search-admin.controller';
import { SearchAiNullProvider } from './search-ai-null.provider';
import { SearchConfigRepository } from './search-config.repository';
import { SearchConfigService } from './search-config.service';
import { SearchController } from './search.controller';
import { SearchFacade } from './search.facade';
import { SearchRepository } from './search.repository';
import { SearchService } from './search.service';
import { SEARCH_AI_PORT } from './search.constants';

/**
 * Not `@Global()` — like `DoctorModule`/`CatalogueModule`/`Availability
 * Module`, nothing outside this module resolves a DI token from here; other
 * modules consume `SearchFacade` via normal constructor injection after
 * importing `SearchModule`.
 *
 * `CatalogueModule`, `DoctorModule` and `AvailabilityModule` are real
 * (non-global) imports: M-09 reads specialties/concerns, doctors and slots
 * ONLY through their facades, never their tables. `DATABASE`, `AuditService`
 * and `AppConfigService` are all `@Global()`, so they need no `imports` entry
 * — same as the three modules above.
 *
 * ---------------------------------------------------------------------------
 * *** POST-MERGE WIRING — THE COORDINATOR'S ONE JOB IN THIS FILE ***
 *
 * `SEARCH_AI_PORT` is currently bound to `SearchAiNullProvider`, a
 * null-object that reports unavailable, so this module is fully functional
 * with no AI module present (every search is served by the deterministic
 * matcher). This mirrors `availability.module.ts`, which binds
 * `BUSY_INTERVAL_PROVIDER` to a placeholder until M-11 exists.
 *
 * Once `modules/ai` is merged, make exactly these two changes:
 *
 *     imports:   [CatalogueModule, DoctorModule, AvailabilityModule, AiModule]
 *     providers: [ ... , { provide: SEARCH_AI_PORT, useExisting: AiFacade } ]
 *
 * and drop `SearchAiNullProvider` from `providers` and its import. `AiFacade`
 * satisfies `SearchAiPort` structurally (see `search-ai.contract.ts`), so no
 * adapter and no cast is needed, and a signature drift on either side
 * surfaces here as a `tsc` error rather than a runtime surprise. Nothing else
 * in this module — and none of its tests — changes.
 */
@Module({
  imports: [CatalogueModule, DoctorModule, AvailabilityModule],
  controllers: [SearchController, SearchAdminController],
  providers: [
    SearchRepository,
    SearchConfigRepository,
    SearchConfigService,
    CrisisDetectorService,
    ConcernMatcherService,
    DoctorRankerService,
    ResponseValidatorService,
    QueryInterpreterService,
    SearchService,
    GuidedIntakeService,
    { provide: SEARCH_AI_PORT, useClass: SearchAiNullProvider },
    SearchFacade,
  ],
  exports: [SearchFacade],
})
export class SearchModule {}
