import type { ConsultationRow } from '../../schema/consultations.schema';
import { DEFAULT_CANCELLATION_POLICY } from './booking-policy.engine';
import { BookingService, type BookingActor } from './booking.service';

/**
 * Unit tests for the booking lifecycle. Convention throughout this repo:
 * `new Service(mockedDeps)` with hand-rolled `jest.fn()`s, never
 * `Test.createTestingModule`.
 *
 * The REAL `23505` — an actual Postgres unique violation from the partial
 * index, under real concurrency — is proved in
 * `booking.slot-race.integration.spec.ts`. Here it is simulated with the
 * driver's own error shape so the CONVERSION (`23505` -> 409, never a 500)
 * is covered on every path that writes a slot.
 */

const PATIENT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_PATIENT_ID = '22222222-2222-4222-8222-222222222222';
const DOCTOR_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_DOCTOR_ID = '44444444-4444-4444-8444-444444444444';
const SPECIALTY_ID = '55555555-5555-4555-8555-555555555555';
const CONSULTATION_ID = '66666666-6666-4666-8666-666666666666';
const NEW_CONSULTATION_ID = '77777777-7777-4777-8777-777777777777';
const PAYMENT_ID = '88888888-8888-4888-8888-888888888888';

/** The shape `node-postgres` throws for a unique-constraint violation — what `isUniqueConstraintViolation` duck-types on. */
function uniqueViolation(constraint = 'consultations_doctor_slot_unique_idx'): Error & { code: string; constraint: string } {
  return Object.assign(new Error(`duplicate key value violates unique constraint "${constraint}"`), {
    code: '23505',
    constraint,
  });
}

