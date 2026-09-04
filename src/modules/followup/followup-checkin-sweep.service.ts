import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import type { FollowupAssignmentRow } from '../../schema/followup-assignments.schema';
import { BookingFacade } from '../booking/booking.facade';
import { FollowupAlertService } from './followup-alert.service';
import { addDaysToIsoDate, isoDateLessThan, todayIstDate } from './followup-ist.util';
import { FollowupPathwayService } from './followup-pathway.service';
import {
  FOLLOWUP_CHECKIN_SWEEP_BATCH_SIZE,
  FOLLOWUP_CHECKIN_SWEEP_INTERVAL_MS,
  FOLLOWUP_CHECKIN_SWEEP_MAX_BATCHES,
} from './followup.constants';
import { FollowupRepository } from './followup.repository';

/**
 * *** HOW THIS SWEEP IS SCHEDULED, AND WHY. ***
 *
 * Same shape as `clinical-gate-sweep.service.ts` and `pricing-quote-sweep
 * .service.ts`, both copied from `booking-slot-hold.service.ts`'s own header:
 * `@nestjs/schedule` is deliberately NOT installed (this worktree does not
 * add it — a second worktree adding the same dependency is exactly the
 * `package.json`/`package-lock.json` merge conflict this codebase avoids
 * across parallel builds). A plain `setInterval` owned by this service,
 * started in `onModuleInit`, `.unref()`'d so it never holds the process open,
 * cleared in `onApplicationShutdown`, and re-entrancy guarded so a slow pass
 * can never overlap the next tick.
 *
 * MULTI-INSTANCE SAFETY, WITH ONE HONEST CAVEAT: `updateAssignmentStatus` is
 * a plain `UPDATE ... WHERE id = ...`, so the window-close transition is
 * fully idempotent under any number of concurrent sweepers. The missed-
 * check-in dedup (`followup.repository.ts#findOpenMissedCheckinAlertByReason`)
 * is a check-THEN-insert, not a constraint — unlike `checkin_responses`'
 * partial unique index, `safety_alerts` carries no unique constraint that
 * could make "one alert per missed day" atomic. At launch scale (§6.4: one
 * process) this is moot; if a second instance is ever added, two sweepers
 * ticking at the same instant against the same stale day could both pass the
 * dedup read and both insert, producing two `missed_checkin` rows for the
 * same day rather than one. That is a duplicate alert, never a lost one or a
 * corrupted read — the failure mode this sweep exists to prevent — so it is
 * left as a known, minor gap rather than reached for with a second advisory
 * lock this module's current single-instance deployment does not need.
 */
const SWEEP_SCHEDULING = true;

export interface FollowupCheckinSweepResult {
  examined: number;
  missedCheckinAlertsRaised: number;
  assignmentsCompleted: number;
  failed: number;
  /** `true` when the pass hit `FOLLOWUP_CHECKIN_SWEEP_MAX_BATCHES` with candidates still unread — see `clinical-gate-sweep.service.ts`'s header for why this is reported rather than silently absorbed. */
  truncated: boolean;
}

/**
 * *** FR-13.3's "MISSED CHECK-IN" HALF, AND THE WINDOW-CLOSE TRANSITION. ***
 *
 * Two jobs in one pass, both over the same `active` assignments:
 *
 *   1. A consultation whose most recently DUE day (yesterday, IST) has no
 *      `checkin_responses` row raises a `missed_checkin` `safety_alerts` row
 *      (FR-13.3/FR-13.5) — once per missed day, never re-raised on every
 *      5-minute tick for the same day (see the repository method's header).
 *
 *   2. An assignment whose window has fully elapsed
 *      (`today >= starts_on + duration_days`) is moved `active -> completed`
 *      — nothing else in this module writes that transition, so without a
 *      sweep an assignment would stay `active` (and keep being checked for a
 *      missed check-in) forever after its seventh day.
 *
 * Deliberately looks only at YESTERDAY, not the whole elapsed window: a
 * patient who has missed three days in a row gets one open alert, not three
 * — an admin acting on it addresses the pattern, and `findOpenMissedCheckin
 * AlertByReason` would otherwise let the same day be re-raised is avoided by
 * checking only the single day that just became "due", each tick.
 */
