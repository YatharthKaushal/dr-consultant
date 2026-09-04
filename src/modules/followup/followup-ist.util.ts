/**
 * Fixed-offset IST (UTC+05:30) calendar-date helpers — pure functions, no I/O,
 * no date library.
 *
 * *** DELIBERATELY DUPLICATED, NOT IMPORTED, FROM `availability/availability-
 * time.util.ts`. *** That file is an internal implementation detail of M-07,
 * never re-exported through `availability.contract.ts`/`availability.facade
 * .ts`, so importing it would be the deep import `backend/README.md` §2
 * forbids ("no deep imports" — a module's only public surface is its
 * facade). `booking.contract.ts` redeclares M-07's `BusyInterval` rather than
 * importing it for the identical reason; this is the same restraint applied
 * to a handful of date functions instead of an interface.
 *
 * Same physics as the original: India launches with one timezone and no DST,
 * so a fixed +330-minute offset is exact and no date library is warranted.
 * `checkin_responses.checkin_date` / `followup_assignments.starts_on` are IST
 * wall-clock calendar dates for the same reason `doctor_availability`'s are.
 */

const IST_OFFSET_MINUTES = 330;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** The IST calendar date (`YYYY-MM-DD`) a UTC instant falls on. */
export function utcToIstDate(utc: Date): string {
  const shifted = new Date(utc.getTime() + IST_OFFSET_MINUTES * 60_000);
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
}

/** Today's IST calendar date. The one place this module reads the wall clock for "today" — every other date is a parameter, so tests stay deterministic. */
export function todayIstDate(now: Date = new Date()): string {
  return utcToIstDate(now);
}

/** `isoDate` shifted by `days` (may be negative). Pure calendar arithmetic — no timezone involved once the string is parsed. */
export function addDaysToIsoDate(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split('-').map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(year, month - 1, day));
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
}

/** `isoDateA <= isoDateB` — plain string comparison is correct for `YYYY-MM-DD`, which sorts lexicographically the same as chronologically. */
export function isoDateLessOrEqual(isoDateA: string, isoDateB: string): boolean {
  return isoDateA <= isoDateB;
}

/** `isoDateA < isoDateB`. */
export function isoDateLessThan(isoDateA: string, isoDateB: string): boolean {
  return isoDateA < isoDateB;
}
