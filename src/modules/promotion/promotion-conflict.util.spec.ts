import { constraintNameOf, refusalForUniqueViolation } from './promotion-conflict.util';
import { PROMOTION_INDEXES } from './promotion.constants';

/**
 * Three partial unique indexes stand behind the reservation transaction and
 * Postgres reports all three as SQLSTATE `23505`. Telling them apart is what
 * turns one generic conflict into three specific, correct refusals — and
 * getting it wrong means a patient re-applying a coupon is told "you have
 * already used this code", which is false.
 *
 * *** THE WRAPPED SHAPE IS THE ONE THAT MATTERS. *** `postgres-error.util.ts`
 * documents the trap: Drizzle 0.45 wraps the driver error in a
 * `DrizzleQueryError` whose own `code` is `undefined`, and hangs the real `pg`
 * `DatabaseError` off `.cause`. Unit tests across the codebase previously
 * constructed only the UNWRAPPED shape, which is real but is not what the ORM
 * hands a service — so every test here asserts BOTH shapes.
 *
 * The wrapped shape is also what
 * `promotion.redemption-race.integration.spec.ts` observes coming out of a real
 * database, which is what makes these fixtures faithful rather than assumed.
 */
describe('promotion-conflict.util', () => {
  /** What the driver throws. */
  const raw = (constraint: string) => ({ code: '23505', constraint });
  /** What Drizzle 0.45 actually hands the service. */
  const wrapped = (constraint: string) => ({ name: 'DrizzleQueryError', cause: raw(constraint) });

  describe('constraintNameOf', () => {
    it('reads the constraint off an unwrapped driver error', () => {
      expect(constraintNameOf(raw('some_idx'))).toBe('some_idx');
    });

    it('*** WALKS THE `cause` CHAIN, because a top-level read returns undefined for every real violation ***', () => {
      expect(constraintNameOf(wrapped('some_idx'))).toBe('some_idx');
    });

    it('returns null when there is no constraint anywhere in the chain', () => {
      expect(constraintNameOf(new Error('boom'))).toBeNull();
      expect(constraintNameOf(null)).toBeNull();
      expect(constraintNameOf(undefined)).toBeNull();
      expect(constraintNameOf('a string')).toBeNull();
      expect(constraintNameOf({ code: '23505' })).toBeNull();
    });

    it('is BOUNDED, so a self-referential cause cannot spin', () => {
      // A malformed or cyclic `cause` must not turn an error path into an
      // infinite loop — this runs inside a catch on the checkout path.
      const cyclic: Record<string, unknown> = { code: 'x' };
      cyclic.cause = cyclic;
      expect(constraintNameOf(cyclic)).toBeNull();
    });
  });

  describe('refusalForUniqueViolation', () => {
    it('returns null for anything that is NOT a unique violation, so the caller rethrows', () => {
      // A genuine fault is not a refusal. Folding a connection error into
      // `CODE_NOT_USABLE` would make a database outage look like a bad coupon.
      expect(refusalForUniqueViolation(new Error('connection reset'))).toBeNull();
      expect(refusalForUniqueViolation({ code: '23503' })).toBeNull();
      expect(refusalForUniqueViolation(undefined)).toBeNull();
    });

    it('maps the live-consultation index to ALREADY_APPLIED — no stacking', () => {
      for (const error of [raw(PROMOTION_INDEXES.LIVE_CONSULTATION_UNIQUE), wrapped(PROMOTION_INDEXES.LIVE_CONSULTATION_UNIQUE)]) {
        expect(refusalForUniqueViolation(error)).toEqual({
          reason: 'ALREADY_APPLIED',
          constraint: PROMOTION_INDEXES.LIVE_CONSULTATION_UNIQUE,
        });
      }
    });

    it('maps the single-use index to USER_LIMIT_REACHED', () => {
      for (const error of [raw(PROMOTION_INDEXES.SINGLE_USE_PER_USER), wrapped(PROMOTION_INDEXES.SINGLE_USE_PER_USER)]) {
        expect(refusalForUniqueViolation(error)).toEqual({
          reason: 'USER_LIMIT_REACHED',
          constraint: PROMOTION_INDEXES.SINGLE_USE_PER_USER,
        });
      }
    });

    it('maps the referee-once index to ALREADY_REFERRED', () => {
      for (const error of [raw(PROMOTION_INDEXES.REFERRAL_REFEREE_ONCE), wrapped(PROMOTION_INDEXES.REFERRAL_REFEREE_ONCE)]) {
        expect(refusalForUniqueViolation(error)).toEqual({
          reason: 'ALREADY_REFERRED',
          constraint: PROMOTION_INDEXES.REFERRAL_REFEREE_ONCE,
        });
      }
    });

    it('*** AN UNRECOGNISED 23505 IS STILL A REFUSAL, NOT A 500 ***', () => {
      // A new index added by a later migration must not turn into a 500 on the
      // checkout path. `CODE_NOT_USABLE` is both truthful (the code did not go
      // through) and safe (it leaks nothing), and the unrecognised name comes
      // back so the caller can log it.
      const result = refusalForUniqueViolation(wrapped('some_future_idx'));
      expect(result).toEqual({ reason: 'CODE_NOT_USABLE', constraint: 'some_future_idx' });
    });

    it('handles a 23505 that names no constraint at all', () => {
      expect(refusalForUniqueViolation({ code: '23505' })).toEqual({ reason: 'CODE_NOT_USABLE', constraint: null });
    });
  });
});
