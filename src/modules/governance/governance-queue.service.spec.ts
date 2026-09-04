/**
 * `GovernanceQueueService` — FR-18.5's two working queues.
 * `new GovernanceQueueService(mockedDeps)`, hand-rolled `jest.fn()`s.
 */
import type { ClinicalRecordView } from '../clinical/clinical.contract';
import type { ClinicalFacade } from '../clinical/clinical.facade';
import type { SafetyAlertView } from '../followup/followup.contract';
import type { FollowupFacade } from '../followup/followup.facade';
import type { GovernanceCaseParties } from './governance.types';
import { GovernanceQueueService } from './governance-queue.service';
import type { GovernanceEnrichmentService } from './governance-enrichment.service';

function clinicalRecord(overrides: Partial<ClinicalRecordView> = {}): ClinicalRecordView {
  return {
    id: 'r0000000-0000-4000-8000-000000000001',
    consultationId: 'c0000000-0000-4000-8000-000000000001',
    chiefComplaint: 'Trouble sleeping',
    clinicalHistory: null,
    diagnosis: null,
    isDiagnosisProvisional: true,
    riskCategory: 'moderate',
    referralNote: null,
    medicines: [],
    advice: { covered: null, homePractice: null, nextFocus: null, warningSigns: null },
    caseSummary: null,
    finalisedAt: null,
    createdAt: new Date('2026-01-01T09:00:00.000Z'),
    updatedAt: new Date('2026-01-01T09:00:00.000Z'),
    ...overrides,
  };
}

function safetyAlert(overrides: Partial<SafetyAlertView> = {}): SafetyAlertView {
  return {
    id: 'a0000000-0000-4000-8000-000000000001',
    alertType: 'red_flag',
    consultationId: 'c0000000-0000-4000-8000-000000000002',
    checkinResponseId: null,
    reason: 'Patient reported thoughts of self-harm.',
    acknowledgedByAdminId: null,
    acknowledgedByDoctorId: null,
    acknowledgedAt: null,
    closedAt: null,
    closingNote: null,
    createdAt: new Date('2026-01-02T09:00:00.000Z'),
    ...overrides,
  };
}

const EMPTY_PARTIES: GovernanceCaseParties = {
  doctorId: null,
  doctorName: null,
  patientId: null,
  patientName: null,
  consultationStatus: null,
};

const RESOLVED_PARTIES: GovernanceCaseParties = {
  doctorId: 'd0000000-0000-4000-8000-000000000001',
  doctorName: 'Dr. Meera Iyer',
  patientId: 'p0000000-0000-4000-8000-000000000001',
  patientName: 'Arjun Rao',
  consultationStatus: 'awaiting_documentation',
};

describe('GovernanceQueueService', () => {
  let clinical: jest.Mocked<ClinicalFacade>;
  let followup: jest.Mocked<FollowupFacade>;
  let enrichment: jest.Mocked<GovernanceEnrichmentService>;
  let service: GovernanceQueueService;

  beforeEach(() => {
    clinical = { listPendingCaseSummaries: jest.fn() } as unknown as jest.Mocked<ClinicalFacade>;
    followup = { listOpenAlerts: jest.fn() } as unknown as jest.Mocked<FollowupFacade>;
    enrichment = { resolveMany: jest.fn() } as unknown as jest.Mocked<GovernanceEnrichmentService>;
    service = new GovernanceQueueService(clinical, followup, enrichment);
  });

  describe('listPendingCaseSummaries', () => {
    it('passes limit/offset straight through and enriches every row', async () => {
      const record = clinicalRecord();
      clinical.listPendingCaseSummaries.mockResolvedValue([record]);
      enrichment.resolveMany.mockResolvedValue(new Map([[record.consultationId, RESOLVED_PARTIES]]));

      const rows = await service.listPendingCaseSummaries(10, 5);

      expect(clinical.listPendingCaseSummaries).toHaveBeenCalledWith(10, 5);
      expect(enrichment.resolveMany).toHaveBeenCalledWith([record.consultationId]);
      expect(rows).toEqual([
        {
          consultationId: record.consultationId,
          riskCategory: 'moderate',
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          ...RESOLVED_PARTIES,
        },
      ]);
    });

    it('falls back to every-field-null parties for a row `resolveMany` did not return', async () => {
      const record = clinicalRecord();
      clinical.listPendingCaseSummaries.mockResolvedValue([record]);
      enrichment.resolveMany.mockResolvedValue(new Map());

      const [row] = await service.listPendingCaseSummaries(10, 0);

      expect(row).toMatchObject(EMPTY_PARTIES);
    });
  });

  describe('listSafetyAlerts', () => {
    it('derives `triage: high_risk` for a red_flag alert', async () => {
      const alert = safetyAlert({ alertType: 'red_flag' });
      followup.listOpenAlerts.mockResolvedValue([alert]);
      enrichment.resolveMany.mockResolvedValue(new Map([[alert.consultationId, RESOLVED_PARTIES]]));

      const [row] = await service.listSafetyAlerts(20, 0);

      expect(row?.triage).toBe('high_risk');
    });

    it.each(['amber', 'missed_checkin', 'medication_side_effect', 'followup_due'] as const)(
      'derives `triage: follow_up` for a %s alert',
      async (alertType) => {
        const alert = safetyAlert({ alertType });
        followup.listOpenAlerts.mockResolvedValue([alert]);
        enrichment.resolveMany.mockResolvedValue(new Map([[alert.consultationId, RESOLVED_PARTIES]]));

        const [row] = await service.listSafetyAlerts(20, 0);

        expect(row?.triage).toBe('follow_up');
      },
    );

    it('carries the reason and enriched identity through unchanged', async () => {
      const alert = safetyAlert();
      followup.listOpenAlerts.mockResolvedValue([alert]);
      enrichment.resolveMany.mockResolvedValue(new Map([[alert.consultationId, RESOLVED_PARTIES]]));

      const [row] = await service.listSafetyAlerts(20, 0);

      expect(row).toEqual({
        id: alert.id,
        alertType: alert.alertType,
        triage: 'high_risk',
        consultationId: alert.consultationId,
        reason: alert.reason,
        createdAt: alert.createdAt,
        ...RESOLVED_PARTIES,
      });
    });
  });
});
