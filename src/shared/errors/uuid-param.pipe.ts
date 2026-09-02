import { BadRequestException, ParseUUIDPipe } from '@nestjs/common';

/**
 * A `ParseUUIDPipe` for `:id`-shaped route params that fails the same way
 * every other bad-input rejection in this codebase does —
 * `{ code: 'VALIDATION_FAILED', message }` — instead of Nest's built-in
 * `ParseUUIDPipe`'s default plain-string `BadRequestException`.
 *
 * Without this, a non-UUID path segment (e.g. `GET /admin/doctors/not-a-
 * real-id`) reaches a Drizzle `eq(table.id, id)` against a `uuid` column,
 * Postgres throws `22P02 invalid input syntax for type uuid`, and
 * `HttpExceptionFilter`'s branch 4 catches it as a generic 500
 * `INTERNAL_SERVER_ERROR` — leaking the fact it's an unhandled DB-level
 * error instead of a clean 400. Catching it here, before the request ever
 * reaches a service or repository, keeps that failure a validation problem.
 *
 * No `version` option: row ids are created via `uuid('id').defaultRandom()`
 * (`gen_random_uuid()`), but this validates the path param against any
 * well-formed UUID rather than pinning to a specific RFC4122 version, so it
 * never rejects a legitimately-stored id on a technicality.
 *
 * Usage: `@Param('id', createUuidValidationPipe('id'))`.
 */
export function createUuidValidationPipe(paramName: string): ParseUUIDPipe {
  return new ParseUUIDPipe({
    exceptionFactory: () =>
      new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: `${paramName} must be a valid UUID.`,
      }),
  });
}
