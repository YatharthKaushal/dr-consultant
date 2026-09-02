import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, inArray, isNotNull, lt } from 'drizzle-orm';
import { DATABASE } from '../../config/db/database.module';
import type { Database } from '../../config/db/database.config';
import { consultationsTable } from '../../schema/consultations.schema';
import type { BusyInterval, BusyIntervalProvider, DoctorBusyIntervals } from './availability.contract';

/**
 * Consultation statuses that occupy a doctor's calendar slot — mirrors the
 * partial unique index's `WHERE` clause added on `consultations` by
 * `drizzle/0003_consultations_double_booking_guard.sql`. Kept as a literal
 * list here (rather than imported from that migration, which is SQL, not
 * TS) so a change to one is a visible diff, not a silent drift; if you ever
 * change the migration's list, change this one too.
 */
const OCCUPYING_STATUSES = [
  'pending_payment',
  'scheduled',
  'awaiting_doctor',
  'in_progress',
  'awaiting_documentation',
  'completed',
] as const;

/** Generous safety margin on the query's lower bound so a consultation that started before `fromUtc` but still overlaps it (long duration, or a `fromUtc` that lands mid-consultation) is not missed. Consultations are booking-scale in length (minutes to a couple of hours); 24h is comfortably more than any real duration + buffer. */
const QUERY_MARGIN_MS = 24 * 60 * 60 * 1000;

/**
 * PLACEHOLDER implementation of `BusyIntervalProvider`. Reads the EXISTING
 * `consultations` table directly — that table already exists in
 * `src/schema/consultations.schema.ts` (owned by the not-yet-built M-11/
 * Booking module), so this is a read of a pre-existing table, not this
 * module creating or owning a cross-module dependency on M-11's internals.
 *
 * M-11 doesn't exist yet. Once it's built, this provider is swapped for a
 * `BookingFacade`-backed implementation at the `BUSY_INTERVAL_PROVIDER`
 * binding in `availability.module.ts` — the slot engine, `availability-
 * slot.service.ts`, and every test of either must never depend on which
 * implementation is wired in, only on the `BusyIntervalProvider` interface.
 */
@Injectable()
export class ConsultationBusyIntervalProvider implements BusyIntervalProvider {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async getBusyIntervals(doctorId: string, fromUtc: Date, toUtc: Date): Promise<BusyInterval[]> {
    const rows = await this.db
      .select({
        scheduledStartAt: consultationsTable.scheduledStartAt,
        durationMinutes: consultationsTable.durationMinutes,
      })
      .from(consultationsTable)
      .where(
        and(
          eq(consultationsTable.doctorId, doctorId),
          isNotNull(consultationsTable.scheduledStartAt),
          inArray(consultationsTable.status, [...OCCUPYING_STATUSES]),
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

  /**
   * The batch form (`BusyIntervalProvider.getBusyIntervalsForMany`) — the
   * identical predicate with `doctor_id IN (...)`, so ranking a candidate set
   * costs one statement rather than one per doctor. Returns an entry for
   * EVERY requested id, including doctors with no occupying consultation, so
   * the caller never has to distinguish "no rows" from "not asked about".
   */
  async getBusyIntervalsForMany(doctorIds: readonly string[], fromUtc: Date, toUtc: Date): Promise<DoctorBusyIntervals[]> {
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
          inArray(consultationsTable.status, [...OCCUPYING_STATUSES]),
          gte(consultationsTable.scheduledStartAt, new Date(fromUtc.getTime() - QUERY_MARGIN_MS)),
          lt(consultationsTable.scheduledStartAt, toUtc),
        ),
      );

    const byDoctor = new Map<string, BusyInterval[]>(doctorIds.map((doctorId) => [doctorId, []]));
    for (const row of rows) {
      if (row.scheduledStartAt === null || row.doctorId === null) continue;
      byDoctor.get(row.doctorId)?.push({
        startsAt: row.scheduledStartAt,
        endsAt: new Date(row.scheduledStartAt.getTime() + row.durationMinutes * 60_000),
      });
    }

    return [...byDoctor].map(([doctorId, intervals]) => ({ doctorId, intervals }));
  }
}
