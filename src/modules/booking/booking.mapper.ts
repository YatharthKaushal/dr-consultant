import type { ConsultationRow } from '../../schema/consultations.schema';
import type { BookingView, ConsultationSummary } from './booking.contract';

/**
 * Row -> public view. `hold_expires_at` is deliberately NOT carried: the hold
 * is this module's internal mechanism for keeping a slot, not a fact any
 * other module or client should branch on. A patient sees `pending_payment`
 * and a checkout; they do not need a countdown they cannot act on, and
 * exposing it would invite callers to reimplement expiry themselves.
 *
 * The follow-up and feedback columns (`followup_*`, `feedback_*`) also stay
 * off this view: they live on the `consultations` row but belong to M-16 and
 * M-19's behaviour, and this module has no business publishing them.
 */
export function toBookingView(row: ConsultationRow): BookingView {
  return {
    id: row.id,
    referenceCode: row.referenceCode,
    patientId: row.patientId,
    doctorId: row.doctorId,
    specialtyId: row.specialtyId,
    concernId: row.concernId,
    mode: row.mode,
    status: row.status,
    scheduledStartAt: row.scheduledStartAt,
    durationMinutes: row.durationMinutes,
    intakeAnswers: row.intakeAnswers ?? null,
    rescheduledFromConsultationId: row.rescheduledFromConsultationId,
    cancelledAt: row.cancelledAt,
    cancelledByParty: row.cancelledByParty,
    cancellationReason: row.cancellationReason,
    createdAt: row.createdAt,
  };
}

/** The narrow projection `document`'s `ConsultationLookupPort` asks for. */
export function toConsultationSummary(row: ConsultationRow): ConsultationSummary {
  return { id: row.id, patientId: row.patientId, doctorId: row.doctorId, status: row.status };
}
