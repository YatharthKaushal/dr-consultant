import { HttpStatus, Injectable } from '@nestjs/common';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { HTTP_CODE_METADATA, SSE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import type { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import type { ApiSuccessResponse } from './response.types';

/**
 * Wraps every successful controller return value in `{ success: true, data }`
 * — the counterpart to `HttpExceptionFilter`'s `{ success: false, error }` on
 * the failure side, so a client can switch on `success` alone.
 *
 * Skips a 204 No Content response entirely: wrapping `undefined` would put a
 * body on a response that must have none. Detected via the `@HttpCode(...)`
 * handler metadata (`HTTP_CODE_METADATA`) rather than the response object's
 * `statusCode`, because Nest applies `@HttpCode` to the response AFTER the
 * interceptor chain resolves — reading `statusCode` here would still see the
 * pre-`@HttpCode` default. Every 204 endpoint in this codebase (`POST
 * /auth/logout-all`, the RBAC grant/revoke routes, `DELETE .../specialties/
 * :specialtyId`) already declares `@HttpCode(HttpStatus.NO_CONTENT)`
 * explicitly, so this check catches all of them.
 *
 * *** ALSO SKIPS `@Sse()` ROUTES, AND MUST. ***
 *
 * Interceptors DO run on SSE handlers — `@nestjs/core`'s
 * `router-execution-context.js` builds the interceptor chain first and only
 * then branches on `isSseHandler`, so without this check every event pushed
 * down an SSE stream would arrive wrapped.
 *
 * That wrapping is not cosmetic, it is corrupting. An `@Sse()` handler emits
 * `MessageEvent`-shaped objects (`{ data, id?, type?, retry? }`) and Nest's
 * `SseStream` reads those fields to build the wire frame (`event:`, `id:`,
 * `data:`). Wrapping the object turns the WHOLE event into the payload of a
 * `data` field, so `id`, `type` and `retry` stop being protocol fields and
 * silently become part of an opaque JSON blob — every consumer loses event
 * typing and resumption, and nothing errors to say so.
 *
 * `@Sse()` marks its handler with `SSE_METADATA`, which is what this reads.
 * The envelope is for request/response routes; a stream is neither.
 */
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, ApiSuccessResponse<T> | T> {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<ApiSuccessResponse<T> | T> {
    const httpCode = this.reflector.get<number | undefined>(HTTP_CODE_METADATA, context.getHandler());
    if (httpCode === HttpStatus.NO_CONTENT) {
      return next.handle();
    }

    // A stream is not a request/response pair — see the header.
    if (this.reflector.get<boolean | undefined>(SSE_METADATA, context.getHandler()) === true) {
      return next.handle();
    }

    return next.handle().pipe(map((data) => ({ success: true as const, data })));
  }
}
