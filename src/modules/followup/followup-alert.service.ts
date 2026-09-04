import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { SafetyAlertType } from '../../schema/enums.schema';
import { AuditService } from '../../shared/audit/audit.service';
import { PERMISSIONS } from '../../shared/auth/permission.catalog';
import type { AdminDirectoryPort } from './followup-admin-directory.contract';
import type { FollowupNotificationPort, FollowupNotificationRequest } from './followup-notification.contract';
import { ADMIN_DIRECTORY_PORT, FOLLOWUP_AUDIT_ENTITY_TYPES, FOLLOWUP_ERROR_CODES, FOLLOWUP_NOTIFICATION_PORT, FOLLOWUP_NOTIFICATION_TEMPLATES } from './followup.constants';
import type { SafetyAlertView } from './followup.contract';
import { toSafetyAlertView } from './followup.mapper';
import { FollowupRepository } from './followup.repository';

/**
 * FR-13.4/FR-13.5: raising, reading and closing `safety_alerts` rows, and the
 * one place this module talks to `FOLLOWUP_NOTIFICATION_PORT`/
 * `ADMIN_DIRECTORY_PORT`. Split out of `followup.service.ts` because BOTH a
 * live check-in submission (`FollowupService#submitCheckin`) and the missed-
 * check-in sweep (`FollowupCheckinSweepService`) raise alerts through this
 * exact path, and neither should duplicate the notification fan-out.
 */
@Injectable()
export class FollowupAlertService {
  private readonly logger = new Logger(FollowupAlertService.name);

  constructor(
    private readonly repo: FollowupRepository,
    private readonly audit: AuditService,
    @Inject(FOLLOWUP_NOTIFICATION_PORT) private readonly notifications: FollowupNotificationPort,
    @Inject(ADMIN_DIRECTORY_PORT) private readonly adminDirectory: AdminDirectoryPort,
  ) {}

  /**
   * *** FR-13.4: "A CONFIGURABLE ALERT TO THE DOCTOR AND TO THE ADMIN OR CARE
   * COORDINATOR." *** Writes the `safety_alerts` row (the durable,
   * authoritative half) and best-effort notifies the treating doctor plus
   * every admin holding `governance.act_alerts` (the push half, which may
   * currently notify nobody — see `ADMIN_DIRECTORY_PORT`'s header).
   *
   * `reason` is admin/clinician-authored (a red-flag rule's `reason`) or one
   * of this module's own fixed, diagnosis-free strings (the missed-check-in
   * sweep's) — never a diagnosis, matching `safety_alerts.reason`'s own
   * schema comment. Never thrown INTO by a notification failure: the row is
   * written first and unconditionally; the notification fan-out is wrapped
   * so a down `NOTIFICATION_PORT` can never roll back an alert.
   */
  async raiseAlert(input: {
    alertType: SafetyAlertType;
    consultationId: string;
    checkinResponseId: string | null;
    reason: string;
    doctorId: string | null;
  }): Promise<SafetyAlertView> {
    const row = await this.repo.insertAlert({
      alertType: input.alertType,
      consultationId: input.consultationId,
      checkinResponseId: input.checkinResponseId,
      reason: input.reason,
    });

    await this.audit.write({
      actorType: 'system',
      actorId: null,
      action: 'create',
      entityType: FOLLOWUP_AUDIT_ENTITY_TYPES.SAFETY_ALERT,
      entityId: row.id,
      consultationId: input.consultationId,
      metadata: { alertType: input.alertType, reason: input.reason },
    });

    if (input.doctorId) {
      await this.notify({
        templateCode: FOLLOWUP_NOTIFICATION_TEMPLATES.RED_FLAG_ALERT,
        audience: { kind: 'doctor', id: input.doctorId },
        consultationId: input.consultationId,
      });
    }

    const adminIds = await this.adminDirectory.listAdminIdsWithPermission(PERMISSIONS.GOVERNANCE_ACT_ALERTS).catch((error: unknown) => {
      this.logger.warn(`Admin directory lookup failed; notifying no admins. ${describeError(error)}`);
      return [] as string[];
    });
    await Promise.all(
      adminIds.map((adminId) =>
        this.notify({
          templateCode: FOLLOWUP_NOTIFICATION_TEMPLATES.RED_FLAG_ALERT,
          audience: { kind: 'admin', id: adminId },
          consultationId: input.consultationId,
        }),
      ),
    );

    return toSafetyAlertView(row);
  }