function makeRow(overrides: Partial<ConsultationRow> = {}): ConsultationRow {
  return {
    id: CONSULTATION_ID,
    referenceCode: 'DRC-TEST-000001',
    patientId: PATIENT_ID,
    doctorId: DOCTOR_ID,
    specialtyId: SPECIALTY_ID,
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

/** Loose mock aliases: every `jest.fn()` here is deliberately untyped so a test can resolve `null`, an error, or a partial shape without fighting inference. */
type Fn = jest.Mock;

interface Harness {
  db: { transaction: Fn };
  repo: Record<string, Fn>;
  patients: Record<string, Fn>;
  doctors: Record<string, Fn>;
  catalogue: Record<string, Fn>;
  availability: Record<string, Fn>;
  documents: Record<string, Fn>;
  payments: Record<string, Fn>;
  appConfig: Record<string, Fn>;
  audit: Record<string, Fn>;
}

function buildHarness(overrides: Partial<Harness> = {}) {
  const db: { transaction: Fn } = { transaction: jest.fn() };
  db.transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(db));

  const repo: Record<string, Fn> = {
    insert: jest.fn(async (values: Record<string, unknown>) => makeRow({ id: NEW_CONSULTATION_ID, ...values } as Partial<ConsultationRow>)),
    findById: jest.fn(async () => makeRow()),
    findByIdForUpdate: jest.fn(async () => makeRow()),
    updateStatusIfIn: jest.fn(async (_id: string, _from: unknown, patch: Partial<ConsultationRow>) => makeRow(patch)),
    movePaymentToConsultation: jest.fn(async () => undefined),
    referenceCodeExists: jest.fn(async () => false),
    hasPriorConsultation: jest.fn(async () => false),
    listForParty: jest.fn(async () => []),
    listForAdmin: jest.fn(async () => []),
    listAdminResolutionQueue: jest.fn(async () => []),
    isSlotOccupied: jest.fn(async () => false),
    hasOccupyingOverlap: jest.fn(async () => false),
    findBilledConsultationFee: jest.fn(async () => '750.00'),
    // ADDITIVE (M-13): the candidate query behind the instant payment sweep.
    listExpiredInstantHolds: jest.fn(async () => []),
  };

  const patients: Record<string, Fn> = {
    getProfileSummary: jest.fn(async () => ({ id: PATIENT_ID, fullName: 'Test Patient' })),
  };

  const doctors: Record<string, Fn> = {
    getPublicProfile: jest.fn(async () => ({
      id: DOCTOR_ID,
      consultationFeeInr: '750.00',
      consultationDurationMinutes: 30,
      specialties: [{ id: SPECIALTY_ID, code: 'gen', name: 'General', isPrimary: true }],
    })),
    isVerifiedAndListed: jest.fn(async () => true),
  };

  const catalogue: Record<string, Fn> = {
    getSpecialtyById: jest.fn(async () => ({ id: SPECIALTY_ID, isActive: true })),
    getConcernById: jest.fn(async () => ({ id: 'c', specialtyId: SPECIALTY_ID })),
  };

  const availability: Record<string, Fn> = { isSlotBookable: jest.fn(async () => ({ bookable: true })) };

  const documents: Record<string, Fn> = {
    getPatientFileById: jest.fn(async () => ({ id: 'f', patientId: PATIENT_ID, fileName: 'report.pdf' })),
  };

  const payments: Record<string, Fn> = {
    quote: jest.fn(async () => ({ totalPayable: '885.00' })),
    createOrderForConsultation: jest.fn(async () => ({
      paymentId: PAYMENT_ID,
      gatewayOrderId: 'order_test_1',
      gatewayKeyId: 'rzp_test_key',
      breakdown: { totalPayable: '885.00' },
    })),
    getByConsultationId: jest.fn(async () => ({ paymentId: PAYMENT_ID, status: 'paid', paidAt: new Date() })),
    reconcileWithGateway: jest.fn(async () => ({ status: 'paid', changed: false })),
    createRefund: jest.fn(async () => ({ refundId: 'rfnd_1', status: 'pending' })),
  };

  const appConfig: Record<string, Fn> = {
    getNumber: jest.fn(async (_key: string, fallback: number) => fallback),
    getJson: jest.fn(async () => DEFAULT_CANCELLATION_POLICY),
  };

  const audit: Record<string, Fn> = { write: jest.fn(async () => undefined) };

  const deps: Harness = { db, repo, patients, doctors, catalogue, availability, documents, payments, appConfig, audit, ...overrides };

  const service = new BookingService(
    deps.db as never,
    deps.repo as never,
    deps.patients as never,
    deps.doctors as never,
    deps.catalogue as never,
    deps.availability as never,
    deps.documents as never,
    deps.payments as never,
    deps.appConfig as never,
    deps.audit as never,
  );

  return { service, ...deps };
}

const PATIENT: BookingActor = { party: 'patient', accountId: PATIENT_ID };
const OTHER_PATIENT: BookingActor = { party: 'patient', accountId: OTHER_PATIENT_ID };
const DOCTOR: BookingActor = { party: 'doctor', accountId: DOCTOR_ID };
const OTHER_DOCTOR: BookingActor = { party: 'doctor', accountId: OTHER_DOCTOR_ID };

describe('BookingService.createBooking', () => {
  const input = {
    patientId: PATIENT_ID,
    doctorId: DOCTOR_ID,
    specialtyId: SPECIALTY_ID,
    scheduledStartAt: new Date('2026-03-02T10:00:00.000Z'),
  };

  it('creates a pending_payment hold and returns the gateway order', async () => {
    const h = buildHarness();
    const result = await h.service.createBooking(input, PATIENT);

    const inserted = h.repo.insert.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted.status).toBe('pending_payment');
    expect(inserted.holdExpiresAt).toBeInstanceOf(Date);
    expect(result.payment.gatewayOrderId).toBe('order_test_1');
  });

  /**
   * *** THIS ASSERTION USED TO BE FLAKY, AND THE FLAKE WAS REAL. ***
   *
   * It read `heldForMinutes = (holdExpiresAt - before) / 60_000` and asserted
   * `<= 45`, where `before` was sampled in the TEST and `holdExpiresAt` is
   * built inside `createBooking` from a LATER `new Date()`. So the value is
   * `45 + elapsed`, and the upper bound only held while `elapsed` rounded to
   * zero milliseconds — true on an idle machine, false the moment the process
   * is descheduled mid-call. Under a full-suite run (91 suites across parallel
   * workers) that happens occasionally, which is exactly the "passes in
   * isolation, fails once under load" signature. Measured directly: with
   * ~111ms of elapsed time the expression evaluates to 45.00185.
   *
   * Bounding it on BOTH sides of the call makes it deterministic without
   * weakening it — the hold must still be exactly 45 minutes past a clock read
   * taken during the call, which is the property the config key is about.
   */
  it('sets hold_expires_at from booking.slot_hold_minutes', async () => {
    const h = buildHarness();
    h.appConfig.getNumber.mockResolvedValueOnce(45);

    const before = Date.now();
    await h.service.createBooking(input, PATIENT);
    const after = Date.now();
    const inserted = h.repo.insert.mock.calls[0][0] as { holdExpiresAt: Date };

    const fortyFiveMinutes = 45 * 60_000;
    expect(inserted.holdExpiresAt.getTime()).toBeGreaterThanOrEqual(before + fortyFiveMinutes);
    expect(inserted.holdExpiresAt.getTime()).toBeLessThanOrEqual(after + fortyFiveMinutes);
  });

  it('reads the hold length from the config key, and falls back when it is non-positive', async () => {
    const h = buildHarness();
    h.appConfig.getNumber.mockResolvedValueOnce(0);

    const before = Date.now();
    await h.service.createBooking(input, PATIENT);
    const inserted = h.repo.insert.mock.calls[0][0] as { holdExpiresAt: Date };

    // A `0`/negative config value must not mint an already-expired hold.
    expect(h.appConfig.getNumber).toHaveBeenCalledWith('booking.slot_hold_minutes', 20);
    expect(inserted.holdExpiresAt.getTime()).toBeGreaterThanOrEqual(before + 20 * 60_000);
  });

  it('writes the creation audit entry inside the transaction', async () => {
    const h = buildHarness();
    await h.service.createBooking(input, PATIENT);
    // Second argument present = transactional write, which is what makes the
    // audit roll back with the row it describes.
    expect(h.audit.write).toHaveBeenCalledWith(expect.objectContaining({ action: 'create' }), h.db);
  });

  /* ── THE SLOT GUARANTEE ─────────────────────────────────────────────────── */

  it('converts the partial index’s 23505 into a 409, never a 500', async () => {
    const h = buildHarness();
    h.repo.insert.mockRejectedValueOnce(uniqueViolation());

    await expect(h.service.createBooking(input, PATIENT)).rejects.toMatchObject({
      status: 409,
      response: { code: 'SLOT_ALREADY_TAKEN' },
    });
  });

  it('rejects a slot availability says is unbookable, carrying the reason through', async () => {
    const h = buildHarness();
    h.availability.isSlotBookable.mockResolvedValueOnce({ bookable: false, reason: 'already_taken' });

    await expect(h.service.createBooking(input, PATIENT)).rejects.toMatchObject({
      status: 409,
      response: { code: 'SLOT_NOT_BOOKABLE', reason: 'already_taken' },
    });
    expect(h.repo.insert).not.toHaveBeenCalled();
  });

  it('still consults isSlotBookable even though the index is authoritative — the index only guards equal start times', async () => {
    const h = buildHarness();
    await h.service.createBooking(input, PATIENT);
    expect(h.availability.isSlotBookable).toHaveBeenCalledWith(DOCTOR_ID, input.scheduledStartAt);
  });

  /* ── Validation gates ───────────────────────────────────────────────────── */

  it('rejects an unknown patient', async () => {
    const h = buildHarness();
    h.patients.getProfileSummary.mockResolvedValueOnce(null);
    await expect(h.service.createBooking(input, PATIENT)).rejects.toMatchObject({ response: { code: 'PATIENT_NOT_FOUND' } });
  });

  it('rejects an unverified or unlisted doctor', async () => {
    const h = buildHarness();
    h.doctors.isVerifiedAndListed.mockResolvedValueOnce(false);
    await expect(h.service.createBooking(input, PATIENT)).rejects.toMatchObject({ response: { code: 'DOCTOR_NOT_BOOKABLE' } });
  });

  it('rejects an inactive specialty', async () => {
    const h = buildHarness();
    h.catalogue.getSpecialtyById.mockResolvedValueOnce({ id: SPECIALTY_ID, isActive: false });
    await expect(h.service.createBooking(input, PATIENT)).rejects.toMatchObject({ response: { code: 'SPECIALTY_NOT_BOOKABLE' } });
  });

  it('rejects a doctor who does not practise the booked specialty, before the composite FK can fire', async () => {
    const h = buildHarness();
    h.doctors.getPublicProfile.mockResolvedValueOnce({
      id: DOCTOR_ID,
      consultationFeeInr: '750.00',
      consultationDurationMinutes: 30,
      specialties: [{ id: 'a-different-specialty', code: 'x', name: 'X', isPrimary: true }],
    });
    await expect(h.service.createBooking(input, PATIENT)).rejects.toMatchObject({
      status: 400,
      response: { code: 'DOCTOR_SPECIALTY_MISMATCH' },
    });
  });

  it('rejects a concern belonging to another specialty', async () => {
    const h = buildHarness();
    h.catalogue.getConcernById.mockResolvedValueOnce({ id: 'c', specialtyId: 'another-specialty' });
    await expect(
      h.service.createBooking({ ...input, concernId: '99999999-9999-4999-8999-999999999999' }, PATIENT),
    ).rejects.toMatchObject({ response: { code: 'CONCERN_NOT_BOOKABLE' } });
  });

  /**
   * A reference-code allocation failure is a transient SERVER problem, not a
   * client one. It used to reuse `INVALID_STATE_TRANSITION` — a 409 whose whole
   * meaning is "this booking is in a state that forbids what you asked", and
   * which clients read `currentStatus` off — for a booking that has no state
   * yet and a caller who did nothing wrong.
   */
  it('reports a reference-code allocation failure as a retryable server error, not an invalid state transition', async () => {
    const h = buildHarness();
    h.repo.referenceCodeExists.mockResolvedValue(true); // every candidate collides

    const error = await h.service.createBooking(input, PATIENT).catch((e: unknown) => e);

    expect(error).toMatchObject({ status: 503, response: { code: 'REFERENCE_ALLOCATION_FAILED' } });
    expect(JSON.stringify(error)).not.toContain('currentStatus');
    expect(h.repo.insert).not.toHaveBeenCalled();
  });

  /* ── THE PAYMENT PORT MUST NEVER LEAK ───────────────────────────────────── */

  it('wraps ANY payment-port throw as PAYMENT_SETUP_FAILED — the raw error never reaches the patient', async () => {
    const h = buildHarness();
    h.payments.createOrderForConsultation.mockRejectedValueOnce(
      Object.assign(new Error('Razorpay: BAD_REQUEST_ERROR key_id is invalid'), {
        response: { code: 'PAYMENT_PORT_UNAVAILABLE' },
      }),
    );

    const error = await h.service.createBooking(input, PATIENT).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 409, response: { code: 'PAYMENT_SETUP_FAILED' } });
    // No gateway wording, no port code, nothing internal.
    expect(JSON.stringify(error)).not.toContain('Razorpay');
    expect(JSON.stringify(error)).not.toContain('PAYMENT_PORT_UNAVAILABLE');
  });

  it('leaves NO orphan hold when payment setup fails — the consultation is released to expired', async () => {
    const h = buildHarness();
    h.payments.createOrderForConsultation.mockRejectedValueOnce(new Error('gateway down'));

    await expect(h.service.createBooking(input, PATIENT)).rejects.toMatchObject({ response: { code: 'PAYMENT_SETUP_FAILED' } });

    // The compensating action ran: status -> expired, which is NOT in the
    // partial index's occupying list, so the slot is genuinely free again.
    expect(h.repo.updateStatusIfIn).toHaveBeenCalledWith(
      NEW_CONSULTATION_ID,
      ['pending_payment'],
      expect.objectContaining({ status: 'expired', holdExpiresAt: null }),
      h.db,
    );
  });

  it('still surfaces PAYMENT_SETUP_FAILED when even the compensating release fails — the sweep is the backstop', async () => {
    const h = buildHarness();
    h.payments.createOrderForConsultation.mockRejectedValueOnce(new Error('gateway down'));
    h.repo.updateStatusIfIn.mockRejectedValueOnce(new Error('db blip during compensation'));

    await expect(h.service.createBooking(input, PATIENT)).rejects.toMatchObject({ response: { code: 'PAYMENT_SETUP_FAILED' } });
  });
});

