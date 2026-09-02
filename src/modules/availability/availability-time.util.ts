/**
 * Fixed-offset IST (Indian Standard Time, UTC+05:30) conversion helpers —
 * pure functions, no I/O, no date library. `doctor_availability.start_time`/
 * `end_time` are stored as timezone-less `time` columns and are meant to be
 * read as IST wall-clock (the platform launches India-only, per
 * `docs/SRS.md`); `specific_date` is likewise an IST calendar date.
 *
 * India does not observe daylight saving time, so a fixed +330-minute offset
 * is exact — there is no DST transition that could make a wall-clock time
 * ambiguous or skipped, which is the only thing that would make plain `Date`
 * arithmetic unsafe here. This is also why no date library (date-fns/luxon/
 * dayjs — none are installed; see `package.json`) is needed: those exist to
 * handle DST/IANA-zone-database complexity this codebase deliberately
 * doesn't have yet.
 *
 * If the platform later needs per-doctor timezones (multi-country expansion),
 * THIS FILE's internals get replaced with a real IANA timezone library
 * (e.g. `luxon`) — its callers (`availability-slot.engine.ts`,
 * `availability-slot.service.ts`) should not need to change, since they only
 * ever go through the functions exported here, never do their own offset
 * arithmetic.
 */

/** UTC+05:30, in minutes. Fixed — India does not observe DST. */
export const IST_OFFSET_MINUTES = 330;

export interface IstWallClock {
  /** IST calendar date, `YYYY-MM-DD`. */
  date: string;
  /** Minutes since IST midnight, `0`-`1439`. */
  minutesOfDay: number;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** Splits a UTC instant into its IST calendar date and minutes-since-midnight. */
export function utcToIstWallClock(utc: Date): IstWallClock {
  const shifted = new Date(utc.getTime() + IST_OFFSET_MINUTES * 60_000);
  const date = `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
  const minutesOfDay = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
  return { date, minutesOfDay };
}

/** Combines an IST calendar date + minutes-since-midnight back into the UTC instant it represents. */
export function istWallClockToUtc(isoDate: string, minutesOfDay: number): Date {
  const [year, month, day] = isoDate.split('-').map(Number) as [number, number, number];
  const midnightUtcOfDate = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  return new Date(midnightUtcOfDate + minutesOfDay * 60_000 - IST_OFFSET_MINUTES * 60_000);
}

/** 0 (Sunday) through 6 (Saturday) for an IST calendar date — matches `doctor_availability.day_of_week`'s own convention. */
export function dayOfWeekOfIsoDate(isoDate: string): number {
  const [year, month, day] = isoDate.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** `isoDate` shifted by `days` (may be negative). Pure calendar-date arithmetic, no timezone involved. */
export function addDaysToIsoDate(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split('-').map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(year, month - 1, day));
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
}

/** `"HH:MM"` or `"HH:MM:SS"` (Postgres `time` columns come back as strings — see `doctor-availability.schema.ts`) to minutes since midnight. Seconds, if present, are truncated — this codebase never needs sub-minute precision for a rule boundary. */
export function parseTimeToMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number) as [number, number];
  return hours * 60 + minutes;
}

/** `isoDateA <= isoDateB` — plain string comparison is correct because `YYYY-MM-DD` sorts lexicographically the same as chronologically. */
export function isoDateLessOrEqual(isoDateA: string, isoDateB: string): boolean {
  return isoDateA <= isoDateB;
}
