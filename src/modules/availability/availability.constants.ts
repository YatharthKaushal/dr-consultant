/** `audit_log.entity_type` values this module writes. */
export const AVAILABILITY_AUDIT_ENTITY_TYPES = {
  WEEKLY_SCHEDULE: 'availability_weekly_schedule',
  OVERRIDE: 'availability_override',
  BLOCK: 'availability_block',
  SETTINGS: 'availability_settings',
} as const;

export const AVAILABILITY_ERROR_CODES = {
  /** A rule's columns don't match its `rule_type`'s required shape, or its times are out of order — the same combinations the `doctor_availability_rule_shape_check`/`doctor_availability_time_order_check` CHECK constraints reject at the DB layer, caught earlier here for a clean 400. */
  INVALID_RULE_SHAPE: 'INVALID_RULE_SHAPE',
  /** Two rules (same day-of-week for weekly, same date for overrides/blocks) whose time ranges intersect. */
  OVERLAPPING_RULE: 'OVERLAPPING_RULE',
  /** `to` is not after `from`. */
  INVALID_RANGE: 'INVALID_RANGE',
  /** `[from, to)` spans more than `scheduling.max_slot_query_days`. */
  RANGE_TOO_LARGE: 'RANGE_TOO_LARGE',
  /** More than `MAX_BATCH_DOCTOR_IDS` ids passed to `getEarliestBookableSlots`. */
  TOO_MANY_DOCTOR_IDS: 'TOO_MANY_DOCTOR_IDS',
  RULE_NOT_FOUND: 'RULE_NOT_FOUND',
  /** Defensive re-check of the DTO's own `@Min`/`@Max` bounds — see `availability-settings.service.ts`. */
  SETTINGS_INVALID: 'SETTINGS_INVALID',
} as const;
export type AvailabilityErrorCode = (typeof AVAILABILITY_ERROR_CODES)[keyof typeof AVAILABILITY_ERROR_CODES];

/**
 * `app_config` keys this module reads (`AppConfigService.getNumber(key,
 * fallback)`, same pattern as identity's OTP thresholds). These three keys
 * are genuinely new — `docs/erd.sql`'s example `app_config` key list does
 * not anticipate them; flagged here rather than invented silently.
 */
export const AVAILABILITY_CONFIG_KEYS = {
  MIN_NOTICE_MINUTES: 'scheduling.min_notice_minutes',
  BOOKING_HORIZON_DAYS: 'scheduling.booking_horizon_days',
  /** Caps how large a single `[from, to)` slot-lookup range may be. */
  MAX_SLOT_QUERY_DAYS: 'scheduling.max_slot_query_days',
} as const;

/** Compiled-in fallbacks for the keys above, used when the `app_config` row is missing or malformed (`AppConfigService`'s own contract). */
export const AVAILABILITY_CONFIG_FALLBACKS = {
  MIN_NOTICE_MINUTES: 120,
  BOOKING_HORIZON_DAYS: 30,
  MAX_SLOT_QUERY_DAYS: 62,
} as const;

/**
 * DI token for the `BusyIntervalProvider` implementation, bound in
 * `availability.module.ts` — mirrors `shared/auth/auth.constants.ts`'s
 * `AUTH_CONTEXT_RESOLVER` pattern. Currently bound to
 * `ConsultationBusyIntervalProvider` (a placeholder reading `consultations`
 * directly, since M-11/Booking doesn't exist yet); swapped for a
 * `BookingFacade`-backed implementation once it does, with no change to
 * `availability-slot.service.ts` or the engine.
 */
export const BUSY_INTERVAL_PROVIDER = Symbol('BUSY_INTERVAL_PROVIDER');

/**
 * Ceiling on `getEarliestBookableSlots`' doctor-id list. Bounds the `IN`
 * clauses and the per-doctor slot expansion behind one batch call, so a
 * caller cannot turn a ranking read into an unbounded scan by passing every
 * doctor on the platform. Comfortably above M-09's own candidate pool
 * (`SEARCH_CANDIDATE_POOL_LIMIT`).
 */
export const MAX_BATCH_DOCTOR_IDS = 200;
