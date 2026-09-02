import { BadRequestException, ParseUUIDPipe } from '@nestjs/common';

/**
 * `ParseUUIDPipe` with the global error envelope's shape. Nest's default
 * throws `BadRequestException('Validation failed (uuid is expected)')` with
 * no `code` field — `shared/errors/http-exception.filter.ts` would then
 * normalize it to a generic `BAD_REQUEST` code rather than the
 * `VALIDATION_FAILED` code every other deliberately-thrown 400 in this
 * codebase uses. This gives a malformed `:id`-shaped path param that same
 * clean, consistent shape instead.
 *
 * An audit of M-05/M-06 found every `:id` route there either uses the bare
 * `ParseUUIDPipe` default or no pipe at all (leaking a raw ad hoc/500
 * response for a malformed id) — this module is the first to fix it, and
 * this lives here (not `shared/`) only because nothing else needs it yet.
 * The coordinator should consider hoisting this to `shared/` once a second
 * module wants the same thing, and retrofitting M-05/M-06's `:id` routes.
 */
export function uuidParam(): ParseUUIDPipe {
  return new ParseUUIDPipe({
    exceptionFactory: () => new BadRequestException({ code: 'VALIDATION_FAILED', message: 'Invalid id format — expected a UUID.' }),
  });
}
