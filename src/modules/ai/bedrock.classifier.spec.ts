import { ServiceUnavailableException } from '@nestjs/common';
import { BedrockClassifier } from './bedrock.classifier';
import { AI_ERROR_CODES } from './ai.constants';

/**
 * Fixtures modelled on AWS SDK v3 errors: the modelled exception name on
 * `name`, the HTTP status under `$metadata.httpStatusCode` (NOT on the error
 * itself), and `$fault` marking client vs server.
 *
 * `BedrockAdapter` is a stub today, so only the last block here exercises a
 * code path that runs in this build. The rest is tested anyway because the
 * whole design claim is that finishing Bedrock is ONE file — a classifier
 * written later, under pressure, alongside a live integration is exactly the
 * thing this module is trying not to produce.
 */
function awsError(params: { name: string; message: string; httpStatusCode?: number; fault?: 'client' | 'server' }): Record<string, unknown> {
  return {
    name: params.name,
    message: params.message,
    $fault: params.fault ?? (params.httpStatusCode !== undefined && params.httpStatusCode >= 500 ? 'server' : 'client'),
    $metadata: {
      httpStatusCode: params.httpStatusCode,
      requestId: '9d2f4b0e-1a3c-4d5e-8f90-abcdef123456',
      attempts: 1,
      totalRetryDelay: 0,
    },
  };
}

describe('BedrockClassifier', () => {
  const classifier = new BedrockClassifier();

  describe('the stub adapter’s own refusal', () => {
    it('classifies PROVIDER_NOT_CONFIGURED as model_unavailable, so rotation skips the profile and carries on', () => {
      // Uses the REAL Nest exception the adapter throws, not a stand-in — the
      // body lives under `response`, and this asserts the classifier reaches
      // it there.
      const error = new ServiceUnavailableException({
        code: AI_ERROR_CODES.PROVIDER_NOT_CONFIGURED,
        message: 'AWS Bedrock is not configured in this build.',
      });

      expect(classifier.classify(error).kind).toBe('model_unavailable');
    });

    it('also recognises the body shape directly', () => {
      expect(
        classifier.classify({ code: AI_ERROR_CODES.PROVIDER_NOT_CONFIGURED, message: 'not configured' }).kind,
      ).toBe('model_unavailable');
    });
  });

  describe('invalid_key', () => {
    it('classifies AccessDeniedException', () => {
      expect(
        classifier.classify(
          awsError({
            name: 'AccessDeniedException',
            message: 'You don’t have access to the model with the specified model ID.',
            httpStatusCode: 403,
          }),
        ).kind,
      ).toBe('invalid_key');
    });

    it('classifies UnrecognizedClientException (a bad access key id)', () => {
      expect(
        classifier.classify(
          awsError({
            name: 'UnrecognizedClientException',
            message: 'The security token included in the request is invalid.',
            httpStatusCode: 403,
          }),
        ).kind,
      ).toBe('invalid_key');
    });

    it('classifies ExpiredTokenException', () => {
      expect(
        classifier.classify(
          awsError({ name: 'ExpiredTokenException', message: 'The security token has expired.', httpStatusCode: 403 }),
        ).kind,
      ).toBe('invalid_key');
    });

    it('classifies a credential-resolution failure that never reached AWS', () => {
      expect(
        classifier.classify({ name: 'CredentialsProviderError', message: 'Could not load credentials from any providers' })
          .kind,
      ).toBe('invalid_key');
    });
  });

  describe('rate_limited', () => {
    it('classifies ThrottlingException', () => {
      const result = classifier.classify(
        awsError({
          name: 'ThrottlingException',
          message: 'Too many requests, please wait before trying again.',
          httpStatusCode: 429,
        }),
      );

      expect(result.kind).toBe('rate_limited');
    });

    it('still classifies a 429 whose name LangChain overwrote', () => {
      // The trap documented on the class: `@langchain/core` renames 429
      // errors, and `ThrottlingException` IS a 429. The status branch has to
      // stand on its own.
      const throttled = awsError({ name: 'ThrottlingException', message: 'Too many requests', httpStatusCode: 429 });

      expect(classifier.classify({ ...throttled, name: 'RateLimitCapacityError' }).kind).toBe('rate_limited');
    });
  });

  describe('insufficient_quota', () => {
    it('classifies ServiceQuotaExceededException', () => {
      expect(
        classifier.classify(
          awsError({
            name: 'ServiceQuotaExceededException',
            message: 'Your account has reached its service quota for this model.',
            httpStatusCode: 400,
          }),
        ).kind,
      ).toBe('insufficient_quota');
    });
  });

  describe('model_unavailable', () => {
    it('classifies ResourceNotFoundException', () => {
      expect(
        classifier.classify(
          awsError({
            name: 'ResourceNotFoundException',
            message: 'Could not resolve the foundation model from the provided model identifier.',
            httpStatusCode: 404,
          }),
        ).kind,
      ).toBe('model_unavailable');
    });

    it('classifies ModelNotReadyException', () => {
      expect(
        classifier.classify(
          awsError({ name: 'ModelNotReadyException', message: 'Model not ready', httpStatusCode: 429 }),
        ).kind,
      ).toBe('model_unavailable');
    });
  });

  describe('context_length — must never rotate', () => {
    it('classifies an oversized-input ValidationException', () => {
      expect(
        classifier.classify(
          awsError({
            name: 'ValidationException',
            message: 'Input is too long for requested model.',
            httpStatusCode: 400,
          }),
        ).kind,
      ).toBe('context_length');
    });
  });

  describe('content_filtered — must never rotate', () => {
    it('classifies a Guardrails refusal', () => {
      expect(
        classifier.classify(
          awsError({
            name: 'ValidationException',
            message: 'The request was blocked by the configured safety policy (guardrail).',
            httpStatusCode: 400,
          }),
        ).kind,
      ).toBe('content_filtered');
    });
  });

  describe('timeout', () => {
    it('classifies ModelTimeoutException', () => {
      expect(
        classifier.classify(
          awsError({ name: 'ModelTimeoutException', message: 'The request took too long', httpStatusCode: 408 }),
        ).kind,
      ).toBe('timeout');
    });
  });

  describe('transient', () => {
    it('classifies InternalServerException', () => {
      expect(
        classifier.classify(
          awsError({ name: 'InternalServerException', message: 'An internal server error occurred.', httpStatusCode: 500 }),
        ).kind,
      ).toBe('transient');
    });

    it('classifies ModelErrorException', () => {
      expect(
        classifier.classify(
          awsError({ name: 'ModelErrorException', message: 'The model produced an error', httpStatusCode: 424 }),
        ).kind,
      ).toBe('transient');
    });

    it('classifies an unmodelled server fault', () => {
      expect(classifier.classify({ name: 'SomeFutureException', message: 'boom', $fault: 'server' }).kind).toBe(
        'transient',
      );
    });
  });

  describe('unknown', () => {
    it('rotates on a generic ValidationException rather than failing fast', () => {
      expect(
        classifier.classify(
          awsError({
            name: 'ValidationException',
            message: 'The value at toolConfig.tools failed to satisfy constraint.',
            httpStatusCode: 400,
          }),
        ).kind,
      ).toBe('unknown');
    });

    it('handles an unrecognised error object', () => {
      expect(classifier.classify({}).kind).toBe('unknown');
    });

    it('handles null without throwing', () => {
      expect(classifier.classify(null).kind).toBe('unknown');
    });
  });
});
