import type { CheckinResponseRow } from '../../schema/checkin-responses.schema';
import type { FollowupAssignmentRow } from '../../schema/followup-assignments.schema';
import type { FollowupPathwayRow } from '../../schema/followup-pathways.schema';
import type { SafetyAlertRow } from '../../schema/safety-alerts.schema';
import type { CheckinResponseView, FollowupAssignmentView, FollowupPathwayView, SafetyAlertView } from './followup.contract';
import type { FollowupAnswers, FollowupQuestion, RedFlagRule } from './followup-question.types';

/** `followup_pathways` row -> public view. `questions`/`redFlagRules` are `jsonb('...').$type<unknown>()` at the schema layer — cast here, at the one seam that gives the untyped column its runtime shape. Safe because nothing reaches this row without passing `validateQuestions`/`validateRedFlagRules` on the way in (`followup-pathway.service.ts`). */
export function toPathwayView(row: FollowupPathwayRow): FollowupPathwayView {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    version: row.version,
    durationDays: row.durationDays,
    questions: row.questions as FollowupQuestion[],
    redFlagRules: row.redFlagRules as RedFlagRule[],
    isCurrent: row.isCurrent,
    createdAt: row.createdAt,
  };
}

/** `followup_assignments` row + the pinned pathway row it points at -> public view. Takes the pathway row explicitly rather than re-fetching it, since every call site already has both in hand. */
export function toAssignmentView(row: FollowupAssignmentRow, pathway: FollowupPathwayRow): FollowupAssignmentView {
  return {
    id: row.id,
    consultationId: row.consultationId,
    pathwayId: row.pathwayId,
    pathwayCode: pathway.code,
    pathwayName: pathway.name,
    pathwayVersion: pathway.version,
    startsOn: row.startsOn,
    durationDays: pathway.durationDays,
    status: row.status,
    createdAt: row.createdAt,
  };
}

export function toCheckinResponseView(row: CheckinResponseRow): CheckinResponseView {
  return {
    id: row.id,
    consultationId: row.consultationId,
    checkinDate: row.checkinDate,
    answers: row.answers as FollowupAnswers,
    status: row.status,
    submittedAt: row.submittedAt,
  };
}

export function toSafetyAlertView(row: SafetyAlertRow): SafetyAlertView {
  return {
    id: row.id,
    alertType: row.alertType,
    consultationId: row.consultationId,
    checkinResponseId: row.checkinResponseId,
    reason: row.reason,
    acknowledgedByAdminId: row.acknowledgedByAdminId,
    acknowledgedByDoctorId: row.acknowledgedByDoctorId,
    acknowledgedAt: row.acknowledgedAt,
    closedAt: row.closedAt,
    closingNote: row.closingNote,
    createdAt: row.createdAt,
  };
}
