import { Inject, Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import type { ConsultationStatus } from '../../schema/enums.schema';
import { InstantFacade } from '../instant/instant.facade';
import type { ClinicalBookingPort } from './clinical-booking.contract';
import {
  CLINICAL_BOOKING_PORT,
  CLINICAL_GATE_SWEEP_BATCH_SIZE,
  CLINICAL_GATE_SWEEP_INTERVAL_MS,
  CLINICAL_GATE_SWEEP_LOOKBACK_MS,
  CLINICAL_GATE_SWEEP_MAX_BATCHES,
  CLINICAL_RECORD_WRITABLE_STATUSES,
} from './clinical.constants';
import { ClinicalRepository } from './clinical.repository';

/** One pass's outcome. Every number is a count of records, not of facade calls. */
export interface ClinicalGateSweepResult {
  examined: number;
  /** Doctors un-gated by this pass — each one is a crash that got repaired. */
  gatesCleared: number;
  /** Consultations moved to `completed` by this pass — the other half of the same repair. */
  consultationsCompleted: number;
  failed: number;
  /**
   * `true` when the pass hit `CLINICAL_GATE_SWEEP_MAX_BATCHES` with candidates
   * still unread. The rest of the window is left for the next tick — which is
   * a real backlog, so it is REPORTED rather than silently absorbed.
   */
  truncated: boolean;
}

/**
 * *** HOW THIS SWEEP IS SCHEDULED, AND WHY. ***
 *
 * Copied verbatim from `booking-slot-hold.service.ts`, whose own header makes
 * the argument in full: `@nestjs/schedule` is NOT installed and this module
 * does not add it. A plain `setInterval` owned by this service, started in
 * `onModuleInit`, cleared in `onApplicationShutdown`.
 *
 * The two things a naive `setInterval` gets wrong are both handled here:
 *   - `.unref()`, so the timer never holds the event loop open and Jest and CLI
 *     processes still exit cleanly.
 *   - a re-entrancy guard, so a slow pass can never overlap the next tick.
 *
 * MULTI-INSTANCE SAFETY does not depend on the scheduler. Two processes
 * sweeping at once is harmless: every write this sweep performs is idempotent
 * by the contract of the method that performs it — `clearCompletionGate` is
 * documented idempotent, and `completeConsultation` takes the row lock and
 * enforces the legal FROM-states under it. The loser of a race does nothing.
 */
const SWEEP_SCHEDULING = true;

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * *** THE BACKSTOP FOR THE THING THAT CANNOT BE A TRANSACTION. ***
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `docs/erd.sql` says of `clinical_records`: setting `finalised_at` and
 * clearing `doctors.blocked_by_consultation_id` happen in "the same
 * transaction". They cannot. `instant.contract.ts` already settled why, and
 * this service is the honest version of what it settled on:
 *
 *   "This method takes no `tx`, and cannot: `backend/README.md` §2 forbids
 *    cross-module transactions. What that ERD note asks for is atomicity
 *    between finalisation and un-gating, and the honest version of it here is
 *    that a crash between the two leaves a doctor gated by a consultation whose
 *    record is already final — which is exactly the state `clearCompletionGate`
 *    is idempotent for. M-15 may retry it, an admin may trigger it, and a
 *    doctor sees 'finish your notes' for a record that is finished until one of
 *    those happens."
 *
 * *** THIS IS THE "UNTIL ONE OF THOSE HAPPENS". *** Without it, that sentence
 * describes a state a doctor sits in until somebody notices. With it, the
 * window is one sweep interval.
 *
 * It reconciles BOTH consequences of finalising, because both are cross-module
 * calls made after the transaction commits and both can be lost the same way:
 *
 *   the completion gate      -> `InstantFacade.clearCompletionGate`
 *   the consultation status  -> `CLINICAL_BOOKING_PORT.completeConsultation`
 *
 * The second matters beyond tidiness: `promotion.referral_qualifying_statuses`
 * defaults to `['awaiting_documentation','completed']`, so a consultation
 * stranded in `awaiting_documentation`... would in fact still qualify, but one
 * stranded anywhere else would not, and a referral reward silently never
 * arriving is exactly the kind of failure nobody reports as a bug.
 *
 * ── WHAT THIS SWEEP DELIBERATELY DOES NOT DO ───────────────────────────────
 *
 * It does not regenerate missing prescription PDFs. Finding them would mean
 * rendering a document for every candidate on every tick just to discover it
 * already exists, and the doctor already has an explicit, idempotent retry
 * (`POST /consultations/:id/clinical-record/prescription-pdf`). A sweep should
 * repair silent failures; that one is visible in the finalise response.
 *
 * It also cannot sweep from the GATE's side — see
 * `CLINICAL_GATE_SWEEP_LOOKBACK_MS` for what that costs and why.
 */
@Injectable()
export class ClinicalGateSweepService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(ClinicalGateSweepService.name);
  private timer: NodeJS.Timeout | null = null;
  private sweepInFlight = false;

  constructor(
    private readonly repo: ClinicalRepository,
    @Inject(CLINICAL_BOOKING_PORT) private readonly bookings: ClinicalBookingPort,
    private readonly instant: InstantFacade,
  ) {}

  onModuleInit(): void {
    if (!SWEEP_SCHEDULING || this.timer) return;
    this.timer = setInterval(() => {
      void this.runScheduledSweep();
    }, CLINICAL_GATE_SWEEP_INTERVAL_MS);
    // Never hold the process open for a timer.
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** The timer's entry point: re-entrancy guarded, and it never lets a failure escape into an unhandled rejection. */
  private async runScheduledSweep(): Promise<void> {
    if (this.sweepInFlight) {
      this.logger.warn('Previous clinical gate sweep still running; skipping this tick.');
      return;
    }
    this.sweepInFlight = true;
    try {
      const result = await this.sweepFinalisedRecords();
      if (result.gatesCleared > 0 || result.consultationsCompleted > 0 || result.failed > 0 || result.truncated) {
        this.logger.log(
          `Clinical gate sweep: ${result.gatesCleared} gate(s) cleared, ${result.consultationsCompleted} consultation(s) completed, ` +
            `${result.failed} failed, of ${result.examined} examined.`,
        );
      }
    } catch (error) {
      this.logger.error(`Clinical gate sweep failed: ${describeError(error)}`);
    } finally {
      this.sweepInFlight = false;
    }
  }

  /**
   * One sweep pass, PAGED ACROSS THE WHOLE WINDOW.
   *
   * `now`, `lookbackMs` and `batchSize` are parameters rather than reads of a
   * global clock and constants, so a test can drive it deterministically and an
   * operator can widen the horizon without a redeploy.
   *
   * Safe to call directly (tests do), and safe to run concurrently with itself
   * in another process — every write it performs is idempotent by the contract
   * of the method that performs it.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * *** WHY THIS PAGES INSTEAD OF TAKING ONE BATCH. ***
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * It used to be a single `listFinalisedSince(since, BATCH_SIZE)` and nothing
   * more, on the reasoning — copied verbatim from
   * `booking-slot-hold.service.ts` — that a batch cap lets "a backlog drain
   * steadily instead of in one spike". THAT REASONING DOES NOT SURVIVE THE
   * COPY, and `clinical.repository.ts#listFinalisedSince` sets out why in full:
   * that sweep's action removes the candidate from its own candidate set and
   * takes the oldest first, so its backlog genuinely drains. Nothing here
   * removes a record from "finalised within the last 24 hours", and the
   * ordering is newest first — so every pass, forever, examined the same newest
   * 100 records, and a gate stranded on the 101st was reachable by nothing at
   * all.
   *
   * That is not a corner case. It is every finalised record on any day with
   * more than `CLINICAL_GATE_SWEEP_BATCH_SIZE` of them. The sweep is the ONLY
   * backstop for the crash window between `finalised_at` and the two facade
   * calls that follow it (`clinical.service.ts`), so the backstop quietly
   * stopped covering most of its own window at a volume this product reaches
   * on a slow day.
   *
   * `CLINICAL_GATE_SWEEP_MAX_BATCHES` still bounds the pass: paging an
   * unbounded window every 60 seconds would be a self-inflicted load spike,
   * which is the real concern the batch size was reaching for. Hitting the
   * bound is reported (`truncated`) and logged, rather than being the silent
   * default it used to be.
   */
  async sweepFinalisedRecords(
    now: Date = new Date(),
    lookbackMs: number = CLINICAL_GATE_SWEEP_LOOKBACK_MS,
    batchSize: number = CLINICAL_GATE_SWEEP_BATCH_SIZE,
  ): Promise<ClinicalGateSweepResult> {
    const since = new Date(now.getTime() - lookbackMs);

    const result: ClinicalGateSweepResult = {
      examined: 0,
      gatesCleared: 0,
      consultationsCompleted: 0,
      failed: 0,
      truncated: false,
    };

    let cursor: { finalisedAt: Date; id: string } | null = null;

    for (let batch = 0; batch < CLINICAL_GATE_SWEEP_MAX_BATCHES; batch += 1) {
      const candidates = await this.repo.listFinalisedSince(since, batchSize, cursor);
      if (candidates.length === 0) return result;

      for (const record of candidates) {
        result.examined += 1;
        try {
          const outcome = await this.reconcileOne(record.consultationId);
          if (outcome.gateCleared) result.gatesCleared += 1;
          if (outcome.consultationCompleted) result.consultationsCompleted += 1;
        } catch (error) {
          result.failed += 1;
          this.logger.error(
            `Reconciling finalised consultation ${record.consultationId} failed: ${describeError(error)}`,
          );
        }
      }

      // A short page is the end of the window. A full one may not be, so keyset
      // on the last row read — see the repository for why `(finalised_at, id)`
      // and not an OFFSET.
      if (candidates.length < batchSize) return result;
      const last = candidates[candidates.length - 1];
      if (!last?.finalisedAt) return result;
      cursor = { finalisedAt: last.finalisedAt, id: last.id };
    }

    result.truncated = true;
    this.logger.warn(
      `Clinical gate sweep stopped after ${CLINICAL_GATE_SWEEP_MAX_BATCHES} batches with candidates still unread; ` +
        'the rest of the look-back window will be examined on the next tick.',
    );
    return result;
  }

  /**
   * One finalised record, reconciled.
   *
   * Reads before it writes, both times. `clearCompletionGate` is idempotent, so
   * calling it unconditionally would be CORRECT — but it is an UPDATE against
   * M-05's table for every finalised record in the window, on every tick,
   * forever, to fix something that almost never happens. One indexed presence
   * read tells us whether there is anything to do, and the answer is normally
   * no.
   *
   * The gate is only cleared when the doctor is gated by THIS consultation. A
   * doctor gated by a DIFFERENT one has outstanding documentation elsewhere,
   * and clearing that would drop exactly the obligation the gate exists to
   * hold — the same refusal `markInstantConsultEnded` makes for the same
   * reason.
   */
  private async reconcileOne(consultationId: string): Promise<{ gateCleared: boolean; consultationCompleted: boolean }> {
    const booking = await this.bookings.getBooking(consultationId);
    if (!booking) {
      // A finalised record whose consultation vanished. Nothing to reconcile,
      // and not this sweep's problem to diagnose.
      return { gateCleared: false, consultationCompleted: false };
    }

    let consultationCompleted = false;
    if ((CLINICAL_RECORD_WRITABLE_STATUSES as readonly ConsultationStatus[]).includes(booking.status)) {
      const moved = await this.bookings.completeConsultation({
        consultationId,
        from: CLINICAL_RECORD_WRITABLE_STATUSES,
        reason: 'clinical_gate_sweep',
      });
      consultationCompleted = moved.changed;
    }

    if (!booking.doctorId) {
      return { gateCleared: false, consultationCompleted };
    }

    const presence = await this.instant.getPresence(booking.doctorId);
    if (presence?.blockedByConsultationId !== consultationId) {
      return { gateCleared: false, consultationCompleted };
    }

    this.logger.warn(
      `Doctor ${booking.doctorId} was still gated by consultation ${consultationId}, whose clinical record is already final. Clearing.`,
    );
    const gate = await this.instant.clearCompletionGate(consultationId);
    return { gateCleared: gate.changed, consultationCompleted };
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
