import type { ClinicalRecordRow } from '../../schema/clinical-records.schema';
import type { InstantFacade } from '../instant/instant.facade';
import type { ClinicalBookingPort, ClinicalConsultationView } from './clinical-booking.contract';
import { ClinicalGateSweepService } from './clinical-gate-sweep.service';
import { CLINICAL_GATE_SWEEP_MAX_BATCHES } from './clinical.constants';
import type { ClinicalRepository } from './clinical.repository';

const CONSULTATION_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_CONSULTATION_ID = '99999999-9999-4999-8999-999999999999';
const DOCTOR_ID = '22222222-2222-4222-8222-222222222222';
const PATIENT_ID = '44444444-4444-4444-8444-444444444444';
const SPECIALTY_ID = '55555555-5555-4555-8555-555555555555';

function finalisedRecord(consultationId = CONSULTATION_ID): ClinicalRecordRow {
  return {
    id: 'record-1',
    consultationId,
    chiefComplaint: 'Low mood.',
    clinicalHistory: null,
    diagnosis: null,
    isDiagnosisProvisional: true,
    riskCategory: 'low',
    referralNote: null,
    medicines: [],
    adviceCovered: null,
    adviceHomePractice: null,
    adviceNextFocus: null,
    adviceWarningSigns: null,
    caseSummary: 'Stable.',
    finalisedAt: new Date('2026-09-01T11:00:00Z'),
    createdAt: new Date('2026-09-01T10:00:00Z'),
    updatedAt: new Date('2026-09-01T11:00:00Z'),
  };
}

function consultation(overrides: Partial<ClinicalConsultationView> = {}): ClinicalConsultationView {
  return {
    id: CONSULTATION_ID,
    referenceCode: 'DC-2026-000123',
    patientId: PATIENT_ID,
    doctorId: DOCTOR_ID,
    specialtyId: SPECIALTY_ID,
    mode: 'instant',
    status: 'completed',
    scheduledStartAt: null,
    durationMinutes: 30,
    ...overrides,
  };
}

/** Hand-rolled deps, `new ClinicalGateSweepService(...)` — never `Test.createTestingModule`. */
function createDeps() {
  const repo = { listFinalisedSince: jest.fn().mockResolvedValue([]) };
  const bookings = {
    getBooking: jest.fn(),
    completeConsultation: jest.fn().mockResolvedValue({ changed: true, status: 'completed' }),
  };
  const instant = {
    getPresence: jest.fn(),
    clearCompletionGate: jest.fn().mockResolvedValue({ changed: true, doctorId: DOCTOR_ID, blockedByConsultationId: null }),
  };

  const service = new ClinicalGateSweepService(
    repo as unknown as ClinicalRepository,
    bookings as unknown as ClinicalBookingPort,
    instant as unknown as InstantFacade,
  );

  return { service, repo, bookings, instant };
}

function presence(blockedByConsultationId: string | null) {
  return {
    doctorId: DOCTOR_ID,
    presence: 'completing_notes' as const,
    allowInstantConsult: true,
    blockedByConsultationId,
    routable: false,
  };
}

