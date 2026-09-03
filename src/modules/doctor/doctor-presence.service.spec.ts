import type { DoctorRow } from '../../schema/doctors.schema';
import { DOCTOR_AUDIT_ENTITY_TYPES } from './doctor.constants';
import { DoctorPresenceService } from './doctor-presence.service';

/**
 * Unit tests for the M-05 side of the M-13 boundary — the WRITE half of
 * `doctors.presence` and `doctors.blocked_by_consultation_id`.
 *
 * Convention throughout this repo: `new Service(mockedDeps)` with hand-rolled
 * `jest.fn()`s, never `Test.createTestingModule`.
 *
 * What these tests are actually protecting: this service is the only thing in
 * the codebase allowed to write the completion gate, and the only thing that
 * takes the doctor row lock. The FR-10.4 transition TABLE lives in M-13
 * (`instant.constants.ts`) and is tested there; what is tested here is that
 * this side enforces whatever `from` set it is handed, refuses rather than
 * throws, and never writes an audit row for a change that did not happen.
 */

const DOCTOR_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_DOCTOR_ID = '22222222-2222-4222-8222-222222222222';
const CONSULTATION_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_CONSULTATION_ID = '44444444-4444-4444-8444-444444444444';
const ADMIN_ID = '55555555-5555-4555-8555-555555555555';

