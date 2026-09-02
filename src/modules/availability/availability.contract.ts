import type { AvailabilityRuleType } from '../../schema/enums.schema';

/**
 * A doctor's busy period, as seen from OUTSIDE this module — the shape
 * `BusyIntervalProvider` reports back in. Deliberately just two `Date`s: the
 * slot engine only ever needs to test overlap against a candidate slot.
 */
export interface BusyInterval {
  startsAt: Date;
  endsAt: Date;
}

/**
 * The engine's only outward-facing dependency on "what already occupies this
 * doctor's calendar" — bound to the `BUSY_INTERVAL_PROVIDER` DI token
 * (`availability.constants.ts`). M-11 (Booking) doesn't exist yet, so this is
 * currently implemented by `ConsultationBusyIntervalProvider` (reads
 * `consultations` directly, a table that already exists in the schema).
 * Once M-11 exists, a `BookingFacade`-backed implementation replaces it at
 * the DI binding in `availability.module.ts` — nothing that depends on this
 * interface (the engine, `availability-slot.service.ts`, or their tests)
 * needs to change.
 */
export interface BusyIntervalProvider {
  /** Every busy interval for `doctorId` that could overlap `[fromUtc, toUtc)` — implementations may return extra intervals outside the range defensively; the caller always re-checks overlap itself. */
  getBusyIntervals(doctorId: string, fromUtc: Date, toUtc: Date): Promise<BusyInterval[]>;

  /**
   * OPTIONAL batch form, added for `getEarliestBookableSlots` (M-09 ranks a
   * whole candidate set at once and cannot afford one round trip per
   * doctor). Deliberately optional, not required: a future
   * `BookingFacade`-backed implementation that has not written one yet must
   * keep compiling, and `availability-slot.service.ts` falls back to looping
   * `getBusyIntervals` when it is absent. Implement it — the fallback is a
   * correctness guarantee, not a performance one.
   */
  getBusyIntervalsForMany?(doctorIds: readonly string[], fromUtc: Date, toUtc: Date): Promise<DoctorBusyIntervals[]>;
}

/** One doctor's busy intervals, as returned by the batch form above. */
export interface DoctorBusyIntervals {
  doctorId: string;
  intervals: BusyInterval[];
}

/**
 * A bookable slot, identified by `(doctorId, startsAt)` — there is no slot
 * `id`. This is a DELIBERATE, SWAPPABLE STORAGE-STRATEGY DECISION: today
 * every slot is computed on demand (`availability-slot.engine.ts`, pure
 * functions over rules/params/busy-intervals, nothing persisted); the client
 * has not committed to that over a future table-backed/materialized-slots
 * design. If that changes, `BookableSlot`/`SlotBookability` and the
 * `AvailabilityContract` methods below do not need to change — only
 * `availability-slot.service.ts`'s internals would.
 */
export interface BookableSlot {
  doctorId: string;
  startsAt: Date;
  endsAt: Date;
}

export type SlotBookability =
  | { bookable: true }
  | {
      bookable: false;
      reason:
        | 'doctor_not_bookable'
        | 'blocked'
        | 'outside_working_hours'
        | 'too_soon'
        | 'too_far_ahead'
        | 'already_taken';
    };

/** One `weekly` `doctor_availability` row, in the doctor's own IST wall-clock terms. */
export interface WeeklyAvailabilityRule {
  id: string;
  /** 0 (Sunday) through 6 (Saturday). */
  dayOfWeek: number;
  /** `"HH:MM:SS"`, IST wall-clock. */
  startTime: string;
  /** `"HH:MM:SS"`, IST wall-clock. */
  endTime: string;
}

/**
 * Availability's public surface — every other module talks to availability
 * through this, never through `doctor_availability`/
 * `doctor_scheduling_settings` directly (`backend/README.md` §2).
 *
 * Kept deliberately narrow, same restraint as `catalogue.contract.ts`:
 *   - listBookableSlots / isSlotBookable: the M-07 "Done when" bar itself
 *     ("two patients cannot take the same slot, and blocked dates never
 *     appear as bookable") — every future consumer that needs to know what a
 *     doctor can be booked for goes through these two. Named near-term
 *     consumers: M-09 (search/ranking — "live availability" per FR-4.2/4.4),
 *     M-11 (booking — the actual reservation), M-13 (instant-consult
 *     routing).
 *   - getWeeklyRules: a doctor's configured weekly shape, with NO
 *     overrides/blocks/min-notice/horizon/busy-interval logic applied. Named
 *     near-term consumer: M-16 ("earliest available doctor" routing, which
 *     needs to compare many doctors' weekly shapes cheaply, without paying
 *     for a full slot-engine run — including a DB round trip for busy
 *     intervals — per candidate doctor). NOT a substitute for
 *     `listBookableSlots`.
 */
export interface AvailabilityContract {
  /** Every bookable slot for `doctorId` in `[fromUtc, toUtc)`. Empty (not an error) for a doctor that doesn't exist or isn't verified-and-listed. */
  listBookableSlots(doctorId: string, fromUtc: Date, toUtc: Date): Promise<BookableSlot[]>;

  /** Whether one specific `(doctorId, startsAtUtc)` slot can be booked right now, and if not, exactly why. */
  isSlotBookable(doctorId: string, startsAtUtc: Date): Promise<SlotBookability>;

  /** The doctor's weekly schedule as currently configured. Empty for a doctor with none set (or that doesn't exist). */
  getWeeklyRules(doctorId: string): Promise<WeeklyAvailabilityRule[]>;

  /**
   * ADDITIVE (M-09/search): the EARLIEST bookable slot for each of many
   * doctors, in ONE pass. This is a ranking signal — FR-4.2/FR-4.4's "live
   * availability", FR-5.4's "alongside availability" — not a booking read.
   *
   * Why it had to exist rather than looping `listBookableSlots`: ranking a
   * thirty-doctor candidate set through the per-doctor method costs roughly
   * four queries each (scheduling parameters, rules, settings, busy
   * intervals), which is ~120 round trips to sort one page of search
   * results. This batches every one of those four into a single statement,
   * so the cost is four queries regardless of how many doctors are ranked.
   *
   * Returns one entry per REQUESTED doctor id, in the order given, with
   * `earliestStartsAt: null` for a doctor who has nothing bookable in the
   * window, is not verified-and-listed, or does not exist — the same
   * "empty, never an error" contract `listBookableSlots` already has, so a
   * search result set never collapses because of one bad id.
   *
   * An ARRAY, not the `Map` the shape suggests: `backend/README.md` §2
   * requires facade methods to pass JSON-safe objects so a local call can
   * become a network call untouched, and a `Map` does not survive
   * serialisation. `Date` does appear here — that is already this contract's
   * established currency (`BookableSlot`), not a new liberty.
   */
  getEarliestBookableSlots(
    doctorIds: readonly string[],
    fromUtc: Date,
    toUtc: Date,
  ): Promise<EarliestBookableSlot[]>;
}

/** See `AvailabilityContract#getEarliestBookableSlots`. */
export interface EarliestBookableSlot {
  doctorId: string;
  /** `null` when this doctor has no bookable slot in the requested window. */
  earliestStartsAt: Date | null;
}

export type { AvailabilityRuleType };
