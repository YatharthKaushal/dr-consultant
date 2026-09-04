/**
 * `FollowupAlertService` — FR-13.4's alert write + notification fan-out.
 * `new FollowupAlertService(mockedDeps)`, hand-rolled `jest.fn()`s.
 */
import { ConflictException, NotFoundException } from '@nestjs/common';
import type { SafetyAlertRow } from '../../schema/safety-alerts.schema';
import type { AuditService } from '../../shared/audit/audit.service';
import { PERMISSIONS } from '../../shared/auth/permission.catalog';
import { FollowupAlertService } from './followup-alert.service';
import type { AdminDirectoryPort } from './followup-admin-directory.contract';
import type { FollowupNotificationPort } from './followup-notification.contract';
import type { FollowupRepository } from './followup.repository';

function alertRow(overrides: Partial<SafetyAlertRow> = {}): SafetyAlertRow {
  return {
    id: 'al000000-0000-4000-8000-000000000001',
    alertType: 'red_flag',
    consultationId: 'c0000000-0000-4000-8000-000000000001',
    checkinResponseId: 'ck000000-0000-4000-8000-000000000001',
    reason: 'Patient reported thoughts of self-harm.',
    acknowledgedByAdminId: null,
    acknowledgedByDoctorId: null,
    acknowledgedAt: null,
    closedAt: null,
    closingNote: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('FollowupAlertService', () => {
  let repo: jest.Mocked<FollowupRepository>;
  let audit: jest.Mocked<AuditService>;
  let notifications: jest.Mocked<FollowupNotificationPort>;
  let adminDirectory: jest.Mocked<AdminDirectoryPort>;
  let service: FollowupAlertService;

  beforeEach(() => {
    repo = {
      insertAlert: jest.fn(async (data) => alertRow(data as Partial<SafetyAlertRow>)),
      findAlertById: jest.fn(),
      listAlertsForConsultation: jest.fn().mockResolvedValue([]),
      listOpenAlerts: jest.fn().mockResolvedValue([]),
      acknowledgeAlert: jest.fn(),
      closeAlert: jest.fn(),
    } as unknown as jest.Mocked<FollowupRepository>;

    audit = { write: jest.fn() } as unknown as jest.Mocked<AuditService>;
    notifications = { notify: jest.fn().mockResolvedValue({ queued: true, notificationId: 1 }) };
    adminDirectory = { listAdminIdsWithPermission: jest.fn().mockResolvedValue([]) };

    service = new FollowupAlertService(repo, audit, notifications, adminDirectory);
  });

  describe('raiseAlert', () => {
    it('writes the alert row and audits it even when notifications are unavailable', async () => {
      notifications.notify.mockResolvedValue({ queued: false, notificationId: null, reason: 'provider_unavailable' });

      const result = await service.raiseAlert({
        alertType: 'red_flag',
        consultationId: 'c1',
        checkinResponseId: 'ck1',
        reason: 'Patient reported thoughts of self-harm.',
        doctorId: 'doc1',
      });

      expect(result.alertType).toBe('red_flag');
      expect(repo.insertAlert).toHaveBeenCalled();
      expect(audit.write).toHaveBeenCalled();
    });

    it('notifies the treating doctor when one is assigned', async () => {
      await service.raiseAlert({
        alertType: 'red_flag',
        consultationId: 'c1',
        checkinResponseId: 'ck1',
        reason: 'x',
        doctorId: 'doc1',
      });

      expect(notifications.notify).toHaveBeenCalledWith(
        expect.objectContaining({ audience: { kind: 'doctor', id: 'doc1' } }),
      );
    });

    it('does not attempt to notify a doctor when none is assigned', async () => {
      await service.raiseAlert({ alertType: 'missed_checkin', consultationId: 'c1', checkinResponseId: null, reason: 'x', doctorId: null });
      expect(notifications.notify).not.toHaveBeenCalledWith(expect.objectContaining({ audience: expect.objectContaining({ kind: 'doctor' }) }));
    });

    it('notifies every admin the directory returns, using governance.act_alerts', async () => {
      adminDirectory.listAdminIdsWithPermission.mockResolvedValue(['admin1', 'admin2']);

      await service.raiseAlert({ alertType: 'red_flag', consultationId: 'c1', checkinResponseId: 'ck1', reason: 'x', doctorId: null });

      expect(adminDirectory.listAdminIdsWithPermission).toHaveBeenCalledWith(PERMISSIONS.GOVERNANCE_ACT_ALERTS);
      expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ audience: { kind: 'admin', id: 'admin1' } }));
      expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ audience: { kind: 'admin', id: 'admin2' } }));
    });

    it('still writes the alert even when the admin directory throws', async () => {
      adminDirectory.listAdminIdsWithPermission.mockRejectedValue(new Error('down'));
      await expect(
        service.raiseAlert({ alertType: 'red_flag', consultationId: 'c1', checkinResponseId: 'ck1', reason: 'x', doctorId: null }),
      ).resolves.toBeDefined();
    });

    it('still returns the alert even when notify() itself throws', async () => {
      notifications.notify.mockRejectedValue(new Error('down'));
      await expect(
        service.raiseAlert({ alertType: 'red_flag', consultationId: 'c1', checkinResponseId: 'ck1', reason: 'x', doctorId: 'doc1' }),
      ).resolves.toBeDefined();
    });
  });

  describe('acknowledgeAlert / closeAlert', () => {
    it('throws NotFoundException for an unknown alert', async () => {
      repo.findAlertById.mockResolvedValue(null);
      await expect(service.acknowledgeAlert('missing', { adminId: 'a1' })).rejects.toThrow(NotFoundException);
    });

    it('refuses to acknowledge an already-closed alert', async () => {
      repo.findAlertById.mockResolvedValue(alertRow({ closedAt: new Date() }));
      await expect(service.acknowledgeAlert('al1', { adminId: 'a1' })).rejects.toThrow(ConflictException);
    });

    it('refuses to close an already-closed alert', async () => {
      repo.findAlertById.mockResolvedValue(alertRow({ closedAt: new Date() }));
      await expect(service.closeAlert('al1', { adminId: 'a1' }, null)).rejects.toThrow(ConflictException);
    });

    it('closes an open alert and audits it', async () => {
      repo.findAlertById.mockResolvedValue(alertRow());
      repo.closeAlert.mockResolvedValue(alertRow({ closedAt: new Date(), closingNote: 'Resolved by phone.' }));

      const result = await service.closeAlert('al1', { adminId: 'a1' }, 'Resolved by phone.');
      expect(result.closedAt).not.toBeNull();
      expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ change: 'closed' }) }));
    });
  });
});
