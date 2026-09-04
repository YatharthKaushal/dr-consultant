/**
 * `FollowupService` — pathway assignment, daily check-in, follow-up booking
 * recommendation, and Care Plan composition. `new FollowupService(mockedDeps)`,
 * hand-rolled `jest.fn()`s, never `Test.createTestingModule`.
 */
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { CheckinResponseRow } from '../../schema/checkin-responses.schema';
import type { FollowupAssignmentRow } from '../../schema/followup-assignments.schema';
import type { FollowupPathwayRow } from '../../schema/followup-pathways.schema';
import type { AuditService } from '../../shared/audit/audit.service';
import type { BookingFacade } from '../booking/booking.facade';
import type { ClinicalFacade } from '../clinical/clinical.facade';
import type { CareHubPort } from './followup-care-hub.contract';
import { FollowupAlertService } from './followup-alert.service';
import { FollowupPathwayService } from './followup-pathway.service';
import { FOLLOWUP_ERROR_CODES } from './followup.constants';
import type { SafetyAlertView } from './followup.contract';
import { FollowupService } from './followup.service';
import { FollowupRepository } from './followup.repository';

const CONSULTATION_ID = 'c0000000-0000-4000-8000-000000000001';
const PATIENT_ID = 'pt000000-0000-4000-8000-000000000001';
const DOCTOR_ID = 'dr000000-0000-4000-8000-000000000001';

const QUESTIONS = [
  { id: 'mood', text: 'Mood?', type: 'scale_1_5', required: true },
  { id: 'self_harm', text: 'Self-harm thoughts?', type: 'yes_no', required: true },
];
const RULES = [{ id: 'r1', questionId: 'self_harm', matchValues: ['yes'], severity: 'red', reason: 'Patient reported thoughts of self-harm.' }];

