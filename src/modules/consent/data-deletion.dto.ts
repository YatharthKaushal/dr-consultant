import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { DELETION_STATUSES, type DeletionStatus } from '../../schema/enums.schema';
import { DEFAULT_DATA_DELETION_PAGE_SIZE, MAX_DATA_DELETION_PAGE_SIZE } from './data-deletion.constants';

/** FR-2.5's request. `patientId` is deliberately ABSENT — it always comes from `@CurrentUser()`, same rule `CreateBookingDto` states for its own patient id. */
export class RaiseDataDeletionRequestDto {
  /** Free text, per `data-deletion-requests.schema.ts`'s nullable `reason` column — optional, patient-supplied context, never a decision input. */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

/**
 * The admin review. Only `in_review`/`approved`/`rejected` are ACCEPTABLE
 * values here — `requested` (going backwards) and `executed`/`failed` (M-21's
 * job, and it also writes `executed_at`/`execution_outcome` in the same act)
 * are refused before the request body is even valid, per
 * `DataDeletionService`'s state machine.
 */
export class ReviewDataDeletionRequestDto {
  @IsIn(['in_review', 'approved', 'rejected'])
  status!: 'in_review' | 'approved' | 'rejected';

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reviewNote?: string;
}

/** The admin queue. `status` narrows it; omitted lists every request, newest first. */
export class ListDataDeletionRequestsQueryDto {
  @IsOptional()
  @IsIn(DELETION_STATUSES)
  status?: DeletionStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_DATA_DELETION_PAGE_SIZE)
  limit?: number = DEFAULT_DATA_DELETION_PAGE_SIZE;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number = 0;
}
