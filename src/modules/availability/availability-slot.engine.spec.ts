import { computeBookableSlots, evaluateSlotBookability, type AvailabilityRuleData, type SchedulingParams, type WindowLimits } from './availability-slot.engine';
import { istWallClockToUtc } from './availability-time.util';

/** 2026-09-07 is a Monday (day_of_week = 1) — see availability-time.util.spec.ts. */
const MONDAY = '2026-09-07';
const TUESDAY = '2026-09-08';
const DOCTOR_ID = 'doctor-1';

const NO_NOTICE_WIDE_HORIZON: WindowLimits = { minNoticeMinutes: 0, bookingHorizonDays: 365 };
const DEFAULT_PARAMS: SchedulingParams = { consultationDurationMinutes: 30, bufferMinutes: 10 };

function weekly(dayOfWeek: number, startTime: string, endTime: string): AvailabilityRuleData {
  return { ruleType: 'weekly', dayOfWeek, specificDate: null, startTime, endTime };
}
function customHours(specificDate: string, startTime: string, endTime: string): AvailabilityRuleData {
  return { ruleType: 'custom_hours', dayOfWeek: null, specificDate, startTime, endTime };
}
function fullDayBlock(specificDate: string): AvailabilityRuleData {
  return { ruleType: 'blocked', dayOfWeek: null, specificDate, startTime: null, endTime: null };
}
function partialBlock(specificDate: string, startTime: string, endTime: string): AvailabilityRuleData {
  return { ruleType: 'blocked', dayOfWeek: null, specificDate, startTime, endTime };
}

function ist(date: string, hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return istWallClockToUtc(date, h * 60 + m);
}

/** Widens the day to a comfortable multi-day UTC window so day-boundary edge effects don't interfere with tests that aren't about them. */
function wideWindow(centerIsoDate: string): { fromUtc: Date; toUtc: Date } {
  return { fromUtc: ist(centerIsoDate, '00:00'), toUtc: ist(centerIsoDate, '23:59') };
}

