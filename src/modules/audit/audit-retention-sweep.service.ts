import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../../shared/app-config/app-config.service';
import { AuditService } from '../../shared/audit/audit.service';
import {
  AUDIT_AUDIT_ENTITY_TYPES,
  AUDIT_CONFIG_FALLBACKS,
  AUDIT_CONFIG_KEYS,
  AUDIT_PURGE_ELIGIBLE_ACTIONS,
  AUDIT_RETENTION_DAYS_BOUNDS,
  AUDIT_RETENTION_SWEEP_BATCH_SIZE,
  AUDIT_RETENTION_SWEEP_INTERVAL_MS,
  AUDIT_RETENTION_SWEEP_MAX_BATCHES,
} from './audit.constants';
import { AuditRepository } from './audit.repository';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** One pass's outcome. */
export interface AuditRetentionSweepResult {
  /** `false` when `retentionDays` resolves to `0` — purging is off and the pass did no work. */
  enabled: boolean;
  retentionDays: number;
  deleted: number;
  batches: number;
  /** `true` when the pass hit `AUDIT_RETENTION_SWEEP_MAX_BATCHES` with rows still eligible — the rest is left for the next tick, same as `clinical-gate-sweep.service.ts`. */
  truncated: boolean;
}

/**
 * *** HOW THIS SWEEP IS SCHEDULED, AND WHY. ***
 *
 * Same shape as `clinical-gate-sweep.service.ts` and `followup-checkin-sweep
 * .service.ts`, both ultimately copied from `booking-slot-hold.service.ts`'s
 * own header: `@nestjs/schedule` is deliberately NOT installed — this
 * worktree does not add it, for the same reason those files give: a second
 * worktree adding the same dependency in parallel is exactly the
 * `package.json`/`package-lock.json` merge conflict this codebase avoids
 * across parallel builds. A plain `setInterval` owned by this service,
 * started in `onModuleInit`, `.unref()`'d so it never holds the process
 * open, cleared in `onApplicationShutdown`, and re-entrancy guarded so a slow
 * pass can never overlap the next tick.
 *
 * MULTI-INSTANCE SAFETY: every batch is a single atomic `DELETE ... WHERE id
 * IN (subquery)` (`AuditRepository.deleteEligibleBatch`) — two sweepers
 * racing the same cutoff simply divide the eligible rows between them
 * (Postgres' row-level locking serialises the two statements), never
 * double-delete or corrupt a read.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * *** WHY THIS SHIPS WITH `audit.retention_days = 0` (OFF), AND WHY IT ONLY  *
 * EVER TOUCHES `login`/`verify` ROWS. SEE `audit.constants.ts#AUDIT_PURGE_   *
 * ELIGIBLE_ACTIONS` FOR THE FULL SRS §5.3 READING. ***                      *
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Short version: SRS §5.3 never mentions `audit_log` — it is entirely about
 * `clinical_records`/`patient_files`/`appointments`. Silence is not
 * permission to auto-delete evidence this module exists to preserve
 * (`docs/MODULES.md`'s own done-when: "a clinical record read, a refund and
 * a configuration change each leave a COMPLETE entry"). So this sweep ships
 * DISABLED by default (an admin must explicitly set a window — "retention
 * rules set by the CLIENT", not a default this build picked for them), and
 * even once enabled it can only ever delete `login`/`verify` rows —
 * authentication noise `audit-log.schema.ts`'s own doc comment already
 * names this table as "absorbing" — never a create/update/delete/read/
 * export/webhook row, regardless of how the window is configured.
 */
const SWEEP_SCHEDULING = true;

