import { HttpException, HttpStatus, ServiceUnavailableException } from '@nestjs/common';

// Mock only SlideClient (the network-calling constructor); keep every real
// error class so `instanceof` checks in the service under test still work
// against errors this test throws.
const otpMock = {
  send: jest.fn(),
  retry: jest.fn(),
  verify: jest.fn(),
  verifyToken: jest.fn(),
};

jest.mock('@synquic/slide', () => {
  const actual = jest.requireActual('@synquic/slide');
  return {
    ...actual,
    SlideClient: jest.fn().mockImplementation(() => ({ otp: otpMock })),
  };
});

// IdentityOtpService reads getEnv() in its constructor; isolate this unit
// test from the real boot-time env validation (which would otherwise
// process.exit(1) and kill the jest worker when Slide/JWT env vars aren't
// set in the test environment).
jest.mock('../../config/env/env.validation', () => ({
  getEnv: () => ({
    SLIDE_API_KEY: 'sk_test_dummy',
    SLIDE_BASE_URL: undefined,
    SLIDE_OTP_WIDGET_ID: 'wgt_test_dummy',
  }),
}));

// Imported after the mock so the constructor above is what identity-otp.service.ts sees.
import { SlideAuthError, SlideError, SlideNotFoundError, SlideScopeError, SlideValidationError } from '@synquic/slide';
import type { AppConfigService } from '../../shared/app-config/app-config.service';
import { IdentityOtpService } from './identity-otp.service';
import { IDENTITY_ERROR_CODES } from './identity.constants';

function createService(retryAfterSeconds = 60): IdentityOtpService {
  const appConfig = { getNumber: jest.fn().mockResolvedValue(retryAfterSeconds) } as unknown as AppConfigService;
  return new IdentityOtpService(appConfig);
}

describe('IdentityOtpService', () => {
  beforeEach(() => {
    otpMock.send.mockReset();
    otpMock.retry.mockReset();
    otpMock.verify.mockReset();
    otpMock.verifyToken.mockReset();
  });

  it('passes through a successful send', async () => {
    otpMock.send.mockResolvedValue({ requestId: 'otpreq_1' });
    const service = createService();

    await expect(service.send('+919876543210')).resolves.toEqual({ requestId: 'otpreq_1' });
  });

  it('maps SlideValidationError on verify to a generic 400 INVALID_OTP', async () => {
    otpMock.verify.mockRejectedValue(new SlideValidationError('bad code'));
    const service = createService();

    await expect(service.verify('otpreq_1', '000000')).rejects.toMatchObject({
      status: HttpStatus.BAD_REQUEST,
      response: expect.objectContaining({ code: IDENTITY_ERROR_CODES.INVALID_OTP }),
    });
  });

  it('maps SlideValidationError on send to OTP_SEND_FAILED, NOT the "wrong code" message — no code has been entered yet at this stage', async () => {
    otpMock.send.mockRejectedValue(new SlideValidationError('invalid identifier'));
    const service = createService();

    try {
      await service.send('+919876543210');
      fail('expected send to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      const httpError = error as HttpException;
      expect(httpError.getStatus()).toBe(HttpStatus.BAD_REQUEST);
      const body = httpError.getResponse() as { code: string; message: string };
      expect(body.code).toBe(IDENTITY_ERROR_CODES.OTP_SEND_FAILED);
      expect(body.message.toLowerCase()).not.toContain('code you entered');
    }
  });

  it('maps SlideValidationError on retry to OTP_RESEND_FAILED, not INVALID_OTP', async () => {
    otpMock.retry.mockRejectedValue(new SlideValidationError('resend limit exceeded'));
    const service = createService();

    await expect(service.retry('otpreq_1')).rejects.toMatchObject({
      status: HttpStatus.BAD_REQUEST,
      response: expect.objectContaining({ code: IDENTITY_ERROR_CODES.OTP_RESEND_FAILED }),
    });
  });

  it('maps a 404 on send to a 503 (config problem), not CHALLENGE_EXPIRED — there is no challenge yet to have expired', async () => {
    otpMock.send.mockRejectedValue(new SlideNotFoundError('widget not found'));
    const service = createService();

    await expect(service.send('+919876543210')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('does not leak whether the code was wrong, expired, or blocked', async () => {
    otpMock.verify.mockRejectedValue(new SlideValidationError('blocked after too many attempts'));
    const service = createService();

    try {
      await service.verify('otpreq_1', '000000');
      fail('expected verify to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      const body = (error as HttpException).getResponse() as { message: string };
      expect(body.message).not.toContain('blocked');
    }
  });

  it('maps SlideNotFoundError to 410 CHALLENGE_EXPIRED', async () => {
    otpMock.verify.mockRejectedValue(new SlideNotFoundError('no such request'));
    const service = createService();

    await expect(service.verify('otpreq_1', '000000')).rejects.toMatchObject({
      status: HttpStatus.GONE,
      response: expect.objectContaining({ code: IDENTITY_ERROR_CODES.CHALLENGE_EXPIRED }),
    });
  });

  it('maps a 429 SlideError to 429 OTP_RATE_LIMITED with our own configured retryAfterSeconds', async () => {
    otpMock.send.mockRejectedValue(new SlideError(429, 'rate limited'));
    const service = createService(42);

    await expect(service.send('+919876543210')).rejects.toMatchObject({
      status: HttpStatus.TOO_MANY_REQUESTS,
      response: expect.objectContaining({ code: IDENTITY_ERROR_CODES.OTP_RATE_LIMITED, retryAfterSeconds: 42 }),
    });
  });

  it('maps SlideAuthError to a 503, never surfacing the vendor auth failure', async () => {
    otpMock.send.mockRejectedValue(new SlideAuthError('bad api key'));
    const service = createService();

    const promise = service.send('+919876543210');
    await expect(promise).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(promise).rejects.toMatchObject({
      response: expect.objectContaining({ code: IDENTITY_ERROR_CODES.OTP_PROVIDER_UNAVAILABLE }),
    });
  });

  it('maps SlideScopeError to a 503', async () => {
    otpMock.send.mockRejectedValue(new SlideScopeError('missing otp:send scope'));
    const service = createService();

    await expect(service.send('+919876543210')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('maps any other SlideError (e.g. 500) to a 503', async () => {
    otpMock.send.mockRejectedValue(new SlideError(500, 'internal error'));
    const service = createService();

    await expect(service.send('+919876543210')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('maps a completely unexpected error (e.g. network failure) to a 503', async () => {
    otpMock.send.mockRejectedValue(new Error('ECONNRESET'));
    const service = createService();

    await expect(service.send('+919876543210')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('calls verifyToken exactly once per invocation (single-use, no internal retry)', async () => {
    otpMock.verifyToken.mockResolvedValue({ verified: true, identifier: '+919876543210', verifiedAt: new Date().toISOString() });
    const service = createService();

    await service.verifyToken('some.jwt.token');

    expect(otpMock.verifyToken).toHaveBeenCalledTimes(1);
  });
});