describe('ClinicalGateSweepService', () => {
  /* ═══════════════════════════════════════════════════════════════════════ */
  /* The backstop for the thing that cannot be one transaction               */
  /* ═══════════════════════════════════════════════════════════════════════ */

  describe('reconciling a finalised record whose doctor is still gated', () => {
    it('*** CLEARS A GATE LEFT BEHIND BY A CRASH between finalising and un-gating ***', async () => {
      const deps = createDeps();
      deps.repo.listFinalisedSince.mockResolvedValue([finalisedRecord()]);
      deps.bookings.getBooking.mockResolvedValue(consultation());
      deps.instant.getPresence.mockResolvedValue(presence(CONSULTATION_ID));

      const result = await deps.service.sweepFinalisedRecords();

      expect(deps.instant.clearCompletionGate).toHaveBeenCalledWith(CONSULTATION_ID);
      expect(result).toMatchObject({ examined: 1, gatesCleared: 1 });
    });

    it('*** NEVER CLEARS A GATE HELD BY A DIFFERENT CONSULTATION *** — that is outstanding documentation elsewhere', async () => {
      const deps = createDeps();
      deps.repo.listFinalisedSince.mockResolvedValue([finalisedRecord()]);
      deps.bookings.getBooking.mockResolvedValue(consultation());
      deps.instant.getPresence.mockResolvedValue(presence(OTHER_CONSULTATION_ID));

      const result = await deps.service.sweepFinalisedRecords();

      expect(deps.instant.clearCompletionGate).not.toHaveBeenCalled();
      expect(result.gatesCleared).toBe(0);
    });

    it('does nothing for the normal case: an un-gated doctor', async () => {
      const deps = createDeps();
      deps.repo.listFinalisedSince.mockResolvedValue([finalisedRecord()]);
      deps.bookings.getBooking.mockResolvedValue(consultation());
      deps.instant.getPresence.mockResolvedValue(presence(null));

      const result = await deps.service.sweepFinalisedRecords();

      expect(deps.instant.clearCompletionGate).not.toHaveBeenCalled();
      expect(result).toMatchObject({ examined: 1, gatesCleared: 0, consultationsCompleted: 0 });
    });

    it('reads presence BEFORE it writes — no blind idempotent UPDATE against M-05 on every tick', async () => {
      const deps = createDeps();
      deps.repo.listFinalisedSince.mockResolvedValue([finalisedRecord()]);
      deps.bookings.getBooking.mockResolvedValue(consultation());
      deps.instant.getPresence.mockResolvedValue(presence(null));

      await deps.service.sweepFinalisedRecords();

      expect(deps.instant.getPresence).toHaveBeenCalledWith(DOCTOR_ID);
      expect(deps.instant.clearCompletionGate).not.toHaveBeenCalled();
    });

    it('skips a consultation with no doctor attached — there is nothing to un-gate', async () => {
      const deps = createDeps();
      deps.repo.listFinalisedSince.mockResolvedValue([finalisedRecord()]);
      deps.bookings.getBooking.mockResolvedValue(consultation({ doctorId: null }));

      await deps.service.sweepFinalisedRecords();

      expect(deps.instant.getPresence).not.toHaveBeenCalled();
    });

    it('skips a finalised record whose consultation has vanished', async () => {
      const deps = createDeps();
      deps.repo.listFinalisedSince.mockResolvedValue([finalisedRecord()]);
      deps.bookings.getBooking.mockResolvedValue(null);

      const result = await deps.service.sweepFinalisedRecords();

      expect(result).toMatchObject({ examined: 1, gatesCleared: 0, failed: 0 });
    });
  });

  describe('reconciling a consultation stranded before `completed`', () => {
    it('completes a consultation left in awaiting_documentation under a final record', async () => {
      const deps = createDeps();
      deps.repo.listFinalisedSince.mockResolvedValue([finalisedRecord()]);
      deps.bookings.getBooking.mockResolvedValue(consultation({ status: 'awaiting_documentation' }));
      deps.instant.getPresence.mockResolvedValue(presence(null));

      const result = await deps.service.sweepFinalisedRecords();

      expect(deps.bookings.completeConsultation).toHaveBeenCalledWith({
        consultationId: CONSULTATION_ID,
        from: ['in_progress', 'awaiting_documentation'],
        reason: 'clinical_gate_sweep',
      });
      expect(result.consultationsCompleted).toBe(1);
    });

    it('leaves an already-completed consultation alone', async () => {
      const deps = createDeps();
      deps.repo.listFinalisedSince.mockResolvedValue([finalisedRecord()]);
      deps.bookings.getBooking.mockResolvedValue(consultation({ status: 'completed' }));
      deps.instant.getPresence.mockResolvedValue(presence(null));

      await deps.service.sweepFinalisedRecords();

      expect(deps.bookings.completeConsultation).not.toHaveBeenCalled();
    });

    it('repairs BOTH consequences in one pass when both were lost', async () => {
      const deps = createDeps();
      deps.repo.listFinalisedSince.mockResolvedValue([finalisedRecord()]);
      deps.bookings.getBooking.mockResolvedValue(consultation({ status: 'in_progress' }));
      deps.instant.getPresence.mockResolvedValue(presence(CONSULTATION_ID));

      const result = await deps.service.sweepFinalisedRecords();

      expect(result).toMatchObject({ examined: 1, gatesCleared: 1, consultationsCompleted: 1, failed: 0 });
    });
  });

  describe('batching', () => {
    it('one failing candidate does not abandon the rest of the batch', async () => {
      const deps = createDeps();
      deps.repo.listFinalisedSince.mockResolvedValue([finalisedRecord(OTHER_CONSULTATION_ID), finalisedRecord()]);
      deps.bookings.getBooking.mockImplementation(async (id: string) => {
        if (id === OTHER_CONSULTATION_ID) throw new Error('booking module unreachable');
        return consultation();
      });
      deps.instant.getPresence.mockResolvedValue(presence(CONSULTATION_ID));

      const result = await deps.service.sweepFinalisedRecords();

      expect(result).toMatchObject({ examined: 2, failed: 1, gatesCleared: 1 });
    });

    it('bounds its candidate window, and opens the first page with no cursor', async () => {
      const deps = createDeps();
      const now = new Date('2026-09-02T00:00:00Z');

      await deps.service.sweepFinalisedRecords(now, 60_000);

      expect(deps.repo.listFinalisedSince).toHaveBeenCalledWith(new Date('2026-09-01T23:59:00Z'), 100, null);
    });

    /* ═════════════════════════════════════════════════════════════════════ */
    /* *** THE BATCH IS A PAGE, NOT A CEILING ON THE PASS. ***               */
    /*                                                                       */
    /* Nothing this sweep does removes a record from "finalised inside the   */
    /* window", and the ordering is newest first — so a single bounded query */
    /* re-read the same newest rows on every tick and never reached the      */
    /* rest. See `clinical.repository.ts#listFinalisedSince`.                */
    /* ═════════════════════════════════════════════════════════════════════ */

    it('*** KEEPS PAGING PAST A FULL BATCH, KEYSET ON (finalised_at, id) ***', async () => {
      const deps = createDeps();
      const older = { ...finalisedRecord(OTHER_CONSULTATION_ID), id: 'record-2', finalisedAt: new Date('2026-09-01T10:00:00Z') };
      deps.repo.listFinalisedSince
        .mockResolvedValueOnce([finalisedRecord()])
        .mockResolvedValueOnce([older])
        .mockResolvedValue([]);
      deps.bookings.getBooking.mockResolvedValue(consultation());
      deps.instant.getPresence.mockResolvedValue(null);

      const result = await deps.service.sweepFinalisedRecords(new Date('2026-09-02T00:00:00Z'), 60_000, 1);

      expect(result.examined).toBe(2);
      expect(deps.repo.listFinalisedSince).toHaveBeenNthCalledWith(1, expect.any(Date), 1, null);
      expect(deps.repo.listFinalisedSince).toHaveBeenNthCalledWith(2, expect.any(Date), 1, {
        finalisedAt: new Date('2026-09-01T11:00:00Z'),
        id: 'record-1',
      });
      expect(deps.repo.listFinalisedSince).toHaveBeenNthCalledWith(3, expect.any(Date), 1, {
        finalisedAt: new Date('2026-09-01T10:00:00Z'),
        id: 'record-2',
      });
      expect(result.truncated).toBe(false);
    });

    it('stops paging on a SHORT page — a page that is not full is the end of the window', async () => {
      const deps = createDeps();
      deps.repo.listFinalisedSince.mockResolvedValue([finalisedRecord()]);
      deps.bookings.getBooking.mockResolvedValue(consultation());
      deps.instant.getPresence.mockResolvedValue(null);

      await deps.service.sweepFinalisedRecords(new Date(), 60_000, 100);

      expect(deps.repo.listFinalisedSince).toHaveBeenCalledTimes(1);
    });

    it('*** REPORTS `truncated` RATHER THAN SILENTLY ABSORBING A BACKLOG *** when it runs out of batches', async () => {
      const deps = createDeps();
      // Every page comes back full, so the pass can only ever be stopped by
      // `CLINICAL_GATE_SWEEP_MAX_BATCHES`.
      deps.repo.listFinalisedSince.mockResolvedValue([finalisedRecord()]);
      deps.bookings.getBooking.mockResolvedValue(consultation());
      deps.instant.getPresence.mockResolvedValue(null);

      const result = await deps.service.sweepFinalisedRecords(new Date(), 60_000, 1);

      expect(result.truncated).toBe(true);
      expect(result.examined).toBe(CLINICAL_GATE_SWEEP_MAX_BATCHES);
      expect(deps.repo.listFinalisedSince).toHaveBeenCalledTimes(CLINICAL_GATE_SWEEP_MAX_BATCHES);
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════ */
  /* Scheduling — copied verbatim from booking-slot-hold.service.ts          */
  /* ═══════════════════════════════════════════════════════════════════════ */

  describe('scheduling', () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    it('starts an UNREF\'d interval on module init, so Jest and CLI processes still exit', () => {
      jest.useFakeTimers();
      const deps = createDeps();

      deps.service.onModuleInit();

      expect(jest.getTimerCount()).toBe(1);
      deps.service.onApplicationShutdown();
    });

    it('clears the interval on application shutdown', () => {
      jest.useFakeTimers();
      const deps = createDeps();

      deps.service.onModuleInit();
      deps.service.onApplicationShutdown();

      expect(jest.getTimerCount()).toBe(0);
    });

    it('does not start a second interval when init runs twice', () => {
      jest.useFakeTimers();
      const deps = createDeps();

      deps.service.onModuleInit();
      deps.service.onModuleInit();

      expect(jest.getTimerCount()).toBe(1);
      deps.service.onApplicationShutdown();
    });

    it('is re-entrancy guarded: a slow pass cannot overlap the next tick', async () => {
      jest.useFakeTimers();
      const deps = createDeps();
      let release: (() => void) | undefined;
      deps.repo.listFinalisedSince.mockImplementation(
        () =>
          new Promise((resolve) => {
            release = () => resolve([]);
          }),
      );

      deps.service.onModuleInit();
      jest.advanceTimersByTime(60_000);
      await Promise.resolve();
      jest.advanceTimersByTime(60_000);
      await Promise.resolve();

      // Two ticks fired; only the first pass ever reached the candidate query.
      expect(deps.repo.listFinalisedSince).toHaveBeenCalledTimes(1);
      release?.();
      deps.service.onApplicationShutdown();
    });

    it('never lets a failed pass escape as an unhandled rejection', async () => {
      jest.useFakeTimers();
      const deps = createDeps();
      deps.repo.listFinalisedSince.mockRejectedValue(new Error('database down'));

      deps.service.onModuleInit();
      jest.advanceTimersByTime(60_000);

      await expect(Promise.resolve()).resolves.toBeUndefined();
      deps.service.onApplicationShutdown();
    });
  });
});
