import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import { DATABASE } from '../../config/db/database.module';
import type { Database, DatabaseTransaction } from '../../config/db/database.config';
import { appConfigTable } from '../../schema/app-config.schema';
import type { InstantConsultancyOutcome } from '../../schema/enums.schema';
import {
  instantConsultancyTable,
  type InstantConsultancyRow,
} from '../../schema/instant-consultancy.schema';

/** Either a pooled handle or an open transaction — every method takes one so a caller can compose it into its own transaction (`shared/audit/audit.service.ts`'s pattern). */
type Executor = Database | DatabaseTransaction;

/**
 * All of this module's SQL (`backend/README.md` §2: "repositories hold the
 * SQL"), against exactly one table: `instant_consultancy`.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────
 *
 * There is no `consultations` query and no `doctors` query in this file, and
 * that is the whole boundary discipline of M-13:
 *
 *   `consultations`  is M-11's. Reads go through `BookingFacade.getBooking`,
 *                    writes through `BookingFacade.transitionInstantConsultation`
 *                    and `assignDoctor`.
 *   `doctors`        is M-05's. `presence`, `allow_instant_consult` and
 *                    `blocked_by_consultation_id` are read and written through
 *                    `DoctorFacade` — see `doctor-presence.service.ts`'s header.
 *
 * `booking.repository.ts` documents two cross-module reads of `payments` and
 * argues each one individually; this module needed none, because the two
 * facades it depends on were extended instead. That was the cheaper fix and it
 * is the one the README asks for.
 *
 * The `app_config` read/write at the bottom is not an exception: `app_config`
 * is owned by no module (`payment-config.repository.ts` and
 * `search-config.repository.ts` both say so), and `docs/MODULES.md` §7's
 * "configuration lives with its owning module" makes the `instant.*` keys
 * this module's.
 */
