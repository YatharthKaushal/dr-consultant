import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { HttpExceptionFilter } from './http-exception.filter';
import { ResponseInterceptor } from './response.interceptor';

/**
 * Registers the response envelope globally: `ResponseInterceptor` wraps
 * every success, `HttpExceptionFilter` shapes every failure — same
 * `APP_FILTER`/`APP_INTERCEPTOR` registration pattern `shared/auth/
 * auth.module.ts` already uses for its three `APP_GUARD`s.
 */
@Module({
  providers: [
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
  ],
})
export class ErrorsModule {}
