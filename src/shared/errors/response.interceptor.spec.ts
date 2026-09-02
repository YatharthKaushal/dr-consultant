import { HttpStatus, type CallHandler, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { of } from 'rxjs';
import { ResponseInterceptor } from './response.interceptor';

function createReflector(returnValue: unknown): Reflector {
  return { get: jest.fn().mockReturnValue(returnValue) } as unknown as Reflector;
}

function createContext(): ExecutionContext {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

function createHandler(value: unknown): CallHandler {
  return { handle: () => of(value) } as CallHandler;
}

describe('ResponseInterceptor', () => {
  it('wraps a plain return value in { success: true, data }', async () => {
    const interceptor = new ResponseInterceptor(createReflector(undefined));
    const result = await interceptor.intercept(createContext(), createHandler({ id: 'doctor-1' })).toPromise();

    expect(result).toEqual({ success: true, data: { id: 'doctor-1' } });
  });

  it('wraps an array return value too, not just objects', async () => {
    const interceptor = new ResponseInterceptor(createReflector(undefined));
    const result = await interceptor.intercept(createContext(), createHandler([1, 2, 3])).toPromise();

    expect(result).toEqual({ success: true, data: [1, 2, 3] });
  });

  it('wraps null/undefined data the same way as any other value', async () => {
    const interceptor = new ResponseInterceptor(createReflector(undefined));
    const result = await interceptor.intercept(createContext(), createHandler(undefined)).toPromise();

    expect(result).toEqual({ success: true, data: undefined });
  });

  it('does NOT wrap a 204 No Content response — passes the raw (empty) value through untouched', async () => {
    const interceptor = new ResponseInterceptor(createReflector(HttpStatus.NO_CONTENT));
    const result = await interceptor.intercept(createContext(), createHandler(undefined)).toPromise();

    expect(result).toBeUndefined();
  });

  it('wraps a non-204 @HttpCode response (e.g. 201 Created) like any other success', async () => {
    const interceptor = new ResponseInterceptor(createReflector(HttpStatus.CREATED));
    const result = await interceptor.intercept(createContext(), createHandler({ id: 'new-1' })).toPromise();

    expect(result).toEqual({ success: true, data: { id: 'new-1' } });
  });
});
