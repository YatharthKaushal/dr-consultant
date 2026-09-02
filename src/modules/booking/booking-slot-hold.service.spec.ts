import type { ConsultationRow } from '../../schema/consultations.schema';
import { BookingSlotHoldService } from './booking-slot-hold.service';
import type { ExpiredHoldCandidate } from './booking.repository';

/**
 * The sweep and the late-capture path — everything that can move a slot
 * without a user asking.
 *
 * The property under test throughout: A HOLD THAT REACHED THE GATEWAY IS
 * NEVER RELEASED ON A TIMER. Several tests below therefore assert not only
 * the outcome but that `reconcileWithGateway` was actually CALLED — a sweep
 * that "correctly" released a failed payment without asking the gateway would
 * pass an outcome-only assertion while being exactly the bug this design
 * exists to prevent.
 */

const CONSULTATION_ID = '66666666-6666-4666-8666-666666666666';
const PATIENT_ID = '11111111-1111-4111-8111-111111111111';
const DOCTOR_ID = '33333333-3333-4333-8333-333333333333';
const PAYMENT_ID = '88888888-8888-4888-8888-888888888888';

function uniqueViolation(): Error & { code: string } {
  return Object.assign(new Error('duplicate key value violates unique constraint "consultations_doctor_slot_unique_idx"'), {
    code: '23505',
  });
}

function makeRow(overrides: Partial<ConsultationRow> = {}): ConsultationRow {
  return {
    id: CONSULTATION_ID,
    referenceCode: 'DRC-TEST-000001',
    patientId: PATIENT_ID,
    doctorId: DOCTOR_ID,
    specialtyId: '55555555-5555-4555-8555-555555555555',
    concernId: null,
    mode: 'scheduled',
    status: 'pending_payment',
    scheduledStartAt: new Date('2026-03-02T10:00:00.000Z'),
    durationMinutes: 30,
    holdExpiresAt: new Date('2026-03-01T09:20:00.000Z'),
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

function makeCandidate(overrides: Partial<ExpiredHoldCandidate> = {}): ExpiredHoldCandidate {
  return {
    consultationId: CONSULTATION_ID,
    patientId: PATIENT_ID,
    doctorId: DOCTOR_ID,
    scheduledStartAt: new Date('2026-03-02T10:00:00.000Z'),
    holdExpiresAt: new Date('2026-03-01T09:20:00.000Z'),
    paymentId: PAYMENT_ID,
    gatewayOrderId: 'order_test_1',
    ...overrides,
  };
}

/** Loose mock aliases — see `booking.service.spec.ts` for why these are deliberately untyped. */
type Fn = jest.Mock;

interface Harness {
  db: { transaction: Fn };
  repo: Record<string, Fn>;
  payments: Record<string, Fn>;
  audit: Record<string, Fn>;
}

function buildHarness(overrides: Partial<Harness> = {}) {
  const db: { transaction: Fn } = { transaction: jest.fn() };
  db.transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(db));

  const repo: Record<string, Fn> = {
    findExpiredHoldCandidates: jest.fn(async () => [] as ExpiredHoldCandidate[]),
    findById: jest.fn(async () => makeRow()),
    findByIdForUpdate: jest.fn(async () => makeRow()),
    updateStatusIfIn: jest.fn(async (_id: string, _from: unknown, patch: Partial<ConsultationRow>) => makeRow(patch)),
  };

  const payments: Record<string, Fn> = {
    reconcileWithGateway: jest.fn(async () => ({ status: 'pending', changed: false })),
  };

  const audit: Record<string, Fn> = { write: jest.fn(async () => undefined) };

  const deps: Harness = { db, repo, payments, audit, ...overrides };
  const service = new BookingSlotHoldService(deps.db as never, deps.repo as never, deps.payments as never, deps.audit as never);
  return { service, ...deps };
}

/** Convenience: the patch handed to the status update on call `n`. */
function patchOf(repo: Record<string, Fn>, n = 0): Record<string, unknown> {
  return repo.updateStatusIfIn.mock.calls[n][2] as Record<string, unknown>;
}

describe('BookingSlotHoldService — TIER 1 (never reached the gateway)', () => {
  it('releases a hold whose payment has no gateway order', async () => {
    const h = buildHarness();
    const outcome = await h.service.sweepOne(makeCandidate({ gatewayOrderId: null }));

    expect(outcome).toBe('released');
    expect(patchOf(h.repo)).toMatchObject({ status: 'expired', holdExpiresAt: null });
  });

  it('releases a hold with no payment row at all', async () => {
    const h = buildHarness();
    const outcome = await h.service.sweepOne(makeCandidate({ paymentId: null, gatewayOrderId: null }));

    expect(outcome).toBe('released');
    expect(patchOf(h.repo)).toMatchObject({ status: 'expired' });
  });

  it('does NOT call the gateway for a Tier 1 hold — there is nothing in flight to ask about', async () => {
    const h = buildHarness();
    await h.service.sweepOne(makeCandidate({ gatewayOrderId: null }));
    expect(h.payments.reconcileWithGateway).not.toHaveBeenCalled();
  });

  it('writes an audit entry naming why the hold was released', async () => {
    const h = buildHarness();
    await h.service.sweepOne(makeCandidate({ gatewayOrderId: null }));
    expect(h.audit.write).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ change: 'hold_released', reason: 'hold_expired_no_gateway_order' }),
      }),
      h.db,
    );
  });
});

