import { Type } from 'class-transformer';
import { IsIn, IsInt, IsObject, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { INSTANT_CONSULTANCY_OUTCOMES, type InstantConsultancyOutcome } from '../../schema/enums.schema';
import {
  DEFAULT_INSTANT_PAGE_SIZE,
  INSTANT_CONFIG_BOUNDS,
  INSTANT_CONFIG_KEYS,
  MAX_INSTANT_PAGE_SIZE,
  SELF_SETTABLE_PRESENCE,
  type SelfSettablePresence,
} from './instant.constants';

/**
 * FR-6.1's "Consult Now". `patientId` is deliberately ABSENT — it always comes
 * from `@CurrentUser()`, never the body, so a patient cannot open a request in
 * somebody else's name (the same rule `booking.dto.ts` and
 * `availability.controller.ts` follow).
 *
 * No `doctorId`: an instant request is routed, not addressed. Letting a
 * patient name a doctor here would be a scheduled booking with the payment
 * step removed, and would route around every one of FR-10.3's, FR-10.5's and
 * FR-10.6's rules at once.
 */
export class CreateInstantConsultDto {
  @IsUUID('4', { message: 'specialtyId must be a valid UUID.' })
  specialtyId!: string;

  @IsOptional()
  @IsUUID('4', { message: 'concernId must be a valid UUID.' })
  concernId?: string;

  /** Answers to the specialty's own intake form (FR-19.2). Shape is specialty-defined, so this is validated as "an object" and no further. */
  @IsOptional()
  @IsObject()
  intakeAnswers?: Record<string, unknown>;
}

/**
 * `PUT /doctors/me/presence`.
 *
 * The allowed set is `SELF_SETTABLE_PRESENCE`, not the full seven:
 * `request_pending`, `in_consultation` and `completing_notes` are facts about
 * work in flight and are set by the system. The service re-checks this — the
 * DTO is the first line, not the rule (`backend/README.md`: services hold the
 * rules, not just the HTTP layer).
 */
export class SetPresenceDto {
  @IsIn([...SELF_SETTABLE_PRESENCE], {
    message: `presence must be one of: ${SELF_SETTABLE_PRESENCE.join(', ')}.`,
  })
  presence!: SelfSettablePresence;
}

/** `PUT /admin/instant-consults/config`. Every field optional; only the present ones are written. Bounds mirror `INSTANT_CONFIG_BOUNDS` exactly. */
export class UpdateInstantConfigDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'acceptanceWindowSeconds must be a whole number of seconds.' })
  @Min(INSTANT_CONFIG_BOUNDS[INSTANT_CONFIG_KEYS.ACCEPTANCE_WINDOW_SECONDS].min)
  @Max(INSTANT_CONFIG_BOUNDS[INSTANT_CONFIG_KEYS.ACCEPTANCE_WINDOW_SECONDS].max)
  acceptanceWindowSeconds?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'paymentWindowSeconds must be a whole number of seconds.' })
  @Min(INSTANT_CONFIG_BOUNDS[INSTANT_CONFIG_KEYS.PAYMENT_WINDOW_SECONDS].min)
  @Max(INSTANT_CONFIG_BOUNDS[INSTANT_CONFIG_KEYS.PAYMENT_WINDOW_SECONDS].max)
  paymentWindowSeconds?: number;
}

/** `PUT /admin/instant-consults/doctors/:id/presence` — the operator override. Same allowed set as a doctor's own change; an admin does not get to assert work in flight either. */
export class AdminSetPresenceDto {
  @IsIn([...SELF_SETTABLE_PRESENCE], {
    message: `presence must be one of: ${SELF_SETTABLE_PRESENCE.join(', ')}.`,
  })
  presence!: SelfSettablePresence;
}

/** `GET /admin/instant-consults`. */
export class ListInstantRequestsQueryDto {
  @IsOptional()
  @IsIn([...INSTANT_CONSULTANCY_OUTCOMES])
  outcome?: InstantConsultancyOutcome;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_INSTANT_PAGE_SIZE)
  limit?: number = DEFAULT_INSTANT_PAGE_SIZE;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number = 0;
}

/** `GET /admin/instant-consults/metrics`. `sinceHours` bounds the window so the count can never become an unbounded scan. */
export class InstantMetricsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(24 * 90)
  sinceHours?: number = 24;
}
