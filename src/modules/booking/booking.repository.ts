import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import { DATABASE } from '../../config/db/database.module';
import type { Database, DatabaseTransaction } from '../../config/db/database.config';
import { auditLogTable } from '../../schema/audit-log.schema';
import { consultationsTable, type ConsultationRow, type NewConsultationRow } from '../../schema/consultations.schema';
import { paymentsTable } from '../../schema/payments.schema';
import type { ConsultationStatus } from '../../schema/enums.schema';
import {
  BOOKING_AUDIT_ENTITY_TYPES,
  MAX_RESOLUTION_QUEUE_PAGE_SIZE,
  SLOT_OCCUPYING_STATUSES,
} from './booking.constants';

/** Either a pooled handle or an open transaction — every method takes one so a caller can compose it into its own transaction (`shared/audit/audit.service.ts`'s pattern). */
type Executor = Database | DatabaseTransaction;

/**
 * Generous lower-bound margin on busy-interval queries, so a consultation
 * that started before `fromUtc` but still overlaps it is not missed. Copied
 * deliberately from `availability/consultation-busy-interval.provider.ts` —
 * this repository replaces that placeholder's queries, so it must not
 * silently change their semantics.
 */
const QUERY_MARGIN_MS = 24 * 60 * 60 * 1000;

/**
 * ADDITIVE (M-13): one instant consultation whose payment hold has lapsed.
 * See `BookingContract#listExpiredInstantHolds` for why M-13 needs its own
 * candidate query rather than reusing `ExpiredHoldCandidate`.
 */
export interface ExpiredInstantHold {
  consultationId: string;
  patientId: string;
  /** `null` while the request is still searching — the crash window between `createInstantBooking` and the move to `awaiting_doctor`. */
  doctorId: string | null;
  holdExpiresAt: Date | null;
}

/** One expired hold, with just enough of its payment to decide which sweep tier it belongs to. */
export interface ExpiredHoldCandidate {
  consultationId: string;
  patientId: string;
  doctorId: string | null;
  scheduledStartAt: Date | null;
  holdExpiresAt: Date | null;
  /** `null` when no `payments` row exists for this consultation at all. */
  paymentId: string | null;
  /**
   * `null` when the patient never reached the gateway — TIER 1, release
   * promptly. Non-null means checkout was genuinely entered, so the hold is
   * TIER 2 and may only be released after `reconcileWithGateway` says so.
   */
  gatewayOrderId: string | null;
}

/**
 * All of this module's SQL (`backend/README.md` §2: "repositories hold the
 * SQL").
 *
 * ── ONE DELIBERATE CROSS-MODULE READ, AND WHY ──────────────────────────────
 *
 * `findExpiredHoldCandidates` LEFT JOINs `payments`, which is M-12's table,
 * to read exactly two columns: `id` and `gateway_order_id`. Nothing else here
 * touches `payments` for reading, and nothing anywhere in this module WRITES
 * a `payments` column except `movePaymentToConsultation` (the reschedule
 * hand-over, which only rewrites the FK back to a consultation this module
 * owns).
 *
 * It is a boundary crossing and it is flagged as one. The justification:
 *
 *   1. The two-tier sweep's whole safety property is "never release a hold
 *      that reached the gateway on a blind timer". Deciding that requires
 *      knowing whether a gateway order exists — and `BookingPaymentPort`'s
 *      signature is FIXED by the parallel worktree (`booking-payment.
 *      contract.ts`); `getByConsultationId` returns `{paymentId, status,
 *      paidAt}` and no `gatewayOrderId`. The fact is not obtainable through
 *      the port, and widening the port would break the verbatim shape the
 *      other worktree is exporting.
 *   2. The alternative — reconcile EVERY expired hold — means one gateway
 *      round trip per abandoned checkout, which is the overwhelmingly common
 *      case. That is a real cost paid on the most frequent path to avoid a
 *      two-column read.
 *   3. It is the exact mirror of what already exists in the other direction:
 *      `availability/consultation-busy-interval.provider.ts` and `document/
 *      consultation-lookup.provider.ts` both read `consultations` — THIS
 *      module's table — directly, each documented as a placeholder pending
 *      the facade. Migration 0006 is itself titled "M-11/M-12 FOUNDATION" and
 *      treats the two tables as one foundation.
 *
 * POST-MERGE the coordinator may replace this join with a port method if M-12
 * chooses to expose one; the sweep reads it through `ExpiredHoldCandidate`, so
 * that is a change to this one query and nothing else.
 */