describe('BookingService.cancel', () => {
  it('cancels, frees the slot and clears the hold', async () => {
    const h = buildHarness();
    h.payments.getByConsultationId.mockResolvedValueOnce(null);

    await h.service.cancel(CONSULTATION_ID, PATIENT, 'Changed my mind');

    expect(h.repo.updateStatusIfIn).toHaveBeenCalledWith(
      CONSULTATION_ID,
      expect.arrayContaining(['scheduled']),
      expect.objectContaining({ status: 'cancelled', cancelledByParty: 'patient', holdExpiresAt: null }),
      h.db,
    );
  });

  it('takes the row lock before mutating', async () => {
    const h = buildHarness();
    h.payments.getByConsultationId.mockResolvedValueOnce(null);
    await h.service.cancel(CONSULTATION_ID, PATIENT, null);
    expect(h.repo.findByIdForUpdate).toHaveBeenCalledWith(CONSULTATION_ID, h.db);
  });

  /* ── INSIDE POLICY -> AUTOMATIC REFUND (deliberate FR-7.7 deviation) ────── */

  it('auto-refunds inside policy with isAutomatic true and no admin id', async () => {
    const h = buildHarness();
    // 30 hours of notice -> the 24h/100% tier.
    const start = new Date(Date.now() + 30 * 3_600_000);
    h.repo.findByIdForUpdate.mockResolvedValueOnce(makeRow({ scheduledStartAt: start }));
    h.repo.updateStatusIfIn.mockResolvedValueOnce(
      makeRow({ status: 'cancelled', scheduledStartAt: start, cancelledByParty: 'patient' }),
    );

    await h.service.cancel(CONSULTATION_ID, PATIENT, null);

    expect(h.payments.createRefund).toHaveBeenCalledWith({
      paymentId: PAYMENT_ID,
      // *** THE FEE-BASED AMOUNT IS NOW THE LEGACY FALLBACK. ***
      // It still governs a payment with no quote, which has no per-component
      // breakdown to apportion a tax reversal against.
      amount: '750.00',
      reason: expect.stringContaining('100%'),
      initiatedByAdminId: null,
      isAutomatic: true,
      // *** AND THE PERCENTAGE IS THE NEW BASE. ***
      // M-12 prefers this whenever the payment was priced by the pricing engine,
      // computing it against the CAPTURED TOTAL rather than the consultation
      // fee — so a 100% tier on a 618.00 bill returns 618.00, not the 500.00
      // fee. THIS IS A COMMERCIAL CHANGE AND IT NEEDS THE CLIENT'S SIGN-OFF.
      refundPct: 100,
    });
  });

  it('refunds the partial percentage at middle-tier notice', async () => {
    const h = buildHarness();
    const start = new Date(Date.now() + 5 * 3_600_000);
    h.repo.findByIdForUpdate.mockResolvedValueOnce(makeRow({ scheduledStartAt: start }));
    h.repo.updateStatusIfIn.mockResolvedValueOnce(
      makeRow({ status: 'cancelled', scheduledStartAt: start, cancelledByParty: 'patient' }),
    );

    await h.service.cancel(CONSULTATION_ID, PATIENT, null);

    expect(h.payments.createRefund).toHaveBeenCalledWith(expect.objectContaining({ amount: '375.00', isAutomatic: true }));
  });

  /* ── OUTSIDE POLICY -> ADMIN QUEUE, NO REFUND CALL ──────────────────────── */

  it('routes an already-started cancellation to the admin queue and raises NO refund', async () => {
    const h = buildHarness();
    const start = new Date(Date.now() - 60_000);
    h.repo.findByIdForUpdate.mockResolvedValueOnce(makeRow({ scheduledStartAt: start }));
    h.repo.updateStatusIfIn.mockResolvedValueOnce(
      makeRow({ status: 'cancelled', scheduledStartAt: start, cancelledByParty: 'patient' }),
    );

    await h.service.cancel(CONSULTATION_ID, PATIENT, null);

    expect(h.payments.createRefund).not.toHaveBeenCalled();
    expect(h.audit.write).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'booking_admin_resolution',
        metadata: expect.objectContaining({ kind: 'refund_needs_review', reason: 'already_started' }),
      }),
    );
  });

  it('routes a doctor-initiated cancellation to the admin queue rather than pricing it on the patient’s tiers', async () => {
    const h = buildHarness();
    const start = new Date(Date.now() + 5 * 3_600_000);
    h.repo.findByIdForUpdate.mockResolvedValueOnce(makeRow({ scheduledStartAt: start }));
    h.repo.updateStatusIfIn.mockResolvedValueOnce(
      makeRow({ status: 'cancelled', scheduledStartAt: start, cancelledByParty: 'doctor' }),
    );

    await h.service.cancel(CONSULTATION_ID, DOCTOR, 'Emergency');

    expect(h.payments.createRefund).not.toHaveBeenCalled();
    expect(h.audit.write).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ reason: 'not_cancelled_by_patient' }) }),
    );
  });

  it('makes no refund call when the policy says 0% — that is a definite answer, not an ambiguity', async () => {
    const h = buildHarness();
    const start = new Date(Date.now() + 30 * 60_000);
    h.repo.findByIdForUpdate.mockResolvedValueOnce(makeRow({ scheduledStartAt: start }));
    h.repo.updateStatusIfIn.mockResolvedValueOnce(
      makeRow({ status: 'cancelled', scheduledStartAt: start, cancelledByParty: 'patient' }),
    );

    await h.service.cancel(CONSULTATION_ID, PATIENT, null);

    expect(h.payments.createRefund).not.toHaveBeenCalled();
    expect(h.audit.write).not.toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'booking_admin_resolution' }),
    );
  });

  /**
   * The refund base must be what the patient WAS BILLED, not the doctor's
   * current list price. A doctor who lowers their fee mid-flight would
   * otherwise shrink every pending cancellation's refund while the audit entry
   * still claimed the full percentage — a short refund that reads as complete.
   */
  it('prices the refund off the BILLED fee, not the doctor’s current profile fee', async () => {
    const h = buildHarness();
    const start = new Date(Date.now() + 30 * 3_600_000); // 30h notice -> 100% tier
    h.repo.findByIdForUpdate.mockResolvedValueOnce(makeRow({ scheduledStartAt: start }));
    h.repo.updateStatusIfIn.mockResolvedValueOnce(
      makeRow({ status: 'cancelled', scheduledStartAt: start, cancelledByParty: 'patient' }),
    );
    // The patient paid 750; the doctor has since dropped their price to 500.
    h.repo.findBilledConsultationFee.mockResolvedValueOnce('750.00');
    h.doctors.getPublicProfile.mockResolvedValue({
      id: DOCTOR_ID,
      consultationFeeInr: '500.00',
      consultationDurationMinutes: 30,
      specialties: [{ id: SPECIALTY_ID, code: 'gen', name: 'General', isPrimary: true }],
    });

    await h.service.cancel(CONSULTATION_ID, PATIENT, null);

    expect(h.payments.createRefund).toHaveBeenCalledWith(expect.objectContaining({ amount: '750.00' }));
  });

  it('falls back to the profile fee only when the consultation has no billed amount at all', async () => {
    const h = buildHarness();
    const start = new Date(Date.now() + 30 * 3_600_000);
    h.repo.findByIdForUpdate.mockResolvedValueOnce(makeRow({ scheduledStartAt: start }));
    h.repo.updateStatusIfIn.mockResolvedValueOnce(
      makeRow({ status: 'cancelled', scheduledStartAt: start, cancelledByParty: 'patient' }),
    );
    h.repo.findBilledConsultationFee.mockResolvedValueOnce(null);

    await h.service.cancel(CONSULTATION_ID, PATIENT, null);

    expect(h.payments.createRefund).toHaveBeenCalledWith(expect.objectContaining({ amount: '750.00' }));
  });

  it('makes no refund call when nothing was ever captured', async () => {
    const h = buildHarness();
    h.payments.getByConsultationId.mockResolvedValueOnce({ paymentId: PAYMENT_ID, status: 'failed', paidAt: null });
    await h.service.cancel(CONSULTATION_ID, PATIENT, null);
    expect(h.payments.createRefund).not.toHaveBeenCalled();
  });

  it('files for admin review — and does NOT fail the cancellation — when the refund call itself throws', async () => {
    const h = buildHarness();
    const start = new Date(Date.now() + 30 * 3_600_000);
    h.repo.findByIdForUpdate.mockResolvedValueOnce(makeRow({ scheduledStartAt: start }));
    h.repo.updateStatusIfIn.mockResolvedValueOnce(
      makeRow({ status: 'cancelled', scheduledStartAt: start, cancelledByParty: 'patient' }),
    );
    h.payments.createRefund.mockRejectedValueOnce(new Error('gateway 500'));

    // The cancellation still succeeds — the slot is freed regardless.
    await expect(h.service.cancel(CONSULTATION_ID, PATIENT, null)).resolves.toMatchObject({ status: 'cancelled' });
    expect(h.audit.write).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ reason: 'refund_call_failed' }) }),
    );
  });

  it('files for admin review when the payment lookup itself throws (the pre-merge null port)', async () => {
    const h = buildHarness();
    h.payments.getByConsultationId.mockRejectedValueOnce(new Error('PAYMENT_PORT_UNAVAILABLE'));

    await expect(h.service.cancel(CONSULTATION_ID, PATIENT, null)).resolves.toMatchObject({ status: 'cancelled' });
    expect(h.audit.write).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ reason: 'payment_lookup_failed' }) }),
    );
  });

  /* ── State guards ───────────────────────────────────────────────────────── */

  it.each(['completed', 'cancelled', 'no_show', 'expired', 'in_progress'] as const)(
    'refuses to cancel from %s',
    async (status) => {
      const h = buildHarness();
      h.repo.findByIdForUpdate.mockResolvedValueOnce(makeRow({ status }));
      await expect(h.service.cancel(CONSULTATION_ID, PATIENT, null)).rejects.toMatchObject({
        status: 409,
        response: { code: 'INVALID_STATE_TRANSITION' },
      });
    },
  );
});

