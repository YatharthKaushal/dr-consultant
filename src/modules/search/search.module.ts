import { Module } from '@nestjs/common';
import { AiFacade } from '../ai/ai.facade';
import { AiModule } from '../ai/ai.module';
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
 * `SEARCH_AI_PORT` is bound to `AiFacade` (M-09 merge). `AiFacade` satisfies
 * `SearchAiPort` structurally (see `search-ai.contract.ts`) — no adapter, no
 * cast — so a signature drift on either side surfaces here as a `tsc` error
 * rather than a runtime surprise.
 *
 * `SearchAiNullProvider` remains in the tree, unbound: it is the null-object
 * this module was built and tested against, and it is what you rebind here to
 * take the LLM out of the request path at the DI level. That is a harder
 * kill-switch than the `search.ai_enabled` config flag, which is the one an
 * admin uses day to day.
 */
@Module({
  imports: [CatalogueModule, DoctorModule, AvailabilityModule, AiModule],
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
    { provide: SEARCH_AI_PORT, useExisting: AiFacade },
    SearchFacade,
  ],
  exports: [SearchFacade],
})
export class SearchModule {}