@Injectable()
export class InstantRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /* ── Writes ───────────────────────────────────────────────────────────── */

  /**
   * Records one offer.
   *
   * *** THIS INSERT IS THE ROUTER'S CONCURRENCY CONTROL. *** There is no row
   * to lock before the first attempt exists, so two racing `routeNext` calls
   * for one consultation are serialized by the unique index on
   * `(consultation_id, attempt_number)`: both compute the same next
   * `attempt_number`, one commits and the other takes a `23505` that
   * `instant.service.ts` converts into "somebody else already routed this".
   * The same shape as M-11's partial unique index being the authority on a
   * slot, rather than the advisory pre-check above it.
   */
  async insertAttempt(
    values: { consultationId: string; doctorId: string; attemptNumber: number; expiresAt: Date },
    executor: Executor = this.db,
  ): Promise<InstantConsultancyRow> {
    const [row] = await executor.insert(instantConsultancyTable).values(values).returning();
    if (!row) {
      throw new Error('instant_consultancy insert returned no row — should be unreachable.');
    }
    return row;
  }

  /**
   * *** THE ROW LOCK. *** `SELECT ... FOR UPDATE` on one attempt, inside the
   * caller's transaction — which is why `tx` is required and not defaulted,
   * exactly as `booking.repository.ts#findByIdForUpdate` requires one.
   *
   * Every outcome transition takes it FIRST and re-reads `outcome` through it,
   * so a doctor's accept racing the timeout sweep serializes: the second
   * waits here, sees the first one's committed outcome, and fails its own
   * guard instead of overwriting it.
   */
  async findAttemptByIdForUpdate(attemptId: string, tx: DatabaseTransaction): Promise<InstantConsultancyRow | null> {
    const [row] = await tx
      .select()
      .from(instantConsultancyTable)
      .where(eq(instantConsultancyTable.id, attemptId))
      .limit(1)
      .for('update');
    return row ?? null;
  }

  /**
   * Outcome transition guarded by BOTH the id and the set of outcomes it is
   * legal from — the mirror of `booking.repository.ts#updateStatusIfIn`. The
   * `WHERE outcome IN (...)` is a second line of defence under the `FOR
   * UPDATE` re-read, so even a caller that skipped the lock cannot answer an
   * offer twice. Returns `null` when the guard did not match.
   *
   * `expiresAt` is optional because ACCEPTING repurposes it: up to that point
   * it is the acceptance window's close, and from then on it is the payment
   * window's. One column, two consecutive meanings, and never both at once —
   * see `instant-expiry.service.ts` for why the second window exists at all.
   */
  async updateOutcomeIfIn(
    attemptId: string,
    from: readonly InstantConsultancyOutcome[],
    to: InstantConsultancyOutcome,
    patch: { expiresAt?: Date } = {},
    executor: Executor = this.db,
  ): Promise<InstantConsultancyRow | null> {
    const [row] = await executor
      .update(instantConsultancyTable)
      .set({ outcome: to, ...patch })
      .where(and(eq(instantConsultancyTable.id, attemptId), inArray(instantConsultancyTable.outcome, [...from])))
      .returning();
    return row ?? null;
  }

  /**
   * Marks every still-pending offer on a consultation `superseded`. Used when
   * the request stops being routable for a reason that has nothing to do with
   * the doctor — the patient cancelled it, or M-11 released it — so the
   * outcome must not be `declined` (which the doctor did not do) or
   * `timed_out` (which is not what happened). Returns how many were closed.
   */
  async supersedePendingAttempts(consultationId: string, executor: Executor = this.db): Promise<number> {
    const rows = await executor
      .update(instantConsultancyTable)
      .set({ outcome: 'superseded' })
      .where(
        and(
          eq(instantConsultancyTable.consultationId, consultationId),
          eq(instantConsultancyTable.outcome, 'pending'),
        ),
      )
      .returning({ id: instantConsultancyTable.id });
    return rows.length;
  }

  /* ── Reads ────────────────────────────────────────────────────────────── */

  async findAttemptById(attemptId: string, executor: Executor = this.db): Promise<InstantConsultancyRow | null> {
    const [row] = await executor
      .select()
      .from(instantConsultancyTable)
      .where(eq(instantConsultancyTable.id, attemptId))
      .limit(1);
    return row ?? null;
  }

  /** Every offer on one consultation, routing order ascending. Backed by the unique index on `(consultation_id, attempt_number)`. */
  async listAttemptsByConsultation(consultationId: string, executor: Executor = this.db): Promise<InstantConsultancyRow[]> {
    return executor
      .select()
      .from(instantConsultancyTable)
      .where(eq(instantConsultancyTable.consultationId, consultationId))
      .orderBy(asc(instantConsultancyTable.attemptNumber));
  }

  /**
   * The routing state of one consultation in a single round trip: the highest
   * attempt number so far, every doctor already tried, and whether an offer is
   * still outstanding. The router reads exactly this before deciding anything.
   *
   * `max(attempt_number)` rather than `count(*)`: attempts are never deleted,
   * but reading the maximum is what the next insert actually needs, and it
   * stays correct if a future release ever does delete one.
   */
  async getRoutingState(
    consultationId: string,
    executor: Executor = this.db,
  ): Promise<{ lastAttemptNumber: number; triedDoctorIds: string[]; hasPending: boolean }> {
    const rows = await executor
      .select({
        attemptNumber: instantConsultancyTable.attemptNumber,
        doctorId: instantConsultancyTable.doctorId,
        outcome: instantConsultancyTable.outcome,
      })
      .from(instantConsultancyTable)
      .where(eq(instantConsultancyTable.consultationId, consultationId));

    let lastAttemptNumber = 0;
    let hasPending = false;
    const triedDoctorIds: string[] = [];
    for (const row of rows) {
      if (row.attemptNumber > lastAttemptNumber) lastAttemptNumber = row.attemptNumber;
      if (row.outcome === 'pending') hasPending = true;
      if (!triedDoctorIds.includes(row.doctorId)) triedDoctorIds.push(row.doctorId);
    }
    return { lastAttemptNumber, triedDoctorIds, hasPending };
  }

  /** The offer currently outstanding on a consultation, if any. There can be at most one — the router never opens a second while one is pending. */
  async findPendingAttempt(consultationId: string, executor: Executor = this.db): Promise<InstantConsultancyRow | null> {
    const [row] = await executor
      .select()
      .from(instantConsultancyTable)
      .where(
        and(
          eq(instantConsultancyTable.consultationId, consultationId),
          eq(instantConsultancyTable.outcome, 'pending'),
        ),
      )
      .orderBy(desc(instantConsultancyTable.attemptNumber))
      .limit(1);
    return row ?? null;
  }

  /** A doctor's outstanding offers — the doctor app's "you have a request waiting" list, and the fallback when a push never arrived and the stream was closed. */
  async listPendingAttemptsForDoctor(
    doctorId: string,
    now: Date,
    executor: Executor = this.db,
  ): Promise<InstantConsultancyRow[]> {
    return executor
      .select()
      .from(instantConsultancyTable)
      .where(
        and(
          eq(instantConsultancyTable.doctorId, doctorId),
          eq(instantConsultancyTable.outcome, 'pending'),
          sql`${instantConsultancyTable.expiresAt} > ${now}`,
        ),
      )
      .orderBy(asc(instantConsultancyTable.expiresAt));
  }

  /**
   * *** SWEEP 1's CANDIDATE QUERY (FR-10.6). *** Offers whose acceptance
   * window has closed with no answer.
   *
   * No starvation risk: resolving a candidate sets `outcome = 'timed_out'`,
   * which takes it out of this result set permanently, so a backlog drains
   * instead of being re-read forever. `instant_consultancy_expires_at_index`
   * backs the range predicate.
   */
  async findExpiredPendingAttempts(now: Date, limit: number, executor: Executor = this.db): Promise<InstantConsultancyRow[]> {
    return executor
      .select()
      .from(instantConsultancyTable)
      .where(and(eq(instantConsultancyTable.outcome, 'pending'), lte(instantConsultancyTable.expiresAt, now)))
      .orderBy(asc(instantConsultancyTable.expiresAt))
      .limit(limit);
  }

  /** The accepted offer on a consultation, if there is one. At most one exists — accepting is what stops routing. */
  async findAcceptedAttempt(consultationId: string, executor: Executor = this.db): Promise<InstantConsultancyRow | null> {
    const [row] = await executor
      .select()
      .from(instantConsultancyTable)
      .where(
        and(
          eq(instantConsultancyTable.consultationId, consultationId),
          eq(instantConsultancyTable.outcome, 'accepted'),
        ),
      )
      .orderBy(desc(instantConsultancyTable.attemptNumber))
      .limit(1);
    return row ?? null;
  }

  /** Admin oversight (FR-18.3): the most recent offers across every consultation, newest first. */
  async listRecentAttempts(
    filter: { outcome?: InstantConsultancyOutcome; limit: number; offset: number },
    executor: Executor = this.db,
  ): Promise<InstantConsultancyRow[]> {
    const conditions = filter.outcome ? [eq(instantConsultancyTable.outcome, filter.outcome)] : [];
    return executor
      .select()
      .from(instantConsultancyTable)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      // `offeredAt` then `id`: `limit`/`offset` paging over an unordered set
      // can repeat or skip rows, and `offeredAt` alone is not unique.
      .orderBy(desc(instantConsultancyTable.offeredAt), desc(instantConsultancyTable.id))
      .limit(filter.limit)
      .offset(filter.offset);
  }

  /**
   * FR-18.6's routing health, computed rather than cached — `docs/erd.sql` on
   * `instant_consultancy`: "Also the source for the FR-18.6 acceptance-rate
   * metric, so no counter is cached on `doctors`."
   */
  async getRoutingMetrics(
    since: Date,
    executor: Executor = this.db,
  ): Promise<{ offered: number; accepted: number; declined: number; timedOut: number; superseded: number }> {
    const [row] = await executor
      .select({
        offered: sql<string>`count(*)`,
        accepted: sql<string>`count(*) filter (where ${instantConsultancyTable.outcome} = 'accepted')`,
        declined: sql<string>`count(*) filter (where ${instantConsultancyTable.outcome} = 'declined')`,
        timedOut: sql<string>`count(*) filter (where ${instantConsultancyTable.outcome} = 'timed_out')`,
        superseded: sql<string>`count(*) filter (where ${instantConsultancyTable.outcome} = 'superseded')`,
      })
      .from(instantConsultancyTable)
      .where(sql`${instantConsultancyTable.offeredAt} >= ${since}`);

    return {
      offered: Number(row?.offered ?? 0),
      accepted: Number(row?.accepted ?? 0),
      declined: Number(row?.declined ?? 0),
      timedOut: Number(row?.timedOut ?? 0),
      superseded: Number(row?.superseded ?? 0),
    };
  }

  /* ── app_config (the `instant.*` keys only) ───────────────────────────── */

  /**
   * Raw current values for the given keys. A key with no row is simply absent
   * — the caller substitutes the compiled-in fallback. A direct counterpart of
   * `payment-config.repository.ts#findByKeys`; the READ half in the hot path
   * is `AppConfigService` (shared, memoized 30s), and this exists for the
   * admin screen and the write path, which that service deliberately does not
   * provide.
   */
  async findConfigByKeys(keys: readonly string[], executor: Executor = this.db): Promise<Map<string, unknown>> {
    if (keys.length === 0) return new Map();
    const rows = await executor
      .select({ key: appConfigTable.key, value: appConfigTable.value })
      .from(appConfigTable)
      .where(inArray(appConfigTable.key, [...keys]));
    return new Map(rows.map((row) => [row.key, row.value]));
  }

  /** Insert-or-update one key. `key` is unique, so this is a single statement and safe under concurrent admin edits. */
  async upsertConfig(key: string, value: unknown, executor: Executor = this.db): Promise<void> {
    await executor
      .insert(appConfigTable)
      .values({ key, value })
      .onConflictDoUpdate({ target: appConfigTable.key, set: { value, updatedAt: new Date() } });
  }
}