describe('BookingService ownership', () => {
  it('a patient cannot cancel another patient’s booking — 404, not 403', async () => {
    const h = buildHarness();
    const error = await h.service.cancel(CONSULTATION_ID, OTHER_PATIENT, null).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 404, response: { code: 'BOOKING_NOT_FOUND' } });
    expect(h.repo.updateStatusIfIn).not.toHaveBeenCalled();
  });

  it('a doctor cannot act on a consultation that is not theirs — 404, not 403', async () => {
    const h = buildHarness();
    await expect(h.service.markNoShow(CONSULTATION_ID, OTHER_DOCTOR)).rejects.toMatchObject({
      status: 404,
      response: { code: 'BOOKING_NOT_FOUND' },
    });
    expect(h.repo.updateStatusIfIn).not.toHaveBeenCalled();
  });

  it('a doctor cannot read another doctor’s booking', async () => {
    const h = buildHarness();
    await expect(h.service.getOwnBooking(CONSULTATION_ID, OTHER_DOCTOR)).rejects.toMatchObject({ status: 404 });
  });

  it('a patient cannot reschedule another patient’s booking', async () => {
    const h = buildHarness();
    await expect(
      h.service.reschedule(CONSULTATION_ID, OTHER_PATIENT, new Date('2026-03-03T10:00:00.000Z')),
    ).rejects.toMatchObject({ status: 404, response: { code: 'BOOKING_NOT_FOUND' } });
  });

  it('an unassigned instant consultation is not actionable by any doctor', async () => {
    const h = buildHarness();
    h.repo.findByIdForUpdate.mockResolvedValueOnce(makeRow({ doctorId: null, mode: 'instant' }));
    await expect(h.service.markNoShow(CONSULTATION_ID, DOCTOR)).rejects.toMatchObject({ status: 404 });
  });

  it('an admin may act on any booking', async () => {
    const h = buildHarness();
    h.payments.getByConsultationId.mockResolvedValueOnce(null);
    await expect(
      h.service.cancel(CONSULTATION_ID, { party: 'admin', accountId: 'admin-1' }, 'Support request'),
    ).resolves.toBeDefined();
  });
});

