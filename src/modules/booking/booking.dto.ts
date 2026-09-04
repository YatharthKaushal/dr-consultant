import { Type } from 'class-transformer';
import { IsIn, IsInt, IsISO8601, IsObject, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import { CONSULTATION_STATUSES, type ConsultationStatus } from '../../schema/enums.schema';
import { DEFAULT_BOOKING_PAGE_SIZE, MAX_BOOKING_PAGE_SIZE } from './booking.constants';

/**
 * Mirrors the shape `modules/promotion/promotion-code.util.ts#CODE_PATTERN`
 * accepts once NORMALISED (upper-cased, everything outside `A-Z0-9` stripped,
 * 4-32 characters). This module does not import that file — `backend/
 * README.md` §2 forbids a deep cross-module import of another module's
 * internals, and `promotion-code.util.ts` is not part of `modules/promotion`'s
 * public surface — so the shape is duplicated here, the same discipline
 * `booking-payment.contract.ts` applies to a PORT's behaviour rather than to a
 * constant. If the promotions module's pattern ever changes, change it here
 * too.
 *
 * This validates the RAW value a patient might type, which is deliberately
 * LOOSER than the stored form: normalisation upper-cases and strips
 * punctuation, so `save-me` and `SAVE ME` are both legal input here even
 * though only `SAVEME` is ever stored. What this pattern rules out is
 * garbage — control characters, wildly long input — not a code a real patient
 * would type. Whether a code that passes this actually EXISTS and applies is
 * answered downstream by the discount port, never by this DTO.
 */
const DISCOUNT_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _-]{2,39}$/;
const DISCOUNT_CODE_MESSAGE =
  'discountCode may contain letters, digits, spaces, dashes and underscores only, 4-40 characters.';

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

  /**
   * A discount/coupon/referral code the patient wants applied. Optional, and
   * VALIDATED — before this field existed the global `ValidationPipe({
   * whitelist: true })` stripped it silently and answered 201 with the
   * undiscounted price, which is the bug class this field closes. Whether the
   * code actually applies is decided by `modules/pricing`'s discount port, not
   * here; an unusable code is refused loudly in the response, never silently
   * dropped.
   */
  @IsOptional()
  @IsString()
  @Matches(DISCOUNT_CODE_PATTERN, { message: DISCOUNT_CODE_MESSAGE })
  discountCode?: string;
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

/** The optional discount/coupon code on `GET /bookings/quote/:doctorId` — a preview, never a reservation. */
export class BookingQuoteQueryDto {
  @IsOptional()
  @IsString()
  @Matches(DISCOUNT_CODE_PATTERN, { message: DISCOUNT_CODE_MESSAGE })
  code?: string;
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
