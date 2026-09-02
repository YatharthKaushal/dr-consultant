import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { Catch, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { ApiErrorBody, ApiErrorResponse } from './response.types';

/** `HttpException` body shape `class-validator`'s `ValidationPipe` throws — see `main.ts`'s global `ValidationPipe`. No `code` field, `message` is every failed constraint's message. */
interface ValidationPipeBody {
  statusCode: number;
  message: string[];
  error: string;
}

/**
 * The single place that decides the final error shape for literally
 * everything a controller (or Nest's own request-handling machinery) can
 * throw — registered globally via `errors.module.ts`. Every branch below
 * produces `ApiErrorResponse` (`{ success: false, error: { code, message,
 * ...extras } }`), so no error, deliberate or not, can reach a client
 * without both fields.
 *
 * Branches, in order:
 *   1. Our own deliberately-thrown `HttpException`s — body is already
 *      `{ code, message, ...extras }` (every call site in this codebase
 *      throws this shape, extras like `retryAfterSeconds` included) — passed
 *      through as-is.
 *   2. Nest's `ValidationPipe`-thrown `BadRequestException` — body is
 *      `{ statusCode, message: string[], error: 'Bad Request' }`, no `code`.
 *      Detected by `message` being an array with no `code` field, and
 *      normalized to `VALIDATION_FAILED` with the full list under `details`.
 *   3. Any other `HttpException` whose body has no `code` — defensive:
 *      catches a future `throw new BadRequestException('oops')`. `code` is
 *      synthesized from the HTTP status via `HttpStatus`'s own reverse
 *      lookup (`HttpStatus[404] === 'NOT_FOUND'`, etc.) so it always matches
 *      Nest's own status vocabulary.
 *   4. Anything that isn't an `HttpException` at all — an uncaught error, a
 *      DB constraint violation nothing caught. Answered with a generic 500
 *      and a message that never repeats `error.message`/stack back to the
 *      client; the real error is logged server-side via `Logger` so it stays
 *      debuggable.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<FastifyReply>();
    const { status, error } = this.resolve(exception);
    const body: ApiErrorResponse = { success: false, error };
    response.status(status).send(body);
  }

  private resolve(exception: unknown): { status: number; error: ApiErrorBody } {
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return { status, error: this.normalize(exception.getResponse(), status) };
    }

    // Never seen by the client: no `error.message`, no stack. Logged here —
    // server-side only — so it's still debuggable.
    const detail = exception instanceof Error ? (exception.stack ?? exception.message) : String(exception);
    this.logger.error(`Unhandled exception: ${detail}`);

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      error: { code: 'INTERNAL_SERVER_ERROR', message: 'An unexpected error occurred. Please try again.' },
    };
  }

  private normalize(raw: unknown, status: number): ApiErrorBody {
    if (this.isRecord(raw) && typeof raw.code === 'string' && typeof raw.message === 'string') {
      // Our own shape already — pass code/message/extras through untouched.
      const { code, message, ...extras } = raw;
      return { code, message, ...extras };
    }

    if (this.isRecord(raw) && Array.isArray(raw.message)) {
      const body = raw as unknown as ValidationPipeBody;
      const messages = body.message.filter((m): m is string => typeof m === 'string');
      return {
        code: 'VALIDATION_FAILED',
        message: messages[0] ?? 'Validation failed.',
        details: messages,
      };
    }

    const message = this.isRecord(raw) && typeof raw.message === 'string' ? raw.message : typeof raw === 'string' ? raw : 'An error occurred.';
    return { code: this.codeForStatus(status), message };
  }

  /** `HttpStatus` is a numeric TS enum, so it carries its own reverse map: `HttpStatus[404] === 'NOT_FOUND'`. */
  private codeForStatus(status: number): string {
    const name = (HttpStatus as unknown as Record<number, string | undefined>)[status];
    return name ?? `HTTP_${status}`;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }
}
