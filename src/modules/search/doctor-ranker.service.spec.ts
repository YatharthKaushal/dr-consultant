import type { ListedDoctorSummary } from '../doctor/doctor.contract';
import { DoctorRankerService, buildMatchReason, rankDoctors, type RankDoctorsInput, type SpecialtyMatch } from './doctor-ranker.service';

const NOW = new Date('2026-09-07T00:00:00Z');
const LOOKAHEAD_DAYS = 14;

const PSYCHIATRY = { id: 'sp-psych', code: 'psychiatry', name: 'Psychiatry' };
const PSYCHOLOGY = { id: 'sp-psy', code: 'psychology', name: 'Psychology' };

function doctor(overrides: Partial<ListedDoctorSummary> & { id: string }): ListedDoctorSummary {
  return {
    fullName: `Dr ${overrides.id}`,
    languages: ['English'],
    qualification: 'MD',
    registrationNumber: 'REG-1',
    yearsOfExperience: 10,
    consultationFeeInr: '1000.00',
    consultationDurationMinutes: 30,
    specialties: [{ ...PSYCHIATRY, isPrimary: true }],
    ...overrides,
  };
}

function specialtyMatch(overrides: Partial<SpecialtyMatch> = {}): SpecialtyMatch {
  return {
    specialtyId: PSYCHIATRY.id,
    specialtyCode: PSYCHIATRY.code,
    specialtyName: PSYCHIATRY.name,
    score: 5,
    concernIds: ['c-sleep'],
    concernNames: ['Sleep problems'],
    ...overrides,
  };
}

function input(overrides: Partial<RankDoctorsInput> & { candidates: ListedDoctorSummary[] }): RankDoctorsInput {
  return {
    specialtyMatches: [specialtyMatch()],
    earliestSlotByDoctorId: new Map(),
    filters: {},
    now: NOW,
    lookaheadDays: LOOKAHEAD_DAYS,
    ...overrides,
  };
}

/** `now + hours`, for the availability signal. */
function inHours(hours: number): Date {
  return new Date(NOW.getTime() + hours * 60 * 60 * 1000);
}

