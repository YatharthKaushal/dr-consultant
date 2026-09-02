import { isUniqueConstraintViolation } from './postgres-error.util';

/**
 * *** THE REGRESSION TEST THAT WOULD HAVE CAUGHT THE ORIGINAL BUG. ***
 *
 * `isUniqueConstraintViolation` used to check only the TOP-LEVEL `code`. That
 * looks right, and every existing test of every caller passes against it,
 * because they all hand-construct the UNWRAPPED driver shape:
 *
 *     Object.assign(new Error('...'), { code: '23505' })
 *
 * That object is real — it is exactly what `node-postgres` throws. It is just
 * not what the SERVICE ever sees. Drizzle 0.45 catches the driver error and
 * rethrows its own `DrizzleQueryError`, whose `code` is `undefined`, with the
 * genuine `pg` `DatabaseError` hanging off `.cause`:
 *
 *     CTOR: DrizzleQueryError   code: undefined
 *     cause ctor: DatabaseError cause code: 23505
 *
 * So every `if (isUniqueConstraintViolation(error))` branch in the codebase —
 * `catalogue`, `doctor`, `ai`, `mcp` and now `booking` — was falling through
 * to `HttpExceptionFilter`'s generic-500 instead of returning its intended
 * 409, and no unit test anywhere could see it. It was found by M-11's
 * real-database slot-race test, where a double booking must be a 409.
 *
 * The tests below therefore cover BOTH shapes deliberately. The unwrapped one
 * keeps the direct-driver path honest; the WRAPPED one is the shape that
 * actually reaches production code, and is the assertion that stops this
 * regressing the next time someone "simplifies" the helper back to a
 * single-level check.
 */

/** The raw `pg` error: what the driver throws, and what every pre-existing test builds. */
function driverUniqueViolation(constraint = 'some_unique_idx'): Error & { code: string; constraint: string } {
  return Object.assign(new Error(`duplicate key value violates unique constraint "${constraint}"`), {
    code: '23505',
    constraint,
  });
}

/** What Drizzle 0.45 actually hands the service — the driver error wrapped, with `code` only on `.cause`. */
function drizzleWrapped(cause: unknown): Error & { query: string; params: unknown[]; cause: unknown } {
  return Object.assign(new Error('Failed query: insert into "consultations" ...'), {
    query: 'insert into "consultations" ...',
    params: [],
    cause,
  });
}

describe('isUniqueConstraintViolation', () => {
  describe('the unwrapped driver error (direct `pg` usage)', () => {
    it('recognises a 23505', () => {
      expect(isUniqueConstraintViolation(driverUniqueViolation())).toBe(true);
    });

    it('ignores a different SQLSTATE', () => {
      // 23503 is a foreign-key violation — a real error, but not this one.
      expect(isUniqueConstraintViolation(Object.assign(new Error('fk'), { code: '23503' }))).toBe(false);
    });
  });

  describe('THE WRAPPED SHAPE — what Drizzle 0.45 really throws', () => {
    it('sees through DrizzleQueryError to the 23505 on `.cause`', () => {
      // *** If this fails, every duplicate-detection branch in the codebase
      // *** is returning 500 instead of 409. See the file header.
      expect(isUniqueConstraintViolation(drizzleWrapped(driverUniqueViolation()))).toBe(true);
    });

    it('still says false when the wrapped cause is a different SQLSTATE', () => {
      expect(isUniqueConstraintViolation(drizzleWrapped(Object.assign(new Error('fk'), { code: '23503' })))).toBe(false);
    });

    it('says false when the wrapper has no cause at all', () => {
      expect(isUniqueConstraintViolation(Object.assign(new Error('Failed query'), { query: 'x' }))).toBe(false);
    });

    it('finds a 23505 nested more than one level deep', () => {
      expect(isUniqueConstraintViolation(drizzleWrapped(drizzleWrapped(driverUniqueViolation())))).toBe(true);
    });
  });

  describe('robustness', () => {
    it('terminates on a self-referential cause chain rather than spinning', () => {
      // The depth bound exists for exactly this: a cyclic `cause` must not
      // turn an error path into an infinite loop.
      const cyclic: Record<string, unknown> = { code: 'X' };
      cyclic.cause = cyclic;
      expect(isUniqueConstraintViolation(cyclic)).toBe(false);
    });

    it('gives up past the depth bound instead of walking forever', () => {
      let deep: unknown = driverUniqueViolation();
      for (let i = 0; i < 10; i += 1) deep = drizzleWrapped(deep);
      expect(isUniqueConstraintViolation(deep)).toBe(false);
    });

    it.each([
      ['null', null],
      ['undefined', undefined],
      ['a string', 'boom'],
      ['a number', 23505],
      ['a plain object', {}],
      ['a cause that is not an object', drizzleWrapped('not-an-error')],
    ])('returns false for %s', (_label, value) => {
      expect(isUniqueConstraintViolation(value)).toBe(false);
    });

    it('matches on the string SQLSTATE, not the number — Postgres codes are strings', () => {
      expect(isUniqueConstraintViolation({ code: 23505 })).toBe(false);
      expect(isUniqueConstraintViolation({ code: '23505' })).toBe(true);
    });
  });
});