@Injectable()
export class FollowupCheckinSweepService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(FollowupCheckinSweepService.name);
  private timer: NodeJS.Timeout | null = null;
  private sweepInFlight = false;

  constructor(
    private readonly repo: FollowupRepository,
    private readonly pathways: FollowupPathwayService,
    private readonly alerts: FollowupAlertService,
    private readonly booking: BookingFacade,
  ) {}

  onModuleInit(): void {
    if (!SWEEP_SCHEDULING || this.timer) return;
    this.timer = setInterval(() => {
      void this.runScheduledSweep();
    }, FOLLOWUP_CHECKIN_SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async runScheduledSweep(): Promise<void> {
    if (this.sweepInFlight) {
      this.logger.warn('Previous follow-up check-in sweep still running; skipping this tick.');
      return;
    }
    this.sweepInFlight = true;
    try {
      const result = await this.sweep();
      if (result.missedCheckinAlertsRaised > 0 || result.assignmentsCompleted > 0 || result.failed > 0 || result.truncated) {
        this.logger.log(
          `Follow-up check-in sweep: ${result.missedCheckinAlertsRaised} missed-check-in alert(s), ` +
            `${result.assignmentsCompleted} assignment(s) completed, ${result.failed} failed, of ${result.examined} examined.`,
        );
      }
    } catch (error) {
      this.logger.error(`Follow-up check-in sweep failed: ${describeError(error)}`);
    } finally {
      this.sweepInFlight = false;
    }
  }

  /** One sweep pass, paged across every `active` assignment. Safe to call directly (tests do) and safe to run concurrently with itself in another process. */
  async sweep(today: string = todayIstDate()): Promise<FollowupCheckinSweepResult> {
    const result: FollowupCheckinSweepResult = {
      examined: 0,
      missedCheckinAlertsRaised: 0,
      assignmentsCompleted: 0,
      failed: 0,
      truncated: false,
    };

    let cursor: string | null = null;

    for (let batch = 0; batch < FOLLOWUP_CHECKIN_SWEEP_MAX_BATCHES; batch += 1) {
      const candidates = await this.repo.listActiveAssignments(FOLLOWUP_CHECKIN_SWEEP_BATCH_SIZE, cursor);
      if (candidates.length === 0) return result;

      for (const assignment of candidates) {
        result.examined += 1;
        try {
          const outcome = await this.reconcileOne(assignment, today);
          if (outcome.missedAlertRaised) result.missedCheckinAlertsRaised += 1;
          if (outcome.completed) result.assignmentsCompleted += 1;
        } catch (error) {
          result.failed += 1;
          this.logger.error(`Reconciling assignment ${assignment.id} (consultation ${assignment.consultationId}) failed: ${describeError(error)}`);
        }
      }

      if (candidates.length < FOLLOWUP_CHECKIN_SWEEP_BATCH_SIZE) return result;
      cursor = candidates[candidates.length - 1]!.id;
    }

    result.truncated = true;
    this.logger.warn(
      `Follow-up check-in sweep stopped after ${FOLLOWUP_CHECKIN_SWEEP_MAX_BATCHES} batches with candidates still unread; the rest will be examined on the next tick.`,
    );
    return result;
  }

  private async reconcileOne(assignment: FollowupAssignmentRow, today: string): Promise<{ missedAlertRaised: boolean; completed: boolean }> {
    const pathway = await this.pathways.getByIdOrThrow(assignment.pathwayId);
    const windowEnd = addDaysToIsoDate(assignment.startsOn, pathway.durationDays); // exclusive

    if (!isoDateLessThan(today, windowEnd)) {
      await this.repo.updateAssignmentStatus(assignment.id, 'completed');
      return { missedAlertRaised: false, completed: true };
    }

    const yesterday = addDaysToIsoDate(today, -1);
    // The window may have started only today, in which case there is no
    // "yesterday" inside it yet to have missed.
    if (isoDateLessThan(yesterday, assignment.startsOn)) return { missedAlertRaised: false, completed: false };

    const existingCheckin = await this.repo.findCheckin(assignment.consultationId, yesterday);
    if (existingCheckin) return { missedAlertRaised: false, completed: false };

    const reason = missedCheckinReason(yesterday);
    const existingAlert = await this.repo.findOpenMissedCheckinAlertByReason(assignment.consultationId, reason);
    if (existingAlert) return { missedAlertRaised: false, completed: false };

    const booking = await this.booking.getBooking(assignment.consultationId).catch(() => null);
    await this.alerts.raiseAlert({
      alertType: 'missed_checkin',
      consultationId: assignment.consultationId,
      checkinResponseId: null,
      reason,
      doctorId: booking?.doctorId ?? null,
    });
    return { missedAlertRaised: true, completed: false };
  }
}

/** Deterministic per date — doubles as the dedup key `findOpenMissedCheckinAlertByReason` matches on. Event-shaped, never clinical (FR-16.2's discipline, applied to an internal record read only by governance-permissioned admins, not a notification body — but there is no reason to be less careful here). */
export function missedCheckinReason(missedDate: string): string {
  return `No check-in was received for ${missedDate}.`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
