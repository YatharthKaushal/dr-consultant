import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { AccountType, CurrentUser, RequirePermission } from '../../shared/auth/auth.decorator';
import type { AuthContext } from '../../shared/auth/auth.types';
import { PERMISSIONS } from '../../shared/auth/permission.catalog';
import { createUuidValidationPipe } from '../../shared/errors/uuid-param.pipe';
import { ListGovernanceQueueQueryDto } from './governance.dto';
import { GovernanceExportService } from './governance-export.service';
import { GovernanceQualityService } from './governance-quality.service';
import { GovernanceQueueService } from './governance-queue.service';

/**
 * M-20's admin surface (FR-18.5/FR-18.6). Prefix `admin/governance`, matching
 * `booking-admin.controller.ts`'s `admin/bookings` and
 * `clarification-admin.controller.ts`'s `admin/clarification-cases`.
 *
 * Three permissions, all already seeded in `permission.catalog.ts` since
 * M-01 and already bundled to `super_admin`/`clinical_governance`/
 * `operations` (queues and quality) and `care_coordinator` (queues only) —
 * none is added, renamed or re-bundled here:
 *   `governance.read_queues`    the two working-queue reads.
 *   `governance.read_quality`   the dashboard and the reliability drill-down.
 *   `governance.export`         both CSV downloads.
 *
 * *** NOT HERE: THE CASE CLARIFICATION TRACKER. *** FR-18.5 names it as a
 * fourth working queue, but it is already fully served at
 * `admin/clarification-cases` (`clarification-admin.controller.ts`), whose
 * own header says as much. See `governance-queue.service.ts`'s header for
 * the full account.
 */
@Controller('admin/governance')
@AccountType('admin')
export class GovernanceAdminController {
  constructor(
    private readonly queues: GovernanceQueueService,
    private readonly quality: GovernanceQualityService,
    private readonly exports: GovernanceExportService,
  ) {}

  /* ---- Working queues (FR-18.5) ---------------------------------------- */

  @Get('queues/pending-case-summaries')
  @RequirePermission(PERMISSIONS.GOVERNANCE_READ_QUEUES)
  listPendingCaseSummaries(@Query() query: ListGovernanceQueueQueryDto) {
    return this.queues.listPendingCaseSummaries(query.limit ?? 20, query.offset ?? 0);
  }

  /** Both "high-risk alerts" and "follow-up alerts" — see `governance.types.ts#SafetyAlertQueueItem`'s `triage` field for how a client tells them apart. */
  @Get('queues/safety-alerts')
  @RequirePermission(PERMISSIONS.GOVERNANCE_READ_QUEUES)
  listSafetyAlerts(@Query() query: ListGovernanceQueueQueryDto) {
    return this.queues.listSafetyAlerts(query.limit ?? 20, query.offset ?? 0);
  }

  /* ---- Quality dashboard (FR-18.6) --------------------------------------- */

  @Get('quality-dashboard')
  @RequirePermission(PERMISSIONS.GOVERNANCE_READ_QUALITY)
  getQualityDashboard() {
    return this.quality.getDashboard();
  }

  /** FR-18.6's "doctor reliability metrics" — a per-doctor drill-down from the same computation `admin/doctors/:id/reliability` already serves. */
  @Get('doctors/:doctorId/reliability')
  @RequirePermission(PERMISSIONS.GOVERNANCE_READ_QUALITY)
  getDoctorReliability(@Param('doctorId', createUuidValidationPipe('doctorId')) doctorId: string) {
    return this.quality.getDoctorReliability(doctorId);
  }

  /* ---- CSV export --------------------------------------------------------- */

  /**
   * Sent as a file download rather than through the JSON envelope, so
   * `@Res()` is used directly — `payment-admin.controller.ts`'s own comment
   * gives the reason: the `ResponseInterceptor` would otherwise wrap the CSV
   * in `{ success, data }` and produce a file no spreadsheet can open.
   */
  @Get('export/pending-case-summaries')
  @RequirePermission(PERMISSIONS.GOVERNANCE_EXPORT)
  async exportPendingCaseSummaries(@CurrentUser() auth: AuthContext, @Res() reply: FastifyReply): Promise<void> {
    const result = await this.exports.exportPendingCaseSummariesCsv(auth.accountId);
    this.sendCsv(reply, result.filename, result.content);
  }

  @Get('export/safety-alerts')
  @RequirePermission(PERMISSIONS.GOVERNANCE_EXPORT)
  async exportSafetyAlerts(@CurrentUser() auth: AuthContext, @Res() reply: FastifyReply): Promise<void> {
    const result = await this.exports.exportSafetyAlertsCsv(auth.accountId);
    this.sendCsv(reply, result.filename, result.content);
  }

  /** `Content-Disposition: attachment` so a browser downloads rather than renders it. Copied from `payment-admin.controller.ts#sendCsv`. */
  private sendCsv(reply: FastifyReply, filename: string, content: string): void {
    void reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${filename}"`)
      .send(content);
  }
}