@Injectable()
export class BookingRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /* ── Writes ───────────────────────────────────────────────────────────── */

  async insert(values: NewConsultationRow, executor: Executor = this.db): Promise<ConsultationRow> {
    const [row] = await executor.insert(consultationsTable).values(values).returning();
    return row;
  }

  /**
   * *** THE ROW LOCK. *** `SELECT ... FOR UPDATE` on one consultation, inside
   * the caller's transaction. Every state transition in this module takes it
   * FIRST and re-reads the status through it, so two concurrent transitions
   * on the same booking serialize instead of interleaving: the second waits
   * here, then sees the first one's committed status and fails its own
   * semantic guard.
   *
   * There is deliberately NO optimistic version column. Row locking already
   * gives strictly stronger serialization for this access pattern (every
   * writer reads the row it is about to write, in the same transaction), and
   * a version column would add a second, weaker mechanism that can disagree
   * with the first. This was an explicit design decision, not an omission.
   */
  async findByIdForUpdate(consultationId: string, tx: DatabaseTransaction): Promise<ConsultationRow | undefined> {
    const [row] = await tx.select().from(consultationsTable).where(eq(consultationsTable.id, consultationId)).limit(1).for('update');
    return row;
  }

  /**
   * Status transition guarded by BOTH the id and the set of statuses it is
   * legal from — the `WHERE status IN (...)` is a second line of defence
   * under the `FOR UPDATE` re-read, so even a call that skipped the lock
   * cannot drive an illegal transition. Returns `undefined` when the guard
   * did not match, which the caller turns into a 409.
   */
  async updateStatusIfIn(
    consultationId: string,
    from: readonly ConsultationStatus[],
    patch: Partial<NewConsultationRow>,
    executor: Executor = this.db,
  ): Promise<ConsultationRow | undefined> {
    const [row] = await executor
      .update(consultationsTable)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(consultationsTable.id, consultationId), inArray(consultationsTable.status, [...from])))
      .returning();
    return row;
  }

  /**
   * Moves a payment to a different consultation — the reschedule hand-over.
   * `payments.consultation_id` is UNIQUE, so this is an UPDATE and never an
   * insert: one payment, one live consultation, no re-charge. The old
   * consultation row survives as history with no payment attached, which is
   * exactly what `rescheduled_from_consultation_id` is for.
   */
  async movePaymentToConsultation(paymentId: string, toConsultationId: string, executor: Executor = this.db): Promise<void> {
    await executor
      .update(paymentsTable)
      .set({ consultationId: toConsultationId, updatedAt: new Date() })
      .where(eq(paymentsTable.id, paymentId));
  }

  /* ── Reads ────────────────────────────────────────────────────────────── */

  async findById(consultationId: string, executor: Executor = this.db): Promise<ConsultationRow | undefined> {
    const [row] = await executor.select().from(consultationsTable).where(eq(consultationsTable.id, consultationId)).limit(1);
    return row;
  }

  /**
   * THE SWEEP'S CANDIDATE QUERY. Every `pending_payment` row whose hold has
   * lapsed, with the two `payments` columns that decide its tier — see the
   * class doc comment on why that join is here.
   *
   * `hold_expires_at IS NOT NULL` is explicit rather than implied: a
   * `pending_payment` row with no hold at all is not an expired hold, and
   * must not be swept. `consultations_hold_expires_at_index` backs the range
   * predicate.
   */
  async findExpiredHoldCandidates(now: Date, limit: number, executor: Executor = this.db): Promise<ExpiredHoldCandidate[]> {
    return executor
      .select({
        consultationId: consultationsTable.id,
        patientId: consultationsTable.patientId,
        doctorId: consultationsTable.doctorId,
        scheduledStartAt: consultationsTable.scheduledStartAt,
        holdExpiresAt: consultationsTable.holdExpiresAt,
        paymentId: paymentsTable.id,
        gatewayOrderId: paymentsTable.gatewayOrderId,
      })
      .from(consultationsTable)
      .leftJoin(paymentsTable, eq(paymentsTable.consultationId, consultationsTable.id))
      .where(
        and(
          eq(consultationsTable.status, 'pending_payment'),
          isNotNull(consultationsTable.holdExpiresAt),
          lte(consultationsTable.holdExpiresAt, now),
        ),
      )
      .orderBy(asc(consultationsTable.holdExpiresAt))
      .limit(limit);
  }

  /**
   * ADDITIVE (M-13): every INSTANT consultation sitting in `pending_payment`
   * past its hold — the candidate query behind M-13's post-acceptance payment
   * sweep.
   *
   * Why this is not `findExpiredHoldCandidates` with a `mode` filter: that
   * query exists to decide a TIER (does a gateway order exist), and M-13's
   * sweep does not want a tier. An instant consult that reached checkout is
   * exactly the case M-11's Tier 2 refuses to release — it asks the gateway
   * and keeps holding on anything but a definitive failure. That is right for
   * a scheduled slot and wrong for a live doctor, who cannot be held while a
   * patient thinks about it. M-13 releases on ITS OWN clock and accepts the
   * late-capture path underneath; see `instant-expiry.service.ts`.
   *
   * `hold_expires_at IS NOT NULL` is explicit for the same reason it is
   * there: a `pending_payment` row with no hold is not an expired hold.
   * `consultations_hold_expires_at_index` backs the range predicate.
   */
  async listExpiredInstantHolds(now: Date, limit: number, executor: Executor = this.db): Promise<ExpiredInstantHold[]> {
    return executor
      .select({
        consultationId: consultationsTable.id,
        patientId: consultationsTable.patientId,
        doctorId: consultationsTable.doctorId,
        holdExpiresAt: consultationsTable.holdExpiresAt,
      })
      .from(consultationsTable)
      .where(
        and(
          eq(consultationsTable.mode, 'instant'),
          eq(consultationsTable.status, 'pending_payment'),
          isNotNull(consultationsTable.holdExpiresAt),
          lte(consultationsTable.holdExpiresAt, now),
        ),
      )
      .orderBy(asc(consultationsTable.holdExpiresAt))
      .limit(limit);
  }

  /**
   * ADDITIVE (M-13): instant consultations that have been sitting in
   * `awaiting_doctor` since before `staleBefore` — the candidate query behind
   * M-13's STRANDED-REQUEST sweep.
   *
   * *** WHY A THIRD CANDIDATE QUERY EXISTS AT ALL. *** `awaiting_doctor` is
   * the one live instant status that carries NO `hold_expires_at` (M-13 clears
   * it on purpose: while a request is routing there is no doctor, no slot and
   * nothing to pay for). That makes such a row invisible to
   * `findExpiredHoldCandidates` AND to `listExpiredInstantHolds`, both of
   * which are driven off a hold. M-13's own acceptance sweep only ever sees
   * `instant_consultancy` rows whose outcome is still `pending`. So a request
   * whose last attempt was settled — declined, timed out, accepted-then-rolled
   * back — and whose re-route then failed or never ran was reachable by
   * NOTHING, and sat on the patient's screen forever.
   *
   * Self-limiting for the same reason `listExpiredInstantHolds` is: acting on
   * a candidate either routes it (which opens a pending attempt, and M-13
   * skips it next pass) or releases it to `expired`. Either way it leaves the
   * set. `updated_at` is what M-13 stamps when it moves a row INTO
   * `awaiting_doctor`, so "older than one acceptance window" is exactly "no
   * longer plausibly mid-route"; the `(status, scheduled_start_at)` index
   * drives the scan on its leading column.
   */
  async listStaleAwaitingDoctorRequests(
    staleBefore: Date,
    limit: number,
    executor: Executor = this.db,
  ): Promise<Array<{ consultationId: string; patientId: string; updatedAt: Date }>> {
    return executor
      .select({
        consultationId: consultationsTable.id,
        patientId: consultationsTable.patientId,
        updatedAt: consultationsTable.updatedAt,
      })
      .from(consultationsTable)
      .where(
        and(
          eq(consultationsTable.mode, 'instant'),
          eq(consultationsTable.status, 'awaiting_doctor'),
          lte(consultationsTable.updatedAt, staleBefore),
        ),
      )
      .orderBy(asc(consultationsTable.updatedAt))
      .limit(limit);
  }

  /**
   * The consultation fee THIS consultation was actually billed at, read off its
   * own `payments` row.
   *
   * *** WHY THIS IS READ AND NOT TAKEN FROM THE DOCTOR'S PROFILE. *** The
   * refund base has to be what the patient PAID, and a doctor's
   * `consultation_fee_inr` is live, mutable configuration — a doctor who
   * lowers their fee after a booking would silently shrink the refund base for
   * every cancellation still in flight, so a patient owed 100% of the ₹750 they
   * paid would be automatically refunded 100% of the NEW ₹500 and the audit
   * entry would still read `refundPct: 100`. A short refund that looks
   * complete in the audit trail is the worst shape this could take. (Raising
   * the fee fails safe in the other direction: M-12 refuses a refund larger
   * than the capture, so it lands in the admin queue instead.)
   *
   * This is the SECOND deliberate cross-module read of `payments` in this file
   * — see the class doc comment for the first (`gateway_order_id`) and the
   * reasoning that licenses it. `BookingPaymentPort.getByConsultationId`
   * returns `{paymentId, status, paidAt}` and no amounts, and that signature is
   * fixed by the parallel M-12 worktree, so the fee is not reachable through
   * the port. One column, read-only. It is the same column M-12's own refund
   * service recomputes its capture ceiling from, so the two agree by
   * construction.
   */
  async findBilledConsultationFee(consultationId: string, executor: Executor = this.db): Promise<string | null> {
    const [row] = await executor
      .select({ consultationFee: paymentsTable.consultationFee })
      .from(paymentsTable)
      .where(eq(paymentsTable.consultationId, consultationId))
      .limit(1);
    return row?.consultationFee ?? null;
  }

  /**
   * Whether `(doctorId, scheduledStartAt)` is occupied by a LIVE consultation
   * other than `excludeConsultationId`. Advisory only — a pre-check for a
   * clean error message. The partial unique index remains the authority, and
   * every write path catches its `23505`.
   */
  async isSlotOccupied(
    doctorId: string,
    scheduledStartAt: Date,
    excludeConsultationId: string | null,
    executor: Executor = this.db,
  ): Promise<boolean> {
    const [row] = await executor
      .select({ id: consultationsTable.id })
      .from(consultationsTable)
      .where(
        and(
          eq(consultationsTable.doctorId, doctorId),
          eq(consultationsTable.scheduledStartAt, scheduledStartAt),
          inArray(consultationsTable.status, [...SLOT_OCCUPYING_STATUSES]),
          excludeConsultationId ? ne(consultationsTable.id, excludeConsultationId) : undefined,
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  /**
   * Whether any OTHER live consultation of this doctor's overlaps the half-open
   * interval `[startsAt, endsAt)` — the same occupying-status set and the same
   * overlap rule `availability-slot.engine.ts#evaluateSlotBookability` applies
   * to its busy intervals, but with one consultation excluded.
   *
   * *** WHY THIS EXISTS. *** `AvailabilityContract.isSlotBookable` takes only
   * `(doctorId, startsAtUtc)` — it has no way to say "ignore this one booking".
   * So during a RESCHEDULE the appointment being moved is itself one of the
   * doctor's busy intervals, and the advisory pre-check answers `already_taken`
   * against the patient's own booking, refusing to move it to the same slot or
   * to any slot inside its own duration. `booking.service.ts#reschedule` uses
   * this to re-test that ONE verdict with the moved row excluded; every other
   * `SlotBookability` reason is unrelated to the moved row and still stands.
   *
   * Deliberately NOT a widening of the availability contract: which
   * consultation is being moved is booking's own fact about booking's own
   * table, and `consultations` is this module's (`backend/README.md` §2).
   */
  async hasOccupyingOverlap(
    doctorId: string,
    startsAt: Date,
    endsAt: Date,
    excludeConsultationId: string | null,
    executor: Executor = this.db,
  ): Promise<boolean> {
    const [row] = await executor
      .select({ id: consultationsTable.id })
      .from(consultationsTable)
      .where(
        and(
          eq(consultationsTable.doctorId, doctorId),
          isNotNull(consultationsTable.scheduledStartAt),
          inArray(consultationsTable.status, [...SLOT_OCCUPYING_STATUSES]),
          excludeConsultationId ? ne(consultationsTable.id, excludeConsultationId) : undefined,
          // Half-open overlap: existing.start < new.end AND existing.end > new.start.
          // `existing.end` is computed in SQL from the row's OWN duration, so a
          // long consultation that started before `startsAt` is still caught.
          lt(consultationsTable.scheduledStartAt, endsAt),
          sql`${consultationsTable.scheduledStartAt} + (${consultationsTable.durationMinutes} * interval '1 minute') > ${startsAt}`,
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  /* ── Busy intervals (backs availability's BUSY_INTERVAL_PROVIDER) ──────── */

  async listBusyIntervals(doctorId: string, fromUtc: Date, toUtc: Date): Promise<{ startsAt: Date; endsAt: Date }[]> {
    const rows = await this.db
      .select({ scheduledStartAt: consultationsTable.scheduledStartAt, durationMinutes: consultationsTable.durationMinutes })
      .from(consultationsTable)
      .where(
        and(
          eq(consultationsTable.doctorId, doctorId),
          isNotNull(consultationsTable.scheduledStartAt),
          inArray(consultationsTable.status, [...SLOT_OCCUPYING_STATUSES]),
          gte(consultationsTable.scheduledStartAt, new Date(fromUtc.getTime() - QUERY_MARGIN_MS)),
          lt(consultationsTable.scheduledStartAt, toUtc),
        ),
      );

    return rows
      .filter((row): row is { scheduledStartAt: Date; durationMinutes: number } => row.scheduledStartAt !== null)
      .map((row) => ({
        startsAt: row.scheduledStartAt,
        endsAt: new Date(row.scheduledStartAt.getTime() + row.durationMinutes * 60_000),
      }));
  }

  async listBusyIntervalsForMany(
    doctorIds: readonly string[],
    fromUtc: Date,
    toUtc: Date,
  ): Promise<{ doctorId: string; scheduledStartAt: Date; durationMinutes: number }[]> {
    if (doctorIds.length === 0) return [];

    const rows = await this.db
      .select({
        doctorId: consultationsTable.doctorId,
        scheduledStartAt: consultationsTable.scheduledStartAt,
        durationMinutes: consultationsTable.durationMinutes,
      })
      .from(consultationsTable)
      .where(
        and(
          inArray(consultationsTable.doctorId, [...doctorIds]),
          isNotNull(consultationsTable.scheduledStartAt),
          inArray(consultationsTable.status, [...SLOT_OCCUPYING_STATUSES]),
          gte(consultationsTable.scheduledStartAt, new Date(fromUtc.getTime() - QUERY_MARGIN_MS)),
          lt(consultationsTable.scheduledStartAt, toUtc),
        ),
      );

    return rows.filter(
      (row): row is { doctorId: string; scheduledStartAt: Date; durationMinutes: number } =>
        row.doctorId !== null && row.scheduledStartAt !== null,
    );
  }

  /* ── Lookups (back document's CONSULTATION_LOOKUP_PROVIDER) ────────────── */

  async listConsultationIdsBetween(doctorId: string, patientId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: consultationsTable.id })
      .from(consultationsTable)
      .where(and(eq(consultationsTable.doctorId, doctorId), eq(consultationsTable.patientId, patientId)));
    return rows.map((row) => row.id);
  }

  async listConsultationIdsForPatient(patientId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: consultationsTable.id })
      .from(consultationsTable)
      .where(eq(consultationsTable.patientId, patientId));
    return rows.map((row) => row.id);
  }

  /* ── Listings ─────────────────────────────────────────────────────────── */

  /**
   * "Upcoming" and "past" for a patient or a doctor (FR-6.5, FR-9.1).
   *
   * UPCOMING is defined by STATUS, not by the clock alone: a `scheduled`
   * consult whose start time slipped past `now` is still upcoming from the
   * patient's point of view until somebody closes it, and a consult with no
   * start time at all (an instant request still routing) is upcoming too.
   * Sorting upcoming ASCENDING puts the next appointment first, which is what
   * FR-3.2's "next upcoming appointment" card reads; past sorts DESCENDING,
   * most recent first.
   */
  async listForParty(input: {
    party: 'patient' | 'doctor';
    accountId: string;
    scope: 'upcoming' | 'past';
    limit: number;
    offset: number;
  }): Promise<ConsultationRow[]> {
    const { party, accountId, scope, limit, offset } = input;
    const owner = party === 'patient' ? eq(consultationsTable.patientId, accountId) : eq(consultationsTable.doctorId, accountId);

    const upcomingStatuses: ConsultationStatus[] = ['pending_payment', 'scheduled', 'awaiting_doctor', 'in_progress'];
    const scopeFilter =
      scope === 'upcoming'
        ? inArray(consultationsTable.status, upcomingStatuses)
        : sql`${consultationsTable.status} not in ${upcomingStatuses}`;

    return this.db
      .select()
      .from(consultationsTable)
      .where(and(owner, scopeFilter))
      .orderBy(
        scope === 'upcoming'
          ? asc(sql`coalesce(${consultationsTable.scheduledStartAt}, ${consultationsTable.createdAt})`)
          : desc(sql`coalesce(${consultationsTable.scheduledStartAt}, ${consultationsTable.createdAt})`),
      )
      .limit(limit)
      .offset(offset);
  }

  /** The admin appointment-oversight listing (FR-18.3). Optionally narrowed to one status. */
  async listForAdmin(input: { status?: ConsultationStatus; limit: number; offset: number }): Promise<ConsultationRow[]> {
    const { status, limit, offset } = input;
    return this.db
      .select()
      .from(consultationsTable)
      .where(status ? eq(consultationsTable.status, status) : undefined)
      .orderBy(desc(consultationsTable.createdAt))
      .limit(limit)
      .offset(offset);
  }

  /**
   * THE ADMIN RESOLUTION QUEUE. Reads back the `audit_log` rows this module
   * writes with `entity_type = 'booking_admin_resolution'` — see
   * `booking.constants.ts` for why the queue is an audit entity rather than a
   * table of its own.
   */
  async listAdminResolutionQueue(limit: number, offset: number): Promise<
    // `audit_log.id` is a bigserial, not a uuid — this is the audit row's own
    // id, not a consultation id.
    { id: number; consultationId: string | null; createdAt: Date; metadata: unknown }[]
  > {
    return this.db
      .select({
        id: auditLogTable.id,
        consultationId: auditLogTable.consultationId,
        createdAt: auditLogTable.createdAt,
        metadata: auditLogTable.metadata,
      })
      .from(auditLogTable)
      .where(eq(auditLogTable.entityType, BOOKING_AUDIT_ENTITY_TYPES.ADMIN_RESOLUTION))
      .orderBy(desc(auditLogTable.createdAt))
      .limit(Math.min(limit, MAX_RESOLUTION_QUEUE_PAGE_SIZE))
      .offset(offset);
  }

  /**
   * Whether this patient has any consultation that reached a real consult —
   * backs M-11's "first consultation prompts for medical history; later
   * consultations carry the existing history forward". `pending_payment` and
   * `expired` rows do not count: an abandoned checkout is not a first
   * consultation.
   */
  async hasPriorConsultation(patientId: string, excludeConsultationId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: consultationsTable.id })
      .from(consultationsTable)
      .where(
        and(
          eq(consultationsTable.patientId, patientId),
          ne(consultationsTable.id, excludeConsultationId),
          inArray(consultationsTable.status, ['in_progress', 'awaiting_documentation', 'completed', 'no_show']),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  /** Reference codes are unique; this backs the retry loop in `booking.service.ts#generateReferenceCode`. */
  async referenceCodeExists(referenceCode: string, executor: Executor = this.db): Promise<boolean> {
    const [row] = await executor
      .select({ id: consultationsTable.id })
      .from(consultationsTable)
      .where(eq(consultationsTable.referenceCode, referenceCode))
      .limit(1);
    return row !== undefined;
  }

  /** Exposed for the late-capture path, which must find a consultation whose hold is already gone. */
  async findReleasedByIdForUpdate(consultationId: string, tx: DatabaseTransaction): Promise<ConsultationRow | undefined> {
    const [row] = await tx
      .select()
      .from(consultationsTable)
      .where(and(eq(consultationsTable.id, consultationId), or(eq(consultationsTable.status, 'expired'), isNull(consultationsTable.holdExpiresAt))))
      .limit(1)
      .for('update');
    return row;
  }
}