function pathwayRow(overrides: Partial<FollowupPathwayRow> = {}): FollowupPathwayRow {
  return {
    id: 'pw000000-0000-4000-8000-000000000001',
    code: 'general',
    name: 'General Follow-up',
    version: 1,
    durationDays: 7,
    questions: QUESTIONS,
    redFlagRules: RULES,
    isCurrent: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function assignmentRow(overrides: Partial<FollowupAssignmentRow> = {}): FollowupAssignmentRow {
  return {
    id: 'as000000-0000-4000-8000-000000000001',
    consultationId: CONSULTATION_ID,
    pathwayId: 'pw000000-0000-4000-8000-000000000001',
    startsOn: '2026-01-01',
    status: 'active',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function bookingView(overrides: Record<string, unknown> = {}) {
  return {
    id: CONSULTATION_ID,
    referenceCode: 'REF001',
    patientId: PATIENT_ID,
    doctorId: DOCTOR_ID,
    specialtyId: 'sp000000-0000-4000-8000-000000000001',
    concernId: null,
    mode: 'scheduled',
    status: 'completed',
    scheduledStartAt: null,
    durationMinutes: 30,
    intakeAnswers: null,
    rescheduledFromConsultationId: null,
    cancelledAt: null,
    cancelledByParty: null,
    cancellationReason: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

const uniqueViolation = Object.assign(new Error('duplicate key'), { code: '23505' });

describe('FollowupService', () => {
  let repo: jest.Mocked<FollowupRepository>;
  let pathways: jest.Mocked<FollowupPathwayService>;
  let alerts: jest.Mocked<FollowupAlertService>;
  let audit: jest.Mocked<AuditService>;
  let booking: jest.Mocked<BookingFacade>;
  let clinical: jest.Mocked<ClinicalFacade>;
  let careHub: jest.Mocked<CareHubPort>;
  let service: FollowupService;

  beforeEach(() => {
    repo = {
      findAssignmentByConsultationId: jest.fn().mockResolvedValue(null),
      insertAssignment: jest.fn(),
      updateAssignmentStatus: jest.fn(),
      listActiveAssignments: jest.fn().mockResolvedValue([]),
      findCheckin: jest.fn().mockResolvedValue(null),
      listCheckinsForConsultation: jest.fn().mockResolvedValue([]),
      insertCheckin: jest.fn(),
      insertAlert: jest.fn(),
      findOpenMissedCheckinAlertByReason: jest.fn(),
      findAlertById: jest.fn(),
      listAlertsForConsultation: jest.fn().mockResolvedValue([]),
      listOpenAlerts: jest.fn().mockResolvedValue([]),
      acknowledgeAlert: jest.fn(),
      closeAlert: jest.fn(),
      countDataRightsRowsForConsultations: jest
        .fn()
        .mockResolvedValue({ checkinResponses: 0, safetyAlerts: 0, followupAssignments: 0 }),
    } as unknown as jest.Mocked<FollowupRepository>;

    pathways = {
      getCurrentByCodeOrThrow: jest.fn().mockResolvedValue(pathwayRow()),
      getByIdOrThrow: jest.fn().mockResolvedValue(pathwayRow()),
    } as unknown as jest.Mocked<FollowupPathwayService>;

    alerts = {
      raiseAlert: jest.fn(async (input): Promise<SafetyAlertView> => ({
        id: 'al000000-0000-4000-8000-000000000001',
        alertType: input.alertType,
        consultationId: input.consultationId,
        checkinResponseId: input.checkinResponseId,
        reason: input.reason,
        acknowledgedByAdminId: null,
        acknowledgedByDoctorId: null,
        acknowledgedAt: null,
        closedAt: null,
        closingNote: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      })),
      listAlertsForConsultation: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<FollowupAlertService>;

    audit = { write: jest.fn() } as unknown as jest.Mocked<AuditService>;

    booking = { getBooking: jest.fn().mockResolvedValue(bookingView()) } as unknown as jest.Mocked<BookingFacade>;
    clinical = { getCarePlanInputs: jest.fn().mockResolvedValue(null) } as unknown as jest.Mocked<ClinicalFacade>;
    careHub = { getRecommendedForConsultation: jest.fn().mockResolvedValue([]) };

    service = new FollowupService(repo, pathways, alerts, audit, booking, clinical, careHub);
  });

  describe('assignPathway', () => {
    it('pins the CURRENT pathway version at the moment of assignment', async () => {
      repo.insertAssignment.mockResolvedValue(assignmentRow());

      const result = await service.assignPathway({ consultationId: CONSULTATION_ID, pathwayCode: 'general' });

      expect(pathways.getCurrentByCodeOrThrow).toHaveBeenCalledWith('general');
      expect(result.pathwayVersion).toBe(1);
      expect(repo.insertAssignment).toHaveBeenCalledWith(
        expect.objectContaining({ consultationId: CONSULTATION_ID, pathwayId: pathwayRow().id, status: 'active' }),
      );
    });

    it('is idempotent: a second call returns the EXISTING assignment untouched, even if the current version has since changed', async () => {
      const existing = assignmentRow({ pathwayId: 'pw-v1' });
      repo.findAssignmentByConsultationId.mockResolvedValue(existing);
      pathways.getByIdOrThrow.mockResolvedValue(pathwayRow({ id: 'pw-v1', version: 1 }));
      // A newer version is now current — irrelevant to an already-assigned consultation.
      pathways.getCurrentByCodeOrThrow.mockResolvedValue(pathwayRow({ id: 'pw-v2', version: 2 }));

      const result = await service.assignPathway({ consultationId: CONSULTATION_ID, pathwayCode: 'general' });

      expect(result.pathwayVersion).toBe(1);
      expect(repo.insertAssignment).not.toHaveBeenCalled();
    });

    it('throws when the consultation does not exist', async () => {
      booking.getBooking.mockResolvedValue(null);
      await expect(service.assignPathway({ consultationId: 'missing', pathwayCode: 'general' })).rejects.toThrow(NotFoundException);
    });

    it('recovers from a race by reading back what the winner wrote', async () => {
      repo.insertAssignment.mockRejectedValue(uniqueViolation);
      const winner = assignmentRow();
      repo.findAssignmentByConsultationId.mockResolvedValueOnce(null).mockResolvedValueOnce(winner);

      const result = await service.assignPathway({ consultationId: CONSULTATION_ID, pathwayCode: 'general' });
      expect(result.id).toBe(winner.id);
    });
  });

  describe('submitCheckin', () => {
    beforeEach(() => {
      repo.findAssignmentByConsultationId.mockResolvedValue(assignmentRow());
    });

    it('scores green and raises no alert', async () => {
      repo.insertCheckin.mockResolvedValue(checkinRow({ status: 'green' }));

      const result = await service.submitCheckin({
        consultationId: CONSULTATION_ID,
        checkinDate: '2026-01-02',
        answers: { mood: '4', self_harm: 'no' },
        actorPatientId: PATIENT_ID,
      });

      expect(result.response.status).toBe('green');
      expect(result.alertRaised).toBeNull();
      expect(alerts.raiseAlert).not.toHaveBeenCalled();
    });

    it('scores red, raises a red_flag alert with the doctor id, and returns it inline', async () => {
      repo.insertCheckin.mockResolvedValue(checkinRow({ status: 'red' }));

      const result = await service.submitCheckin({
        consultationId: CONSULTATION_ID,
        checkinDate: '2026-01-02',
        answers: { mood: '4', self_harm: 'yes' },
        actorPatientId: PATIENT_ID,
      });

      expect(result.alertRaised).not.toBeNull();
      expect(alerts.raiseAlert).toHaveBeenCalledWith(
        expect.objectContaining({ alertType: 'red_flag', doctorId: DOCTOR_ID, reason: 'Patient reported thoughts of self-harm.' }),
      );
    });

    it('refuses a duplicate (consultationId, checkinDate) with a clean 409', async () => {
      repo.insertCheckin.mockRejectedValue(uniqueViolation);

      await expect(
        service.submitCheckin({
          consultationId: CONSULTATION_ID,
          checkinDate: '2026-01-02',
          answers: { mood: '4', self_harm: 'no' },
          actorPatientId: PATIENT_ID,
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('refuses a check-in for someone else\'s consultation with a 404, not a 403', async () => {
      await expect(
        service.submitCheckin({
          consultationId: CONSULTATION_ID,
          checkinDate: '2026-01-02',
          answers: { mood: '4', self_harm: 'no' },
          actorPatientId: 'someone-else',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    /**
     * *** THE OWNERSHIP CHECK MUST RUN BEFORE ANY ASSIGNMENT/WINDOW CHECK. ***
     * Otherwise a stranger probing a consultation id that is NOT theirs can
     * use this route as an oracle: the assignment-existence and
     * assignment-status checks ran (and produced a DIFFERENT error) before
     * ownership was ever checked, leaking whether that foreign consultation
     * has an active follow-up window at all — exactly the "same 404 a
     * stranger gets" leak `clarification.service.spec.ts#getAssignedCase
     * 404s with the SAME code` guards against in M-17. Both cases below MUST
     * 404 with `CONSULTATION_NOT_FOUND`, identical to the already-covered
     * "someone else's consultation, active assignment" case above — never a
     * 403, and never `ASSIGNMENT_NOT_FOUND`.
     */
    it('refuses a check-in for someone else\'s consultation with the SAME 404 even when THEIR assignment is not active — a stranger must not be able to tell an inactive foreign window from a nonexistent one', async () => {
      repo.findAssignmentByConsultationId.mockResolvedValue(assignmentRow({ status: 'completed' }));

      const rejection = await service
        .submitCheckin({
          consultationId: CONSULTATION_ID,
          checkinDate: '2026-01-02',
          answers: { mood: '4', self_harm: 'no' },
          actorPatientId: 'someone-else',
        })
        .catch((e) => e);

      expect(rejection).toBeInstanceOf(NotFoundException);
      expect(rejection.response.code).toBe(FOLLOWUP_ERROR_CODES.CONSULTATION_NOT_FOUND);
    });

    it('refuses a check-in for someone else\'s consultation with the SAME 404 even when no assignment has been made for it at all — not FOLLOWUP_ASSIGNMENT_NOT_FOUND, which would tell a stranger the consultation exists but is unassigned', async () => {
      repo.findAssignmentByConsultationId.mockResolvedValue(null);

      const rejection = await service
        .submitCheckin({
          consultationId: CONSULTATION_ID,
          checkinDate: '2026-01-02',
          answers: { mood: '4', self_harm: 'no' },
          actorPatientId: 'someone-else',
        })
        .catch((e) => e);

      expect(rejection).toBeInstanceOf(NotFoundException);
      expect(rejection.response.code).toBe(FOLLOWUP_ERROR_CODES.CONSULTATION_NOT_FOUND);
    });

    it('refuses a date outside the pinned window', async () => {
      await expect(
        service.submitCheckin({
          consultationId: CONSULTATION_ID,
          checkinDate: '2026-01-09', // startsOn 2026-01-01 + 7 days -> window ends 2026-01-08
          answers: { mood: '4', self_harm: 'no' },
          actorPatientId: PATIENT_ID,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('refuses a check-in once the assignment is no longer active', async () => {
      repo.findAssignmentByConsultationId.mockResolvedValue(assignmentRow({ status: 'completed' }));
      await expect(
        service.submitCheckin({
          consultationId: CONSULTATION_ID,
          checkinDate: '2026-01-02',
          answers: { mood: '4', self_harm: 'no' },
          actorPatientId: PATIENT_ID,
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('recommendFollowUpBooking', () => {
    it('recommends the treating doctor by default (not urgent)', async () => {
      const result = await service.recommendFollowUpBooking(CONSULTATION_ID, false);
      expect(result.recommendedDoctorId).toBe(DOCTOR_ID);
      expect(result.sameDoctor).toBe(true);
      expect(result.urgent).toBe(false);
    });

    it('signals sameDoctor: false when urgent, without inventing an "earliest available" doctor it cannot resolve', async () => {
      const result = await service.recommendFollowUpBooking(CONSULTATION_ID, true);
      expect(result.sameDoctor).toBe(false);
      expect(result.urgent).toBe(true);
    });
  });

  describe('getCarePlan', () => {
    it('composes prescription, check-ins, follow-up window, booking and self-help without storing anything of its own', async () => {
      clinical.getCarePlanInputs.mockResolvedValue({
        consultationId: CONSULTATION_ID,
        medicines: [{ name: 'Sertraline', dose: '50mg', frequency: 'OD', duration: '4 weeks' }],
        advice: { covered: null, homePractice: null, nextFocus: null, warningSigns: 'Seek help if symptoms worsen.' },
        finalisedAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      repo.listCheckinsForConsultation.mockResolvedValue([checkinRow()]);
      repo.findAssignmentByConsultationId.mockResolvedValue(assignmentRow());
      careHub.getRecommendedForConsultation.mockResolvedValue([{ contentId: 'x', title: 'Breathing exercise', kind: 'self_help_tool' }]);

      const plan = await service.getCarePlan(CONSULTATION_ID);

      expect(plan.prescription?.medicines).toHaveLength(1);
      expect(plan.checkins).toHaveLength(1);
      expect(plan.followUp?.pathwayCode).toBe('general');
      expect(plan.booking?.doctorId).toBe(DOCTOR_ID);
      expect(plan.recommendedSelfHelp).toHaveLength(1);
      expect(plan.recommendedFollowUpBooking).not.toBeNull();
    });

    it('returns prescription: null when the clinical record has not been finalised', async () => {
      clinical.getCarePlanInputs.mockResolvedValue(null);
      const plan = await service.getCarePlan(CONSULTATION_ID);
      expect(plan.prescription).toBeNull();
    });

    it('degrades to an empty self-help list rather than failing when the Care Hub port throws', async () => {
      careHub.getRecommendedForConsultation.mockRejectedValue(new Error('down'));
      const plan = await service.getCarePlan(CONSULTATION_ID);
      expect(plan.recommendedSelfHelp).toEqual([]);
    });
  });

  describe('countDataRightsRowsForConsultations (ADDITIVE, M-21/data rights execution)', () => {
    it('returns all-zero WITHOUT querying the repository when given an empty array', async () => {
      const result = await service.countDataRightsRowsForConsultations([]);

      expect(result).toEqual({ checkinResponses: 0, safetyAlerts: 0, followupAssignments: 0 });
      expect(repo.countDataRightsRowsForConsultations).not.toHaveBeenCalled();
    });

    it('delegates a non-empty id list straight to the repository', async () => {
      repo.countDataRightsRowsForConsultations.mockResolvedValue({
        checkinResponses: 3,
        safetyAlerts: 1,
        followupAssignments: 1,
      });

      const result = await service.countDataRightsRowsForConsultations([CONSULTATION_ID]);

      expect(repo.countDataRightsRowsForConsultations).toHaveBeenCalledWith([CONSULTATION_ID]);
      expect(result).toEqual({ checkinResponses: 3, safetyAlerts: 1, followupAssignments: 1 });
    });
  });
});

function checkinRow(overrides: Partial<CheckinResponseRow> = {}): CheckinResponseRow {
  return {
    id: 'ck000000-0000-4000-8000-000000000001',
    consultationId: CONSULTATION_ID,
    checkinDate: '2026-01-02',
    answers: { mood: '4', self_harm: 'no' },
    status: 'green',
    submittedAt: new Date('2026-01-02T00:00:00.000Z'),
    ...overrides,
  };
}
