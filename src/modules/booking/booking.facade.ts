import { Injectable } from '@nestjs/common';
import type { ConsultationStatus } from '../../schema/enums.schema';
import type { BookingContract, BookingView, BusyInterval, ConsultationSummary, DoctorBusyIntervals } from './booking.contract';
import { toBookingView, toConsultationSummary } from './booking.mapper';
import { BookingRepository } from './booking.repository';
import { BookingService } from './booking.service';
import { BookingSlotHoldService } from './booking-slot-hold.service';

/**
 * Booking's single public surface (`backend/README.md` §2).
 *
 * ── WHAT THIS CLOSES, AND WHAT THE COORDINATOR STILL HAS TO DO ─────────────
 *
 * This class is structurally compatible with BOTH placeholder interfaces that
 * are currently waiting on M-11, so each can be rebound with no adapter and
 * no cast:
 *
 *   `availability`'s `BusyIntervalProvider` (token `BUSY_INTERVAL_PROVIDER`,
 *   bound in `availability.module.ts` to `ConsultationBusyIntervalProvider`)
 *     <- `getBusyIntervals` + `getBusyIntervalsForMany`
 *
 *   `document`'s `ConsultationLookupPort` (token
 *   `CONSULTATION_LOOKUP_PROVIDER`, bound in `document.module.ts` to
 *   `ConsultationLookupProvider`)
 *     <- `findById` + `listConsultationIdsBetween` +
 *        `listConsultationIdsForPatient`
 *
 * *** THIS MODULE DOES NOT REBIND EITHER TOKEN, ON PURPOSE. *** Both stay
 * pointed at their existing in-module placeholders. The coordinator does the
 * rebinding post-merge — `{ provide: BUSY_INTERVAL_PROVIDER, useExisting:
 * BookingFacade }` in `availability.module.ts` (importing `BookingModule`)
 * and the same for `CONSULTATION_LOOKUP_PROVIDER` in `document.module.ts` —
 * because `BookingModule` already imports `AvailabilityModule` and
 * `DocumentModule`, so binding from the other side closes an import cycle.
 * Doing that across three parallel worktrees at once is how a cycle turns
 * into an afternoon of debugging. Nothing is broken in the meantime: the
 * placeholders read the same `consultations` table this module writes, so
 * they stay correct, just not routed through the facade.
 *
 * The busy-interval methods here return exactly what the placeholder returned
 * — same occupying-status list, same 24h lower-bound margin (both live in
 * `booking.constants.ts`/`booking.repository.ts`) — so the swap cannot change
 * slot behaviour.
 */
@Injectable()
export class BookingFacade implements BookingContract {
  constructor(
    private readonly repo: BookingRepository,
    private readonly service: BookingService,
    private readonly holds: BookingSlotHoldService,
  ) {}

  /* ── availability's BUSY_INTERVAL_PROVIDER ─────────────────────────────── */

  async getBusyIntervals(doctorId: string, fromUtc: Date, toUtc: Date): Promise<BusyInterval[]> {
    return this.repo.listBusyIntervals(doctorId, fromUtc, toUtc);
  }

  /**
   * Implemented rather than left off, even though `BusyIntervalProvider`
   * marks it optional: its own doc comment says "Implement it — the fallback
   * is a correctness guarantee, not a performance one." Returns an entry for
   * EVERY requested id, including doctors with nothing booked, so the caller
   * never has to tell "no rows" from "not asked about".
   */
  async getBusyIntervalsForMany(doctorIds: readonly string[], fromUtc: Date, toUtc: Date): Promise<DoctorBusyIntervals[]> {
    if (doctorIds.length === 0) return [];

    const rows = await this.repo.listBusyIntervalsForMany(doctorIds, fromUtc, toUtc);
    const byDoctor = new Map<string, BusyInterval[]>(doctorIds.map((doctorId) => [doctorId, []]));
    for (const row of rows) {
      byDoctor.get(row.doctorId)?.push({
        startsAt: row.scheduledStartAt,
        endsAt: new Date(row.scheduledStartAt.getTime() + row.durationMinutes * 60_000),
      });
    }
    return [...byDoctor].map(([doctorId, intervals]) => ({ doctorId, intervals }));
  }

  /* ── document's CONSULTATION_LOOKUP_PROVIDER ───────────────────────────── */

  async findById(consultationId: string): Promise<ConsultationSummary | null> {
    const row = await this.repo.findById(consultationId);
    return row ? toConsultationSummary(row) : null;
  }

  async listConsultationIdsBetween(doctorId: string, patientId: string): Promise<string[]> {
    return this.repo.listConsultationIdsBetween(doctorId, patientId);
  }

  async listConsultationIdsForPatient(patientId: string): Promise<string[]> {
    return this.repo.listConsultationIdsForPatient(patientId);
  }

  /* ── General ──────────────────────────────────────────────────────────── */

  async getBooking(consultationId: string): Promise<BookingView | null> {
    const row = await this.repo.findById(consultationId);
    return row ? toBookingView(row) : null;
  }

  /* ── M-12 (Payments) ───────────────────────────────────────────────────── */

  /** See `BookingContract#confirmPayment` — the paid -> scheduled transition, idempotent, with the late-capture path underneath it. */
  async confirmPayment(consultationId: string): Promise<BookingView> {
    return toBookingView(await this.holds.confirmPayment(consultationId));
  }

  /* ── M-13 (Instant Consult) ────────────────────────────────────────────── */

  async createInstantBooking(input: {
    patientId: string;
    specialtyId: string;
    concernId?: string | null;
    intakeAnswers?: unknown;
  }): Promise<BookingView> {
    const row = await this.service.createInstantBooking(input, { party: 'patient', accountId: input.patientId });
    return toBookingView(row);
  }

  async assignDoctor(consultationId: string, doctorId: string): Promise<BookingView> {
    const row = await this.service.assignDoctor(consultationId, doctorId, { party: 'system', accountId: null });
    return toBookingView(row);
  }

  /** See `BookingContract#transitionInstantConsultation` — the rule/write split that keeps M-13 out of `consultations`. */
  async transitionInstantConsultation(input: {
    consultationId: string;
    to: 'awaiting_doctor' | 'pending_payment' | 'expired';
    from: readonly ConsultationStatus[];
    holdExpiresAt?: Date | null;
    reason?: string;
  }): Promise<{ changed: boolean; booking: BookingView | null; refusal?: 'not_found' | 'not_instant' | 'illegal_transition' }> {
    const result = await this.service.transitionInstantConsultation(input);
    return {
      changed: result.changed,
      booking: result.booking ? toBookingView(result.booking) : null,
      ...(result.refusal ? { refusal: result.refusal } : {}),
    };
  }

  /** See `BookingContract#listExpiredInstantHolds`. */
  async listExpiredInstantHolds(now: Date, limit: number) {
    return this.service.listExpiredInstantHolds(now, limit);
  }

  /** See `BookingContract#listStaleAwaitingDoctorRequests`. */
  async listStaleAwaitingDoctorRequests(staleBefore: Date, limit: number) {
    return this.service.listStaleAwaitingDoctorRequests(staleBefore, limit);
  }
}
