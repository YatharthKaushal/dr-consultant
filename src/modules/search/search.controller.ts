import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { AccountType, CurrentUser } from '../../shared/auth/auth.decorator';
import type { AuthContext } from '../../shared/auth/auth.types';
import { GuidedIntakeService } from './guided-intake.service';
import { SearchService } from './search.service';
import {
  DiscoverSearchDto,
  GuidedSearchDto,
  ListConcernsQueryDto,
  ListDoctorsQueryDto,
  ListRecentSearchesQueryDto,
} from './search.dto';

/**
 * The patient-facing search surface. No logic here — parse, authorise via
 * decorators, delegate, exactly like `concern.controller.ts`.
 *
 * *** EVERY ROUTE IS SELF-SCOPED FROM `@CurrentUser()`. *** There is no
 * patient id in a path, a query string or a body anywhere in this
 * controller, so no request can be shaped to read or log against another
 * patient — the same discipline `availability.controller.ts` applies to
 * `doctors/me`.
 *
 * `source: 'app'` is hard-coded rather than taken from the client: a caller
 * must not be able to label its own traffic as `mcp` and land in a different
 * rate-limit bucket. The MCP surface passes its own source through
 * `SearchFacade`, not through here.
 */
@Controller('search')
@AccountType('patient')
export class SearchController {
  constructor(
    private readonly search: SearchService,
    private readonly guided: GuidedIntakeService,
  ) {}

  /**
   * FR-5.1. The full pipeline. The `search.ai_enabled` kill switch is
   * honoured transparently — the response shape is identical whether the
   * mapping came from the model or the deterministic matcher, and
   * `meta.interpretation` says which, so a client needs no branch.
   */
  @Post('discover')
  discover(@CurrentUser() auth: AuthContext, @Body() dto: DiscoverSearchDto) {
    return this.search.discover({
      patientId: auth.accountId,
      source: 'app',
      queryText: dto.queryText,
      isVoiceInput: dto.isVoiceInput,
      languages: dto.languages,
      maxFeeInr: dto.maxFeeInr,
      availableWithinDays: dto.availableWithinDays,
      limit: dto.limit,
    });
  }

  /** FR-5.5's concern guide. Same engine, same response shape — see `guided-intake.service.ts`. */
  @Post('guided')
  guidedDiscover(@CurrentUser() auth: AuthContext, @Body() dto: GuidedSearchDto) {
    return this.guided.discover(auth.accountId, 'app', {
      concernIds: dto.concernIds,
      forSelf: dto.forSelf,
      ageBand: dto.ageBand,
      supportPreference: dto.supportPreference,
      languages: dto.languages,
      maxFeeInr: dto.maxFeeInr,
      availableWithinDays: dto.availableWithinDays,
      limit: dto.limit,
    });
  }

  /** FR-5.11. This patient's own searches, and only ever this patient's — the id comes from the token, never the request. */
  @Get('recent')
  listRecent(@CurrentUser() auth: AuthContext, @Query() query: ListRecentSearchesQueryDto) {
    return this.search.listRecent(auth.accountId, query.limit);
  }

  /** FR-5.11. The admin-edited list from `app_config` — never computed from the query log. */
  @Get('popular')
  listPopular() {
    return this.search.listPopular();
  }

  /** FR-5.3. Browse the concern taxonomy. */
  @Get('concerns')
  listConcerns(@Query() query: ListConcernsQueryDto) {
    return this.search.listConcerns(query.specialtyId);
  }

  /** FR-5.3. Browse by professional type. */
  @Get('professional-types')
  listProfessionalTypes() {
    return this.search.listProfessionalTypes();
  }

  /** FR-4.4. Filtered and sorted listing, no query and no concern mapping — same ranker, empty specialty-match set. */
  @Get('doctors')
  listDoctors(@Query() query: ListDoctorsQueryDto) {
    return this.search.listDoctors({
      specialtyId: query.specialtyId,
      languages: query.languages,
      maxFeeInr: query.maxFeeInr,
      availableWithinDays: query.availableWithinDays,
      sort: query.sort,
      limit: query.limit,
      offset: query.offset,
    });
  }
}