  async listAlertsForConsultation(consultationId: string): Promise<SafetyAlertView[]> {
    const rows = await this.repo.listAlertsForConsultation(consultationId);
    return rows.map(toSafetyAlertView);
  }

  /** `governance.read_queues` — the admin queue of OPEN alerts, newest first. */
  async listOpenAlertsForAdmin(limit: number, offset: number): Promise<SafetyAlertView[]> {
    const rows = await this.repo.listOpenAlerts(limit, offset);
    return rows.map(toSafetyAlertView);
  }

  /** ADDITIVE (M-20/governance and quality) — see `followup.repository.ts#countOpenAlertsByType`. */
  async countOpenAlertsByType(): Promise<Partial<Record<SafetyAlertType, number>>> {
    return this.repo.countOpenAlertsByType();
  }

  async acknowledgeAlert(alertId: string, actor: { adminId?: string; doctorId?: string }): Promise<SafetyAlertView> {
    const existing = await this.repo.findAlertById(alertId);
    if (!existing) throw this.alertNotFound();
    if (existing.closedAt) throw this.alertAlreadyClosed();

    const row = await this.repo.acknowledgeAlert(alertId, actor);
    if (!row) throw this.alertNotFound();

    await this.audit.write({
      actorType: actor.adminId ? 'admin' : 'doctor',
      actorId: actor.adminId ?? actor.doctorId ?? null,
      action: 'update',
      entityType: FOLLOWUP_AUDIT_ENTITY_TYPES.SAFETY_ALERT,
      entityId: row.id,
      consultationId: row.consultationId,
      metadata: { change: 'acknowledged' },
    });

    return toSafetyAlertView(row);
  }

  async closeAlert(alertId: string, actor: { adminId: string }, closingNote: string | null): Promise<SafetyAlertView> {
    const existing = await this.repo.findAlertById(alertId);
    if (!existing) throw this.alertNotFound();
    if (existing.closedAt) throw this.alertAlreadyClosed();

    const row = await this.repo.closeAlert(alertId, closingNote);
    if (!row) throw this.alertNotFound();

    await this.audit.write({
      actorType: 'admin',
      actorId: actor.adminId,
      action: 'update',
      entityType: FOLLOWUP_AUDIT_ENTITY_TYPES.SAFETY_ALERT,
      entityId: row.id,
      consultationId: row.consultationId,
      metadata: { change: 'closed', closingNote },
    });

    return toSafetyAlertView(row);
  }

  /**
   * Wrapped even though the port's contract says `notify` MUST NOT throw —
   * the same defensive wrap `instant.service.ts#notify` applies, because a
   * port is a promise about an interface, not a runtime guarantee, and a
   * failed push must never fail (or roll back) the alert this method just
   * wrote.
   */
  private async notify(request: FollowupNotificationRequest): Promise<void> {
    try {
      const result = await this.notifications.notify(request);
      if (!result.queued && result.reason && result.reason !== 'provider_unavailable') {
        this.logger.debug(`Notification "${request.templateCode}" not queued: ${result.reason}`);
      }
    } catch (error) {
      this.logger.warn(`Notification "${request.templateCode}" threw; ignoring. ${describeError(error)}`);
    }
  }

  private alertNotFound(): NotFoundException {
    return new NotFoundException({ code: FOLLOWUP_ERROR_CODES.ALERT_NOT_FOUND, message: 'Safety alert not found.' });
  }

  private alertAlreadyClosed(): ConflictException {
    return new ConflictException({ code: FOLLOWUP_ERROR_CODES.ALERT_ALREADY_CLOSED, message: 'This safety alert is already closed.' });
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
