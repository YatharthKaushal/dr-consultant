import type { ConsultationRow } from '../../schema/consultations.schema';
import { BookingFacade } from './booking.facade';

/**
 * The facade is this module's ONLY public surface (`backend/README.md` §2), so
 * what is missing from it is as much a defect as what is wrong on it. These
 * tests pin the M-12 seam method in particular — see `confirmPayment` below.
 */

const CONSULTATION_ID = '66666666-6666-4666-8666-666666666666';
const DOCTOR_ID = '33333333-3333-4333-8333-333333333333';

function makeRow(overrides: Partial<ConsultationRow> = {}): ConsultationRow {
  return {
    id: CONSULTATION_ID,
    referenceCode: 'DRC-TEST-000001',
    patientId: '11111111-1111-4111-8111-111111111111',
    doctorId: DOCTOR_ID,
    specialtyId: '55555555-5555-4555-8555-555555555555',
    concernId: null,
    mode: 'scheduled',
    status: 'scheduled',
    scheduledStartAt: new Date('2026-03-02T10:00:00.000Z'),
    durationMinutes: 30,
    holdExpiresAt: null,
    intakeAnswers: null,
    rescheduledFromConsultationId: null,
    followupOfConsultationId: null,
    cancelledAt: null,
    cancelledByParty: null,
    cancellationReason: null,
    followupPathwayId: null,
    followupStartsOn: null,
    followupStatus: 'none',
    extraCheckinQuestions: [],
    feedbackRating: null,
    feedbackComment: null,
    createdAt: new Date('2026-03-01T09:00:00.000Z'),
    updatedAt: new Date('2026-03-01T09:00:00.000Z'),
    ...overrides,
  } as ConsultationRow;
}

function buildHarness() {
  const repo = {
    listBusyIntervals: jest.fn(async () => []),
    listBusyIntervalsForMany: jest.fn(async () => []),
    findById: jest.fn(async () => makeRow()),
    listConsultationIdsBetween: jest.fn(async () => []),
    listConsultationIdsForPatient: jest.fn(async () => []),
  };
  const service = {
    createInstantBooking: jest.fn(async () => makeRow()),
    assignDoctor: jest.fn(async () => makeRow()),
    transitionConsultationStatus: jest.fn(async () => ({ changed: true, booking: makeRow({ status: 'in_progress' }) })),
  };
  const holds = { confirmPayment: jest.fn(async () => makeRow({ status: 'scheduled', holdExpiresAt: null })) };

  const facade = new BookingFacade(repo as never, service as never, holds as never);
  return { facade, repo, service, holds };
}

describe('BookingFacade — the M-12 seam', () => {
  /**
   * *** THE DEFECT THIS PINS. *** `BookingSlotHoldService.confirmPayment` — the
   * paid -> scheduled transition, and the entry point its own doc comment
   * describes as handling "the ordinary case" of a capture webhook — was not on
   * `BookingContract` or `BookingFacade`. Nothing outside this module could
   * reach it (verified by grep: no reference to `confirmPayment`,
   * `BookingFacade` or `BookingSlotHoldService` existed anywhere outside
   * `src/modules/booking/`). The only route from a captured payment to a
   * `scheduled` booking was therefore the expiry sweep, which by construction
   * examines only holds that have ALREADY LAPSED — so a patient who paid
   * successfully stayed `pending_payment` until their hold ran out.
   */
  it('exposes confirmPayment so a captured payment has a public route to the booking', async () => {
    const h = buildHarness();
    const view = await h.facade.confirmPayment(CONSULTATION_ID);

    expect(h.holds.confirmPayment).toHaveBeenCalledWith(CONSULTATION_ID);
    expect(view).toMatchObject({ id: CONSULTATION_ID, status: 'scheduled' });
  });

  it('returns the mapped view, never the raw row', async () => {
    const h = buildHarness();
    const view = (await h.facade.confirmPayment(CONSULTATION_ID)) as unknown as Record<string, unknown>;
    // `toBookingView` is the module's outward shape; internal columns stay in.
    expect(view).not.toHaveProperty('holdExpiresAt');
    expect(view).not.toHaveProperty('updatedAt');
  });

  it('propagates a not-found rather than inventing a booking', async () => {
    const h = buildHarness();
    h.holds.confirmPayment.mockRejectedValueOnce(Object.assign(new Error('nope'), { status: 404 }));
    await expect(h.facade.confirmPayment(CONSULTATION_ID)).rejects.toMatchObject({ status: 404 });
  });
});

/**
 * ADDITIVE (M-14). The one method the video module needed, and the reason it
 * did not have to reach into `consultations` itself.
 */
describe('BookingFacade — the M-14 seam', () => {
  it('exposes transitionConsultationStatus, passing the caller-supplied from-set straight through', async () => {
    const h = buildHarness();

    const result = await h.facade.transitionConsultationStatus({
      consultationId: CONSULTATION_ID,
      to: 'in_progress',
      from: ['scheduled'],
      reason: 'video_participant_joined',
    });

    expect(h.service.transitionConsultationStatus).toHaveBeenCalledWith({
      consultationId: CONSULTATION_ID,
      to: 'in_progress',
      from: ['scheduled'],
      reason: 'video_participant_joined',
    });
    expect(result).toMatchObject({ changed: true, booking: { id: CONSULTATION_ID, status: 'in_progress' } });
  });

  it('returns the mapped view, never the raw row', async () => {
    const h = buildHarness();

    const result = await h.facade.transitionConsultationStatus({
      consultationId: CONSULTATION_ID,
      to: 'in_progress',
      from: ['scheduled'],
    });

    // `hold_expires_at` is this module's internal slot mechanism and must not
    // cross the facade, least of all to a module that receives webhooks.
    expect(result.booking).not.toHaveProperty('holdExpiresAt');
  });

  it('carries a refusal across rather than throwing — the caller must answer 2xx', async () => {
    const h = buildHarness();
    h.service.transitionConsultationStatus.mockResolvedValueOnce({
      changed: false,
      booking: null,
      refusal: 'not_found',
    } as never);

    await expect(
      h.facade.transitionConsultationStatus({ consultationId: CONSULTATION_ID, to: 'in_progress', from: ['scheduled'] }),
    ).resolves.toEqual({ changed: false, booking: null, refusal: 'not_found' });
  });

  it('omits `refusal` entirely on success, so a caller can test for its presence', async () => {
    const h = buildHarness();

    const result = await h.facade.transitionConsultationStatus({
      consultationId: CONSULTATION_ID,
      to: 'in_progress',
      from: ['scheduled'],
    });

    expect(Object.prototype.hasOwnProperty.call(result, 'refusal')).toBe(false);
  });
});
