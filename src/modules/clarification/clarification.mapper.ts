import type { ClarificationCaseRow } from '../../schema/clarification-cases.schema';
import type { ClarificationStatus, ClarificationUrgency, Gender } from '../../schema/enums.schema';
import { parseClarificationMessages } from './clarification-message.util';
import { DEIDENTIFICATION_NOTICE } from './clarification.constants';
import type { ClarificationCaseSummaryView, ClarificationMessage } from './clarification.contract';

/**
 * The treating doctor's / admin's full view of a case — every column,
 * including `sourceConsultationId`. Never returned from an expert-facing
 * route; see `toClarificationCaseExpertView` below and
 * `clarification.mapper.spec.ts` for the test that proves the two views
 * cannot be confused for each other.
 */
export interface ClarificationCaseView {
  id: string;
  treatingDoctorId: string;
  sourceConsultationId: string | null;
  title: string;
  patientAge: number | null;
  patientGender: Gender | null;
  briefHistory: string;
  diagnosis: string | null;
  currentPlan: string | null;
  specificDoubt: string;
  urgency: ClarificationUrgency;
  expertDoctorId: string | null;
  assignedAt: Date | null;
  messages: ClarificationMessage[];
  status: ClarificationStatus;
  postedAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /**
   * *** THE DE-IDENTIFICATION WARNING, SURFACED ON THE RESPONSE ITSELF. ***
   * `clarification.constants.ts#DEIDENTIFICATION_NOTICE`'s full text, present
   * only while the case is still `draft` — i.e. exactly the window in which a
   * client should be showing it before the "Post" action. Absent (not
   * `null`, genuinely absent — see `toClarificationCaseView`) once posted,
   * because a posted case is no longer being written and the warning has
   * nothing left to act on.
   */
  deidentificationNotice?: string;
}

/**
 * *** THE DE-IDENTIFIED VIEW. CHECK #2 FROM `clarification-cases.schema.ts`:
 * "WHAT THEY MAY SEE". ***
 *
 * Structurally missing two things `ClarificationCaseView` has:
 *
 *   `sourceConsultationId` — the schema's own doc comment: "for the treating
 *   doctor and audit ONLY — never exposed to the reviewer". Omitted by
 *   construction, not filtered at runtime: this interface has no such
 *   property, so there is nothing to accidentally leave in.
 *
 *   `deidentificationNotice` — that warning is for the treating doctor
 *   deciding what to post, before they post it. An expert reading an
 *   already-posted case has no "Post" action in front of them for it to gate.
 *
 * `treatingDoctorId` IS included — it identifies a COLLEAGUE, not the
 * patient, and knowing who to address a clinical reply to is the ordinary
 * professional context this whole feature exists to provide (FR-12.4/FR-12.5).
 */
export interface ClarificationCaseExpertView {
  id: string;
  treatingDoctorId: string;
  title: string;
  patientAge: number | null;
  patientGender: Gender | null;
  briefHistory: string;
  diagnosis: string | null;
  currentPlan: string | null;
  specificDoubt: string;
  urgency: ClarificationUrgency;
  expertDoctorId: string | null;
  assignedAt: Date | null;
  messages: ClarificationMessage[];
  status: ClarificationStatus;
  postedAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** `clarification_cases` row -> the treating doctor's / admin's full view. */
export function toClarificationCaseView(row: ClarificationCaseRow): ClarificationCaseView {
  return {
    id: row.id,
    treatingDoctorId: row.treatingDoctorId,
    sourceConsultationId: row.sourceConsultationId,
    title: row.title,
    patientAge: row.patientAge,
    patientGender: row.patientGender,
    briefHistory: row.briefHistory,
    diagnosis: row.diagnosis,
    currentPlan: row.currentPlan,
    specificDoubt: row.specificDoubt,
    urgency: row.urgency,
    expertDoctorId: row.expertDoctorId,
    assignedAt: row.assignedAt,
    messages: parseClarificationMessages(row.messages),
    status: row.status,
    postedAt: row.postedAt,
    closedAt: row.closedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.status === 'draft' ? { deidentificationNotice: DEIDENTIFICATION_NOTICE } : {}),
  };
}

/**
 * `clarification_cases` row -> the expert's de-identified view. Built field
 * by field FROM THE ROW, never by spreading `toClarificationCaseView`'s
 * result and deleting keys — a `delete` is one refactor away from being
 * forgotten; a literal that never names `sourceConsultationId` cannot leak it
 * by omission of a later edit.
 */
export function toClarificationCaseExpertView(row: ClarificationCaseRow): ClarificationCaseExpertView {
  return {
    id: row.id,
    treatingDoctorId: row.treatingDoctorId,
    title: row.title,
    patientAge: row.patientAge,
    patientGender: row.patientGender,
    briefHistory: row.briefHistory,
    diagnosis: row.diagnosis,
    currentPlan: row.currentPlan,
    specificDoubt: row.specificDoubt,
    urgency: row.urgency,
    expertDoctorId: row.expertDoctorId,
    assignedAt: row.assignedAt,
    messages: parseClarificationMessages(row.messages),
    status: row.status,
    postedAt: row.postedAt,
    closedAt: row.closedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** `clarification_cases` row -> the governance summary `ClarificationContract#getCaseSummary` returns. */
export function toClarificationCaseSummaryView(row: ClarificationCaseRow): ClarificationCaseSummaryView {
  return {
    id: row.id,
    treatingDoctorId: row.treatingDoctorId,
    expertDoctorId: row.expertDoctorId,
    status: row.status,
    urgency: row.urgency,
    postedAt: row.postedAt,
    assignedAt: row.assignedAt,
    closedAt: row.closedAt,
    createdAt: row.createdAt,
  };
}
