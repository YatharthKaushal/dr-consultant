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
  const service = { createInstantBooking: jest.fn(async () => makeRow()), assignDoctor: jest.fn(async () => makeRow()) };
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
