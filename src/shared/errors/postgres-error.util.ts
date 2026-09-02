/** Standard Postgres SQLSTATE for a unique-constraint violation (`23505`). */
const UNIQUE_VIOLATION_SQLSTATE = '23505';

/**
 * True when `error` is a `pg` driver error (`pg-protocol`'s `DatabaseError`,
 * what `node-postgres`/Drizzle throw for a failed statement) carrying the
 * Postgres unique-violation SQLSTATE.
 *
 * Duck-typed rather than `instanceof pg.DatabaseError` on purpose: `shared`
 * has no reason to depend on the `pg` package directly (`backend/README.md`
 * — modules own their data access, `shared` stays a thin dependency), and
 * every Postgres driver error already carries a string `code` field shaped
 * this way regardless of which class wraps it.
 *
 * Used to add a safety net under a "SELECT to check it doesn't exist, then
 * INSERT/UPDATE" duplicate check: under concurrent requests, two callers can
 * both pass the SELECT check before either writes, so the second write hits
 * the database's own unique constraint. Catching that here lets a service
 * convert it into the same `ConflictException` the sequential check already
 * throws, instead of letting a raw driver error fall through to
 * `HttpExceptionFilter`'s generic-500 branch.
 *
 * *** WHY THIS WALKS THE `cause` CHAIN (found by M-11, fixed for everyone). ***
 *
 * Drizzle 0.45 does NOT rethrow the driver's error as-is. It wraps it in its
 * own `DrizzleQueryError`, whose own `code` is `undefined`, and hangs the real
 * `pg` `DatabaseError` — the one actually carrying `code: '23505'` — off
 * `.cause`. Verified against the live database on this exact version:
 *
 *     CTOR: DrizzleQueryError   code: undefined
 *     cause ctor: DatabaseError cause code: 23505
 *
 * A top-level-only check therefore returns FALSE for every real unique
 * violation raised through a Drizzle query builder, so every `if
 * (isUniqueConstraintViolation(error))` branch in the codebase silently fell
 * through to the generic-500 path instead of producing its intended 409. Unit
 * tests did not catch it anywhere, because they all construct the UNWRAPPED
 * `{ code: '23505' }` shape by hand — which is real (it is what the driver
 * throws) but is not what the ORM hands the service.
 *
 * This surfaced in M-11, where the partial unique index behind double-booking
 * prevention is the authoritative slot guard and a 500 instead of a 409 is a
 * user-visible correctness failure. The same latent bug affected
 * `catalogue`, `doctor`, `ai` and `mcp`, so the fix belongs here rather than
 * in one module.
 *
 * Walking `cause` is additive: an unwrapped driver error still matches on the
 * first hop, so no existing behaviour or test changes. The chain is walked
 * with a depth bound rather than recursion so a self-referential `cause`
 * cannot spin.
 */
export function isUniqueConstraintViolation(error: unknown): boolean {
  return hasSqlState(error, UNIQUE_VIOLATION_SQLSTATE);
}

/** Generic SQLSTATE test over an error and its `cause` chain. */
function hasSqlState(error: unknown, sqlState: string): boolean {
  let current: unknown = error;

  // Bounded rather than unbounded: a malformed or cyclic `cause` must not
  // turn an error path into an infinite loop.
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== 'object' || current === null) return false;
    if ((current as { code?: unknown }).code === sqlState) return true;
    if (!('cause' in current)) return false;
    current = (current as { cause?: unknown }).cause;
  }

  return false;
}

/** Drizzle wraps once; the bound is generous headroom in case a future version wraps again. */
const MAX_CAUSE_DEPTH = 5;
