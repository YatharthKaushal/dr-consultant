import { Body, Controller, Get, Put, Query } from '@nestjs/common';
import { AccountType, CurrentUser, RequirePermission } from '../../shared/auth/auth.decorator';
import type { AuthContext } from '../../shared/auth/auth.types';
import { PERMISSIONS } from '../../shared/auth/permission.catalog';
import { SearchConfigService } from './search-config.service';
import { SearchService } from './search.service';
import { ListSearchQueriesDto, UpdateSearchConfigDto } from './search-admin.dto';

/**
 * Every route is admin-only, gated by its own permission — mirrors
 * `concern-admin.controller.ts`.
 *
 * Two permissions, deliberately different ones:
 *   - `SEARCH_READ_QUERIES` for the query log. It is a read of patients'
 *     own free-text symptom descriptions, "among the most sensitive strings
 *     this platform stores" (`search-queries.schema.ts`), so it is its own
 *     grantable permission rather than riding on the mapping-edit one. An
 *     admin who tunes crisis keywords does not thereby get to read what
 *     people typed.
 *   - `SEARCH_MANAGE_MAPPING` for config. It already exists, and its own
 *     description already names crisis keywords: "Edit the
 *     symptom-to-specialty mapping, synonyms and crisis keywords."
 */
@Controller('admin/search')
@AccountType('admin')
export class SearchAdminController {
  constructor(
    private readonly search: SearchService,
    private readonly config: SearchConfigService,
  ) {}

  /**
   * FR-5.7's feedback loop. `?maxResultCount=0` is the view this exists for:
   * the phrasings that returned no doctors, which is the input to editing
   * `concerns.matchPhrases` from the admin panel.
   */
  @Get('queries')
  @RequirePermission(PERMISSIONS.SEARCH_READ_QUERIES)
  listQueries(@Query() query: ListSearchQueriesDto) {
    return this.search.listQueryLogs({
      maxResultCount: query.maxResultCount,
      source: query.source,
      crisisGuardrailFired: query.crisisGuardrailFired,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      limit: query.limit ?? 50,
      offset: query.offset ?? 0,
    });
  }

  /** Current `search.*` values, each resolved against its compiled-in fallback so the panel shows what search is ACTUALLY using, not just what has a row. */
  @Get('config')
  @RequirePermission(PERMISSIONS.SEARCH_MANAGE_MAPPING)
  getConfig() {
    return this.config.getResolved();
  }

  /** Crisis keywords and guidance, popular searches, the AI kill switch, result cap and rate limit. Each changed key writes its own audited before/after and invalidates the config memo. */
  @Put('config')
  @RequirePermission(PERMISSIONS.SEARCH_MANAGE_MAPPING)
  updateConfig(@CurrentUser() auth: AuthContext, @Body() dto: UpdateSearchConfigDto) {
    return this.config.update(auth.accountId, {
      crisisKeywords: dto.crisisKeywords,
      crisisGuidance: dto.crisisGuidance,
      popularSearches: dto.popularSearches,
      aiEnabled: dto.aiEnabled,
      maxResults: dto.maxResults,
      rateLimitPerHour: dto.rateLimitPerHour,
    });
  }
}
