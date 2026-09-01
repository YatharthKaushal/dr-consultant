import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  SlideAuthError,
  SlideClient,
  SlideError,
  SlideNotFoundError,
  SlideScopeError,
  SlideValidationError,
} from '@synquic/slide';
import { getEnv } from '../../config/env/env.validation';
import { AppConfigService } from '../../shared/app-config/app-config.service';
import { IDENTITY_APP_CONFIG_DEFAULTS, IDENTITY_APP_CONFIG_KEYS, IDENTITY_ERROR_CODES } from './identity.constants';

export interface SlideSendResult {
  requestId: string;
}

export interface SlideVerifyResult {
  accessToken: string;
}

export interface SlideVerifyTokenResult {
  verified: boolean;
  identifier: string;
  verifiedAt: string;
}

/**
 * Per-call overrides for the two Slide error types whose correct client
 * message genuinely depends on WHICH operation failed — a `SlideValidationError`
 * from `otp.send` (bad number/widget) has nothing to do with a wrong code,
 * yet both would otherwise fall through the same generic handler. The other
 * error types (429/401/403/5xx/network) are infrastructure-level and mean
 * the same thing regardless of which operation triggered them, so they stay
 * shared across every call.
 */
interface CallOverrides {
  onValidationError: (error: SlideValidationError) => HttpException;
  /** Omit to fall back to the shared CHALLENGE_EXPIRED/410 mapping. */
  onNotFoundError?: (error: SlideNotFoundError) => HttpException;
}

/**
 * The ONLY file in this codebase that imports `@synquic/slide`. Every
 * caller gets back either a typed result or a plain Nest `HttpException` —
 * no `Slide*Error` ever escapes this file, so nothing downstream needs to
 * know Slide exists.
 *
 * Our backend is the only thing that ever calls Slide: the API key can't be
 * client-side (Slide's own docs: "Never expose it in client-side code"),
 * same reasoning this codebase already applies to LiveKit join tokens and
 * Razorpay webhooks.
 */
@Injectable()
export class IdentityOtpService {
  private readonly logger = new Logger(IdentityOtpService.name);
  private readonly client: SlideClient;
  private readonly widgetId: string;

  constructor(private readonly appConfig: AppConfigService) {
    const env = getEnv();
    this.client = new SlideClient({ apiKey: env.SLIDE_API_KEY, baseUrl: env.SLIDE_BASE_URL });
    this.widgetId = env.SLIDE_OTP_WIDGET_ID;
  }

  async send(mobileNumber: string): Promise<SlideSendResult> {
    return this.call(() => this.client.otp.send({ widgetId: this.widgetId, identifier: mobileNumber }), {
      onValidationError: () =>
        new HttpException(
          {
            code: IDENTITY_ERROR_CODES.OTP_SEND_FAILED,
            message: 'Could not send a verification code to this number. Please check the number and try again.',
          },
          HttpStatus.BAD_REQUEST,
        ),
      // A 404 on a fresh send has nothing to do with an expired challenge
      // (there isn't one yet) — it means the widget itself is misconfigured.
      // Not something the caller can act on; log it and treat as our fault.
      onNotFoundError: () => {
        this.logger.error('Slide otp.send returned 404 — check SLIDE_OTP_WIDGET_ID is a valid widget id.');
        return unavailable();
      },
    });
  }

  /** Resends under the SAME `requestId` — Slide's own resend cooldown/max apply on top of ours. */
  async retry(requestId: string): Promise<SlideSendResult> {
    return this.call(() => this.client.otp.retry({ requestId }), {
      onValidationError: () =>
        new HttpException(
          { code: IDENTITY_ERROR_CODES.OTP_RESEND_FAILED, message: 'Could not resend the code. Please request a new one.' },
          HttpStatus.BAD_REQUEST,
        ),
    });
  }

  async verify(requestId: string, otp: string): Promise<SlideVerifyResult> {
    return this.call(() => this.client.otp.verify({ requestId, otp }), {
      // One generic message for invalid/expired/blocked-at-Slide alike —
      // distinguishing them is free reconnaissance to an attacker and
      // nothing in the SRS asks for it.
      onValidationError: () =>
        new HttpException(
          { code: IDENTITY_ERROR_CODES.INVALID_OTP, message: 'The code you entered is incorrect or has expired.' },
          HttpStatus.BAD_REQUEST,
        ),
    });
  }

  /** Single-use — Slide consumes the token on this call. Never call this more than once per accessToken, and never retry it. */
  async verifyToken(accessToken: string): Promise<SlideVerifyTokenResult> {
    return this.call(() => this.client.otp.verifyToken({ accessToken }), {
      onValidationError: () =>
        new HttpException(
          { code: IDENTITY_ERROR_CODES.INVALID_OTP, message: 'Verification failed. Please try again.' },
          HttpStatus.BAD_REQUEST,
        ),
    });
  }

  private async call<T>(fn: () => Promise<T>, overrides: CallOverrides): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw await this.mapError(error, overrides);
    }
  }

  /**
   * No retries anywhere in this service — the user can press resend for
   * `send`/`retry`, and `verifyToken` is single-use so a retry after a
   * timeout could destroy a legitimate session.
   */
  private async mapError(error: unknown, overrides: CallOverrides): Promise<HttpException> {
    if (error instanceof SlideValidationError) {
      return overrides.onValidationError(error);
    }

    if (error instanceof SlideNotFoundError) {
      if (overrides.onNotFoundError) {
        return overrides.onNotFoundError(error);
      }
      return new HttpException(
        {
          code: IDENTITY_ERROR_CODES.CHALLENGE_EXPIRED,
          message: 'This OTP request has expired. Please request a new code.',
        },
        HttpStatus.GONE,
      );
    }

    if (error instanceof SlideError && error.statusCode === 429) {
      // The SDK's error body carries no Retry-After header — the client
      // gets our own configured constant instead.
      const retryAfterSeconds = await this.appConfig.getNumber(
        IDENTITY_APP_CONFIG_KEYS.OTP_PROVIDER_RETRY_AFTER_SECONDS,
        IDENTITY_APP_CONFIG_DEFAULTS[IDENTITY_APP_CONFIG_KEYS.OTP_PROVIDER_RETRY_AFTER_SECONDS],
      );
      this.logger.warn(`Slide OTP API rate limited (429) — advising client retry after ${retryAfterSeconds}s.`);
      return new HttpException(
        {
          code: IDENTITY_ERROR_CODES.OTP_RATE_LIMITED,
          message: 'Too many OTP requests. Please try again shortly.',
          retryAfterSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // Never surface a vendor auth/scope failure to the caller — it is
    // never their fault, and it advertises the integration.
    if (error instanceof SlideAuthError) {
      this.logger.error('Slide API key rejected (401) — check SLIDE_API_KEY.');
      return unavailable();
    }

    if (error instanceof SlideScopeError) {
      this.logger.error(`Slide API key missing a required scope (otp:send / otp:verify): ${error.message}`);
      return unavailable();
    }

    if (error instanceof SlideError) {
      this.logger.error(`Slide OTP API error (${error.statusCode}): ${error.message}`);
      return unavailable();
    }

    const message = error instanceof Error ? error.message : String(error);
    this.logger.error(`Unexpected error calling the Slide OTP API: ${message}`);
    return unavailable();
  }
}

function unavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    code: IDENTITY_ERROR_CODES.OTP_PROVIDER_UNAVAILABLE,
    message: 'OTP delivery is temporarily unavailable. Please try again shortly.',
  });
}
