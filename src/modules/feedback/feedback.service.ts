import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { NewFeedbackRow } from '../../schema/feedback.schema';
import { AuditService } from '../../shared/audit/audit.service';
import { isUniqueConstraintViolation } from '../../shared/errors/postgres-error.util';
import { BookingFacade } from '../booking/booking.facade';
import { FEEDBACK_AUDIT_ENTITY_TYPES, FEEDBACK_ERROR_CODES } from './feedback.constants';
import type { ListFeedbackFilter } from './feedback.repository';
import { FeedbackRepository } from './feedback.repository';
import type { ListFeedbackQueryDto, SubmitFeedbackDto } from './feedback.dto';
import { toFeedbackView, type FeedbackView } from './feedback.mapper';

/**
 * FR-17.1's rules (`backend/README.md` §2: "services hold the rules").
 *
 * *** OWNERSHIP, COPIED FROM `followup.service.ts#assertPatientOwnsConsultation`. ***
 * `BookingFacade` is injected directly — M-11 is a real, merged module, the
 * same reasoning `followup.module.ts`'s and `carehub.module.ts`'s own
 * headers give for the identical choice. A consultation that does not exist
 * and one that belongs to another patient produce the IDENTICAL 404 — never
 * a 403, which would leak whether the id exists at all.
 *
 * *** ONE SUBMISSION PER CONSULTATION. *** Enforced at the database
 * (`feedback.schema.ts`'s `UNIQUE(consultation_id)`), not re-checked with a
 * SELECT-then-INSERT here — that would leave the same TOCTOU race
 * `booking.service.ts#generateReferenceCode`'s own header warns about for a
 * different unique column. A collision surfaces as Postgres `23505` and is
 * translated to a clean 409 here.
 */
@Injectable()
export class FeedbackService {
  constructor(
    private readonly repo: FeedbackRepository,
    private readonly booking: BookingFacade,
    private readonly audit: AuditService,
  ) {}

  /** FR-17.1. `patientId` is a method parameter, never read off `dto` — `feedback.controller.ts` always supplies `@CurrentUser().accountId`. */
  async submitFeedback(consultationId: string, patientId: string, dto: SubmitFeedbackDto): Promise<FeedbackView> {
    await this.assertPatientOwnsConsultation(consultationId, patientId);

    const insert: NewFeedbackRow = {
      consultationId,
      patientId,
      rating: dto.rating,
      comment: dto.comment ?? null,
    };

    let row;
    try {
      row = await this.repo.create(insert);
    } catch (error) {
      if (isUniqueConstraintViolation(error)) {
        throw this.alreadySubmitted();
      }
      throw error;
    }

    await this.audit.write({
      actorType: 'patient',
      actorId: patientId,
      action: 'create',
      entityType: FEEDBACK_AUDIT_ENTITY_TYPES.FEEDBACK,
      entityId: row.id,
      consultationId,
      metadata: { change: 'feedback_submitted', rating: dto.rating },
    });

    return toFeedbackView(row);
  }

  /** The patient's own feedback for one consultation — `null` when they have not submitted yet (a normal state, not an error, `followup.service.ts#getAssignmentForPatient`'s convention for the identical reason). */
  async getOwnFeedback(consultationId: string, patientId: string): Promise<FeedbackView | null> {
    await this.assertPatientOwnsConsultation(consultationId, patientId);
    const row = await this.repo.findByConsultationId(consultationId);
    return row ? toFeedbackView(row) : null;
  }

  /** The admin review surface's list — FR-18.8, filterable by rating and by date. Unconditional: an admin route, gated by `RequirePermission` at the controller, not by ownership. */
  async listForAdmin(query: ListFeedbackQueryDto): Promise<FeedbackView[]> {
    const filter: ListFeedbackFilter = {
      rating: query.rating,
      dateFrom: query.dateFrom ? new Date(query.dateFrom) : undefined,
      dateTo: query.dateTo ? new Date(query.dateTo) : undefined,
      limit: query.limit ?? 20,
      offset: query.offset ?? 0,
    };
    const rows = await this.repo.listForAdmin(filter);
    return rows.map(toFeedbackView);
  }

  /* ══════════════════════════════════════════════════════════════════════ */
  /* Shared plumbing                                                        */
  /* ══════════════════════════════════════════════════════════════════════ */

  /** `followup.service.ts#assertPatientOwnsConsultation`'s exact shape. */
  private async assertPatientOwnsConsultation(consultationId: string, patientId: string) {
    const booking = await this.booking.getBooking(consultationId);
    if (!booking || booking.patientId !== patientId) throw this.consultationNotFound();
    return booking;
  }

  private consultationNotFound(): NotFoundException {
    return new NotFoundException({ code: FEEDBACK_ERROR_CODES.CONSULTATION_NOT_FOUND, message: 'Consultation not found.' });
  }

  private alreadySubmitted(): ConflictException {
    return new ConflictException({
      code: FEEDBACK_ERROR_CODES.ALREADY_SUBMITTED,
      message: 'Feedback has already been submitted for this consultation.',
    });
  }
}
