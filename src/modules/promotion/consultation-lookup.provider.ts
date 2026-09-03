import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, count, eq, inArray, ne } from 'drizzle-orm';
import { DATABASE } from '../../config/db/database.module';
import type { Database } from '../../config/db/database.config';
import { consultationsTable } from '../../schema/consultations.schema';
import type { ConsultationLookupStatus, PromotionBookingLookupPort } from './promotion-booking.contract';

/**
 * *** THE REAL `PROMOTION_BOOKING_LOOKUP_PORT`, AND WHY IT READS THE TABLE
 * DIRECTLY RATHER THAN GOING THROUGH `BookingFacade`. ***
 *
 * The obvious implementation — inject `BookingFacade` and delegate — closes an
 * import cycle. The module graph runs:
 *
 *     booking -> payment -> pricing -> promotion
 *
 * (`booking.module.ts` imports `PaymentModule`, `payment.module.ts` imports
 * `PricingModule`, and `pricing.module.ts` binds `PromotionFacade` at its
 * `DISCOUNT_PORT`.) Importing `BookingModule` from here would close that ring,
 * and Nest would need `forwardRef` on both sides — a construct this codebase has
 * deliberately never used.
 *
 * *** THERE IS DIRECT PRECEDENT, AND THIS FOLLOWS IT. ***
 * `availability/consultation-busy-interval.provider.ts` reads `consultations`
 * exactly this way, for exactly this reason, and `booking.module.ts` explains
 * why it and `document`'s `CONSULTATION_LOOKUP_PROVIDER` are both still on
 * their own providers rather than bound to `BookingFacade`: "binding
 * `BookingFacade` from inside either of those closes an import cycle".
 *
 * *** WHAT KEEPS THIS HONEST. *** It is a strictly READ-ONLY projection of two
 * columns, and it writes nothing. Booking remains the only module that MUTATES
 * a consultation. That is the line that matters — the boundary rule exists so
 * two modules cannot both own a row's lifecycle, not to forbid reading a status.
 * If `BookingFacade` ever grows these two methods AND the cycle is broken, this
 * file should be deleted and the token rebound; until then, deleting it means
 * the sweep stops working.
 *
 * *** NEVER THROWS. *** Both methods answer `'unknown'` on any failure, and
 * `'unknown'` is a first-class value the callers already handle — pointing
 * opposite ways by design (the sweep KEEPS a reservation it cannot classify;
 * the first-consultation rule SKIPS). A database blip must not release a
 * redemption that a live checkout is holding.
 */
@Injectable()
export class PromotionConsultationLookupProvider implements PromotionBookingLookupPort {
  private readonly logger = new Logger(PromotionConsultationLookupProvider.name);

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async getConsultationStatuses(
    consultationIds: readonly string[],
  ): Promise<ReadonlyMap<string, ConsultationLookupStatus>> {
    if (consultationIds.length === 0) {
      return new Map();
    }

    try {
      const rows = await this.db
        .select({ id: consultationsTable.id, status: consultationsTable.status })
        .from(consultationsTable)
        .where(inArray(consultationsTable.id, [...consultationIds]));

      // An id with no row is simply absent from the map, which the contract
      // states means the same as `'unknown'`.
      return new Map(rows.map((row) => [row.id, row.status as ConsultationLookupStatus]));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Could not read consultation statuses for ${consultationIds.length} candidate(s); ` +
          `every one will be treated as unknown, so the sweep keeps their reservations. ${message}`,
      );
      return new Map();
    }
  }

  async countPriorConsultations(
    patientId: string,
    excludeConsultationId: string | null,
  ): Promise<number | 'unknown'> {
    try {
      // The SAME four statuses `booking.repository.ts#hasPriorConsultation`
      // uses for `isFirstConsultation`. Deliberately identical: a patient must
      // not be "first-time" for the booking prompt and "returning" for the
      // referral rule on one and the same consultation.
      const reachedAConsult = and(
        eq(consultationsTable.patientId, patientId),
        inArray(consultationsTable.status, ['in_progress', 'awaiting_documentation', 'completed', 'no_show']),
        excludeConsultationId === null ? undefined : ne(consultationsTable.id, excludeConsultationId),
      );

      const [row] = await this.db.select({ total: count() }).from(consultationsTable).where(reachedAConsult);
      return row?.total ?? 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Could not count prior consultations for patient ${patientId}; the first-consultation ` +
          `rule will be skipped for this evaluation rather than refusing a valid code. ${message}`,
      );
      return 'unknown';
    }
  }
}
