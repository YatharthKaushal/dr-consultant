import { Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsObject, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { CONSULTATION_STATUSES, type ConsultationStatus } from '../../schema/enums.schema';
import { DEFAULT_BOOKING_PAGE_SIZE, MAX_BOOKING_PAGE_SIZE } from './booking.constants';

/**
 * A scheduled booking. `patientId` is deliberately ABSENT — it always comes
 * from `@CurrentUser()`, never the body, so a patient cannot book in somebody
 * else's name (FR-1.4, and the same rule `availability.controller.ts` follows
 * for doctor ids).
 */
export class CreateBookingDto {
  @IsUUID('4', { message: 'doctorId must be a valid UUID.' })
  doctorId!: string;

  @IsUUID('4', { message: 'specialtyId must be a valid UUID.' })
  specialtyId!: string;

  @IsOptional()
  @IsUUID('4', { message: 'concernId must be a valid UUID.' })
  concernId?: string;

  /** The slot's start as a UTC instant — a slot's identity is `(doctorId, startsAt)`, per `availability.contract.ts`. */
  @IsISO8601({ strict: true }, { message: 'scheduledStartAt must be an ISO 8601 timestamp.' })
  scheduledStartAt!: string;

  /** Answers to the specialty's own intake form (FR-19.2). Shape is specialty-defined, so this is validated as "an object" and no further. */
  @IsOptional()
  @IsObject()
  intakeAnswers?: Record<string, unknown>;
}

/** An instant request. No doctor and no slot — M-13 routes it. */
export class CreateInstantBookingDto {
  @IsUUID('4', { message: 'specialtyId must be a valid UUID.' })
  specialtyId!: string;

  @IsOptional()
  @IsUUID('4', { message: 'concernId must be a valid UUID.' })
  concernId?: string;

  @IsOptional()
  @IsObject()
  intakeAnswers?: Record<string, unknown>;
}

export class CancelBookingDto {
  /** Free text shown back to the patient and stored on the row. `varchar(200)` in the schema. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}

export class RescheduleBookingDto {
  @IsISO8601({ strict: true }, { message: 'scheduledStartAt must be an ISO 8601 timestamp.' })
  scheduledStartAt!: string;
}

export class SaveIntakeAnswersDto {
  @IsObject()
  answers!: Record<string, unknown>;
}

export class AttachDocumentDto {
  @IsUUID('4', { message: 'fileId must be a valid UUID.' })
  fileId!: string;
}

/** `upcoming`/`past` for the Appointments screen (FR-6.5). See `booking.repository.ts#listForParty` for what "upcoming" means. */
export class ListBookingsQueryDto {
  @IsOptional()
  @IsIn(['upcoming', 'past'])
  scope?: 'upcoming' | 'past';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_BOOKING_PAGE_SIZE)
  limit?: number = DEFAULT_BOOKING_PAGE_SIZE;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number = 0;
}

export class ListAdminBookingsQueryDto {
  @IsOptional()
  @IsIn([...CONSULTATION_STATUSES])
  status?: ConsultationStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_BOOKING_PAGE_SIZE)
  limit?: number = DEFAULT_BOOKING_PAGE_SIZE;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number = 0;
}
