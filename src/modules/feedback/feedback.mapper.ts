import type { ComplaintRow } from '../../schema/complaints.schema';
import type { ComplaintCategory, ComplaintStatus } from '../../schema/enums.schema';
import type { FeedbackRow } from '../../schema/feedback.schema';
import { parseComplaintMessages, toPatientVisibleMessages } from './complaint-message.util';
import type { ComplaintMessage } from './feedback.contract';

/* -------------------------------------------------------------------------- */
/* Feedback                                                                    */
/* -------------------------------------------------------------------------- */

export interface FeedbackView {
  id: string;
  consultationId: string;
  patientId: string;
  rating: number;
  comment: string | null;
  createdAt: Date;
}

export function toFeedbackView(row: FeedbackRow): FeedbackView {
  return {
    id: row.id,
    consultationId: row.consultationId,
    patientId: row.patientId,
    rating: row.rating,
    comment: row.comment,
    createdAt: row.createdAt,
  };
}

/* -------------------------------------------------------------------------- */
/* Complaints                                                                  */
/* -------------------------------------------------------------------------- */

/** The admin's full view of a complaint — every column, every message including internal-only ones. */
export interface ComplaintView {
  id: string;
  referenceCode: string;
  patientId: string;
  consultationId: string | null;
  category: ComplaintCategory;
  subject: string;
  description: string;
  status: ComplaintStatus;
  assignedToAdminId: string | null;
  messages: ComplaintMessage[];
  resolvedAt: Date | null;
  resolutionNote: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** `complaints` row -> the admin's full view. Never used for a patient-facing route — see `toComplaintPatientView` below. */
export function toComplaintView(row: ComplaintRow): ComplaintView {
  return {
    id: row.id,
    referenceCode: row.referenceCode,
    patientId: row.patientId,
    consultationId: row.consultationId,
    category: row.category,
    subject: row.subject,
    description: row.description,
    status: row.status,
    assignedToAdminId: row.assignedToAdminId,
    messages: parseComplaintMessages(row.messages),
    resolvedAt: row.resolvedAt,
    resolutionNote: row.resolutionNote,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * `complaints` row -> the patient's own view — identical to `ComplaintView`
 * except `messages` is filtered through `toPatientVisibleMessages` first, so
 * an admin's internal note never reaches the patient who raised the
 * complaint. Built by re-using `toComplaintView` and replacing `messages`,
 * not by hand-listing every other field — there is nothing else this view
 * hides, unlike `clarification.mapper.ts#toClarificationCaseExpertView`,
 * which must omit whole columns.
 */
export function toComplaintPatientView(row: ComplaintRow): ComplaintView {
  const view = toComplaintView(row);
  return { ...view, messages: toPatientVisibleMessages(view.messages) };
}