describe('BookingSlotHoldService — TIER 2 (checkout was entered)', () => {
  it('ASKS THE GATEWAY before doing anything at all', async () => {
    const h = buildHarness();
    await h.service.sweepOne(makeCandidate());
    // The single most important assertion in this file.
    expect(h.payments.reconcileWithGateway).toHaveBeenCalledWith(PAYMENT_ID);
  });

  it('CONFIRMS — never releases — when the gateway says paid', async () => {
    const h = buildHarness();
    h.payments.reconcileWithGateway.mockResolvedValueOnce({ status: 'paid', changed: true });

    const outcome = await h.service.sweepOne(makeCandidate());

    expect(outcome).toBe('confirmed');
    expect(h.payments.reconcileWithGateway).toHaveBeenCalledWith(PAYMENT_ID);
    expect(patchOf(h.repo)).toMatchObject({ status: 'scheduled', holdExpiresAt: null });
    // The slot must NOT have been freed.
    const everySetStatus = h.repo.updateStatusIfIn.mock.calls.map((call) => (call[2] as { status?: string }).status);
    expect(everySetStatus).not.toContain('expired');
  });

  it('releases when the gateway says the payment definitively failed — and only after asking', async () => {
    const h = buildHarness();
    h.payments.reconcileWithGateway.mockResolvedValueOnce({ status: 'failed', changed: true });

    const outcome = await h.service.sweepOne(makeCandidate());

    expect(h.payments.reconcileWithGateway).toHaveBeenCalledWith(PAYMENT_ID);
    expect(outcome).toBe('released');
    expect(patchOf(h.repo)).toMatchObject({ status: 'expired' });
  });

  it('KEEPS HOLDING when the gateway says the payment is still pending', async () => {
    const h = buildHarness();
    h.payments.reconcileWithGateway.mockResolvedValueOnce({ status: 'pending', changed: false });

    const outcome = await h.service.sweepOne(makeCandidate());

    expect(outcome).toBe('stillHeld');
    // Nothing was written — the patient may be mid-3-D-Secure right now.
    expect(h.repo.updateStatusIfIn).not.toHaveBeenCalled();
  });

  it.each(['created', 'refunded', 'partially_refunded', 'something_new_from_the_gateway'])(
    'keeps holding on the non-final status %s rather than guessing',
    async (status) => {
      const h = buildHarness();
      h.payments.reconcileWithGateway.mockResolvedValueOnce({ status, changed: false });

      expect(await h.service.sweepOne(makeCandidate())).toBe('stillHeld');
      expect(h.repo.updateStatusIfIn).not.toHaveBeenCalled();
    },
  );

  it('keeps the hold when the gateway itself is unreachable — releasing under a live payment is the worse failure', async () => {
    const h = buildHarness();
    h.payments.reconcileWithGateway.mockRejectedValueOnce(new Error('gateway timeout'));

    expect(await h.service.sweepOne(makeCandidate())).toBe('stillHeld');
    expect(h.repo.updateStatusIfIn).not.toHaveBeenCalled();
  });
});