function makeDoctor(overrides: Partial<DoctorRow> = {}): DoctorRow {
  return {
    id: DOCTOR_ID,
    mobileNumber: '+919000000001',
    mobileVerifiedAt: null,
    tokenVersion: 0,
    pushToken: null,
    deviceId: null,
    fullName: 'Dr Test',
    bio: null,
    languages: ['English'],
    verificationStatus: 'verified',
    registrationNumber: 'REG-1',
    qualification: 'MBBS',
    yearsOfExperience: 5,
    verifiedByAdminId: null,
    verifiedAt: null,
    seniorityLevel: 'standard',
    consultationFeeInr: '750.00',
    consultationDurationMinutes: 30,
    bufferMinutes: 5,
    isListed: true,
    allowInstantConsult: true,
    presence: 'offline',
    blockedByConsultationId: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as DoctorRow;
}

/** Loose mock aliases: every `jest.fn()` here is deliberately untyped so a test can resolve `null`, an error, or a partial shape without fighting inference. */
type Fn = jest.Mock;

function buildHarness(repoOverrides: Record<string, Fn> = {}) {
  const db: { transaction: Fn } = { transaction: jest.fn() };
  db.transaction.mockImplementation(async (cb: (tx: unknown) => unknown) => cb(db));

  const repo: Record<string, Fn> = {
    findById: jest.fn(async () => makeDoctor()),
    findByIdForUpdate: jest.fn(async () => makeDoctor()),
    updatePresenceIfIn: jest.fn(async (_id: string, _from: unknown, to: string) => makeDoctor({ presence: to as DoctorRow['presence'] })),
    setCompletionGate: jest.fn(async (id: string, consultationId: string) =>
      makeDoctor({ id, blockedByConsultationId: consultationId }),
    ),
    clearCompletionGateByConsultation: jest.fn(async () => makeDoctor({ blockedByConsultationId: null })),
    listInstantRoutingCandidates: jest.fn(async () => [makeDoctor()]),
    bulkResetPresence: jest.fn(async () => [DOCTOR_ID, OTHER_DOCTOR_ID]),
    ...repoOverrides,
  };

  const audit: Record<string, Fn> = { write: jest.fn(async () => undefined) };

  const service = new DoctorPresenceService(db as never, repo as never, audit as never);
  return { service, db, repo, audit };
}

const SYSTEM = { actorType: 'system' as const, actorId: null };

describe('DoctorPresenceService', () => {
  describe('getPresenceState', () => {
    it('reports the four routing-relevant facts, with isVerifiedAndListed derived', async () => {
      const { service } = buildHarness({
        findById: jest.fn(async () => makeDoctor({ presence: 'available_now', blockedByConsultationId: CONSULTATION_ID })),
      });

      await expect(service.getPresenceState(DOCTOR_ID)).resolves.toEqual({
        doctorId: DOCTOR_ID,
        presence: 'available_now',
        allowInstantConsult: true,
        blockedByConsultationId: CONSULTATION_ID,
        isVerifiedAndListed: true,
      });
    });

    it('is false for isVerifiedAndListed when the doctor is unlisted', async () => {
      const { service } = buildHarness({ findById: jest.fn(async () => makeDoctor({ isListed: false })) });
      await expect(service.getPresenceState(DOCTOR_ID)).resolves.toMatchObject({ isVerifiedAndListed: false });
    });

    it('returns null rather than throwing for an unknown doctor', async () => {
      const { service } = buildHarness({ findById: jest.fn(async () => null) });
      await expect(service.getPresenceState(DOCTOR_ID)).resolves.toBeNull();
    });
  });

  describe('transitionPresence', () => {
    it('takes the ROW LOCK before writing — findByIdForUpdate, not findById', async () => {
      const { service, repo } = buildHarness({
        findByIdForUpdate: jest.fn(async () => makeDoctor({ presence: 'offline' })),
      });

      await service.transitionPresence({ doctorId: DOCTOR_ID, to: 'available_now', from: ['offline'], actor: SYSTEM });

      expect(repo.findByIdForUpdate).toHaveBeenCalledTimes(1);
      expect(repo.findById).not.toHaveBeenCalled();
    });

    it('moves the doctor and writes ONE transactional audit row carrying before/after', async () => {
      const { service, repo, audit, db } = buildHarness({
        findByIdForUpdate: jest.fn(async () => makeDoctor({ presence: 'offline' })),
      });

      const result = await service.transitionPresence({
        doctorId: DOCTOR_ID,
        to: 'available_now',
        from: ['offline'],
        actor: { actorType: 'doctor', actorId: DOCTOR_ID },
        reason: 'doctor_self_service',
      });

      expect(result).toMatchObject({ changed: true, before: 'offline', after: 'available_now' });
      expect(repo.updatePresenceIfIn).toHaveBeenCalledWith(DOCTOR_ID, ['offline'], 'available_now', { requireNotGated: undefined }, db);
      expect(audit.write).toHaveBeenCalledTimes(1);
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({
          actorType: 'doctor',
          actorId: DOCTOR_ID,
          entityType: DOCTOR_AUDIT_ENTITY_TYPES.DOCTOR_PRESENCE,
          entityId: DOCTOR_ID,
          metadata: { change: 'presence', before: 'offline', after: 'available_now', reason: 'doctor_self_service' },
        }),
        // Transactional, not best-effort — the audit must roll back with the write it records.
        db,
      );
    });

    it('passes the caller-supplied `from` set straight through — M-13 owns the transition table, not this module', async () => {
      const { service, repo } = buildHarness({
        findByIdForUpdate: jest.fn(async () => makeDoctor({ presence: 'request_pending' })),
      });

      await service.transitionPresence({
        doctorId: DOCTOR_ID,
        to: 'in_consultation',
        from: ['request_pending'],
        actor: SYSTEM,
      });

      expect(repo.updatePresenceIfIn).toHaveBeenCalledWith(
        DOCTOR_ID,
        ['request_pending'],
        'in_consultation',
        expect.anything(),
        expect.anything(),
      );
    });

    it('is an idempotent NO-OP when the doctor is already in the target state, and writes no audit row', async () => {
      const { service, repo, audit } = buildHarness({
        findByIdForUpdate: jest.fn(async () => makeDoctor({ presence: 'available_now' })),
      });

      const result = await service.transitionPresence({
        doctorId: DOCTOR_ID,
        to: 'available_now',
        from: ['offline'],
        actor: SYSTEM,
      });

      expect(result).toMatchObject({ changed: false, before: 'available_now', after: 'available_now' });
      expect(result.refusal).toBeUndefined();
      expect(repo.updatePresenceIfIn).not.toHaveBeenCalled();
      // A no-op is not a state change and must not look like one in the log.
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('REFUSES rather than throws when the guard does not match, and writes nothing', async () => {
      const { service, audit } = buildHarness({
        findByIdForUpdate: jest.fn(async () => makeDoctor({ presence: 'in_consultation' })),
        updatePresenceIfIn: jest.fn(async () => null),
      });

      const result = await service.transitionPresence({
        doctorId: DOCTOR_ID,
        to: 'request_pending',
        from: ['available_now'],
        actor: SYSTEM,
      });

      expect(result).toMatchObject({ changed: false, refusal: 'illegal_transition', before: 'in_consultation' });
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('refuses with doctor_not_found rather than throwing — a sweep batch must not be derailed by one missing row', async () => {
      const { service } = buildHarness({ findByIdForUpdate: jest.fn(async () => null) });

      const result = await service.transitionPresence({
        doctorId: DOCTOR_ID,
        to: 'offline',
        from: ['available_now'],
        actor: SYSTEM,
      });

      expect(result).toEqual({ changed: false, before: null, after: null, refusal: 'doctor_not_found' });
    });

    describe('the completion gate, checked under the lock', () => {
      it('refuses with completion_gated and never reaches the UPDATE', async () => {
        const { service, repo, audit } = buildHarness({
          findByIdForUpdate: jest.fn(async () => makeDoctor({ presence: 'offline', blockedByConsultationId: CONSULTATION_ID })),
        });

        const result = await service.transitionPresence({
          doctorId: DOCTOR_ID,
          to: 'available_now',
          from: ['offline'],
          requireNotGated: true,
          actor: { actorType: 'doctor', actorId: DOCTOR_ID },
        });

        expect(result).toMatchObject({
          changed: false,
          refusal: 'completion_gated',
          blockedByConsultationId: CONSULTATION_ID,
        });
        expect(repo.updatePresenceIfIn).not.toHaveBeenCalled();
        expect(audit.write).not.toHaveBeenCalled();
      });

      it('ALSO pushes requireNotGated down into the UPDATE itself, so there is no read-then-write window', async () => {
        const { service, repo } = buildHarness({
          findByIdForUpdate: jest.fn(async () => makeDoctor({ presence: 'offline', blockedByConsultationId: null })),
        });

        await service.transitionPresence({
          doctorId: DOCTOR_ID,
          to: 'available_now',
          from: ['offline'],
          requireNotGated: true,
          actor: SYSTEM,
        });

        expect(repo.updatePresenceIfIn).toHaveBeenCalledWith(
          DOCTOR_ID,
          ['offline'],
          'available_now',
          { requireNotGated: true },
          expect.anything(),
        );
      });

      it('does NOT block a transition that did not ask for the gate check — going offline while gated is legal', async () => {
        const { service } = buildHarness({
          findByIdForUpdate: jest.fn(async () => makeDoctor({ presence: 'paused', blockedByConsultationId: CONSULTATION_ID })),
        });

        const result = await service.transitionPresence({
          doctorId: DOCTOR_ID,
          to: 'offline',
          from: ['paused'],
          actor: SYSTEM,
        });

        expect(result.changed).toBe(true);
        expect(result.refusal).toBeUndefined();
      });
    });
  });

  describe('setCompletionGate', () => {
    it('sets the gate and audits it against the gating consultation', async () => {
      const { service, repo, audit, db } = buildHarness();

      const result = await service.setCompletionGate({ doctorId: DOCTOR_ID, consultationId: CONSULTATION_ID, actor: SYSTEM });

      expect(result).toEqual({ changed: true, doctorId: DOCTOR_ID, blockedByConsultationId: CONSULTATION_ID });
      expect(repo.setCompletionGate).toHaveBeenCalledWith(DOCTOR_ID, CONSULTATION_ID, db);
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: DOCTOR_AUDIT_ENTITY_TYPES.DOCTOR_COMPLETION_GATE,
          entityId: DOCTOR_ID,
          consultationId: CONSULTATION_ID,
          metadata: { change: 'completion_gate_set', before: null, after: CONSULTATION_ID },
        }),
        db,
      );
    });

    it('is an idempotent no-op when already gated by the SAME consultation', async () => {
      const { service, repo, audit } = buildHarness({
        findByIdForUpdate: jest.fn(async () => makeDoctor({ blockedByConsultationId: CONSULTATION_ID })),
      });

      const result = await service.setCompletionGate({ doctorId: DOCTOR_ID, consultationId: CONSULTATION_ID, actor: SYSTEM });

      expect(result).toMatchObject({ changed: false, blockedByConsultationId: CONSULTATION_ID });
      expect(result.refusal).toBeUndefined();
      expect(repo.setCompletionGate).not.toHaveBeenCalled();
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('REFUSES when already gated by a DIFFERENT consultation — the older documentation must not be dropped', async () => {
      const { service, audit } = buildHarness({
        findByIdForUpdate: jest.fn(async () => makeDoctor({ blockedByConsultationId: OTHER_CONSULTATION_ID })),
        setCompletionGate: jest.fn(async () => null),
      });

      const result = await service.setCompletionGate({ doctorId: DOCTOR_ID, consultationId: CONSULTATION_ID, actor: SYSTEM });

      expect(result).toMatchObject({ changed: false, refusal: 'already_gated', blockedByConsultationId: OTHER_CONSULTATION_ID });
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('refuses for an unknown doctor rather than throwing', async () => {
      const { service } = buildHarness({ findByIdForUpdate: jest.fn(async () => null) });
      await expect(
        service.setCompletionGate({ doctorId: DOCTOR_ID, consultationId: CONSULTATION_ID, actor: SYSTEM }),
      ).resolves.toMatchObject({ changed: false, refusal: 'doctor_not_found' });
    });
  });

  describe('clearCompletionGate', () => {
    it('clears by CONSULTATION — M-15 holds the consultation, not the doctor id', async () => {
      const { service, repo, audit, db } = buildHarness();

      const result = await service.clearCompletionGate({ consultationId: CONSULTATION_ID, actor: SYSTEM });

      expect(result).toEqual({ changed: true, doctorId: DOCTOR_ID, blockedByConsultationId: null });
      expect(repo.clearCompletionGateByConsultation).toHaveBeenCalledWith(CONSULTATION_ID, db);
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({
          entityType: DOCTOR_AUDIT_ENTITY_TYPES.DOCTOR_COMPLETION_GATE,
          consultationId: CONSULTATION_ID,
          metadata: { change: 'completion_gate_cleared', before: CONSULTATION_ID, after: null },
        }),
        db,
      );
    });

    it('is IDEMPOTENT — clearing a gate nobody holds succeeds silently, so M-15 can retry', async () => {
      const { service, audit } = buildHarness({ clearCompletionGateByConsultation: jest.fn(async () => null) });

      const result = await service.clearCompletionGate({ consultationId: CONSULTATION_ID, actor: SYSTEM });

      expect(result).toEqual({ changed: false, doctorId: null, blockedByConsultationId: null });
      expect(audit.write).not.toHaveBeenCalled();
    });
  });

  describe('listInstantRoutingCandidates', () => {
    it('projects only what routing needs — the fee and duration, never a full listing', async () => {
      const { service } = buildHarness();

      await expect(
        service.listInstantRoutingCandidates({ specialtyId: 'spec', limit: 5 }),
      ).resolves.toEqual([
        { doctorId: DOCTOR_ID, fullName: 'Dr Test', consultationFeeInr: '750.00', consultationDurationMinutes: 30 },
      ]);
    });

    it('passes the exclusion list through, so a doctor already tried is never re-offered', async () => {
      const { service, repo } = buildHarness();

      await service.listInstantRoutingCandidates({ specialtyId: 'spec', excludeDoctorIds: [OTHER_DOCTOR_ID], limit: 3 });

      expect(repo.listInstantRoutingCandidates).toHaveBeenCalledWith({
        specialtyId: 'spec',
        excludeDoctorIds: [OTHER_DOCTOR_ID],
        limit: 3,
      });
    });

    it('short-circuits a zero limit without touching the database', async () => {
      const { service, repo } = buildHarness();
      await expect(service.listInstantRoutingCandidates({ specialtyId: 'spec', limit: 0 })).resolves.toEqual([]);
      expect(repo.listInstantRoutingCandidates).not.toHaveBeenCalled();
    });
  });

  describe('resetPresence (the boot sweep)', () => {
    it('audits EVERY doctor it moved, individually, inside the one transaction', async () => {
      const { service, repo, audit, db } = buildHarness();

      const result = await service.resetPresence({
        from: ['available_now', 'request_pending'],
        to: 'offline',
        actor: SYSTEM,
        reason: 'boot_sweep_no_live_stream',
      });

      expect(result).toEqual({ doctorIds: [DOCTOR_ID, OTHER_DOCTOR_ID] });
      expect(repo.bulkResetPresence).toHaveBeenCalledWith(['available_now', 'request_pending'], 'offline', db);
      expect(audit.write).toHaveBeenCalledTimes(2);
      expect(audit.write).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          entityId: DOCTOR_ID,
          entityType: DOCTOR_AUDIT_ENTITY_TYPES.DOCTOR_PRESENCE,
          // `before` is null: a bulk statement cannot report each row's prior
          // state, and inventing one would be worse than saying nothing.
          metadata: { change: 'presence', before: null, after: 'offline', reason: 'boot_sweep_no_live_stream' },
        }),
        db,
      );
    });

    it('writes no audit rows when nothing was stale', async () => {
      const { service, audit } = buildHarness({ bulkResetPresence: jest.fn(async () => []) });
      await expect(service.resetPresence({ from: ['available_now'], to: 'offline', actor: SYSTEM })).resolves.toEqual({
        doctorIds: [],
      });
      expect(audit.write).not.toHaveBeenCalled();
    });
  });

  it('attributes an admin override to the ADMIN, not to the doctor being moved', async () => {
    const { service, audit } = buildHarness({ findByIdForUpdate: jest.fn(async () => makeDoctor({ presence: 'available_now' })) });

    await service.transitionPresence({
      doctorId: DOCTOR_ID,
      to: 'offline',
      from: ['available_now'],
      actor: { actorType: 'admin', actorId: ADMIN_ID },
      reason: 'admin_override',
    });

    expect(audit.write).toHaveBeenCalledWith(
      expect.objectContaining({ actorType: 'admin', actorId: ADMIN_ID, entityId: DOCTOR_ID }),
      expect.anything(),
    );
  });
});
