import { COMPLAINT_STATUSES } from '../../schema/enums.schema';
import type { ComplaintService } from './complaint.service';
import { FeedbackFacade } from './feedback.facade';
import type { FeedbackService } from './feedback.service';

/** Hand-rolled `jest.fn()` collaborators — never `Test.createTestingModule`. */
function createDeps() {
  const complaints = {
    countComplaintsByStatus: jest.fn(),
    countByPatientId: jest.fn(),
  } as unknown as jest.Mocked<ComplaintService>;
  const feedback = {
    countByPatientId: jest.fn(),
  } as unknown as jest.Mocked<FeedbackService>;

  const facade = new FeedbackFacade(complaints, feedback);
  return { facade, complaints, feedback };
}

describe('FeedbackFacade', () => {
  it('countComplaintsByStatus delegates to ComplaintService', async () => {
    const { facade, complaints } = createDeps();
    const zeroed = Object.fromEntries(COMPLAINT_STATUSES.map((s) => [s, 0])) as Record<(typeof COMPLAINT_STATUSES)[number], number>;
    complaints.countComplaintsByStatus.mockResolvedValue(zeroed);

    await expect(facade.countComplaintsByStatus()).resolves.toEqual(zeroed);
  });

  describe('countDataRightsRowsForPatient', () => {
    it('combines the feedback count and the complaints count for one patient', async () => {
      const { facade, complaints, feedback } = createDeps();
      feedback.countByPatientId.mockResolvedValue(1);
      complaints.countByPatientId.mockResolvedValue(2);

      await expect(facade.countDataRightsRowsForPatient('patient-1')).resolves.toEqual({
        feedback: 1,
        complaints: 2,
      });
      expect(feedback.countByPatientId).toHaveBeenCalledWith('patient-1');
      expect(complaints.countByPatientId).toHaveBeenCalledWith('patient-1');
    });
  });
});
