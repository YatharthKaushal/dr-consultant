import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { DATABASE } from '../../config/db/database.module';
import type { Database } from '../../config/db/database.config';
import { consultationsTable } from '../../schema/consultations.schema';
import type { ConsultationStatus } from '../../schema/enums.schema';
import { AuditService } from '../../shared/audit/audit.service';
import { BookingFacade } from '../booking/booking.facade';
import type {
  ClinicalBookingPort,
  ClinicalConsultationView,
  CompleteConsultationResult,
} from './clinical-booking.contract';

/**
 * *** PLACEHOLDER implementation of `ClinicalBookingPort`. READ
 * `clinical-booking.contract.ts` FIRST. ***
 *
 * The READ half delegates to the real `BookingFacade` — `getBooking` already
 * exists on `BookingContract` and is exactly what this module needs, so there
 * is no reason to reimplement it and every reason not to.
 *
 * The WRITE half is the placeholder, and it is the ONE thing in this module
 * that touches a table it does not own. It exists because `BookingContract`
 * has no method that can move a consultation to `completed`
 * (`transitionInstantConsultation` is narrowed to three other values and
 * refuses non-instant rows), and M-14 — which is adding the general sibling —
 * is in a parallel worktree that this one cannot see or import from.
 *
 * *** THIS IS A TEMPORARY SEAM, NOT A PATTERN TO COPY. *** It is confined to
 * ONE guarded UPDATE, it applies exactly the discipline M-11 applies to its own
 * status writes (`SELECT ... FOR UPDATE` first, the caller's legal FROM-states
 * enforced under that lock, non-throwing refusal), and the coordinator deletes
 * it by changing one line in `clinical.module.ts`:
 *
 *     { provide: CLINICAL_BOOKING_PORT, useExisting: BookingFacade }
 *
 * Precedent for the shape, not for the write: `document`'s
 * `ConsultationLookupProvider` and `availability`'s
 * `ConsultationBusyIntervalProvider` are both placeholders reading
 * `consultations` directly while waiting on the owning module's facade. This is
 * the same seam with the same exit, and the exit is one line.
 *
 * The audit row is written here rather than left to the caller because a status
 * change to another module's row must never be un-auditable, and after the
 * rebinding M-11 writes its own (`entityType: 'consultation'`) exactly as it
 * does for every other transition it owns.
 */
@Injectable()
export class ConsultationCompletionProvider implements ClinicalBookingPort {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly bookings: BookingFacade,
    private readonly audit: AuditService,
  ) {}

  /** Straight delegation to the owning module's facade — no placeholder behaviour here at all. */
  async getBooking(consultationId: string): Promise<ClinicalConsultationView | null> {
    return this.bookings.getBooking(consultationId);
  }

  /**
   * `from` -> `completed`, taken under `SELECT ... FOR UPDATE` on the
   * consultation row.
   *
   * Idempotent and non-throwing, both deliberately:
   *   already `completed`  -> `{ changed: false, status: 'completed' }`, no
   *                           refusal. A retried finalise is not an error.
   *   not in `from`        -> `{ changed: false, refusal: 'illegal_transition' }`.
   *   row missing          -> `{ changed: false, status: null, refusal: 'not_found' }`.
   */
  async completeConsultation(input: {
    consultationId: string;
    from: readonly ConsultationStatus[];
    reason?: string;
  }): Promise<CompleteConsultationResult> {
    return this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: consultationsTable.id, status: consultationsTable.status })
        .from(consultationsTable)
        .where(eq(consultationsTable.id, input.consultationId))
        .limit(1)
        .for('update');

      if (!existing) {
        return { changed: false, status: null, refusal: 'not_found' as const };
      }

      // Idempotent: finalisation may be retried, and the sweep re-examines
      // records whose consultation is already where it should be.
      if (existing.status === 'completed') {
        return { changed: false, status: 'completed' as const };
      }

      const [updated] = await tx
        .update(consultationsTable)
        .set({ status: 'completed', updatedAt: new Date() })
        .where(
          and(
            eq(consultationsTable.id, input.consultationId),
            inArray(consultationsTable.status, [...input.from]),
          ),
        )
        .returning({ status: consultationsTable.status });

      if (!updated) {
        return { changed: false, status: existing.status, refusal: 'illegal_transition' as const };
      }

      await this.audit.write(
        {
          actorType: 'system',
          actorId: null,
          action: 'update',
          entityType: 'consultation',
          entityId: input.consultationId,
          consultationId: input.consultationId,
          metadata: {
            before: existing.status,
            after: updated.status,
            ...(input.reason ? { reason: input.reason } : {}),
          },
        },
        tx,
      );

      return { changed: true, status: updated.status };
    });
  }
}
