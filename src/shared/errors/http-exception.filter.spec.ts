import { BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { HttpExceptionFilter } from './http-exception.filter';

function createHost() {
  const response = {
    status: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => response }),
  } as unknown as ArgumentsHost;
  return { host, response };
}

describe('HttpExceptionFilter', () => {
  let filter: HttpExceptionFilter;

  beforeEach(() => {
    filter = new HttpExceptionFilter();
    // Silence the Logger.error call the 500 branch makes — assertions below
    // check response.send, not console output.
    jest.spyOn(filter['logger'], 'error').mockImplementation(() => undefined);
  });

  it('passes an own {code, message} HttpException through into the envelope untouched', () => {
    const { host, response } = createHost();
    const exception = new NotFoundException({ code: 'DOCTOR_NOT_FOUND', message: 'Doctor not found.' });

    filter.catch(exception, host);

    expect(response.status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(response.send).toHaveBeenCalledWith({
      success: false,
      error: { code: 'DOCTOR_NOT_FOUND', message: 'Doctor not found.' },
    });
  });

  it('carries extra fields (e.g. retryAfterSeconds) through alongside code/message', () => {
    const { host, response } = createHost();
    const exception = new HttpException(
      { code: 'OTP_RATE_LIMITED', message: 'Too many OTP requests. Please try again shortly.', retryAfterSeconds: 42 },
      HttpStatus.TOO_MANY_REQUESTS,
    );

    filter.catch(exception, host);

    expect(response.send).toHaveBeenCalledWith({
      success: false,
      error: { code: 'OTP_RATE_LIMITED', message: 'Too many OTP requests. Please try again shortly.', retryAfterSeconds: 42 },
    });
  });

  it('normalizes a ValidationPipe BadRequestException ({statusCode, message: string[], error}) to VALIDATION_FAILED with details', () => {
    const { host, response } = createHost();
    // Exact shape Nest's ValidationPipe throws — see main.ts's global ValidationPipe.
    const exception = new BadRequestException(['fullName should not be empty', 'dateOfBirth must be a valid ISO date']);

    filter.catch(exception, host);

    expect(response.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(response.send).toHaveBeenCalledWith({
      success: false,
      error: {
        code: 'VALIDATION_FAILED',
        message: 'fullName should not be empty',
        details: ['fullName should not be empty', 'dateOfBirth must be a valid ISO date'],
      },
    });
  });

  it('synthesizes a code from the HTTP status for an HttpException with no code (e.g. a bare-string BadRequestException)', () => {
    const { host, response } = createHost();
    const exception = new BadRequestException('oops');

    filter.catch(exception, host);

    expect(response.send).toHaveBeenCalledWith({
      success: false,
      error: { code: 'BAD_REQUEST', message: 'oops' },
    });
  });

  it('synthesizes NOT_FOUND/FORBIDDEN/CONFLICT for their respective built-ins with no code', () => {
    const { host, response } = createHost();

    filter.catch(new NotFoundException('missing'), host);
    expect(response.send).toHaveBeenLastCalledWith({ success: false, error: { code: 'NOT_FOUND', message: 'missing' } });

    filter.catch(new ForbiddenException('nope'), host);
    expect(response.send).toHaveBeenLastCalledWith({ success: false, error: { code: 'FORBIDDEN', message: 'nope' } });

    filter.catch(new ConflictException('clash'), host);
    expect(response.send).toHaveBeenLastCalledWith({ success: false, error: { code: 'CONFLICT', message: 'clash' } });
  });

  it('maps a non-HttpException (unexpected error) to a generic 500 without leaking its message', () => {
    const { host, response } = createHost();
    const exception = new Error('duplicate key value violates unique constraint "doctors_mobile_number_key"');

    filter.catch(exception, host);

    expect(response.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(response.send).toHaveBeenCalledWith({
      success: false,
      error: { code: 'INTERNAL_SERVER_ERROR', message: 'An unexpected error occurred. Please try again.' },
    });
  });

  it('logs the real error server-side for a non-HttpException, even though the client never sees it', () => {
    const { host } = createHost();
    const loggerSpy = jest.spyOn(filter['logger'], 'error');
    const exception = new Error('boom');

    filter.catch(exception, host);

    expect(loggerSpy).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });

  it('maps a thrown non-Error value (e.g. a string) to the same generic 500 shape', () => {
    const { host, response } = createHost();

    // eslint-disable-next-line @typescript-eslint/only-throw-error
    filter.catch('a string was thrown', host);

    expect(response.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(response.send).toHaveBeenCalledWith({
      success: false,
      error: { code: 'INTERNAL_SERVER_ERROR', message: 'An unexpected error occurred. Please try again.' },
    });
  });
});