describe('BookingSlotHoldService — release re-checks under the row lock', () => {
  it('does not release a hold that was confirmed between the candidate query and the lock', async () => {
    const h = buildHarness();
    // By the time we hold the lock, a webhook has already taken it live.
    h.repo.findByIdForUpdate.mockResolvedValueOnce(makeRow({ status: 'scheduled', holdExpiresAt: null }));

    const outcome = await h.service.sweepOne(makeCandidate({ gatewayOrderId: null }));

    expect(outcome).toBe('stillHeld');
    expect(h.repo.updateStatusIfIn).not.toHaveBeenCalled();
  });

  it('takes the row lock before releasing', async () => {
    const h = buildHarness();
    await h.service.sweepOne(makeCandidate({ gatewayOrderId: null }));
    expect(h.repo.findByIdForUpdate).toHaveBeenCalledWith(CONSULTATION_ID, h.db);
  });
});

describe('BookingSlotHoldService.sweepExpiredHolds', () => {
  it('tallies a mixed batch and keeps going after one candidate fails', async () => {
    const h = buildHarness();
    h.repo.findExpiredHoldCandidates.mockResolvedValueOnce([
      makeCandidate({ consultationId: 'c-tier1', gatewayOrderId: null }),
      makeCandidate({ consultationId: 'c-paid', paymentId: 'p-paid' }),
      makeCandidate({ consultationId: 'c-pending', paymentId: 'p-pending' }),
      makeCandidate({ consultationId: 'c-boom', paymentId: 'p-boom' }),
    ]);
    h.payments.reconcileWithGateway.mockImplementation(async (paymentId: string) => {
      if (paymentId === 'p-paid') return { status: 'paid', changed: true };
      if (paymentId === 'p-pending') return { status: 'pending', changed: false };
      return { status: 'failed', changed: true };
    });
    h.repo.findByIdForUpdate.mockImplementation(async (id: string) => {
      if (id === 'c-boom') throw new Error('row lock failed');
      return makeRow({ id });
    });

    const result = await h.service.sweepExpiredHolds(new Date());

    expect(result).toEqual({ examined: 4, released: 1, confirmed: 1, stillHeld: 1, failed: 1 });
  });

  it('returns an all-zero result for an empty batch', async () => {
    const h = buildHarness();
    expect(await h.service.sweepExpiredHolds(new Date())).toEqual({
      examined: 0,
      released: 0,
      confirmed: 0,
      stillHeld: 0,
      failed: 0,
    });
  });
});

describe('BookingSlotHoldService.confirmPayment', () => {
  it('takes a pending_payment booking live and clears the hold', async () => {
    const h = buildHarness();
    await h.service.confirmPayment(CONSULTATION_ID);

    expect(h.repo.updateStatusIfIn).toHaveBeenCalledWith(
      CONSULTATION_ID,
      ['pending_payment'],
      { status: 'scheduled', holdExpiresAt: null },
      h.db,
    );
  });

  it('is idempotent for a replayed webhook on an already-scheduled booking', async () => {
    const h = buildHarness();
    h.repo.findByIdForUpdate.mockResolvedValueOnce(makeRow({ status: 'scheduled', holdExpiresAt: null }));

    await expect(h.service.confirmPayment(CONSULTATION_ID)).resolves.toMatchObject({ status: 'scheduled' });
    expect(h.repo.updateStatusIfIn).not.toHaveBeenCalled();
  });

  it('404s for a consultation that does not exist', async () => {
    const h = buildHarness();
    h.repo.findByIdForUpdate.mockResolvedValueOnce(undefined);
    await expect(h.service.confirmPayment(CONSULTATION_ID)).rejects.toMatchObject({ status: 404 });
  });
});

