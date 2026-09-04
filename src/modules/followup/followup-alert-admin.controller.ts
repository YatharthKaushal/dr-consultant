import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { AccountType, CurrentUser, RequirePermission } from '../../shared/auth/auth.decorator';
import type { AuthContext } from '../../shared/auth/auth.types';
import { PERMISSIONS } from '../../shared/auth/permission.catalog';
import { createUuidValidationPipe } from '../../shared/errors/uuid-param.pipe';
import { FollowupAlertService } from './followup-alert.service';
import { CloseAlertDto, ListOpenAlertsQueryDto } from './followup.dto';

/**
 * FR-13.4/FR-18.5's safety-alert queue. `governance.read_queues` gates
 * reading it, `governance.act_alerts` gates acting on it — both bundled to
 * `clinical_governance` AND `care_coordinator` (`permission.catalog.ts`),
 * unlike the pathway editor's `content.manage_followup_questions`, which is
 * `clinical_governance`-only. Deliberately a separate controller from
 * `followup-pathway-admin.controller.ts` for exactly that reason: editing
 * clinical content and acting on a live alert are different acts, gated by
 * different permissions, and splitting the routes keeps neither controller's
 * method list mixing the two.
 */
@Controller('admin/safety-alerts')
@AccountType('admin')
export class FollowupAlertAdminController {
  constructor(private readonly alerts: FollowupAlertService) {}

  /** The open-alert queue (`acknowledged_at`/`closed_at` both null), newest first — FR-18.5's "high-risk alerts, follow-up alerts". */
  @Get()
  @RequirePermission(PERMISSIONS.GOVERNANCE_READ_QUEUES)
  listOpen(@Query() query: ListOpenAlertsQueryDto) {
    return this.alerts.listOpenAlertsForAdmin(query.limit ?? 20, query.offset ?? 0);
  }

  /** Declared before `:id` — a literal segment first, so it is never swallowed by the `:id` route below. */
  @Get('consultation/:consultationId')
  @RequirePermission(PERMISSIONS.GOVERNANCE_READ_QUEUES)
  listForConsultation(@Param('consultationId', createUuidValidationPipe('consultationId')) consultationId: string) {
    return this.alerts.listAlertsForConsultation(consultationId);
  }

  /** `@HttpCode(OK)`: acknowledges an alert that already exists. */
  @Post(':id/acknowledge')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(PERMISSIONS.GOVERNANCE_ACT_ALERTS)
  acknowledge(@CurrentUser() auth: AuthContext, @Param('id', createUuidValidationPipe('id')) id: string) {
    return this.alerts.acknowledgeAlert(id, { adminId: auth.accountId });
  }

  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(PERMISSIONS.GOVERNANCE_ACT_ALERTS)
  close(@CurrentUser() auth: AuthContext, @Param('id', createUuidValidationPipe('id')) id: string, @Body() dto: CloseAlertDto) {
    return this.alerts.closeAlert(id, { adminId: auth.accountId }, dto.closingNote ?? null);
  }
}
