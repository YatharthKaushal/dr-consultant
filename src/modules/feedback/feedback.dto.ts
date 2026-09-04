import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsISO8601, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import { COMPLAINT_CATEGORIES, COMPLAINT_STATUSES, type ComplaintCategory, type ComplaintStatus } from '../../schema/enums.schema';
import { COMPLAINT_FIELD_LIMITS, FEEDBACK_FIELD_LIMITS } from './feedback.constants';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/* -------------------------------------------------------------------------- */
/* Feedback                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * `POST /consultations/:id/feedback` — FR-17.1. `patientId` is deliberately
 * absent: it always comes from `@CurrentUser()`, the same rule
 * `CreateBookingDto`'s own doc comment states for `patientId`, and
 * `consultationId` is a route param, never a body field.
 */
export class SubmitFeedbackDto {
  @Type(() => Number)
  @IsInt()
  @Min(FEEDBACK_FIELD_LIMITS.MIN_RATING)
  @Max(FEEDBACK_FIELD_LIMITS.MAX_RATING)
  rating!: number;

  @IsOptional()
  @IsString()
  @Length(1, FEEDBACK_FIELD_LIMITS.COMMENT)
  comment?: string;
}

/** `GET /admin/feedback` — FR-18.8's "by rating" and "by date" filters. */
export class ListFeedbackQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(FEEDBACK_FIELD_LIMITS.MIN_RATING)
  @Max(FEEDBACK_FIELD_LIMITS.MAX_RATING)
  rating?: number;

  @IsOptional()
  @IsISO8601()
  dateFrom?: string;

  @IsOptional()
  @IsISO8601()
  dateTo?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit?: number = DEFAULT_PAGE_SIZE;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number = 0;
}

/* -------------------------------------------------------------------------- */
/* Complaints                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * `POST /complaints` — FR-17.2. `consultationId` is optional: "not about one
 * consultation" is a real, valid case per `complaints.schema.ts`'s own
 * comment ("Null when not about one consultation") and FR-17.2. When given,
 * `complaint.service.ts#raiseComplaint` ownership-checks it the same way
 * every other module here checks a consultation id — the same ~404 a
 * stranger gets.
 */
export class RaiseComplaintDto {
  @IsIn([...COMPLAINT_CATEGORIES])
  category!: ComplaintCategory;

  @IsString()
  @Length(1, COMPLAINT_FIELD_LIMITS.SUBJECT)
  subject!: string;

  @IsString()
  @Length(1, COMPLAINT_FIELD_LIMITS.DESCRIPTION)
  description!: string;

  @IsOptional()
  @IsUUID('4', { message: 'consultationId must be a valid UUID.' })
  consultationId?: string;
}

/**
 * The body shared by every "add a message" route — the patient's own and
 * the admin's. `authorId`/`authorType` are never here; both come from
 * `@CurrentUser()`, the same rule `AddClarificationMessageDto`'s own header
 * states.
 */
export class AddComplaintMessageDto {
  @IsString()
  @Length(1, COMPLAINT_FIELD_LIMITS.MESSAGE_BODY)
  body!: string;
}

/**
 * The admin-only variant: an admin may mark a message internal-only (a
 * triage note for another admin, never shown on the patient's own view —
 * see `feedback.contract.ts#ComplaintMessage.isInternal`). A patient's own
 * `AddComplaintMessageDto` has no such field — a patient cannot write a
 * message that hides itself from the very thread they are looking at.
 */
export class AddComplaintAdminMessageDto extends AddComplaintMessageDto {
  @IsOptional()
  @IsBoolean()
  isInternal?: boolean = false;
}

/** `POST /admin/complaints/:id/assign` — `open` -> `in_progress`. */
export class AssignComplaintDto {
  @IsUUID('4', { message: 'assignedToAdminId must be a valid UUID.' })
  assignedToAdminId!: string;
}

/** `POST /admin/complaints/:id/resolve` and `.../reject` share this shape — see `complaint.service.ts` for which sets `resolvedAt` and which does not. */
export class ResolveComplaintDto {
  @IsString()
  @Length(1, COMPLAINT_FIELD_LIMITS.RESOLUTION_NOTE)
  resolutionNote!: string;
}

export class RejectComplaintDto {
  @IsString()
  @Length(1, COMPLAINT_FIELD_LIMITS.RESOLUTION_NOTE)
  resolutionNote!: string;
}

/** `GET /complaints` — the patient's own list. No `assignedToAdminId` filter: a patient has no reason to filter by which admin, only by their complaint's own status. */
export class ListOwnComplaintsQueryDto {
  @IsOptional()
  @IsIn([...COMPLAINT_STATUSES])
  status?: ComplaintStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit?: number = DEFAULT_PAGE_SIZE;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number = 0;
}

/** `GET /admin/complaints` — FR-18.8: filter by status, by category, by assignee. */
export class ListComplaintsAdminQueryDto {
  @IsOptional()
  @IsIn([...COMPLAINT_STATUSES])
  status?: ComplaintStatus;

  @IsOptional()
  @IsIn([...COMPLAINT_CATEGORIES])
  category?: ComplaintCategory;

  @IsOptional()
  @IsUUID('4', { message: 'assignedToAdminId must be a valid UUID.' })
  assignedToAdminId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit?: number = DEFAULT_PAGE_SIZE;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number = 0;
}
