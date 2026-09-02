import { HttpStatus, Injectable } from '@nestjs/common';
import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
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
 */
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, ApiSuccessResponse<T> | T> {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<ApiSuccessResponse<T> | T> {
    const httpCode = this.reflector.get<number | undefined>(HTTP_CODE_METADATA, context.getHandler());
    if (httpCode === HttpStatus.NO_CONTENT) {
      return next.handle();
    }

    return next.handle().pipe(map((data) => ({ success: true as const, data })));
  }
}
