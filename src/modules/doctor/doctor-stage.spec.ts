import { DOCTOR_VERIFICATION_STATUSES } from '../../schema/enums.schema';
import {
  DOCTOR_ONBOARDING_STAGES,
  __STAGE_RULES_FOR_TEST,
  deriveDoctorStage,
  isZeroFee,
  type DoctorStageInput,
} from './doctor-stage';

/**
 * The full input space of the stage rule: 5 verification statuses x 2 fee
 * states x 2 listing states = 20 rows. Small enough to enumerate, which is
 * what lets the properties below be proven rather than sampled.
 */
const MATRIX: DoctorStageInput[] = DOCTOR_VERIFICATION_STATUSES.flatMap((verificationStatus) =>
  ['0.00', '1500.00'].flatMap((consultationFeeInr) =>
    [false, true].map((isListed) => ({ verificationStatus, consultationFeeInr, isListed })),
  ),
);

describe('isZeroFee', () => {
  it.each(['0', '0.0', '0.00', ' 0.00 '])('treats %p as zero', (value) => {
    expect(isZeroFee(value)).toBe(true);
  });

  it.each(['0.01', '1500.00', '10.50'])('treats %p as set', (value) => {
    expect(isZeroFee(value)).toBe(false);
  });

  it('does not coerce through Number — a value Number() would round to zero still reads as set', () => {
    // Number('0.000000001') is truthy-but-tiny; the point is that this
    // function never asks Number() anything about a money string.
    expect(isZeroFee('0.000000001')).toBe(false);
  });
});

describe('STAGE_RULES', () => {
  it('assigns exactly one stage to every point in the input space', () => {
    for (const row of MATRIX) {
      const hits = __STAGE_RULES_FOR_TEST.filter(([, rule]) => {
        if (!(rule.statusIn as readonly string[]).includes(row.verificationStatus)) return false;
        if (rule.fee === 'zero' && !isZeroFee(row.consultationFeeInr)) return false;
        if (rule.fee === 'set' && isZeroFee(row.consultationFeeInr)) return false;
        if (rule.isListed !== undefined && rule.isListed !== row.isListed) return false;
        return true;
      });

      // Exhaustive (>= 1) and mutually exclusive (<= 1) in one assertion.
      // Both matter: a gap would fall through to the `blocked` fallback and
      // silently mislabel a doctor, and an overlap would make the ordering
      // of STAGE_RULES load-bearing for correctness rather than readability.
      expect({ row, hits: hits.map(([stage]) => stage) }).toEqual({
        row,
        hits: [expect.any(String)],
      });
    }
  });

  it('covers every declared stage — no stage is unreachable', () => {
    const reached = new Set(MATRIX.map(deriveDoctorStage));
    expect([...reached].sort()).toEqual([...DOCTOR_ONBOARDING_STAGES].sort());
  });
});

describe('deriveDoctorStage', () => {
  it.each([
    ['pending', '0.00', false, 'awaiting_verification'],
    ['under_review', '1500.00', false, 'awaiting_verification'],
    ['verified', '0.00', false, 'needs_fee'],
    ['verified', '1500.00', false, 'ready_to_list'],
    ['verified', '1500.00', true, 'live'],
    ['rejected', '1500.00', false, 'blocked'],
    ['suspended', '1500.00', true, 'blocked'],
  ])('%s / fee %s / listed %p -> %s', (verificationStatus, consultationFeeInr, isListed, expected) => {
    expect(deriveDoctorStage({ verificationStatus, consultationFeeInr, isListed: isListed as boolean })).toBe(expected);
  });

  it('ranks needs_fee above live — a listed doctor on a zero fee is bookable for free, which is the more urgent problem', () => {
    expect(deriveDoctorStage({ verificationStatus: 'verified', consultationFeeInr: '0.00', isListed: true })).toBe(
      'needs_fee',
    );
  });

  it('reports blocked for a rejected doctor regardless of fee or listing, since the backend has already force-unlisted them', () => {
    for (const row of MATRIX.filter((r) => r.verificationStatus === 'rejected')) {
      expect(deriveDoctorStage(row)).toBe('blocked');
    }
  });
});
