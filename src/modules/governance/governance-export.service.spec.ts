/**
 * `GovernanceExportService` — the two CSV exports (`governance.export`).
 * `new GovernanceExportService(mockedDeps)`, hand-rolled `jest.fn()`s.
 */
import type { AuditService } from '../../shared/audit/audit.service';
import { GOVERNANCE_AUDIT_ENTITY_TYPES, GOVERNANCE_EXPORT_MAX_ROWS } from './governance.constants';
import { GovernanceExportService } from './governance-export.service';
import type { GovernanceQueueService } from './governance-queue.service';
import type { PendingCaseSummaryQueueItem, SafetyAlertQueueItem } from './governance.types';

const PARTIES = {
  doctorId: 'd0000000-0000-4000-8000-000000000001',
  doctorName: 'Dr. Meera Iyer',
  patientId: 'p0000000-0000-4000-8000-000000000001',
  patientName: 'Arjun Rao',
  consultationStatus: 'awaiting_documentation' as const,
};

describe('GovernanceExportService', () => {
  let queues: jest.Mocked<GovernanceQueueService>;
  let audit: jest.Mocked<AuditService>;
  let service: GovernanceExportService;

  beforeEach(() => {
    queues = {
      listPendingCaseSummaries: jest.fn().mockResolvedValue([]),
      listSafetyAlerts: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<GovernanceQueueService>;
    audit = { write: jest.fn() } as unknown as jest.Mocked<AuditService>;
    service = new GovernanceExportService(queues, audit);
  });

  describe('exportPendingCaseSummariesCsv', () => {
    it('fetches one unpaged page at the export cap, not the screen page size', async () => {
      await service.exportPendingCaseSummariesCsv('admin-1');
      expect(queues.listPendingCaseSummaries).toHaveBeenCalledWith(GOVERNANCE_EXPORT_MAX_ROWS, 0);
    });

    it('renders a CSV with the header and one row per item, defusing a formula-shaped field', async () => {
      const item: PendingCaseSummaryQueueItem = {
        consultationId: 'c0000000-0000-4000-8000-000000000001',
        riskCategory: 'high',
        createdAt: new Date('2026-01-01T09:00:00.000Z'),
        updatedAt: new Date('2026-01-01T09:00:00.000Z'),
        ...PARTIES,
        doctorName: '=cmd|/c calc',
      };
      queues.listPendingCaseSummaries.mockResolvedValue([item]);

      const result = await service.exportPendingCaseSummariesCsv('admin-1');

      expect(result.rowCount).toBe(1);
      expect(result.filename).toMatch(/^governance-pending-case-summaries-\d{4}-\d{2}-\d{2}\.csv$/);
      const lines = result.content.split('\r\n');
      expect(lines[0]).toContain('consultation_id');
      expect(lines[1]).toContain(item.consultationId);
      // Defused: a leading `=` is prefixed with a quote so no spreadsheet runs it as a formula.
      expect(lines[1]).toContain("'=cmd|/c calc");
    });

    it('writes exactly one audit entry, with the true row count and a correct truncated flag', async () => {
      queues.listPendingCaseSummaries.mockResolvedValue([]);

      await service.exportPendingCaseSummariesCsv('admin-42');

      expect(audit.write).toHaveBeenCalledTimes(1);
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({
          actorType: 'admin',
          actorId: 'admin-42',
          action: 'export',
          entityType: GOVERNANCE_AUDIT_ENTITY_TYPES.PENDING_CASE_SUMMARIES_EXPORT,
          metadata: expect.objectContaining({ rowCount: 0, truncated: false }),
        }),
      );
    });
  });

  describe('exportSafetyAlertsCsv', () => {
    it('fetches one unpaged page at the export cap', async () => {
      await service.exportSafetyAlertsCsv('admin-1');
      expect(queues.listSafetyAlerts).toHaveBeenCalledWith(GOVERNANCE_EXPORT_MAX_ROWS, 0);
    });

    it('renders the triage column so the export can be filtered by it', async () => {
      const item: SafetyAlertQueueItem = {
        id: 'a0000000-0000-4000-8000-000000000001',
        alertType: 'red_flag',
        triage: 'high_risk',
        consultationId: 'c0000000-0000-4000-8000-000000000002',
        reason: 'Patient reported thoughts of self-harm.',
        createdAt: new Date('2026-01-02T09:00:00.000Z'),
        ...PARTIES,
      };
      queues.listSafetyAlerts.mockResolvedValue([item]);

      const result = await service.exportSafetyAlertsCsv('admin-1');

      const lines = result.content.split('\r\n');
      expect(lines[0]).toContain('triage');
      expect(lines[1]).toContain('high_risk');
    });

    it('audits under the safety-alerts export entity type', async () => {
      queues.listSafetyAlerts.mockResolvedValue([]);

      await service.exportSafetyAlertsCsv('admin-1');

      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({ entityType: GOVERNANCE_AUDIT_ENTITY_TYPES.SAFETY_ALERTS_EXPORT }),
      );
    });
  });
});
