import type { AvailabilityRuleType } from '../../schema/enums.schema';
import type { BookableSlot, BusyInterval, SlotBookability } from './availability.contract';
import {
  addDaysToIsoDate,
  dayOfWeekOfIsoDate,
  istWallClockToUtc,
  parseTimeToMinutes,
  utcToIstWallClock,
} from './availability-time.util';

/**
 * The slot engine — PURE FUNCTIONS, no I/O. Everything it needs (rules,
 * scheduling params, resolved window limits, busy intervals) is fetched by
 * `availability-slot.service.ts` and handed in as plain data, which is why
 * almost all of this module's tests live in `availability-slot.engine.spec.ts`:
 * no DB/HTTP mocking needed, just data in, data out.
 *
 * Algorithm, per IST calendar day in range:
 *   1. Expand the day's base working range from its `weekly` rule (if any).
 *   2. If the day also has a `custom_hours` override, that REPLACES (not
 *      adds to) the weekly-derived range.
 *   3. Subtract any `blocked` rule for the day — a full-day block (no times)
 *      removes the whole day; a partial-day block subtracts only the
 *      overlapping sub-range.
 *   4. Slice what's left into slots of `consultationDurationMinutes`, with
 *      `bufferMinutes` gaps BETWEEN consecutive slots (the buffer is not
 *      part of a slot's own bookable duration, and there is no trailing
 *      buffer after the last slot in a range).
 *   5. Drop any candidate whose start is before `now + minNoticeMinutes` or
 *      after `now + bookingHorizonDays`.
 *   6. Drop any candidate that overlaps a busy interval.
 */

export interface AvailabilityRuleData {
  ruleType: AvailabilityRuleType;
  /** 0-6, `weekly` rules only. */
  dayOfWeek: number | null;
  /** `YYYY-MM-DD` IST calendar date, `custom_hours`/`blocked` rules only. */
  specificDate: string | null;
  /** `"HH:MM:SS"` IST wall-clock, or `null` for a full-day `blocked` rule. */
  startTime: string | null;
  endTime: string | null;
}

export interface SchedulingParams {
  consultationDurationMinutes: number;
  bufferMinutes: number;
}

export interface WindowLimits {
  minNoticeMinutes: number;
  bookingHorizonDays: number;
}

interface MinuteRange {
  /** Minutes since IST midnight, inclusive. */
  start: number;
  /** Minutes since IST midnight, exclusive. */
  end: number;
}

export interface ComputeBookableSlotsInput {
  doctorId: string;
  fromUtc: Date;
  toUtc: Date;
  now: Date;
  rules: AvailabilityRuleData[];
  schedulingParams: SchedulingParams;
  windowLimits: WindowLimits;
  busyIntervals: BusyInterval[];
}

export interface EvaluateSlotBookabilityInput {
  startsAtUtc: Date;
  now: Date;
  rules: AvailabilityRuleData[];
  schedulingParams: SchedulingParams;
  windowLimits: WindowLimits;
  busyIntervals: BusyInterval[];
}

/* -------------------------------------------------------------------------- */
/* Day-range computation — shared by both public entry points                  */
/* -------------------------------------------------------------------------- */

interface DayRanges {
  /** Bookable-before-busy-interval-check ranges, in IST minutes-of-day. */
  workingRanges: MinuteRange[];
  /** Partial-day block ranges, in IST minutes-of-day (empty when the day is fully blocked, or not blocked at all). */
  blockedRanges: MinuteRange[];
  isFullyBlocked: boolean;
}

function toMinuteRange(rule: AvailabilityRuleData): MinuteRange {
  return { start: parseTimeToMinutes(rule.startTime as string), end: parseTimeToMinutes(rule.endTime as string) };
}

/** Interval subtraction: `base` minus every overlapping range in `subtract`, split as needed. Touching-but-not-overlapping boundaries (`a.end === b.start`) leave both ranges intact. */
function subtractRanges(base: MinuteRange[], subtract: MinuteRange[]): MinuteRange[] {
  let result = base;
  for (const cut of subtract) {
    const next: MinuteRange[] = [];
    for (const range of result) {
      const noOverlap = cut.end <= range.start || cut.start >= range.end;
      if (noOverlap) {
        next.push(range);
        continue;
      }
      if (cut.start > range.start) {
        next.push({ start: range.start, end: Math.min(cut.start, range.end) });
      }
      if (cut.end < range.end) {
        next.push({ start: Math.max(cut.end, range.start), end: range.end });
      }
    }
    result = next;
  }
  return result.filter((r) => r.end > r.start);
}

function computeDayRanges(isoDate: string, rules: AvailabilityRuleData[]): DayRanges {
  const dayOfWeek = dayOfWeekOfIsoDate(isoDate);

  const customHoursRule = rules.find((r) => r.ruleType === 'custom_hours' && r.specificDate === isoDate);
  const weeklyRule = rules.find((r) => r.ruleType === 'weekly' && r.dayOfWeek === dayOfWeek);

  // A custom_hours override REPLACES the weekly-derived range for this day, it does not add to it.
  const baseRange = customHoursRule ?? weeklyRule;
  const baseRanges: MinuteRange[] = baseRange ? [toMinuteRange(baseRange)] : [];

  const blockRules = rules.filter((r) => r.ruleType === 'blocked' && r.specificDate === isoDate);
  const isFullyBlocked = blockRules.some((r) => r.startTime === null || r.endTime === null);
  const blockedRanges = isFullyBlocked ? [] : blockRules.map(toMinuteRange);

  const workingRanges = isFullyBlocked ? [] : subtractRanges(baseRanges, blockedRanges);

  return { workingRanges, blockedRanges, isFullyBlocked };
}