describe('BookingService.reschedule', () => {
  const NEW_START = new Date('2026-03-05T11:00:00.000Z');

  it('cancels the old booking, creates the replacement and moves the payment across', async () => {
    const h = buildHarness();
    await h.service.reschedule(CONSULTATION_ID, PATIENT, NEW_START);

    // 1. Old row cancelled, which is what frees its slot in the partial index.
    expect(h.repo.updateStatusIfIn).toHaveBeenCalledWith(
      CONSULTATION_ID,
      ['scheduled'],
      expect.objectContaining({ status: 'cancelled', cancellationReason: 'Rescheduled', holdExpiresAt: null }),
      h.db,
    );

    // 2. New row carries the link back and goes straight to `scheduled` — no
    //    second trip through checkout.
    const inserted = h.repo.insert.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted).toMatchObject({
      rescheduledFromConsultationId: CONSULTATION_ID,
      status: 'scheduled',
      scheduledStartAt: NEW_START,
      holdExpiresAt: null,
      patientId: PATIENT_ID,
      doctorId: DOCTOR_ID,
    });

    // 3. ONE payment follows the patient — an UPDATE, never a second insert,
    //    because `payments.consultation_id` is UNIQUE.
    expect(h.repo.movePaymentToConsultation).toHaveBeenCalledWith(PAYMENT_ID, NEW_CONSULTATION_ID, h.db);
  });

  it('never re-charges — no new order is created', async () => {
    const h = buildHarness();
    await h.service.reschedule(CONSULTATION_ID, PATIENT, NEW_START);
    expect(h.payments.createOrderForConsultation).not.toHaveBeenCalled();
    expect(h.payments.createRefund).not.toHaveBeenCalled();
  });

  it('cancels the old row BEFORE inserting the new one, so the freed slot can be re-taken', async () => {
    const h = buildHarness();
    const order: string[] = [];
    h.repo.updateStatusIfIn.mockImplementationOnce(async (_id: string, _from: unknown, patch: Partial<ConsultationRow>) => {
      order.push('cancel-old');
      return makeRow(patch);
    });
    h.repo.insert.mockImplementationOnce(async (values: Record<string, unknown>) => {
      order.push('insert-new');
      return makeRow({ id: NEW_CONSULTATION_ID, ...values } as Partial<ConsultationRow>);
    });

    await h.service.reschedule(CONSULTATION_ID, PATIENT, NEW_START);
    expect(order).toEqual(['cancel-old', 'insert-new']);
  });

  it('converts a 23505 on the new slot into a 409 — and the whole transaction rolls back, so the old booking survives', async () => {
    const h = buildHarness();
    h.repo.insert.mockRejectedValueOnce(uniqueViolation());

    await expect(h.service.reschedule(CONSULTATION_ID, PATIENT, NEW_START)).rejects.toMatchObject({
      status: 409,
      response: { code: 'SLOT_ALREADY_TAKEN' },
    });
    expect(h.repo.movePaymentToConsultation).not.toHaveBeenCalled();
  });

  it('validates the new slot exactly like a fresh booking', async () => {
    const h = buildHarness();
    h.availability.isSlotBookable.mockResolvedValueOnce({ bookable: false, reason: 'outside_working_hours' });

    await expect(h.service.reschedule(CONSULTATION_ID, PATIENT, NEW_START)).rejects.toMatchObject({
      response: { code: 'SLOT_NOT_BOOKABLE', reason: 'outside_working_hours' },
    });
    expect(h.repo.insert).not.toHaveBeenCalled();
  });

  it('refuses when the doctor is no longer bookable', async () => {
    const h = buildHarness();
    h.doctors.isVerifiedAndListed.mockResolvedValueOnce(false);
    await expect(h.service.reschedule(CONSULTATION_ID, PATIENT, NEW_START)).rejects.toMatchObject({
      response: { code: 'DOCTOR_NOT_BOOKABLE' },
    });
  });

  /* ── THE BOOKING BEING MOVED MUST NOT BLOCK ITS OWN MOVE ─────────────────── */

  /**
   * `isSlotBookable(doctorId, startsAt)` cannot be told to ignore one
   * consultation, so the appointment being rescheduled is itself one of the
   * doctor's busy intervals and the advisory pre-check answers `already_taken`
   * against the patient's own booking. Reproduced live before the fix:
   * rescheduling a 09:00 30-minute booking to 09:00, and to 09:15, both
   * returned 409 `SLOT_NOT_BOOKABLE / already_taken`.
   */
  it('allows a move to the SAME slot — the only thing occupying it is the booking being moved', async () => {
    const h = buildHarness();
    h.availability.isSlotBookable.mockResolvedValueOnce({ bookable: false, reason: 'already_taken' });
    h.repo.hasOccupyingOverlap.mockResolvedValueOnce(false); // nobody else is there

    const start = new Date('2026-03-02T10:00:00.000Z');
    await expect(h.service.reschedule(CONSULTATION_ID, PATIENT, start)).resolves.toBeDefined();
    expect(h.repo.insert).toHaveBeenCalled();
  });

  it('allows a move to a slot that OVERLAPS the booking being moved (10:00 → 10:15 on a 30-minute consult)', async () => {
    const h = buildHarness();
    h.availability.isSlotBookable.mockResolvedValueOnce({ bookable: false, reason: 'already_taken' });
    h.repo.hasOccupyingOverlap.mockResolvedValueOnce(false);

    const overlapping = new Date('2026-03-02T10:15:00.000Z');
    await expect(h.service.reschedule(CONSULTATION_ID, PATIENT, overlapping)).resolves.toBeDefined();

    // The exclusion is what makes it legal: the row being moved is excluded,
    // and the window checked is the one the REPLACEMENT will occupy.
    expect(h.repo.hasOccupyingOverlap).toHaveBeenCalledWith(
      DOCTOR_ID,
      overlapping,
      new Date(overlapping.getTime() + 30 * 60_000),
      CONSULTATION_ID,
    );
  });

  it('still refuses when SOMEBODY ELSE occupies the target window — the exclusion loosens nothing', async () => {
    const h = buildHarness();
    h.availability.isSlotBookable.mockResolvedValueOnce({ bookable: false, reason: 'already_taken' });
    h.repo.hasOccupyingOverlap.mockResolvedValueOnce(true); // another patient is there

    await expect(h.service.reschedule(CONSULTATION_ID, PATIENT, NEW_START)).rejects.toMatchObject({
      status: 409,
      response: { code: 'SLOT_NOT_BOOKABLE', reason: 'already_taken' },
    });
    expect(h.repo.insert).not.toHaveBeenCalled();
  });

  it.each(['blocked', 'outside_working_hours', 'too_soon', 'too_far_ahead', 'doctor_not_bookable'] as const)(
    'does not second-guess the %s verdict — only already_taken can be caused by the moved row',
    async (reason) => {
      const h = buildHarness();
      h.availability.isSlotBookable.mockResolvedValueOnce({ bookable: false, reason });

      await expect(h.service.reschedule(CONSULTATION_ID, PATIENT, NEW_START)).rejects.toMatchObject({
        response: { code: 'SLOT_NOT_BOOKABLE', reason },
      });
      expect(h.repo.hasOccupyingOverlap).not.toHaveBeenCalled();
      expect(h.repo.insert).not.toHaveBeenCalled();
    },
  );

  it.each(['pending_payment', 'completed', 'cancelled', 'expired', 'no_show'] as const)(
    'refuses to reschedule from %s',
    async (status) => {
      const h = buildHarness();
      h.repo.findById.mockResolvedValueOnce(makeRow({ status }));
      await expect(h.service.reschedule(CONSULTATION_ID, PATIENT, NEW_START)).rejects.toMatchObject({
        status: 409,
        response: { code: 'INVALID_STATE_TRANSITION' },
      });
    },
  );

  it('refuses when there is no payment to move', async () => {
    const h = buildHarness();
    h.payments.getByConsultationId.mockResolvedValueOnce(null);
    await expect(h.service.reschedule(CONSULTATION_ID, PATIENT, NEW_START)).rejects.toMatchObject({
      response: { code: 'PAYMENT_NOT_FOUND' },
    });
  });

  it('wraps a payment-port throw rather than leaking it', async () => {
    const h = buildHarness();
    h.payments.getByConsultationId.mockRejectedValueOnce(new Error('Razorpay unreachable'));
    const error = await h.service.reschedule(CONSULTATION_ID, PATIENT, NEW_START).catch((e: unknown) => e);
    expect(error).toMatchObject({ response: { code: 'PAYMENT_SETUP_FAILED' } });
    expect(JSON.stringify(error)).not.toContain('Razorpay');
  });
});

