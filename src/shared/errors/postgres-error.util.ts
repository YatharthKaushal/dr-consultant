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
 */
export function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION_SQLSTATE
  );
}
