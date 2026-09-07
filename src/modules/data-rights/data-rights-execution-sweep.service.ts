import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../../shared/app-config/app-config.service';
import { DataDeletionExecutionFacade } from '../consent/data-deletion-execution.facade';
import { DATA_DELETION_CONFIG_KEYS, DATA_DELETION_DEFAULT_AUTO_EXECUTE } from '../consent/data-deletion.constants';
import { DataRightsService } from './data-rights.service';

/**
 * *** HOW THE SWEEP IS SCHEDULED, AND WHY. *** Copied verbatim from
 * `pricing-quote-sweep.service.ts`'s own `SWEEP_SCHEDULING` comment,
 * because the reasoning is identical and the two must not diverge:
 * `@nestjs/schedule` is not installed and this module does not add it
 * (see that file's header for the full three-point argument); a plain
 * `setInterval`, `.unref()`'d and re-entrancy guarded, is the whole
 * mechanism. Multi-instance safety does not depend on the scheduler at
 * all — every write this sweep makes is a CONDITIONAL UPDATE guarded on
 * the status it expects (`data-deletion.repository.ts#autoApprove`, and
 * `recordExecutionOutcome`'s own `WHERE status = 'approved'`), so two
 * processes sweeping the same request at once is harmless: the loser
 * simply matches zero rows and moves on.
 *
 * *** THIS IS THE ONE AUTOMATIC TRIGGER OF EXECUTION IN THIS CODEBASE. ***
 * `data-rights.service.ts`'s own header used to say "no sweep, no
 * scheduler, no automatic trigger... called ONLY from the two explicit
 * HTTP routes" — true when it was written, no longer true now that FR-2.5's
 * "auto delete in set period" exists as a real requirement. An admin's
 * explicit `POST .../execute` remains available at any time regardless —
 * this sweep is what happens when nobody used it before the grace period
 * (`compliance.deletion_grace_period_days`) ran out.
 */
const SWEEP_SCHEDULING = true;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // hourly — a deletion grace period is measured in days, not minutes, so this needs no tighter cadence
const SWEEP_BATCH_SIZE = 50;

export interface DeletionSweepResult {
  examined: number;
  executed: number;
  failed: number;
  deferred: number;
}

@Injectable()
export class DataRightsExecutionSweepService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(DataRightsExecutionSweepService.name);
  private timer: NodeJS.Timeout | null = null;
  private sweepInFlight = false;

  constructor(
    private readonly deletionRequests: DataDeletionExecutionFacade,
    private readonly dataRights: DataRightsService,
    private readonly appConfig: AppConfigService,
  ) {}

  onModuleInit(): void {
    if (!SWEEP_SCHEDULING || this.timer) return;
    this.timer = setInterval(() => {
      void this.runScheduledSweep();
    }, SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** The timer's entry point: re-entrancy guarded, never lets a failure escape into an unhandled rejection. */
  private async runScheduledSweep(): Promise<void> {
    if (this.sweepInFlight) {
      this.logger.warn('Previous data-deletion sweep still running; skipping this tick.');
      return;
    }
    this.sweepInFlight = true;
    try {
      const result = await this.sweep();
      if (result.executed > 0 || result.failed > 0) {
        this.logger.log(`Data-deletion sweep: ${result.executed} executed, ${result.failed} failed, ${result.deferred} deferred, of ${result.examined} examined.`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Data-deletion sweep failed: ${message}`);
    } finally {
      this.sweepInFlight = false;
    }
  }

  /**
   * One sweep pass. Safe to call directly (tests do), and safe to run
   * concurrently with itself in another process.
   *
   * `compliance.deletion_auto_execute` (default `true`) is the operator's
   * kill switch: `false` makes the grace period purely INFORMATIONAL — a
   * request still becomes visible as "due" but this method returns without
   * touching it, leaving execution to an admin's explicit action. This is
   * checked ONCE per pass, not per request, so a mid-pass config edit
   * cannot leave some requests auto-executed and others not within the same
   * tick.
   */
  async sweep(): Promise<DeletionSweepResult> {
    const result: DeletionSweepResult = { examined: 0, executed: 0, failed: 0, deferred: 0 };

    const autoExecute = await this.appConfig.getJson<boolean>(DATA_DELETION_CONFIG_KEYS.AUTO_EXECUTE, DATA_DELETION_DEFAULT_AUTO_EXECUTE);
    const due = await this.deletionRequests.listDueForSweep(SWEEP_BATCH_SIZE);
    result.examined = due.length;
    if (!autoExecute || due.length === 0) {
      result.deferred = due.length;
      return result;
    }

    for (const request of due) {
      try {
        if (request.status === 'requested' || request.status === 'in_review') {
          await this.deletionRequests.autoApproveForSweep(request.id);
        }
        // Re-read is unnecessary: `autoApproveForSweep` either already
        // reflects `approved` (its own idempotent return), or the request
        // was `approved` already — either way `executeForRequest`'s own
        // `WHERE status = 'approved'` guard is the actual authority, so a
        // request that moved out from under this loop (an admin decided it
        // in the meantime) simply throws `ConflictException` here, caught
        // below like any other per-request failure.
        await this.dataRights.executeForRequest(request.id, { actorType: 'system', actorId: null });
        result.executed += 1;
      } catch (error) {
        result.failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Data-deletion sweep could not execute request ${request.id}: ${message}`);
      }
    }

    return result;
  }
}