describe('BookingService.markNoShow', () => {
  it('marks no_show and clears any hold, freeing the slot', async () => {
    const h = buildHarness();
    await h.service.markNoShow(CONSULTATION_ID, DOCTOR);
    expect(h.repo.updateStatusIfIn).toHaveBeenCalledWith(
      CONSULTATION_ID,
      expect.arrayContaining(['scheduled']),
      expect.objectContaining({ status: 'no_show', holdExpiresAt: null }),
      h.db,
    );
  });

  it.each(['pending_payment', 'completed', 'cancelled', 'expired'] as const)('refuses from %s', async (status) => {
    const h = buildHarness();
    h.repo.findByIdForUpdate.mockResolvedValueOnce(makeRow({ status }));
    await expect(h.service.markNoShow(CONSULTATION_ID, DOCTOR)).rejects.toMatchObject({
      response: { code: 'INVALID_STATE_TRANSITION' },
    });
  });
});

describe('BookingService intake and attachments', () => {
  it('snapshots intake answers on the consultation', async () => {
    const h = buildHarness();
    await h.service.saveIntakeAnswers(CONSULTATION_ID, PATIENT, { q1: 'yes' });
    expect(h.repo.updateStatusIfIn).toHaveBeenCalledWith(
      CONSULTATION_ID,
      expect.arrayContaining(['scheduled']),
      { intakeAnswers: { q1: 'yes' } },
      h.db,
    );
  });

  it('refuses to change intake answers once the consult is under way', async () => {
    const h = buildHarness();
    h.repo.findByIdForUpdate.mockResolvedValueOnce(makeRow({ status: 'in_progress' }));
    await expect(h.service.saveIntakeAnswers(CONSULTATION_ID, PATIENT, {})).rejects.toMatchObject({
      response: { code: 'INVALID_STATE_TRANSITION' },
    });
  });

  it('a patient cannot write intake answers on someone else’s booking', async () => {
    const h = buildHarness();
    await expect(h.service.saveIntakeAnswers(CONSULTATION_ID, OTHER_PATIENT, {})).rejects.toMatchObject({ status: 404 });
  });

  it('refuses to attach a document belonging to a different patient', async () => {
    const h = buildHarness();
    h.documents.getPatientFileById.mockResolvedValueOnce({ id: 'f', patientId: OTHER_PATIENT_ID, fileName: 'x.pdf' });
    await expect(
      h.service.attachDocument(CONSULTATION_ID, PATIENT, '99999999-9999-4999-8999-999999999999'),
    ).rejects.toMatchObject({ status: 404, response: { code: 'DOCUMENT_NOT_ATTACHABLE' } });
  });

  it('records an accepted attachment against the consultation', async () => {
    const h = buildHarness();
    await h.service.attachDocument(CONSULTATION_ID, PATIENT, '99999999-9999-4999-8999-999999999999');
    expect(h.audit.write).toHaveBeenCalledWith(
      expect.objectContaining({ consultationId: CONSULTATION_ID, metadata: expect.objectContaining({ change: 'document_attached' }) }),
    );
  });
});