/* -------------------------------------------------------------------------- */
/* listBookableSlots                                                           */
/* -------------------------------------------------------------------------- */

function sliceRangeIntoSlots(range: MinuteRange, durationMinutes: number, bufferMinutes: number): MinuteRange[] {
  const slots: MinuteRange[] = [];
  let cursor = range.start;
  while (cursor + durationMinutes <= range.end) {
    slots.push({ start: cursor, end: cursor + durationMinutes });
    cursor += durationMinutes + bufferMinutes;
  }
  return slots;
}

function overlapsAnyBusyInterval(startUtc: Date, endUtc: Date, busyIntervals: BusyInterval[]): boolean {
  return busyIntervals.some((busy) => startUtc.getTime() < busy.endsAt.getTime() && busy.startsAt.getTime() < endUtc.getTime());
}

export function computeBookableSlots(input: ComputeBookableSlotsInput): BookableSlot[] {
  const { doctorId, fromUtc, toUtc, now, rules, schedulingParams, windowLimits, busyIntervals } = input;
  const { consultationDurationMinutes, bufferMinutes } = schedulingParams;

  const notBeforeUtc = new Date(now.getTime() + windowLimits.minNoticeMinutes * 60_000);
  const notAfterUtc = new Date(now.getTime() + windowLimits.bookingHorizonDays * 24 * 60 * 60_000);

  // Iterate IST calendar dates covering [fromUtc, toUtc), with a one-day
  // safety margin on each side — any slot outside the real bounds is
  // dropped by the final fromUtc/toUtc filter below regardless.
  const startIsoDate = addDaysToIsoDate(utcToIstWallClock(fromUtc).date, -1);
  const endIsoDate = addDaysToIsoDate(utcToIstWallClock(toUtc).date, 1);

  const slots: BookableSlot[] = [];
  let cursorIsoDate = startIsoDate;
  while (cursorIsoDate <= endIsoDate) {
    const { workingRanges } = computeDayRanges(cursorIsoDate, rules);

    for (const range of workingRanges) {
      for (const minuteSlot of sliceRangeIntoSlots(range, consultationDurationMinutes, bufferMinutes)) {
        const startsAt = istWallClockToUtc(cursorIsoDate, minuteSlot.start);
        const endsAt = new Date(startsAt.getTime() + consultationDurationMinutes * 60_000);

        if (startsAt.getTime() < fromUtc.getTime() || startsAt.getTime() >= toUtc.getTime()) continue;
        if (startsAt.getTime() < notBeforeUtc.getTime()) continue;
        if (startsAt.getTime() > notAfterUtc.getTime()) continue;
        if (overlapsAnyBusyInterval(startsAt, endsAt, busyIntervals)) continue;

        slots.push({ doctorId, startsAt, endsAt });
      }
    }

    cursorIsoDate = addDaysToIsoDate(cursorIsoDate, 1);
  }

  slots.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  return slots;
}

/* -------------------------------------------------------------------------- */
/* isSlotBookable                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Evaluates ONE `(startsAtUtc)` instant. Does NOT check `doctor_not_
 * bookable` — that depends on `DoctorFacade.getSchedulingParameters` (I/O),
 * so it's checked by `availability-slot.service.ts` before this function is
 * ever called. Precedence when multiple reasons could apply: too_soon /
 * too_far_ahead (fundamental temporal gates, independent of any rule) ->
 * blocked -> outside_working_hours -> already_taken -> bookable.
 */
export function evaluateSlotBookability(input: EvaluateSlotBookabilityInput): SlotBookability {
  const { startsAtUtc, now, rules, schedulingParams, windowLimits, busyIntervals } = input;
  const { consultationDurationMinutes } = schedulingParams;

  const notBeforeUtc = new Date(now.getTime() + windowLimits.minNoticeMinutes * 60_000);
  const notAfterUtc = new Date(now.getTime() + windowLimits.bookingHorizonDays * 24 * 60 * 60_000);

  if (startsAtUtc.getTime() < notBeforeUtc.getTime()) {
    return { bookable: false, reason: 'too_soon' };
  }
  if (startsAtUtc.getTime() > notAfterUtc.getTime()) {
    return { bookable: false, reason: 'too_far_ahead' };
  }

  const { date: isoDate, minutesOfDay: slotStart } = utcToIstWallClock(startsAtUtc);
  const slotEnd = slotStart + consultationDurationMinutes;
  const { workingRanges, blockedRanges, isFullyBlocked } = computeDayRanges(isoDate, rules);

  if (isFullyBlocked) {
    return { bookable: false, reason: 'blocked' };
  }
  const overlapsBlock = blockedRanges.some((b) => slotStart < b.end && b.start < slotEnd);
  if (overlapsBlock) {
    return { bookable: false, reason: 'blocked' };
  }

  const withinWorkingHours = workingRanges.some((r) => slotStart >= r.start && slotEnd <= r.end);
  if (!withinWorkingHours) {
    return { bookable: false, reason: 'outside_working_hours' };
  }

  const endsAtUtc = new Date(startsAtUtc.getTime() + consultationDurationMinutes * 60_000);
  if (overlapsAnyBusyInterval(startsAtUtc, endsAtUtc, busyIntervals)) {
    return { bookable: false, reason: 'already_taken' };
  }

  return { bookable: true };
}
