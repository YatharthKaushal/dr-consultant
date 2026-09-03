import {
  DEFAULT_CANCELLATION_POLICY,
  DEFAULT_RESCHEDULE_POLICY,
  decideRefund,
  parseRefundPolicy,
  refundAmountFor,
  type RefundPolicy,
} from './booking-policy.engine';

const NOW = new Date('2026-03-01T10:00:00.000Z');
const hoursFromNow = (hours: number): Date => new Date(NOW.getTime() + hours * 3_600_000);

describe('parseRefundPolicy', () => {
  it('accepts a well-formed tier list', () => {
    const raw = [
      { hoursBefore: 24, refundPct: 100 },
      { hoursBefore: 0, refundPct: 0 },
    ];
    expect(parseRefundPolicy(raw, DEFAULT_CANCELLATION_POLICY)).toEqual(raw);
  });

  it('sorts tiers by hoursBefore descending, so an admin need not enter them in order', () => {
    const raw = [
      { hoursBefore: 0, refundPct: 0 },
      { hoursBefore: 48, refundPct: 100 },
      { hoursBefore: 2, refundPct: 50 },
    ];
    expect(parseRefundPolicy(raw, DEFAULT_CANCELLATION_POLICY).map((tier) => tier.hoursBefore)).toEqual([48, 2, 0]);
  });

  // Every one of these must degrade to the fallback rather than throw — a
  // typo in the admin panel must never make a booking un-cancellable.
  it.each([
    ['not an array', { hoursBefore: 24, refundPct: 100 }],
    ['an empty array', []],
    ['a null entry', [null]],
    ['a missing hoursBefore', [{ refundPct: 100 }]],
    ['a missing refundPct', [{ hoursBefore: 24 }]],
    ['a negative hoursBefore', [{ hoursBefore: -1, refundPct: 100 }]],
    ['a refundPct above 100', [{ hoursBefore: 24, refundPct: 101 }]],
    ['a refundPct below 0', [{ hoursBefore: 24, refundPct: -5 }]],
    ['a non-numeric hoursBefore', [{ hoursBefore: '24', refundPct: 100 }]],
    ['NaN', [{ hoursBefore: Number.NaN, refundPct: 100 }]],
    ['undefined', undefined],
    ['a string', 'always refund'],
  ])('falls back when the config is %s', (_label, raw) => {
    expect(parseRefundPolicy(raw, DEFAULT_CANCELLATION_POLICY)).toBe(DEFAULT_CANCELLATION_POLICY);
  });
});

describe('decideRefund', () => {
  const policy: RefundPolicy = DEFAULT_CANCELLATION_POLICY;

  it('gives 100% for cancellation outside the longest window', () => {
    const decision = decideRefund({ policy, scheduledStartAt: hoursFromNow(30), cancelledByParty: 'patient', now: NOW });
    expect(decision).toEqual({ outcome: 'auto_refund', refundPct: 100, matchedTier: { hoursBefore: 24, refundPct: 100 } });
  });

  it('treats the tier boundary as inclusive — exactly 24h notice still earns 100%', () => {
    const decision = decideRefund({ policy, scheduledStartAt: hoursFromNow(24), cancelledByParty: 'patient', now: NOW });
    expect(decision.outcome).toBe('auto_refund');
    expect(decision).toMatchObject({ refundPct: 100 });
  });

  it('gives the middle tier between windows', () => {
    const decision = decideRefund({ policy, scheduledStartAt: hoursFromNow(5), cancelledByParty: 'patient', now: NOW });
    expect(decision).toMatchObject({ outcome: 'auto_refund', refundPct: 50 });
  });

  it('resolves to no_refund — NOT admin review — inside the final window', () => {
    // This distinction matters: the policy has a definite answer ("nothing
    // comes back"), so no human needs to look and no refund call is made.
    const decision = decideRefund({ policy, scheduledStartAt: hoursFromNow(0.5), cancelledByParty: 'patient', now: NOW });
    expect(decision).toEqual({ outcome: 'no_refund', refundPct: 0, matchedTier: { hoursBefore: 0, refundPct: 0 } });
  });

  it('routes a cancellation after the start time to admin review', () => {
    const decision = decideRefund({ policy, scheduledStartAt: hoursFromNow(-1), cancelledByParty: 'patient', now: NOW });
    expect(decision).toEqual({ outcome: 'needs_admin_review', reason: 'already_started' });
  });

  it('routes a consultation with no scheduled start to admin review', () => {
    const decision = decideRefund({ policy, scheduledStartAt: null, cancelledByParty: 'patient', now: NOW });
    expect(decision).toEqual({ outcome: 'needs_admin_review', reason: 'no_scheduled_start' });
  });

  it.each(['doctor', 'admin', 'system'] as const)('routes a %s-initiated cancellation to admin review', (party) => {
    // The tiers price the notice THE PATIENT gave. Applying them to a doctor
    // pulling out three hours ahead would refund the patient 50% of a
    // cancellation that was not their doing.
    const decision = decideRefund({ policy, scheduledStartAt: hoursFromNow(5), cancelledByParty: party, now: NOW });
    expect(decision).toEqual({ outcome: 'needs_admin_review', reason: 'not_cancelled_by_patient' });
  });

  it('routes to admin review when no tier has a zero-hour floor and notice is short', () => {
    const gappedPolicy: RefundPolicy = [{ hoursBefore: 24, refundPct: 100 }];
    const decision = decideRefund({ policy: gappedPolicy, scheduledStartAt: hoursFromNow(3), cancelledByParty: 'patient', now: NOW });
    expect(decision).toEqual({ outcome: 'needs_admin_review', reason: 'already_started' });
  });

  it('the default reschedule policy refunds in full at any notice', () => {
    const decision = decideRefund({
      policy: DEFAULT_RESCHEDULE_POLICY,
      scheduledStartAt: hoursFromNow(0.1),
      cancelledByParty: 'patient',
      now: NOW,
    });
    expect(decision).toMatchObject({ outcome: 'auto_refund', refundPct: 100 });
  });
});