describe('BookingService instant consultations', () => {
  it('creates an instant row with no doctor and no slot, but a real hold', async () => {
    const h = buildHarness();
    await h.service.createInstantBooking({ patientId: PATIENT_ID, specialtyId: SPECIALTY_ID }, PATIENT);

    const inserted = h.repo.insert.mock.calls[0][0] as Record<string, unknown>;
    expect(inserted).toMatchObject({ mode: 'instant', doctorId: null, scheduledStartAt: null, status: 'pending_payment' });
    expect(inserted.holdExpiresAt).toBeInstanceOf(Date);
  });

  it('assigns a doctor and adopts that doctor’s consultation duration', async () => {
    const h = buildHarness();
    h.repo.findByIdForUpdate.mockResolvedValueOnce(makeRow({ mode: 'instant', doctorId: null, status: 'pending_payment' }));
    await h.service.assignDoctor(CONSULTATION_ID, DOCTOR_ID, { party: 'system', accountId: null });

    expect(h.repo.updateStatusIfIn).toHaveBeenCalledWith(
      CONSULTATION_ID,
      ['pending_payment'],
      { doctorId: DOCTOR_ID, durationMinutes: 30 },
      h.db,
    );
  });

  it('refuses to assign a doctor who does not practise the booked specialty', async () => {
    const h = buildHarness();
    h.repo.findByIdForUpdate.mockResolvedValueOnce(makeRow({ mode: 'instant', doctorId: null, specialtyId: 'other' }));
    await expect(
      h.service.assignDoctor(CONSULTATION_ID, DOCTOR_ID, { party: 'system', accountId: null }),
    ).rejects.toMatchObject({ response: { code: 'DOCTOR_SPECIALTY_MISMATCH' } });
  });

  it('refuses to reassign a consultation that already has a doctor', async () => {
    const h = buildHarness();
    h.repo.findByIdForUpdate.mockResolvedValueOnce(makeRow({ mode: 'instant', doctorId: DOCTOR_ID }));
    await expect(
      h.service.assignDoctor(CONSULTATION_ID, DOCTOR_ID, { party: 'system', accountId: null }),
    ).rejects.toMatchObject({ response: { code: 'INVALID_STATE_TRANSITION' } });
  });
});