describe('BookingSlotHoldService — RESIDUAL LATE CAPTURE', () => {
  it('re-acquires the same slot when the hold is gone but the slot is still free', async () => {
    const h = buildHarness();
    // The sweep released it a moment ago; the capture webhook has just landed.
    h.repo.findByIdForUpdate.mockResolvedValue(makeRow({ status: 'expired', holdExpiresAt: null }));

    const result = await h.service.confirmPayment(CONSULTATION_ID);

    expect(result.status).toBe('scheduled');
    expect(h.repo.updateStatusIfIn).toHaveBeenCalledWith(
      CONSULTATION_ID,
      ['expired'],
      { status: 'scheduled', holdExpiresAt: null },
      h.db,
    );
    expect(h.audit.write).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ change: 'late_capture_reacquired' }) }),
      h.db,
    );
  });

  it('files for ADMIN RESOLUTION — and holds the money — when the slot has since been taken', async () => {
    const h = buildHarness();
    h.repo.findByIdForUpdate.mockResolvedValue(makeRow({ status: 'expired', holdExpiresAt: null }));
    // The re-acquire is refused by the partial unique index: somebody else
    // now holds this (doctor, start) pair.
    h.repo.updateStatusIfIn.mockRejectedValueOnce(uniqueViolation());
    h.repo.findById.mockResolvedValueOnce(makeRow({ status: 'expired' }));

    const result = await h.service.confirmPayment(CONSULTATION_ID);

    expect(result.status).toBe('expired');
    expect(h.audit.write).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'booking_admin_resolution',
        metadata: expect.objectContaining({
          kind: 'late_capture_slot_taken',
          reason: 'slot_taken_by_another_booking',
          moneyHeld: true,
        }),
      }),
    );
  });

  it('NEVER auto-refunds a late capture whose slot was taken — money stays put for a human', async () => {
    const h = buildHarness();
    const createRefund = jest.fn();
    const withRefund = buildHarness({ payments: { ...h.payments, createRefund } });
    withRefund.repo.findByIdForUpdate.mockResolvedValue(makeRow({ status: 'expired', holdExpiresAt: null }));
    withRefund.repo.updateStatusIfIn.mockRejectedValueOnce(uniqueViolation());
    withRefund.repo.findById.mockResolvedValueOnce(makeRow({ status: 'expired' }));

    await withRefund.service.confirmPayment(CONSULTATION_ID);

    expect(createRefund).not.toHaveBeenCalled();
  });

  it.each(['cancelled', 'completed', 'no_show'] as const)(
    'refuses to overwrite a deliberate %s decision, and sends it to a human instead',
    async (status) => {
      const h = buildHarness();
      h.repo.findByIdForUpdate.mockResolvedValue(makeRow({ status, holdExpiresAt: null }));

      const result = await h.service.confirmPayment(CONSULTATION_ID);

      expect(result.status).toBe(status);
      expect(h.repo.updateStatusIfIn).not.toHaveBeenCalled();
      expect(h.audit.write).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: 'booking_admin_resolution',
          metadata: expect.objectContaining({ reason: 'late_capture_on_non_reacquirable_status' }),
        }),
        h.db,
      );
    },
  );

  it('a paid sweep result on an already-released hold still ends up scheduled — the sweep and late capture compose', async () => {
    const h = buildHarness();
    h.payments.reconcileWithGateway.mockResolvedValueOnce({ status: 'paid', changed: true });
    h.repo.findByIdForUpdate.mockResolvedValue(makeRow({ status: 'expired', holdExpiresAt: null }));

    expect(await h.service.sweepOne(makeCandidate())).toBe('confirmed');
    expect(h.repo.updateStatusIfIn).toHaveBeenCalledWith(
      CONSULTATION_ID,
      ['expired'],
      { status: 'scheduled', holdExpiresAt: null },
      h.db,
    );
  });
});

describe('BookingSlotHoldService — scheduling lifecycle', () => {
  it('starts an unref’d interval on init and clears it on shutdown', () => {
    const h = buildHarness();
    const setSpy = jest.spyOn(global, 'setInterval');
    const clearSpy = jest.spyOn(global, 'clearInterval');

    h.service.onModuleInit();
    expect(setSpy).toHaveBeenCalled();
    // `.unref()` is what keeps Jest and CLI processes exiting cleanly.
    const timer = setSpy.mock.results[0].value as NodeJS.Timeout;
    expect(typeof timer.unref).toBe('function');

    h.service.onApplicationShutdown();
    expect(clearSpy).toHaveBeenCalled();

    setSpy.mockRestore();
    clearSpy.mockRestore();
  });

  it('does not start a second timer if init runs twice', () => {
    const h = buildHarness();
    const setSpy = jest.spyOn(global, 'setInterval');

    h.service.onModuleInit();
    h.service.onModuleInit();
    expect(setSpy).toHaveBeenCalledTimes(1);

    h.service.onApplicationShutdown();
    setSpy.mockRestore();
  });

  it('shutdown is safe when the timer was never started', () => {
    const h = buildHarness();
    expect(() => h.service.onApplicationShutdown()).not.toThrow();
  });
});
