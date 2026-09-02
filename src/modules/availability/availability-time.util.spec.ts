import {
  addDaysToIsoDate,
  dayOfWeekOfIsoDate,
  istWallClockToUtc,
  parseTimeToMinutes,
  utcToIstWallClock,
} from './availability-time.util';

describe('availability-time.util', () => {
  describe('utcToIstWallClock', () => {
    it('converts a UTC instant mid-day to the same-day IST wall clock', () => {
      // 03:30 UTC + 05:30 = 09:00 IST, same calendar date.
      expect(utcToIstWallClock(new Date('2026-09-07T03:30:00.000Z'))).toEqual({
        date: '2026-09-07',
        minutesOfDay: 9 * 60,
      });
    });

    it('crosses into the next IST calendar date near UTC midnight', () => {
      // 20:00 UTC on the 6th + 05:30 = 01:30 IST on the 7th.
      expect(utcToIstWallClock(new Date('2026-09-06T20:00:00.000Z'))).toEqual({
        date: '2026-09-07',
        minutesOfDay: 1 * 60 + 30,
      });
    });

    it('does not cross a date boundary at UTC midnight itself (offset < 24h)', () => {
      expect(utcToIstWallClock(new Date('2026-09-07T00:00:00.000Z'))).toEqual({
        date: '2026-09-07',
        minutesOfDay: 5 * 60 + 30,
      });
    });
  });

  describe('istWallClockToUtc', () => {
    it('is the exact inverse of utcToIstWallClock for a same-day case', () => {
      expect(istWallClockToUtc('2026-09-07', 9 * 60)).toEqual(new Date('2026-09-07T03:30:00.000Z'));
    });

    it('rolls back to the previous UTC calendar date when IST wall-clock time is before the 05:30 offset', () => {
      expect(istWallClockToUtc('2026-09-07', 1 * 60 + 30)).toEqual(new Date('2026-09-06T20:00:00.000Z'));
    });

    it('round-trips through utcToIstWallClock for an arbitrary instant', () => {
      const original = new Date('2026-11-23T14:07:00.000Z');
      const wallClock = utcToIstWallClock(original);
      expect(istWallClockToUtc(wallClock.date, wallClock.minutesOfDay)).toEqual(original);
    });
  });

  describe('dayOfWeekOfIsoDate', () => {
    it.each([
      ['2026-09-06', 0], // Sunday
      ['2026-09-07', 1], // Monday
      ['2026-09-08', 2],
      ['2026-09-09', 3],
      ['2026-09-10', 4],
      ['2026-09-11', 5],
      ['2026-09-12', 6], // Saturday
      ['2026-09-13', 0], // Sunday again
    ])('%s is day %i', (isoDate, expected) => {
      expect(dayOfWeekOfIsoDate(isoDate)).toBe(expected);
    });
  });

  describe('addDaysToIsoDate', () => {
    it('adds days within a month', () => {
      expect(addDaysToIsoDate('2026-09-07', 3)).toBe('2026-09-10');
    });

    it('subtracts days across a month boundary', () => {
      expect(addDaysToIsoDate('2026-09-01', -1)).toBe('2026-08-31');
    });

    it('adds days across a year boundary', () => {
      expect(addDaysToIsoDate('2026-12-31', 1)).toBe('2027-01-01');
    });

    it('is a no-op for 0 days', () => {
      expect(addDaysToIsoDate('2026-09-07', 0)).toBe('2026-09-07');
    });
  });

  describe('parseTimeToMinutes', () => {
    it('parses HH:MM', () => {
      expect(parseTimeToMinutes('09:30')).toBe(570);
    });

    it('parses HH:MM:SS, truncating seconds', () => {
      expect(parseTimeToMinutes('09:30:45')).toBe(570);
    });

    it('parses midnight', () => {
      expect(parseTimeToMinutes('00:00')).toBe(0);
    });
  });
});
