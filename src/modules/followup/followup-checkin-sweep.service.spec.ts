/**
 * `FollowupCheckinSweepService` — FR-13.3/FR-13.5's missed-check-in half, and
 * the `active -> completed` window-close transition. Drives `sweep()`
 * directly with a deterministic `today`, the same discipline
 * `clinical-gate-sweep.service.spec.ts` applies to `sweepFinalisedRecords`.
 */
import type { CheckinResponseRow } from '../../schema/checkin-responses.schema';
import type { FollowupAssignmentRow } from '../../schema/followup-assignments.schema';
import type { FollowupPathwayRow } from '../../schema/followup-pathways.schema';
import type { SafetyAlertRow } from '../../schema/safety-alerts.schema';
import type { BookingFacade } from '../booking/booking.facade';
import { FollowupAlertService } from './followup-alert.service';
import { missedCheckinReason, FollowupCheckinSweepService } from './followup-checkin-sweep.service';
import { FollowupPathwayService } from './followup-pathway.service';
import { FollowupRepository } from './followup.repository';

const CONSULTATION_ID = 'c0000000-0000-4000-8000-000000000001';
const DOCTOR_ID = 'dr000000-0000-4000-8000-000000000001';

function pathwayRow(overrides: Partial<FollowupPathwayRow> = {}): FollowupPathwayRow {
  return {
    id: 'pw000000-0000-4000-8000-000000000001',
    code: 'general',
    name: 'General Follow-up',
    version: 1,
    durationDays: 7,
    questions: [],
    redFlagRules: [],
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

describe('FollowupCheckinSweepService', () => {
  let repo: jest.Mocked<FollowupRepository>;
  let pathways: jest.Mocked<FollowupPathwayService>;
  let alerts: jest.Mocked<FollowupAlertService>;
  let booking: jest.Mocked<BookingFacade>;
  let sweep: FollowupCheckinSweepService;

  beforeEach(() => {
    repo = {
      listActiveAssignments: jest.fn(),
      findCheckin: jest.fn(),
      findOpenMissedCheckinAlertByReason: jest.fn().mockResolvedValue(null),
      updateAssignmentStatus: jest.fn(),
    } as unknown as jest.Mocked<FollowupRepository>;

    pathways = { getByIdOrThrow: jest.fn().mockResolvedValue(pathwayRow()) } as unknown as jest.Mocked<FollowupPathwayService>;
    alerts = { raiseAlert: jest.fn() } as unknown as jest.Mocked<FollowupAlertService>;
    booking = { getBooking: jest.fn().mockResolvedValue({ doctorId: DOCTOR_ID }) } as unknown as jest.Mocked<BookingFacade>;

    sweep = new FollowupCheckinSweepService(repo, pathways, alerts, booking);
  });

  it('raises a missed_checkin alert when yesterday has no check-in row', async () => {
    repo.listActiveAssignments.mockResolvedValueOnce([assignmentRow()]).mockResolvedValueOnce([]);
    repo.findCheckin.mockResolvedValue(null);

    // startsOn 2026-01-01, today 2026-01-03 -> yesterday 2026-01-02, inside the window.
    const result = await sweep.sweep('2026-01-03');

    expect(result.missedCheckinAlertsRaised).toBe(1);
    expect(alerts.raiseAlert).toHaveBeenCalledWith(
      expect.objectContaining({ alertType: 'missed_checkin', consultationId: CONSULTATION_ID, doctorId: DOCTOR_ID, reason: missedCheckinReason('2026-01-02') }),
    );
  });

  it('does not raise when yesterday already has a check-in', async () => {
    repo.listActiveAssignments.mockResolvedValueOnce([assignmentRow()]).mockResolvedValueOnce([]);
    repo.findCheckin.mockResolvedValue({} as CheckinResponseRow);

    const result = await sweep.sweep('2026-01-03');

    expect(result.missedCheckinAlertsRaised).toBe(0);
    expect(alerts.raiseAlert).not.toHaveBeenCalled();
  });

  it('does not re-raise when an open alert for the same missed date already exists (dedup)', async () => {
    repo.listActiveAssignments.mockResolvedValueOnce([assignmentRow()]).mockResolvedValueOnce([]);
    repo.findCheckin.mockResolvedValue(null);
    repo.findOpenMissedCheckinAlertByReason.mockResolvedValue({} as SafetyAlertRow);

    const result = await sweep.sweep('2026-01-03');

    expect(result.missedCheckinAlertsRaised).toBe(0);
    expect(alerts.raiseAlert).not.toHaveBeenCalled();
  });

  it('does nothing when the window started only today (no "yesterday" inside it yet)', async () => {
    repo.listActiveAssignments.mockResolvedValueOnce([assignmentRow({ startsOn: '2026-01-03' })]).mockResolvedValueOnce([]);

    const result = await sweep.sweep('2026-01-03');

    expect(result.missedCheckinAlertsRaised).toBe(0);
    expect(repo.findCheckin).not.toHaveBeenCalled();
  });

  it('moves an assignment to completed once its window has fully elapsed, and skips the missed-check-in check', async () => {
    // startsOn 2026-01-01 + duration 7 -> window ends (exclusive) 2026-01-08.
    repo.listActiveAssignments.mockResolvedValueOnce([assignmentRow()]).mockResolvedValueOnce([]);

    const result = await sweep.sweep('2026-01-08');

    expect(result.assignmentsCompleted).toBe(1);
    expect(repo.updateAssignmentStatus).toHaveBeenCalledWith('as000000-0000-4000-8000-000000000001', 'completed');
    expect(repo.findCheckin).not.toHaveBeenCalled();
  });

  it('a failure reconciling one assignment does not abandon the rest of the batch', async () => {
    const other = assignmentRow({ id: 'as2', consultationId: 'c2' });
    repo.listActiveAssignments.mockResolvedValueOnce([assignmentRow(), other]).mockResolvedValueOnce([]);
    repo.findCheckin.mockRejectedValueOnce(new Error('db down')).mockResolvedValueOnce(null);

    const result = await sweep.sweep('2026-01-03');

    expect(result.failed).toBe(1);
    expect(result.examined).toBe(2);
    expect(result.missedCheckinAlertsRaised).toBe(1);
  });

  it('pages across batches when a page comes back exactly full (a short page ends the scan; a full one may not be)', async () => {
    // `FOLLOWUP_CHECKIN_SWEEP_BATCH_SIZE` is 100 — a page of exactly that size
    // must not be mistaken for "the last page", the same reasoning
    // `clinical-gate-sweep.service.ts` documents for its own keyset paging.
    const fullPage = Array.from({ length: 100 }, (_, i) => assignmentRow({ id: `as-${i}`, consultationId: `c-${i}` }));
    repo.listActiveAssignments.mockResolvedValueOnce(fullPage).mockResolvedValueOnce([]);
    repo.findCheckin.mockResolvedValue({} as CheckinResponseRow);

    const result = await sweep.sweep('2026-01-03');

    expect(result.examined).toBe(100);
    expect(repo.listActiveAssignments).toHaveBeenCalledTimes(2);
    // The second page is requested with a cursor past the last row of the first.
    expect(repo.listActiveAssignments).toHaveBeenNthCalledWith(2, expect.any(Number), 'as-99');
  });
});