@Injectable()
export class AuditRetentionSweepService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(AuditRetentionSweepService.name);
  private timer: NodeJS.Timeout | null = null;
  private sweepInFlight = false;

  constructor(
    private readonly repo: AuditRepository,
    private readonly appConfig: AppConfigService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    if (!SWEEP_SCHEDULING || this.timer) return;
    this.timer = setInterval(() => {
      void this.runScheduledSweep();
    }, AUDIT_RETENTION_SWEEP_INTERVAL_MS);
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
      this.logger.warn('Previous audit retention sweep still running; skipping this tick.');
      return;
    }
    this.sweepInFlight = true;
    try {
      const result = await this.sweep();
      if (result.deleted > 0 || result.truncated) {
        this.logger.log(
          `Audit retention sweep: ${result.deleted} row(s) deleted (retentionDays=${result.retentionDays}), ` +
            `${result.batches} batch(es), truncated=${result.truncated}.`,
        );
      }
    } catch (error) {
      this.logger.error(`Audit retention sweep failed: ${describeError(error)}`);
    } finally {
      this.sweepInFlight = false;
    }
  }

  /**
   * One sweep pass. Safe to call directly (tests do) and safe to run
   * concurrently with itself in another process.
   *
   * Reads the window straight off `AppConfigService` (the shared, 30s-
   * memoized read path every other module uses for its own runtime config
   * reads) rather than through `AuditConfigService` — this is a background
   * job reading a resolved number, not an admin screen, and `AuditConfig
   * Service.getResolved` itself reads the repository directly with no cache,
   * which would cost this hourly tick one avoidable query.
   */
  async sweep(now: Date = new Date()): Promise<AuditRetentionSweepResult> {
    const retentionDays = await this.resolveRetentionDays();
    if (retentionDays <= 0) {
      return { enabled: false, retentionDays: 0, deleted: 0, batches: 0, truncated: false };
    }

    const cutoff = new Date(now.getTime() - retentionDays * ONE_DAY_MS);
    let deleted = 0;
    let batches = 0;
    let truncated = false;

    for (; batches < AUDIT_RETENTION_SWEEP_MAX_BATCHES; batches += 1) {
      const deletedIds = await this.repo.deleteEligibleBatch(
        cutoff,
        AUDIT_PURGE_ELIGIBLE_ACTIONS,
        AUDIT_RETENTION_SWEEP_BATCH_SIZE,
      );
      deleted += deletedIds.length;
      if (deletedIds.length < AUDIT_RETENTION_SWEEP_BATCH_SIZE) {
        batches += 1;
        break;
      }
    }

    if (batches >= AUDIT_RETENTION_SWEEP_MAX_BATCHES) {
      truncated = true;
      this.logger.warn(
        `Audit retention sweep stopped after ${AUDIT_RETENTION_SWEEP_MAX_BATCHES} batches with rows still eligible; the rest will be examined on the next tick.`,
      );
    }

    if (deleted > 0) {
      // *** THE MODULE THAT DELETES EVIDENCE LOGS ITS OWN DELETIONS. ***
      // Best-effort, `system`-attributed, once per non-empty pass — a
      // durable trace of "N rows purged, at this cutoff, under this window"
      // survives even though the rows themselves do not.
      await this.audit.write({
        actorType: 'system',
        actorId: null,
        action: 'delete',
        entityType: AUDIT_AUDIT_ENTITY_TYPES.RETENTION_PURGE,
        entityId: 'audit_log',
        metadata: { deleted, retentionDays, cutoff: cutoff.toISOString(), eligibleActions: AUDIT_PURGE_ELIGIBLE_ACTIONS },
      });
    }

    return { enabled: true, retentionDays, deleted, batches, truncated };
  }

  /** Tolerant reader, mirroring `AuditConfigService`'s own bounds — a malformed or out-of-bounds stored value degrades to `0` (disabled), never to an unbounded window. */
  private async resolveRetentionDays(): Promise<number> {
    const value = await this.appConfig.getNumber(AUDIT_CONFIG_KEYS.RETENTION_DAYS, AUDIT_CONFIG_FALLBACKS.RETENTION_DAYS);
    if (!Number.isInteger(value) || value < 0) return AUDIT_CONFIG_FALLBACKS.RETENTION_DAYS;
    if (value === 0) return 0;
    if (value < AUDIT_RETENTION_DAYS_BOUNDS.min || value > AUDIT_RETENTION_DAYS_BOUNDS.max) {
      return AUDIT_CONFIG_FALLBACKS.RETENTION_DAYS;
    }
    return value;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
