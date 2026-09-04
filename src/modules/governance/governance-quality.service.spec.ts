/**
 * `GovernanceQualityService` — FR-18.6's quality dashboard and the
 * per-doctor reliability drill-down. `new GovernanceQualityService
 * (mockedDeps)`, hand-rolled `jest.fn()`s.
 */
import { Logger } from '@nestjs/common';
import { COMPLAINT_STATUSES, type ComplaintStatus } from '../../schema/enums.schema';
import type { BookingFacade } from '../booking/booking.facade';
import type { ClinicalFacade } from '../clinical/clinical.facade';
import type { DoctorReliabilityMetrics } from '../doctor/doctor.contract';
import type { DoctorFacade } from '../doctor/doctor.facade';
import type { FollowupFacade } from '../followup/followup.facade';
import type { GovernanceComplaintsPort } from './governance-complaints.contract';
import { GovernanceQualityService } from './governance-quality.service';

function zeroComplaints(): Record<ComplaintStatus, number> {
  return Object.fromEntries(COMPLAINT_STATUSES.map((status) => [status, 0])) as Record<ComplaintStatus, number>;
}

describe('GovernanceQualityService', () => {
  let booking: jest.Mocked<BookingFacade>;
  let clinical: jest.Mocked<ClinicalFacade>;
  let followup: jest.Mocked<FollowupFacade>;
  let doctor: jest.Mocked<DoctorFacade>;
  let complaints: jest.Mocked<GovernanceComplaintsPort>;
  let service: GovernanceQualityService;

  beforeEach(() => {
    booking = { countByStatus: jest.fn() } as unknown as jest.Mocked<BookingFacade>;
    clinical = { countPendingCaseSummaries: jest.fn() } as unknown as jest.Mocked<ClinicalFacade>;
    followup = { countOpenAlertsByType: jest.fn() } as unknown as jest.Mocked<FollowupFacade>;
    doctor = { getReliabilityMetrics: jest.fn() } as unknown as jest.Mocked<DoctorFacade>;
    complaints = { countComplaintsByStatus: jest.fn() };
    service = new GovernanceQualityService(booking, clinical, followup, doctor, complaints);
  });

  describe('getDashboard', () => {
    it('reads `completed` off countByStatus, treating a missing key as 0', async () => {
      booking.countByStatus.mockResolvedValue({});
      clinical.countPendingCaseSummaries.mockResolvedValue(0);
      followup.countOpenAlertsByType.mockResolvedValue({});
      complaints.countComplaintsByStatus.mockResolvedValue(zeroComplaints());

      const dashboard = await service.getDashboard();

      expect(dashboard.completedCases).toBe(0);
    });

    it('splits open alerts into red_flag ("redFlags") and every other type summed ("followUpAlerts")', async () => {
      booking.countByStatus.mockResolvedValue({ completed: 12 });
      clinical.countPendingCaseSummaries.mockResolvedValue(3);
      followup.countOpenAlertsByType.mockResolvedValue({
        red_flag: 4,
        amber: 2,
        missed_checkin: 1,
        medication_side_effect: 0,
        followup_due: 5,
      });
      complaints.countComplaintsByStatus.mockResolvedValue(zeroComplaints());

      const dashboard = await service.getDashboard();

      expect(dashboard.completedCases).toBe(12);
      expect(dashboard.pendingCaseSummaries).toBe(3);
      expect(dashboard.redFlags).toBe(4);
      expect(dashboard.followUpAlerts).toBe(8); // 2 + 1 + 0 + 5
    });

    it('passes the complaints-by-status breakdown straight through', async () => {
      booking.countByStatus.mockResolvedValue({});
      clinical.countPendingCaseSummaries.mockResolvedValue(0);
      followup.countOpenAlertsByType.mockResolvedValue({});
      const counts = { ...zeroComplaints(), open: 7, resolved: 2 };
      complaints.countComplaintsByStatus.mockResolvedValue(counts);

      const dashboard = await service.getDashboard();

      expect(dashboard.complaintsByStatus).toEqual(counts);
    });

    it('reports zero complaints for every status, and does not throw, when the port itself throws', async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      booking.countByStatus.mockResolvedValue({});
      clinical.countPendingCaseSummaries.mockResolvedValue(0);
      followup.countOpenAlertsByType.mockResolvedValue({});
      complaints.countComplaintsByStatus.mockRejectedValue(new Error('M-19 facade unavailable'));

      const dashboard = await service.getDashboard();

      expect(dashboard.complaintsByStatus).toEqual(zeroComplaints());
      jest.restoreAllMocks();
    });

    it('stamps `generatedAt` with a fresh Date', async () => {
      booking.countByStatus.mockResolvedValue({});
      clinical.countPendingCaseSummaries.mockResolvedValue(0);
      followup.countOpenAlertsByType.mockResolvedValue({});
      complaints.countComplaintsByStatus.mockResolvedValue(zeroComplaints());

      const before = Date.now();
      const dashboard = await service.getDashboard();
      const after = Date.now();

      expect(dashboard.generatedAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(dashboard.generatedAt.getTime()).toBeLessThanOrEqual(after);
    });
  });

  describe('getDoctorReliability', () => {
    it('is a thin pass-through to DoctorFacade.getReliabilityMetrics', async () => {
      const metrics: DoctorReliabilityMetrics = {
        acceptanceRate: 0.8,
        noShowRate: 0.1,
        caseSummaryCompletionRate: 0.95,
      };
      doctor.getReliabilityMetrics.mockResolvedValue(metrics);

      const result = await service.getDoctorReliability('doc-1');

      expect(doctor.getReliabilityMetrics).toHaveBeenCalledWith('doc-1');
      expect(result).toBe(metrics);
    });

    it('propagates a rejection (e.g. doctor-not-found) rather than swallowing it', async () => {
      doctor.getReliabilityMetrics.mockRejectedValue(new Error('doctor not found'));

      await expect(service.getDoctorReliability('missing')).rejects.toThrow('doctor not found');
    });
  });
});