describe('availability-slot.engine', () => {
  describe('computeBookableSlots', () => {
    it('returns an empty result when there are no rules at all', () => {
      const result = computeBookableSlots({
        doctorId: DOCTOR_ID,
        ...wideWindow(MONDAY),
        now: ist(MONDAY, '00:00'),
        rules: [],
        schedulingParams: DEFAULT_PARAMS,
        windowLimits: NO_NOTICE_WIDE_HORIZON,
        busyIntervals: [],
      });
      expect(result).toEqual([]);
    });

    it('expands a weekly rule into slots, straightforwardly', () => {
      // 09:00-10:00, 30-minute consult, 10-minute buffer -> two slots: 09:00-09:30, 09:40-10:10... but 10:10 > 10:00, so only ONE full slot plus a second attempt that doesn't fit.
      // Use a wider window to get exactly two slots: 09:00-11:00.
      const rules = [weekly(1, '09:00', '11:00')];
      const result = computeBookableSlots({
        doctorId: DOCTOR_ID,
        ...wideWindow(MONDAY),
        now: ist(MONDAY, '00:00'),
        rules,
        schedulingParams: DEFAULT_PARAMS,
        windowLimits: NO_NOTICE_WIDE_HORIZON,
        busyIntervals: [],
      });
      expect(result).toEqual([
        { doctorId: DOCTOR_ID, startsAt: ist(MONDAY, '09:00'), endsAt: ist(MONDAY, '09:30') },
        { doctorId: DOCTOR_ID, startsAt: ist(MONDAY, '09:40'), endsAt: ist(MONDAY, '10:10') },
        { doctorId: DOCTOR_ID, startsAt: ist(MONDAY, '10:20'), endsAt: ist(MONDAY, '10:50') },
      ]);
    });

    it('a day with no weekly rule and no override produces no slots', () => {
      const rules = [weekly(2, '09:00', '17:00')]; // Tuesday only
      const result = computeBookableSlots({
        doctorId: DOCTOR_ID,
        ...wideWindow(MONDAY), // Monday
        now: ist(MONDAY, '00:00'),
        rules,
        schedulingParams: DEFAULT_PARAMS,
        windowLimits: NO_NOTICE_WIDE_HORIZON,
        busyIntervals: [],
      });
      expect(result).toEqual([]);
    });

    it('a custom_hours override REPLACES the weekly-derived range for that day, not adds to it', () => {
      const rules = [weekly(1, '09:00', '10:00'), customHours(MONDAY, '14:00', '15:00')];
      const result = computeBookableSlots({
        doctorId: DOCTOR_ID,
        ...wideWindow(MONDAY),
        now: ist(MONDAY, '00:00'),
        rules,
        schedulingParams: DEFAULT_PARAMS,
        windowLimits: NO_NOTICE_WIDE_HORIZON,
        busyIntervals: [],
      });
      // Only the override's 14:00-15:00 window is used — nothing from 09:00-10:00.
      expect(result).toEqual([{ doctorId: DOCTOR_ID, startsAt: ist(MONDAY, '14:00'), endsAt: ist(MONDAY, '14:30') }]);
    });

    it('a full-day block removes every slot for that day', () => {
      const rules = [weekly(1, '09:00', '17:00'), fullDayBlock(MONDAY)];
      const result = computeBookableSlots({
        doctorId: DOCTOR_ID,
        ...wideWindow(MONDAY),
        now: ist(MONDAY, '00:00'),
        rules,
        schedulingParams: DEFAULT_PARAMS,
        windowLimits: NO_NOTICE_WIDE_HORIZON,
        busyIntervals: [],
      });
      expect(result).toEqual([]);
    });

    describe('partial-day block subtraction', () => {
      const baseRules = (block: AvailabilityRuleData) => [weekly(1, '09:00', '12:00'), block];

      it('removes only the overlapping slot when the block falls entirely within the range', () => {
        // 09:00-12:00 working range; block 10:00-10:30 should remove the 10:00 slot but keep 09:00 and 11:00-ish slots.
        const result = computeBookableSlots({
          doctorId: DOCTOR_ID,
          ...wideWindow(MONDAY),
          now: ist(MONDAY, '00:00'),
          rules: baseRules(partialBlock(MONDAY, '10:00', '10:30')),
          schedulingParams: DEFAULT_PARAMS,
          windowLimits: NO_NOTICE_WIDE_HORIZON,
          busyIntervals: [],
        });
        const starts = result.map((s) => s.startsAt.toISOString());
        expect(starts).not.toContain(ist(MONDAY, '10:00').toISOString());
        expect(starts).toContain(ist(MONDAY, '09:00').toISOString());
      });

      it('a block strictly BEFORE the working range removes nothing', () => {
        const result = computeBookableSlots({
          doctorId: DOCTOR_ID,
          ...wideWindow(MONDAY),
          now: ist(MONDAY, '00:00'),
          rules: baseRules(partialBlock(MONDAY, '07:00', '08:00')),
          schedulingParams: DEFAULT_PARAMS,
          windowLimits: NO_NOTICE_WIDE_HORIZON,
          busyIntervals: [],
        });
        expect(result.map((s) => s.startsAt.toISOString())).toContain(ist(MONDAY, '09:00').toISOString());
      });

      it('a block strictly AFTER the working range removes nothing', () => {
        const result = computeBookableSlots({
          doctorId: DOCTOR_ID,
          ...wideWindow(MONDAY),
          now: ist(MONDAY, '00:00'),
          rules: baseRules(partialBlock(MONDAY, '13:00', '14:00')),
          schedulingParams: DEFAULT_PARAMS,
          windowLimits: NO_NOTICE_WIDE_HORIZON,
          busyIntervals: [],
        });
        expect(result.map((s) => s.startsAt.toISOString())).toContain(ist(MONDAY, '09:00').toISOString());
      });

      it('a block STRADDLING the range start truncates only the overlapping portion', () => {
        // Range 09:00-12:00, block 08:00-09:30 -> working range becomes 09:30-12:00.
        const result = computeBookableSlots({
          doctorId: DOCTOR_ID,
          ...wideWindow(MONDAY),
          now: ist(MONDAY, '00:00'),
          rules: baseRules(partialBlock(MONDAY, '08:00', '09:30')),
          schedulingParams: DEFAULT_PARAMS,
          windowLimits: NO_NOTICE_WIDE_HORIZON,
          busyIntervals: [],
        });
        const starts = result.map((s) => s.startsAt.toISOString());
        expect(starts).not.toContain(ist(MONDAY, '09:00').toISOString());
        expect(starts).toContain(ist(MONDAY, '09:30').toISOString());
      });

      it('a block STRADDLING the range end truncates only the overlapping portion', () => {
        // Range 09:00-12:00, block 11:45-13:00 -> working range becomes 09:00-11:45, so the 11:20 slot (ends 11:50) no longer fits.
        const result = computeBookableSlots({
          doctorId: DOCTOR_ID,
          ...wideWindow(MONDAY),
          now: ist(MONDAY, '00:00'),
          rules: baseRules(partialBlock(MONDAY, '11:45', '13:00')),
          schedulingParams: DEFAULT_PARAMS,
          windowLimits: NO_NOTICE_WIDE_HORIZON,
          busyIntervals: [],
        });
        const starts = result.map((s) => s.startsAt.toISOString());
        expect(starts).toContain(ist(MONDAY, '09:00').toISOString());
        expect(starts).not.toContain(ist(MONDAY, '11:20').toISOString());
      });

      it('a block touching the range boundary exactly (end === start) removes nothing (exclusive edge)', () => {
        // Block 07:00-09:00 touches the range start (09:00) exactly but does not overlap it.
        const result = computeBookableSlots({
          doctorId: DOCTOR_ID,
          ...wideWindow(MONDAY),
          now: ist(MONDAY, '00:00'),
          rules: baseRules(partialBlock(MONDAY, '07:00', '09:00')),
          schedulingParams: DEFAULT_PARAMS,
          windowLimits: NO_NOTICE_WIDE_HORIZON,
          busyIntervals: [],
        });
        expect(result.map((s) => s.startsAt.toISOString())).toContain(ist(MONDAY, '09:00').toISOString());
      });

      it('a block that SPLITS the range in two produces slots on both sides', () => {
        // Range 09:00-12:00, block 10:00-11:00 splits it into 09:00-10:00 and 11:00-12:00.
        const result = computeBookableSlots({
          doctorId: DOCTOR_ID,
          ...wideWindow(MONDAY),
          now: ist(MONDAY, '00:00'),
          rules: baseRules(partialBlock(MONDAY, '10:00', '11:00')),
          schedulingParams: DEFAULT_PARAMS,
          windowLimits: NO_NOTICE_WIDE_HORIZON,
          busyIntervals: [],
        });
        const starts = result.map((s) => s.startsAt.toISOString());
        expect(starts).toContain(ist(MONDAY, '09:00').toISOString());
        expect(starts).toContain(ist(MONDAY, '11:00').toISOString());
        expect(starts).not.toContain(ist(MONDAY, '10:00').toISOString());
      });
    });

    describe('buffer and trailing-partial-window slicing', () => {
      it('gaps consecutive slots by the buffer, which is not counted as part of a slot duration', () => {
        const rules = [weekly(1, '09:00', '10:10')]; // exactly two 30-min slots with a 10-min buffer: 09:00-09:30, 09:40-10:10
        const result = computeBookableSlots({
          doctorId: DOCTOR_ID,
          ...wideWindow(MONDAY),
          now: ist(MONDAY, '00:00'),
          rules,
          schedulingParams: DEFAULT_PARAMS,
          windowLimits: NO_NOTICE_WIDE_HORIZON,
          busyIntervals: [],
        });
        expect(result).toEqual([
          { doctorId: DOCTOR_ID, startsAt: ist(MONDAY, '09:00'), endsAt: ist(MONDAY, '09:30') },
          { doctorId: DOCTOR_ID, startsAt: ist(MONDAY, '09:40'), endsAt: ist(MONDAY, '10:10') },
        ]);
      });

      it('a trailing window shorter than one consultation duration produces no extra slot (no truncated slots)', () => {
        const rules = [weekly(1, '09:00', '10:09')]; // one 09:00-09:30 slot fits; the leftover 09:40-10:09 (29 min) is < 30-min duration, so no second slot
        const result = computeBookableSlots({
          doctorId: DOCTOR_ID,
          ...wideWindow(MONDAY),
          now: ist(MONDAY, '00:00'),
          rules,
          schedulingParams: DEFAULT_PARAMS,
          windowLimits: NO_NOTICE_WIDE_HORIZON,
          busyIntervals: [],
        });
        expect(result).toEqual([{ doctorId: DOCTOR_ID, startsAt: ist(MONDAY, '09:00'), endsAt: ist(MONDAY, '09:30') }]);
      });

      it('a window exactly one consultation duration long (no room for a buffer) still yields exactly one slot', () => {
        const rules = [weekly(1, '09:00', '09:30')];
        const result = computeBookableSlots({
          doctorId: DOCTOR_ID,
          ...wideWindow(MONDAY),
          now: ist(MONDAY, '00:00'),
          rules,
          schedulingParams: DEFAULT_PARAMS,
          windowLimits: NO_NOTICE_WIDE_HORIZON,
          busyIntervals: [],
        });
        expect(result).toEqual([{ doctorId: DOCTOR_ID, startsAt: ist(MONDAY, '09:00'), endsAt: ist(MONDAY, '09:30') }]);
      });
    });

    it('min-notice trims slots that start too soon', () => {
      const rules = [weekly(1, '09:00', '12:00')];
      const result = computeBookableSlots({
        doctorId: DOCTOR_ID,
        ...wideWindow(MONDAY),
        now: ist(MONDAY, '09:15'), // 09:00 slot is already in the past relative to "now" wall-clock-wise once notice is applied
        rules,
        schedulingParams: DEFAULT_PARAMS,
        windowLimits: { minNoticeMinutes: 60, bookingHorizonDays: 365 }, // must start at/after 10:15
        busyIntervals: [],
      });
      const starts = result.map((s) => s.startsAt.toISOString());
      expect(starts).not.toContain(ist(MONDAY, '09:00').toISOString());
      expect(starts).not.toContain(ist(MONDAY, '09:40').toISOString());
      expect(starts).toContain(ist(MONDAY, '10:20').toISOString());
    });

    it('booking horizon trims slots beyond the window', () => {
      const rules = [weekly(1, '09:00', '12:00'), weekly(2, '09:00', '12:00')];
      const result = computeBookableSlots({
        doctorId: DOCTOR_ID,
        fromUtc: ist(MONDAY, '00:00'),
        toUtc: ist(TUESDAY, '23:59'),
        now: ist(MONDAY, '00:00'),
        rules,
        schedulingParams: DEFAULT_PARAMS,
        windowLimits: { minNoticeMinutes: 0, bookingHorizonDays: 1 }, // horizon ends 24h after "now", i.e. Tuesday 00:00 IST
        busyIntervals: [],
      });
      const starts = result.map((s) => s.startsAt.toISOString());
      expect(starts).toContain(ist(MONDAY, '09:00').toISOString());
      expect(starts).not.toContain(ist(TUESDAY, '09:00').toISOString());
    });

    it('a busy interval exactly matching a candidate slot removes it', () => {
      const rules = [weekly(1, '09:00', '10:00')];
      const result = computeBookableSlots({
        doctorId: DOCTOR_ID,
        ...wideWindow(MONDAY),
        now: ist(MONDAY, '00:00'),
        rules,
        schedulingParams: DEFAULT_PARAMS,
        windowLimits: NO_NOTICE_WIDE_HORIZON,
        busyIntervals: [{ startsAt: ist(MONDAY, '09:00'), endsAt: ist(MONDAY, '09:30') }],
      });
      expect(result).toEqual([]);
    });

    it('a busy interval partially overlapping a candidate slot removes it (any overlap, not just exact match)', () => {
      const rules = [weekly(1, '09:00', '10:00')];
      const result = computeBookableSlots({
        doctorId: DOCTOR_ID,
        ...wideWindow(MONDAY),
        now: ist(MONDAY, '00:00'),
        rules,
        schedulingParams: DEFAULT_PARAMS,
        windowLimits: NO_NOTICE_WIDE_HORIZON,
        // Busy 09:15-09:20 is fully inside the 09:00-09:30 candidate slot — partial overlap, still removes it.
        busyIntervals: [{ startsAt: ist(MONDAY, '09:15'), endsAt: ist(MONDAY, '09:20') }],
      });
      expect(result).toEqual([]);
    });

    it('a busy interval that does not overlap any candidate slot removes nothing', () => {
      const rules = [weekly(1, '09:00', '10:00')];
      const result = computeBookableSlots({
        doctorId: DOCTOR_ID,
        ...wideWindow(MONDAY),
        now: ist(MONDAY, '00:00'),
        rules,
        schedulingParams: DEFAULT_PARAMS,
        windowLimits: NO_NOTICE_WIDE_HORIZON,
        busyIntervals: [{ startsAt: ist(MONDAY, '20:00'), endsAt: ist(MONDAY, '20:30') }],
      });
      expect(result.length).toBeGreaterThan(0);
    });

    it('combines multiple days correctly (Monday + Tuesday, different weekly hours)', () => {
      const rules = [weekly(1, '09:00', '09:30'), weekly(2, '14:00', '14:30')];
      const result = computeBookableSlots({
        doctorId: DOCTOR_ID,
        fromUtc: ist(MONDAY, '00:00'),
        toUtc: ist(TUESDAY, '23:59'),
        now: ist(MONDAY, '00:00'),
        rules,
        schedulingParams: DEFAULT_PARAMS,
        windowLimits: NO_NOTICE_WIDE_HORIZON,
        busyIntervals: [],
      });
      expect(result).toEqual([
        { doctorId: DOCTOR_ID, startsAt: ist(MONDAY, '09:00'), endsAt: ist(MONDAY, '09:30') },
        { doctorId: DOCTOR_ID, startsAt: ist(TUESDAY, '14:00'), endsAt: ist(TUESDAY, '14:30') },
      ]);
    });

    it('results carry the doctorId passed in (multi-doctor composition happens at the service layer, one call per doctor)', () => {
      const rules = [weekly(1, '09:00', '09:30')];
      const result = computeBookableSlots({
        doctorId: 'doctor-xyz',
        ...wideWindow(MONDAY),
        now: ist(MONDAY, '00:00'),
        rules,
        schedulingParams: DEFAULT_PARAMS,
        windowLimits: NO_NOTICE_WIDE_HORIZON,
        busyIntervals: [],
      });
      expect(result.every((s) => s.doctorId === 'doctor-xyz')).toBe(true);
    });

    it('a custom_hours override on a day with NO weekly rule at all still produces slots (override does not depend on a base weekly rule existing)', () => {
      // No weekly rule for Monday whatsoever — only a one-off override.
      const rules = [customHours(MONDAY, '14:00', '15:00')];
      const result = computeBookableSlots({
        doctorId: DOCTOR_ID,
        ...wideWindow(MONDAY),
        now: ist(MONDAY, '00:00'),
        rules,
        schedulingParams: DEFAULT_PARAMS,
        windowLimits: NO_NOTICE_WIDE_HORIZON,
        busyIntervals: [],
      });
      expect(result).toEqual([{ doctorId: DOCTOR_ID, startsAt: ist(MONDAY, '14:00'), endsAt: ist(MONDAY, '14:30') }]);
    });

    it('a blocked rule for a date with NO weekly rule for that weekday is a no-op, not an error (nothing to block, nothing produced either way)', () => {
      const rules = [fullDayBlock(MONDAY)]; // no weekly(1, ...) at all
      const result = computeBookableSlots({
        doctorId: DOCTOR_ID,
        ...wideWindow(MONDAY),
        now: ist(MONDAY, '00:00'),
        rules,
        schedulingParams: DEFAULT_PARAMS,
        windowLimits: NO_NOTICE_WIDE_HORIZON,
        busyIntervals: [],
      });
      expect(result).toEqual([]);
    });

    it('a duration longer than the entire working window produces zero slots cleanly (no hang, no error)', () => {
      const rules = [weekly(1, '09:00', '09:20')]; // 20-minute window, 30-minute consult duration doesn't fit even once
      const result = computeBookableSlots({
        doctorId: DOCTOR_ID,
        ...wideWindow(MONDAY),
        now: ist(MONDAY, '00:00'),
        rules,
        schedulingParams: DEFAULT_PARAMS, // 30-min duration
        windowLimits: NO_NOTICE_WIDE_HORIZON,
        busyIntervals: [],
      });
      expect(result).toEqual([]);
    });

    it('correctly attributes slots to IST calendar days across a UTC-midnight boundary — an early-morning IST slot (whose UTC instant falls on the PREVIOUS UTC calendar date) is still attributed to the right IST weekday', () => {
      // Tuesday 00:00-01:00 IST = Monday 18:30-19:30 UTC (IST is UTC+05:30, so early-IST-morning hours land on the
      // previous UTC calendar date). Querying a UTC range that straddles this boundary must still produce the
      // Tuesday-IST slot, proving day iteration keys off IST calendar dates, not UTC ones.
      const rules = [weekly(2, '00:00', '01:00')]; // Tuesday
      const result = computeBookableSlots({
        doctorId: DOCTOR_ID,
        fromUtc: ist(MONDAY, '23:30'),
        toUtc: ist(TUESDAY, '02:00'),
        now: ist(MONDAY, '00:00'),
        rules,
        schedulingParams: DEFAULT_PARAMS,
        windowLimits: NO_NOTICE_WIDE_HORIZON,
        busyIntervals: [],
      });
      expect(result).toEqual([{ doctorId: DOCTOR_ID, startsAt: ist(TUESDAY, '00:00'), endsAt: ist(TUESDAY, '00:30') }]);
      // Sanity check that this genuinely exercises the UTC-day boundary: the slot's UTC calendar date is the day
      // BEFORE its IST calendar date (Sept 7 UTC vs. Sept 8 IST).
      expect(result[0]!.startsAt.getUTCDate()).toBe(7);
    });

    it('excludes candidates outside the requested [fromUtc, toUtc) range even if the day iteration margin computes them', () => {
      const rules = [weekly(1, '09:00', '09:30')];
      const result = computeBookableSlots({
        doctorId: DOCTOR_ID,
        fromUtc: ist(MONDAY, '09:15'), // after the 09:00 slot start
        toUtc: ist(MONDAY, '23:59'),
        now: ist(MONDAY, '00:00'),
        rules,
        schedulingParams: DEFAULT_PARAMS,
        windowLimits: NO_NOTICE_WIDE_HORIZON,
        busyIntervals: [],
      });
      expect(result).toEqual([]);
    });
  });

  describe('evaluateSlotBookability', () => {
    it('is bookable when nothing prevents it', () => {
      const rules = [weekly(1, '09:00', '10:00')];
      const result = evaluateSlotBookability({
        startsAtUtc: ist(MONDAY, '09:00'),
        now: ist(MONDAY, '00:00'),
        rules,
        schedulingParams: DEFAULT_PARAMS,
        windowLimits: NO_NOTICE_WIDE_HORIZON,
        busyIntervals: [],
      });
      expect(result).toEqual({ bookable: true });
    });

    it('reports too_soon when the slot starts before now + minNoticeMinutes', () => {
      const rules = [weekly(1, '09:00', '12:00')];
      const result = evaluateSlotBookability({
        startsAtUtc: ist(MONDAY, '09:00'),
        now: ist(MONDAY, '08:30'),
        rules,
        schedulingParams: DEFAULT_PARAMS,
        windowLimits: { minNoticeMinutes: 60, bookingHorizonDays: 365 },
        busyIntervals: [],
      });
      expect(result).toEqual({ bookable: false, reason: 'too_soon' });
    });

    it('reports too_far_ahead when the slot starts after now + bookingHorizonDays', () => {
      const rules = [weekly(1, '09:00', '12:00'), weekly(2, '09:00', '12:00')];
      const result = evaluateSlotBookability({
        startsAtUtc: ist(TUESDAY, '09:00'),
        now: ist(MONDAY, '00:00'),
        rules,
        schedulingParams: DEFAULT_PARAMS,
        windowLimits: { minNoticeMinutes: 0, bookingHorizonDays: 1 },
        busyIntervals: [],
      });
      expect(result).toEqual({ bookable: false, reason: 'too_far_ahead' });
    });

    it('reports blocked for a full-day block', () => {
      const rules = [weekly(1, '09:00', '12:00'), fullDayBlock(MONDAY)];
      const result = evaluateSlotBookability({
        startsAtUtc: ist(MONDAY, '09:00'),
        now: ist(MONDAY, '00:00'),
        rules,
        schedulingParams: DEFAULT_PARAMS,
        windowLimits: NO_NOTICE_WIDE_HORIZON,
        busyIntervals: [],
      });
      expect(result).toEqual({ bookable: false, reason: 'blocked' });
    });

    it('reports blocked for a partial-day block overlapping the slot', () => {
      const rules = [weekly(1, '09:00', '12:00'), partialBlock(MONDAY, '09:00', '09:30')];
      const result = evaluateSlotBookability({
        startsAtUtc: ist(MONDAY, '09:00'),
        now: ist(MONDAY, '00:00'),
        rules,
        schedulingParams: DEFAULT_PARAMS,
        windowLimits: NO_NOTICE_WIDE_HORIZON,
        busyIntervals: [],
      });
      expect(result).toEqual({ bookable: false, reason: 'blocked' });
    });

    it('reports outside_working_hours when there is no rule covering that time at all', () => {
      const result = evaluateSlotBookability({
        startsAtUtc: ist(MONDAY, '09:00'),
        now: ist(MONDAY, '00:00'),
        rules: [],
        schedulingParams: DEFAULT_PARAMS,
        windowLimits: NO_NOTICE_WIDE_HORIZON,
        busyIntervals: [],
      });
      expect(result).toEqual({ bookable: false, reason: 'outside_working_hours' });
    });

    it('reports outside_working_hours when the slot would run past the end of the working range', () => {
      const rules = [weekly(1, '09:00', '09:20')]; // a 30-min slot starting at 09:00 would end at 09:30, past 09:20
      const result = evaluateSlotBookability({
        startsAtUtc: ist(MONDAY, '09:00'),
        now: ist(MONDAY, '00:00'),
        rules,
        schedulingParams: DEFAULT_PARAMS,
        windowLimits: NO_NOTICE_WIDE_HORIZON,
        busyIntervals: [],
      });
      expect(result).toEqual({ bookable: false, reason: 'outside_working_hours' });
    });

    it('reports already_taken when a busy interval overlaps the slot', () => {
      const rules = [weekly(1, '09:00', '10:00')];
      const result = evaluateSlotBookability({
        startsAtUtc: ist(MONDAY, '09:00'),
        now: ist(MONDAY, '00:00'),
        rules,
        schedulingParams: DEFAULT_PARAMS,
        windowLimits: NO_NOTICE_WIDE_HORIZON,
        busyIntervals: [{ startsAt: ist(MONDAY, '09:10'), endsAt: ist(MONDAY, '09:20') }],
      });
      expect(result).toEqual({ bookable: false, reason: 'already_taken' });
    });

    it('a custom_hours override on the day makes an out-of-weekly-range slot bookable', () => {
      const rules = [weekly(1, '09:00', '10:00'), customHours(MONDAY, '14:00', '15:00')];
      const result = evaluateSlotBookability({
        startsAtUtc: ist(MONDAY, '14:00'),
        now: ist(MONDAY, '00:00'),
        rules,
        schedulingParams: DEFAULT_PARAMS,
        windowLimits: NO_NOTICE_WIDE_HORIZON,
        busyIntervals: [],
      });
      expect(result).toEqual({ bookable: true });
    });

    it('a custom_hours override on the day makes an in-weekly-range slot NOT bookable (override replaces, not adds)', () => {
      const rules = [weekly(1, '09:00', '10:00'), customHours(MONDAY, '14:00', '15:00')];
      const result = evaluateSlotBookability({
        startsAtUtc: ist(MONDAY, '09:00'),
        now: ist(MONDAY, '00:00'),
        rules,
        schedulingParams: DEFAULT_PARAMS,
        windowLimits: NO_NOTICE_WIDE_HORIZON,
        busyIntervals: [],
      });
      expect(result).toEqual({ bookable: false, reason: 'outside_working_hours' });
    });
  });
});
