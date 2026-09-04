import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import {
  CLARIFICATION_STATUSES,
  CLARIFICATION_URGENCIES,
  GENDERS,
  type ClarificationStatus,
  type ClarificationUrgency,
  type Gender,
} from '../../schema/enums.schema';
import { CLARIFICATION_FIELD_LIMITS } from './clarification.constants';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/**
 * `POST /clarification-cases` — creates a `draft` (FR-12.1/FR-12.3).
 *
 * *** `treatingDoctorId` IS DELIBERATELY ABSENT. *** It always comes from
 * `@CurrentUser()`, never the body — the same rule `CreateBookingDto`'s own
 * doc comment states for `patientId`: a doctor cannot post a case as someone
 * else's, because there is nowhere on this DTO to say whose it is.
 *
 * *** THERE IS ALSO NO `patientName`/`patientPhone`/`patientAddress`/
 * `patientEmail` FIELD, AND THAT IS NOT AN OVERSIGHT — IT IS HALF OF THIS
 * MODULE'S DE-IDENTIFICATION GUARANTEE. *** `clarification_cases` has no
 * column for any of them (`clarification-cases.schema.ts`), so there is
 * structurally nowhere for a direct identifier to be attached even if a
 * caller tried to send one — and the global `ValidationPipe({ whitelist:
 * true })` (`app.bootstrap.ts`) strips it before this class ever sees it.
 *
 * *** THE OTHER HALF IS NOT STRUCTURAL, AND THAT IS THE PART A DOCTOR MUST
 * READ. *** `briefHistory`, `diagnosis`, `currentPlan` and `specificDoubt`
 * are free text. Nothing here parses or redacts them — see
 * `DEIDENTIFICATION_NOTICE` in `clarification.constants.ts`, which every
 * response carrying a draft echoes back as `deidentificationNotice`
 * specifically so a client surfaces it before the "Post" action.
 */
export class CreateClarificationCaseDto {
  @IsString()
  @Length(1, CLARIFICATION_FIELD_LIMITS.TITLE)
  title!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(CLARIFICATION_FIELD_LIMITS.MIN_PATIENT_AGE)
  @Max(CLARIFICATION_FIELD_LIMITS.MAX_PATIENT_AGE)
  patientAge?: number;

  @IsOptional()
  @IsIn([...GENDERS])
  patientGender?: Gender;

  /** Free text — see this class's header. Nothing here redacts an identifier a doctor types in. */
  @IsString()
  @Length(1, CLARIFICATION_FIELD_LIMITS.BRIEF_HISTORY)
  briefHistory!: string;

  /** Free text — see this class's header. */
  @IsOptional()
  @IsString()
  @Length(1, CLARIFICATION_FIELD_LIMITS.DIAGNOSIS)
  diagnosis?: string;

  /** Free text — see this class's header. */
  @IsOptional()
  @IsString()
  @Length(1, CLARIFICATION_FIELD_LIMITS.CURRENT_PLAN)
  currentPlan?: string;

  /** Free text — see this class's header. */
  @IsString()
  @Length(1, CLARIFICATION_FIELD_LIMITS.SPECIFIC_DOUBT)
  specificDoubt!: string;

  @IsOptional()
  @IsIn([...CLARIFICATION_URGENCIES])
  urgency?: ClarificationUrgency;

  /**
   * For the treating doctor's own audit trail ONLY — `clarification-
   * cases.schema.ts`: "never exposed to the reviewer". This module has no
   * way to verify the calling doctor actually treated this consultation
   * (that would need `BookingFacade`, and M-17's stated dependencies are only
   * M-02/M-05/M-15 — `docs/MODULES.md`); the id is taken on the treating
   * doctor's own word, exactly as `@CurrentUser()` is trusted for
   * `treatingDoctorId` itself. What IS enforced: no expert-facing read path
   * in this module ever selects or returns this column — see
   * `clarification.mapper.ts#toClarificationCaseExpertView` and its spec.
   */
  @IsOptional()
  @IsUUID('4', { message: 'sourceConsultationId must be a valid UUID.' })
  sourceConsultationId?: string;
}

/**
 * `PUT /clarification-cases/:id` — edits a `draft` in place. Every field is
 * optional so a partial edit does not require resubmitting the whole case,
 * but `clarification.service.ts#updateDraft` refuses the call entirely once
 * the case has left `draft` — there is no "edit a posted case", the same
 * "no unfinalise" discipline `clinical.controller.ts#finalise` documents.
 */
export class UpdateClarificationCaseDto {
  @IsOptional()
  @IsString()
  @Length(1, CLARIFICATION_FIELD_LIMITS.TITLE)
  title?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(CLARIFICATION_FIELD_LIMITS.MIN_PATIENT_AGE)
  @Max(CLARIFICATION_FIELD_LIMITS.MAX_PATIENT_AGE)
  patientAge?: number;

  @IsOptional()
  @IsIn([...GENDERS])
  patientGender?: Gender;

  @IsOptional()
  @IsString()
  @Length(1, CLARIFICATION_FIELD_LIMITS.BRIEF_HISTORY)
  briefHistory?: string;

  @IsOptional()
  @IsString()
  @Length(1, CLARIFICATION_FIELD_LIMITS.DIAGNOSIS)
  diagnosis?: string;

  @IsOptional()
  @IsString()
  @Length(1, CLARIFICATION_FIELD_LIMITS.CURRENT_PLAN)
  currentPlan?: string;

  @IsOptional()
  @IsString()
  @Length(1, CLARIFICATION_FIELD_LIMITS.SPECIFIC_DOUBT)
  specificDoubt?: string;

  @IsOptional()
  @IsIn([...CLARIFICATION_URGENCIES])
  urgency?: ClarificationUrgency;

  @IsOptional()
  @IsUUID('4', { message: 'sourceConsultationId must be a valid UUID.' })
  sourceConsultationId?: string;
}

/**
 * `POST /admin/clarification-cases/:id/assign` — check #1 from
 * `clarification-cases.schema.ts`'s header: "WHO MAY BE ASKED". The admin
 * names a doctor; `clarification.service.ts#assignExpert` is what asserts
 * `seniorityLevel === 'expert'` through `DoctorFacade.isExpertDoctor` before
 * this id is ever written to `expert_doctor_id`.
 */
export class AssignExpertDto {
  @IsUUID('4', { message: 'expertDoctorId must be a valid UUID.' })
  expertDoctorId!: string;
}

/**
 * The body shared by every "add a message" route — the treating doctor's
 * reply and the expert's response alike. `authorId`/`authorType` are never
 * here; both come from `@CurrentUser()` and the route's own authorization,
 * the same way `authorId` on any other actor-stamped write in this codebase
 * is never a client-supplied field.
 */
export class AddClarificationMessageDto {
  @IsIn(['comment', 'clinical_consideration', 'clarification_request', 'followup_advice'])
  messageType!: 'comment' | 'clinical_consideration' | 'clarification_request' | 'followup_advice';

  @IsString()
  @Length(1, CLARIFICATION_FIELD_LIMITS.MESSAGE_BODY)
  body!: string;
}

/** `GET /clarification-cases` and `GET /clarification-cases/assigned` — both list routes share this shape. */
export class ListClarificationCasesQueryDto {
  @IsOptional()
  @IsIn([...CLARIFICATION_STATUSES])
  status?: ClarificationStatus;

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