describe('refundAmountFor', () => {
  it('returns the full amount at 100%', () => {
    expect(refundAmountFor('750.00', 100)).toBe('750.00');
  });

  it('returns zero at 0%', () => {
    expect(refundAmountFor('750.00', 0)).toBe('0.00');
  });

  it('halves cleanly', () => {
    expect(refundAmountFor('750.00', 50)).toBe('375.00');
  });

  it('rounds a half-paise result once, in the patient’s favour', () => {
    // 199.99 * 50% = 99.995 exactly. Computed in integer paise (19999 * 50 /
    // 100 = 9999.5 -> 10000) and rounded once, so it does not drift.
    expect(refundAmountFor('199.99', 50)).toBe('100.00');
  });

  it('always returns two decimal places', () => {
    expect(refundAmountFor('100', 100)).toBe('100.00');
    expect(refundAmountFor('33.33', 33)).toBe('11.00');
  });

  it('degrades to zero for an unparsable or negative amount rather than producing NaN', () => {
    expect(refundAmountFor('not-a-number', 100)).toBe('0.00');
    expect(refundAmountFor('-10.00', 100)).toBe('0.00');
  });

  /* ------------------------------------------------------------------ */
  /* Regressions for the float-arithmetic defect this function once had  */
  /* ------------------------------------------------------------------ */

  /**
   * The old implementation ran `Math.round((paise * refundPct) / 100)` with no
   * guard on the sign of the percentage, so a negative tier produced a NEGATIVE
   * refund string ('-375.00') and handed it to the gateway as a refund amount.
   * A refund is never negative; an incomputable one is zero.
   */
  it('refuses a negative percentage instead of emitting a negative refund', () => {
    expect(refundAmountFor('750.00', -50)).toBe('0.00');
  });

  it('degrades to zero for a non-finite percentage', () => {
    expect(refundAmountFor('750.00', Number.NaN)).toBe('0.00');
    expect(refundAmountFor('750.00', Number.POSITIVE_INFINITY)).toBe('0.00');
  });

  /**
   * The ceiling of `numeric(10,2)`. Floats lose integer precision above 2^53
   * paise; `bigint` does not, and this is the shape of amount where the old
   * `Number(amount) * 100` step was least trustworthy.
   */
  it('stays exact at the top of numeric(10,2)', () => {
    expect(refundAmountFor('99999999.99', 100)).toBe('99999999.99');
    expect(refundAmountFor('99999999.99', 50)).toBe('50000000.00');
  });

  /** Fractional tiers are representable — `numeric(5,2)` allows 12.50%. */
  it('handles a fractional percentage', () => {
    expect(refundAmountFor('749.00', 12.5)).toBe('93.63');
  });
});