describe('rankDoctors — signals in isolation', () => {
  describe('specialty fit', () => {
    it('ranks a PRIMARY specialty match above a SECONDARY one', () => {
      const primary = doctor({ id: 'a', specialties: [{ ...PSYCHIATRY, isPrimary: true }] });
      const secondary = doctor({
        id: 'b',
        specialties: [
          { ...PSYCHOLOGY, isPrimary: true },
          { ...PSYCHIATRY, isPrimary: false },
        ],
      });

      const ranked = rankDoctors(input({ candidates: [secondary, primary] }));
      expect(ranked.map((r) => r.doctor.id)).toEqual(['a', 'b']);
      expect(ranked[0]?.signals.specialtyFit).toBe(1);
      expect(ranked[1]?.signals.specialtyFit).toBe(0.6);
    });

    it('picks the PRIMARY match when a doctor matches on both of their specialties', () => {
      const both = doctor({
        id: 'a',
        specialties: [
          { ...PSYCHIATRY, isPrimary: true },
          { ...PSYCHOLOGY, isPrimary: false },
        ],
      });
      const ranked = rankDoctors(
        input({
          candidates: [both],
          specialtyMatches: [specialtyMatch(), specialtyMatch({ specialtyId: PSYCHOLOGY.id, specialtyCode: PSYCHOLOGY.code, specialtyName: PSYCHOLOGY.name, score: 9 })],
        }),
      );
      expect(ranked[0]?.signals.specialtyFit).toBe(1);
      expect(ranked[0]?.matchedSpecialty?.code).toBe('psychiatry');
    });

    it('is NEUTRAL for every candidate on a plain browse (no specialty matches)', () => {
      const ranked = rankDoctors(input({ candidates: [doctor({ id: 'a' }), doctor({ id: 'b' })], specialtyMatches: [] }));
      expect(ranked.every((r) => r.signals.specialtyFit === 1 && r.signals.concernFit === 1)).toBe(true);
      expect(ranked.every((r) => r.matchedSpecialty === null)).toBe(true);
    });
  });

  describe('concern weight', () => {
    it('ranks a doctor of the strongest-matching specialty first', () => {
      const psychiatrist = doctor({ id: 'a', specialties: [{ ...PSYCHIATRY, isPrimary: true }] });
      const psychologist = doctor({ id: 'b', specialties: [{ ...PSYCHOLOGY, isPrimary: true }] });

      const ranked = rankDoctors(
        input({
          candidates: [psychologist, psychiatrist],
          specialtyMatches: [
            specialtyMatch({ score: 10 }),
            specialtyMatch({ specialtyId: PSYCHOLOGY.id, specialtyCode: PSYCHOLOGY.code, specialtyName: PSYCHOLOGY.name, score: 2 }),
          ],
        }),
      );
      expect(ranked.map((r) => r.doctor.id)).toEqual(['a', 'b']);
      expect(ranked[0]?.signals.concernFit).toBe(1);
      expect(ranked[1]?.signals.concernFit).toBeCloseTo(0.2);
    });
  });

  describe('availability proximity', () => {
    it('ranks a sooner slot above a later one, all else equal', () => {
      const soon = doctor({ id: 'a' });
      const later = doctor({ id: 'b' });
      const ranked = rankDoctors(
        input({
          candidates: [later, soon],
          earliestSlotByDoctorId: new Map([
            ['a', inHours(2)],
            ['b', inHours(24 * 10)],
          ]),
        }),
      );
      expect(ranked.map((r) => r.doctor.id)).toEqual(['a', 'b']);
      expect(ranked[0]!.signals.availability).toBeGreaterThan(ranked[1]!.signals.availability);
    });

    it('scores 0 — but does NOT exclude — a doctor with no bookable slot', () => {
      const ranked = rankDoctors(input({ candidates: [doctor({ id: 'a' })], earliestSlotByDoctorId: new Map([['a', null]]) }));
      expect(ranked).toHaveLength(1);
      expect(ranked[0]?.signals.availability).toBe(0);
    });

    it('clamps a slot beyond the lookahead horizon to 0 rather than going negative', () => {
      const ranked = rankDoctors(
        input({ candidates: [doctor({ id: 'a' })], earliestSlotByDoctorId: new Map([['a', inHours(24 * 60)]]) }),
      );
      expect(ranked[0]?.signals.availability).toBe(0);
    });
  });

  describe('language', () => {
    it('is NEUTRAL for everyone when no language was requested', () => {
      const ranked = rankDoctors(input({ candidates: [doctor({ id: 'a', languages: [] }), doctor({ id: 'b', languages: ['Hindi'] })] }));
      expect(ranked.every((r) => r.signals.language === 1)).toBe(true);
    });

    it('matches case-insensitively and ignores surrounding whitespace', () => {
      const ranked = rankDoctors(
        input({ candidates: [doctor({ id: 'a', languages: [' HiNdI '] })], filters: { languages: ['hindi'] } }),
      );
      expect(ranked).toHaveLength(1);
      expect(ranked[0]?.signals.language).toBe(1);
    });
  });

  describe('fee', () => {
    it('ranks the cheapest of the candidate set highest', () => {
      const cheap = doctor({ id: 'a', consultationFeeInr: '500.00' });
      const dear = doctor({ id: 'b', consultationFeeInr: '2500.00' });
      const ranked = rankDoctors(input({ candidates: [dear, cheap] }));
      expect(ranked.map((r) => r.doctor.id)).toEqual(['a', 'b']);
      expect(ranked[0]?.signals.fee).toBe(1);
      expect(ranked[1]?.signals.fee).toBe(0);
    });

    it('is neutral when every candidate charges the same', () => {
      const ranked = rankDoctors(input({ candidates: [doctor({ id: 'a' }), doctor({ id: 'b' })] }));
      expect(ranked.every((r) => r.signals.fee === 1)).toBe(true);
    });

    it('is scored relative to the SURVIVING candidates, after filtering', () => {
      const ranked = rankDoctors(
        input({
          candidates: [
            doctor({ id: 'a', consultationFeeInr: '500.00' }),
            doctor({ id: 'b', consultationFeeInr: '900.00' }),
            doctor({ id: 'c', consultationFeeInr: '9000.00' }),
          ],
          filters: { maxFeeInr: '1000.00' },
        }),
      );
      // The 9000 doctor is filtered out and must not stretch the fee scale.
      expect(ranked.map((r) => r.doctor.id)).toEqual(['a', 'b']);
      expect(ranked[1]?.signals.fee).toBe(0);
    });
  });
});

