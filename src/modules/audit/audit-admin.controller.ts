import { Body, Controller, Get, Put, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { AccountType, CurrentUser, RequirePermission } from '../../shared/auth/auth.decorator';
import type { AuthContext } from '../../shared/auth/auth.types';
import { PERMISSIONS } from '../../shared/auth/permission.catalog';
import type { ActorType, AuditAction } from '../../schema/enums.schema';
import { AuditConfigService } from './audit-config.service';
import { AuditExportService } from './audit-export.service';
import { AuditSearchQueryDto, ExportAuditLogDto, UpdateAuditConfigDto } from './audit.dto';
import { AUDIT_DEFAULT_PAGE_SIZE } from './audit.constants';
import type { AuditLogFilter } from './audit.types';
import { AuditSearchService } from './audit-search.service';

/**
 * M-21's admin surface. Prefix `admin/audit`, matching `admin/governance`,
 * `admin/payments`, `admin/search`.
 *
 * Three permissions:
 *   `audit.read`      log search (`GET log`).
 *   `audit.export`    CSV download (`GET export`).
 *   `config.read`/`config.manage`   the retention window (`GET`/`PUT config`).
 *
 * *** `audit.read`/`audit.export` ARE NOT NEW. *** Both have been seeded in
 * `permission.catalog.ts` and bundled into roles since M-01 — "same pattern
 * `content.*` had before M-18 existed" — with zero controller consuming them
 * until this one.
 *
 * *** THE RETENTION WINDOW USES `config.read`/`config.manage`, NOT A NEW
 * `audit.manage_retention`. *** Every other owning-module config screen in
 * this codebase gates on a permission scoped to ITS OWN domain
 * (`payments.manage_config`, `search.manage_mapping`) — this module's build
 * task deliberately did not add one for audit (its guardrails scope edits
 * away from `shared/auth/permission.catalog.ts`), and `config.read`/`config
 * .manage` already exist in the catalog, generically described ("View/Edit
 * app configuration values"), seeded since M-01, held by `operations` and
 * `super_admin`, and — like `audit.read`/`audit.export` before this build —
 * consumed by no controller until now. They are the correct, already-
 * provisioned fit for a generic system setting that is not itself audit-LOG
 * business data (unlike the log rows `audit.read`/`audit.export` gate), and
 * widening them to cover this is the same "wire up what was already seeded"
 * move this whole module makes for `audit.read`/`audit.export`.
 */
@Controller('admin/audit')
@AccountType('admin')
export class AuditAdminController {
  constructor(
    private readonly search: AuditSearchService,
    private readonly exports: AuditExportService,
    private readonly config: AuditConfigService,
  ) {}

  /* ---- Search (docs/MODULES.md: "Log search by actor, module and date") - */

  @Get('log')
  @RequirePermission(PERMISSIONS.AUDIT_READ)
  listLog(@Query() query: AuditSearchQueryDto) {
    return this.search.search(this.toFilter(query, query.limit ?? AUDIT_DEFAULT_PAGE_SIZE, query.offset ?? 0));
  }

  /* ---- CSV export -------------------------------------------------------- */

  /**
   * Sent as a file download rather than through the JSON envelope
   * (`@Res()` directly) — same reason `governance-admin.controller.ts
   * #sendCsv` and `payment-admin.controller.ts#sendCsv` give: the
   * `ResponseInterceptor` would otherwise wrap the CSV in `{ success, data
   * }` and produce a file no spreadsheet can open.
   */
  @Get('export')
  @RequirePermission(PERMISSIONS.AUDIT_EXPORT)
  async exportLog(
    @Query() query: ExportAuditLogDto,
    @CurrentUser() auth: AuthContext,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const result = await this.exports.exportCsv(this.toExportFilter(query), auth.accountId);
    this.sendCsv(reply, result.filename, result.content);
  }

  /* ---- Retention configuration -------------------------------------------- */

  @Get('config')
  @RequirePermission(PERMISSIONS.CONFIG_READ)
  getConfig() {
    return this.config.getResolved();
  }

  @Put('config')
  @RequirePermission(PERMISSIONS.CONFIG_MANAGE)
  updateConfig(@Body() body: UpdateAuditConfigDto, @CurrentUser() auth: AuthContext) {
    return this.config.update(auth.accountId, body);
  }

  private toFilter(query: AuditSearchQueryDto, limit: number, offset: number): AuditLogFilter {
    return { ...this.toExportFilter(query), limit, offset };
  }

  private toExportFilter(query: ExportAuditLogDto): Omit<AuditLogFilter, 'limit' | 'offset'> {
    return {
      actorType: query.actorType as ActorType | undefined,
      actorId: query.actorId,
      entityType: query.entityType,
      action: query.action as AuditAction | undefined,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
    };
  }

  /** `Content-Disposition: attachment` so a browser downloads rather than renders it. Copied from `governance-admin.controller.ts#sendCsv`. */
  private sendCsv(reply: FastifyReply, filename: string, content: string): void {
    void reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .send(content);
  }
}