/**
 * ADDITIVE (M-13). The narrow status-move method M-13 drives the instant
 * lifecycle through, rather than reaching into `consultations` itself.
 *
 * The property worth guarding is the RESTRICTION, not the happy path: this is
 * the only method here that takes a target status as an argument, so the tests
 * below are mostly about what it refuses to do.
 */
describe('BookingService.transitionInstantConsultation', () => {
  const AWAITING = { consultationId: CONSULTATION_ID, to: 'awaiting_doctor' as const, from: ['pending_payment' as const] };

  it('moves an instant consultation and audits before/after transactionally', async () => {
    const h = buildHarness();
    h.repo.findByIdForUpdate.mockResolvedValueOnce(makeRow({ mode: 'instant', status: 'pending_payment' }));

    const result = await h.service.transitionInstantConsultation({ ...AWAITING, holdExpiresAt: null, reason: 'routing' });

    expect(result.changed).toBe(true);
    expect(h.repo.updateStatusIfIn).toHaveBeenCalledWith(
      CONSULTATION_ID,
      ['pending_payment'],
      { status: 'awaiting_doctor', holdExpiresAt: null },
      h.db,
    );
    expect(h.audit.write).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'system',
        metadata: expect.objectContaining({
          change: 'instant_transition',
          before: 'pending_payment',
          after: 'awaiting_doctor',
          reason: 'routing',
        }),
      }),
      h.db,
    );
  });

  it('takes the ROW LOCK first, like every other transition in this service', async () => {
    const h = buildHarness();
    h.repo.findByIdForUpdate.mockResolvedValueOnce(makeRow({ mode: 'instant', status: 'pending_payment' }));

    await h.service.transitionInstantConsultation(AWAITING);

    expect(h.repo.findByIdForUpdate).toHaveBeenCalledWith(CONSULTATION_ID, h.db);
  });

  it('*** REFUSES A SCHEDULED CONSULTATION *** — it can never become a general status setter', async () => {
    const h = buildHarness();
    h.repo.findByIdForUpdate.mockResolvedValueOnce(makeRow({ mode: 'scheduled', status: 'pending_payment' }));

    const result = await h.service.transitionInstantConsultation(AWAITING);

    // Otherwise this would route around cancel/reschedule/no-show and their
    // policies.
    expect(result).toMatchObject({ changed: false, refusal: 'not_instant' });
    expect(h.repo.updateStatusIfIn).not.toHaveBeenCalled();
    expect(h.audit.write).not.toHaveBeenCalled();
  });

  it('enforces the CALLER-supplied from-set — M-13 owns the state machine, this module owns the lock', async () => {
    const h = buildHarness();
    h.repo.findByIdForUpdate.mockResolvedValueOnce(makeRow({ mode: 'instant', status: 'cancelled' }));
    h.repo.updateStatusIfIn.mockResolvedValueOnce(undefined);

    const result = await h.service.transitionInstantConsultation(AWAITING);

    expect(result).toMatchObject({ changed: false, refusal: 'illegal_transition' });
    expect(h.audit.write).not.toHaveBeenCalled();
  });

  it('REFUSES rather than throws, so M-13s sweeps are not derailed by one candidate', async () => {
    const h = buildHarness();
    h.repo.findByIdForUpdate.mockResolvedValueOnce(undefined);

    await expect(h.service.transitionInstantConsultation(AWAITING)).resolves.toEqual({
      changed: false,
      booking: null,
      refusal: 'not_found',
    });
  });

  it('is an idempotent no-op when already in the target status, and writes no audit row', async () => {
    const h = buildHarness();
    h.repo.findByIdForUpdate.mockResolvedValueOnce(makeRow({ mode: 'instant', status: 'awaiting_doctor' }));

    const result = await h.service.transitionInstantConsultation(AWAITING);

    expect(result.changed).toBe(false);
    expect(result.refusal).toBeUndefined();
    expect(h.repo.updateStatusIfIn).not.toHaveBeenCalled();
    expect(h.audit.write).not.toHaveBeenCalled();
  });

  it('leaves the hold ALONE when holdExpiresAt is omitted — `null` is a meaningful value, so presence decides, not truthiness', async () => {
    const h = buildHarness();
    h.repo.findByIdForUpdate.mockResolvedValueOnce(makeRow({ mode: 'instant', status: 'awaiting_doctor' }));

    await h.service.transitionInstantConsultation({
      consultationId: CONSULTATION_ID,
      to: 'expired',
      from: ['awaiting_doctor'],
    });

    expect(h.repo.updateStatusIfIn).toHaveBeenCalledWith(CONSULTATION_ID, ['awaiting_doctor'], { status: 'expired' }, h.db);
  });

  it('sets a payment hold when M-13 hands it one (the accept-then-pay window)', async () => {
    const h = buildHarness();
    const payBy = new Date('2026-03-02T10:05:00.000Z');
    h.repo.findByIdForUpdate.mockResolvedValueOnce(makeRow({ mode: 'instant', status: 'awaiting_doctor' }));

    await h.service.transitionInstantConsultation({
      consultationId: CONSULTATION_ID,
      to: 'pending_payment',
      from: ['awaiting_doctor'],
      holdExpiresAt: payBy,
    });

    expect(h.repo.updateStatusIfIn).toHaveBeenCalledWith(
      CONSULTATION_ID,
      ['awaiting_doctor'],
      { status: 'pending_payment', holdExpiresAt: payBy },
      h.db,
    );
  });

  it('lists expired instant holds through the repository for M-13s payment sweep', async () => {
    const h = buildHarness();
    const now = new Date('2026-03-02T11:00:00.000Z');

    await h.service.listExpiredInstantHolds(now, 100);

    expect(h.repo.listExpiredInstantHolds).toHaveBeenCalledWith(now, 100);
  });
});