describe('rankDoctors — hard filters (FR-4.4)', () => {
  it('excludes a doctor who speaks none of the requested languages', () => {
    const ranked = rankDoctors(
      input({
        candidates: [doctor({ id: 'a', languages: ['English'] }), doctor({ id: 'b', languages: ['Hindi', 'English'] })],
        filters: { languages: ['Hindi'] },
      }),
    );
    expect(ranked.map((r) => r.doctor.id)).toEqual(['b']);
  });

  it('excludes a doctor above maxFeeInr', () => {
    const ranked = rankDoctors(
      input({
        candidates: [doctor({ id: 'a', consultationFeeInr: '1500.00' }), doctor({ id: 'b', consultationFeeInr: '800.00' })],
        filters: { maxFeeInr: '1000' },
      }),
    );
    expect(ranked.map((r) => r.doctor.id)).toEqual(['b']);
  });

  it('includes a doctor whose fee EQUALS maxFeeInr (inclusive ceiling)', () => {
    const ranked = rankDoctors(
      input({ candidates: [doctor({ id: 'a', consultationFeeInr: '1000.00' })], filters: { maxFeeInr: '1000' } }),
    );
    expect(ranked).toHaveLength(1);
  });

  it('excludes a doctor with no slot inside availableWithinDays', () => {
    const ranked = rankDoctors(
      input({
        candidates: [doctor({ id: 'a' }), doctor({ id: 'b' }), doctor({ id: 'c' })],
        earliestSlotByDoctorId: new Map([
          ['a', inHours(12)],
          ['b', inHours(24 * 9)],
          ['c', null],
        ]),
        filters: { availableWithinDays: 3 },
      }),
    );
    expect(ranked.map((r) => r.doctor.id)).toEqual(['a']);
  });

  it('applies language, fee and availability filters together', () => {
    const keep = doctor({ id: 'keep', languages: ['Hindi'], consultationFeeInr: '700.00' });
    const wrongLanguage = doctor({ id: 'lang', languages: ['Tamil'], consultationFeeInr: '700.00' });
    const tooDear = doctor({ id: 'fee', languages: ['Hindi'], consultationFeeInr: '5000.00' });
    const tooLate = doctor({ id: 'late', languages: ['Hindi'], consultationFeeInr: '700.00' });

    const ranked = rankDoctors(
      input({
        candidates: [keep, wrongLanguage, tooDear, tooLate],
        earliestSlotByDoctorId: new Map([
          ['keep', inHours(6)],
          ['lang', inHours(6)],
          ['fee', inHours(6)],
          ['late', inHours(24 * 12)],
        ]),
        filters: { languages: ['Hindi'], maxFeeInr: '1000', availableWithinDays: 5 },
      }),
    );
    expect(ranked.map((r) => r.doctor.id)).toEqual(['keep']);
  });

  it('returns an empty list (not an error) when every candidate is filtered out', () => {
    expect(rankDoctors(input({ candidates: [doctor({ id: 'a' })], filters: { maxFeeInr: '1' } }))).toEqual([]);
  });
});

describe('rankDoctors — combined behaviour and stability', () => {
  it('combines every signal into one weighted score bounded by 0..1', () => {
    const ranked = rankDoctors(
      input({
        candidates: [doctor({ id: 'a', languages: ['Hindi'], consultationFeeInr: '500.00' })],
        earliestSlotByDoctorId: new Map([['a', inHours(1)]]),
        filters: { languages: ['Hindi'] },
      }),
    );
    expect(ranked[0]!.score).toBeGreaterThan(0);
    expect(ranked[0]!.score).toBeLessThanOrEqual(1);
  });

  it('TIE-BREAKS by doctor id, so identical requests never shuffle', () => {
    const forward = rankDoctors(input({ candidates: [doctor({ id: 'zzz' }), doctor({ id: 'aaa' }), doctor({ id: 'mmm' })] }));
    const reversed = rankDoctors(input({ candidates: [doctor({ id: 'mmm' }), doctor({ id: 'aaa' }), doctor({ id: 'zzz' })] }));
    expect(forward.map((r) => r.doctor.id)).toEqual(['aaa', 'mmm', 'zzz']);
    expect(reversed.map((r) => r.doctor.id)).toEqual(forward.map((r) => r.doctor.id));
  });

  it('honours a limit after ordering', () => {
    const ranked = rankDoctors(
      input({ candidates: [doctor({ id: 'a' }), doctor({ id: 'b' }), doctor({ id: 'c' })], limit: 2 }),
    );
    expect(ranked.map((r) => r.doctor.id)).toEqual(['a', 'b']);
  });

  it('carries the matched concern ids and names through for FR-5.4', () => {
    const ranked = rankDoctors(
      input({
        candidates: [doctor({ id: 'a' })],
        specialtyMatches: [specialtyMatch({ concernIds: ['c1', 'c2'], concernNames: ['Sleep problems', 'Anxiety and stress'] })],
      }),
    );
    expect(ranked[0]?.matchedConcernIds).toEqual(['c1', 'c2']);
    expect(ranked[0]?.reason).toBe('Matched to: Sleep problems, Anxiety and stress');
  });

  it('tolerates an unparsable fee rather than producing NaN scores', () => {
    const ranked = rankDoctors(input({ candidates: [doctor({ id: 'a', consultationFeeInr: 'not-a-number' })] }));
    expect(Number.isNaN(ranked[0]!.score)).toBe(false);
  });
});

describe('buildMatchReason', () => {
  it('names the matched concerns when there are any', () => {
    expect(buildMatchReason(['Sleep problems', 'Anxiety and stress'], 'Psychiatry')).toBe(
      'Matched to: Sleep problems, Anxiety and stress',
    );
  });

  it('falls back to the specialty, then to a neutral line — never to invented text', () => {
    expect(buildMatchReason([], 'Psychiatry')).toBe('Practises Psychiatry');
    expect(buildMatchReason([], null)).toBe('Available for consultation');
  });
});

describe('DoctorRankerService', () => {
  it('delegates to the pure function', () => {
    const ranked = new DoctorRankerService().rank(input({ candidates: [doctor({ id: 'a' })] }));
    expect(ranked.map((r) => r.doctor.id)).toEqual(['a']);
  });
});
