import { GoogleGenAiClassifier } from './google-genai.classifier';

/**
 * Fixtures modelled on what `@google/generative-ai@0.24.1` actually throws
 * (verified against its `dist/index.js` `handleResponseNotOk`), which is
 * materially less than the REST API returns:
 *
 *   - the SDK reads the body, keeps `error.message` and `error.details`, and
 *     DISCARDS `error.status` (`RESOURCE_EXHAUSTED`, `PERMISSION_DENIED`,
 *     `INVALID_ARGUMENT`, ...) and `error.code`. Those canonical status
 *     strings never reach a classifier, so nothing here may depend on them.
 *   - the message is a fixed template:
 *     `[GoogleGenerativeAI Error]: Error fetching from <url>: [<status>
 *      <statusText>] <message> <details JSON>`
 *   - there are NO headers on the error at all, so `Retry-After` is
 *     unreadable for this provider.
 */
function googleFetchError(params: {
  status: number;
  statusText: string;
  vendorMessage: string;
  reasons?: string[];
}): Record<string, unknown> {
  const details = params.reasons?.map((reason) => ({
    '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
    reason,
    domain: 'googleapis.com',
    metadata: { service: 'generativelanguage.googleapis.com' },
  }));

  const url =
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=AIzaSyFAKEKEYVALUE1234';

  return {
    name: 'GoogleGenerativeAIFetchError',
    status: params.status,
    statusText: params.statusText,
    errorDetails: details,
    message: `[GoogleGenerativeAI Error]: Error fetching from ${url}: [${params.status} ${params.statusText}] ${params.vendorMessage}${details ? ` ${JSON.stringify(details)}` : ''}`,
  };
}

describe('GoogleGenAiClassifier', () => {
  const classifier = new GoogleGenAiClassifier();

  describe('invalid_key — Gemini returns 400, not 401', () => {
    it('classifies a 400 carrying reason API_KEY_INVALID', () => {
      // The trap this provider sets: a classifier written against the other
      // two vendors' 401 convention would call this `unknown` and give a dead
      // key a 60-second cooldown instead of the long one it has earned.
      const result = classifier.classify(
        googleFetchError({
          status: 400,
          statusText: 'Bad Request',
          vendorMessage: 'API key not valid. Please pass a valid API key.',
          reasons: ['API_KEY_INVALID'],
        }),
      );

      expect(result.kind).toBe('invalid_key');
    });

    it('classifies a blocked API key (referrer/IP restriction)', () => {
      expect(
        classifier.classify(
          googleFetchError({
            status: 403,
            statusText: 'Forbidden',
            vendorMessage: 'Requests from referer are blocked.',
            reasons: ['API_KEY_HTTP_REFERRER_BLOCKED'],
          }),
        ).kind,
      ).toBe('invalid_key');
    });

    it('classifies by message when the details array is absent', () => {
      expect(
        classifier.classify(
          googleFetchError({
            status: 400,
            statusText: 'Bad Request',
            vendorMessage: 'API key not valid. Please pass a valid API key.',
          }),
        ).kind,
      ).toBe('invalid_key');
    });

    it('still classifies a 401, for a proxy that normalises the status', () => {
      expect(
        classifier.classify(googleFetchError({ status: 401, statusText: 'Unauthorized', vendorMessage: 'Unauthorized' }))
          .kind,
      ).toBe('invalid_key');
    });
  });

  describe('rate_limited vs insufficient_quota — both arrive as 429', () => {
    it('classifies a per-minute limit as rate_limited', () => {
      const result = classifier.classify(
        googleFetchError({
          status: 429,
          statusText: 'Too Many Requests',
          vendorMessage: 'Resource has been exhausted (e.g. check quota).',
          reasons: ['RATE_LIMIT_EXCEEDED'],
        }),
      );

      expect(result.kind).toBe('rate_limited');
    });

    it('carries NO retryAfterMs — a Gemini fetch error has no headers at all', () => {
      const result = classifier.classify(
        googleFetchError({ status: 429, statusText: 'Too Many Requests', vendorMessage: 'Resource has been exhausted' }),
      );

      expect(result.retryAfterMs).toBeUndefined();
    });

    it('still honours a retryAfterMs LangChain managed to parse out of the message', () => {
      const base = googleFetchError({
        status: 429,
        statusText: 'Too Many Requests',
        vendorMessage: 'Please retry in 31.5s',
      });

      expect(classifier.classify({ ...base, retryAfterMs: 31_500 }).retryAfterMs).toBe(31_500);
    });

    it('classifies an exhausted billing quota as insufficient_quota', () => {
      const result = classifier.classify(
        googleFetchError({
          status: 429,
          statusText: 'Too Many Requests',
          vendorMessage:
            'You exceeded your current quota, please check your plan and billing details.',
          reasons: ['RATE_LIMIT_EXCEEDED'],
        }),
      );

      expect(result.kind).toBe('insufficient_quota');
    });

    it('classifies BILLING_DISABLED as insufficient_quota', () => {
      expect(
        classifier.classify(
          googleFetchError({
            status: 403,
            statusText: 'Forbidden',
            vendorMessage: 'Billing has not been enabled for this project.',
            reasons: ['BILLING_DISABLED'],
          }),
        ).kind,
      ).toBe('insufficient_quota');
    });
  });

  describe('model_unavailable', () => {
    it('classifies a 404 for a decommissioned model', () => {
      expect(
        classifier.classify(
          googleFetchError({
            status: 404,
            statusText: 'Not Found',
            vendorMessage: 'models/gemini-1.0-pro is not found for API version v1beta.',
          }),
        ).kind,
      ).toBe('model_unavailable');
    });

    it('classifies SERVICE_DISABLED', () => {
      expect(
        classifier.classify(
          googleFetchError({
            status: 403,
            statusText: 'Forbidden',
            vendorMessage: 'Generative Language API has not been used in project 123 before or it is disabled.',
            reasons: ['SERVICE_DISABLED'],
          }),
        ).kind,
      ).toBe('model_unavailable');
    });

    it('classifies a plain 403 PERMISSION_DENIED', () => {
      expect(
        classifier.classify(
          googleFetchError({
            status: 403,
            statusText: 'Forbidden',
            vendorMessage: 'The caller does not have permission to use this model.',
          }),
        ).kind,
      ).toBe('model_unavailable');
    });
  });

  describe('context_length — must never rotate', () => {
    it('classifies an oversized-prompt 400', () => {
      expect(
        classifier.classify(
          googleFetchError({
            status: 400,
            statusText: 'Bad Request',
            vendorMessage:
              'The input token count (1300000) exceeds the maximum number of tokens allowed (1048575).',
          }),
        ).kind,
      ).toBe('context_length');
    });
  });

  describe('content_filtered — must never rotate', () => {
    it('classifies a SAFETY block', () => {
      expect(
        classifier.classify({
          name: 'GoogleGenerativeAIResponseError',
          message:
            '[GoogleGenerativeAI Error]: Text not available. Response was blocked due to SAFETY. Blocked reason: SAFETY',
        }).kind,
      ).toBe('content_filtered');
    });

    it('classifies a PROHIBITED_CONTENT finish reason', () => {
      expect(
        classifier.classify({
          name: 'GoogleGenerativeAIResponseError',
          message: 'Candidate was blocked due to PROHIBITED_CONTENT',
        }).kind,
      ).toBe('content_filtered');
    });
  });

  describe('transient', () => {
    it('classifies a 503 UNAVAILABLE — Gemini’s most common failure under load', () => {
      expect(
        classifier.classify(
          googleFetchError({
            status: 503,
            statusText: 'Service Unavailable',
            vendorMessage: 'The model is overloaded. Please try again later.',
          }),
        ).kind,
      ).toBe('transient');
    });

    it('classifies a 500 INTERNAL', () => {
      expect(
        classifier.classify(
          googleFetchError({ status: 500, statusText: 'Internal Server Error', vendorMessage: 'An internal error has occurred.' }),
        ).kind,
      ).toBe('transient');
    });

    it('classifies a bare GoogleGenerativeAIError from a connection failure, which carries NO status', () => {
      // The SDK does not produce a `GoogleGenerativeAIFetchError` for a
      // transport failure — this branch is load-bearing for Gemini, not
      // defensive padding.
      expect(
        classifier.classify({
          name: 'GoogleGenerativeAIError',
          message:
            '[GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/models/x:generateContent: fetch failed',
        }).kind,
      ).toBe('transient');
    });
  });

  describe('timeout', () => {
    it('classifies an aborted request', () => {
      expect(
        classifier.classify({ name: 'GoogleGenerativeAIAbortError', message: 'Request aborted' }).kind,
      ).toBe('timeout');
    });
  });

  describe('unknown', () => {
    it('classifies a generic 400 as unknown (rotate) rather than fail-fast', () => {
      const result = classifier.classify(
        googleFetchError({
          status: 400,
          statusText: 'Bad Request',
          vendorMessage: 'Invalid JSON payload received. Unknown name "responseSchemaX".',
        }),
      );

      expect(result.kind).toBe('unknown');
    });

    it('handles an error with no recognisable fields', () => {
      expect(classifier.classify({}).kind).toBe('unknown');
    });

    it('handles null without throwing', () => {
      expect(classifier.classify(null).kind).toBe('unknown');
    });
  });

  describe('detail', () => {
    it('still contains the API key — which is exactly why callers must redact it', () => {
      // Documented as a test rather than a comment: Gemini puts the key in a
      // `?key=` query parameter and the SDK embeds the full URL in the
      // message. `ai-rotation.service.ts` scrubs this with `redactSecret()`
      // before it reaches a log line or an admin response. If this
      // expectation ever fails, the redaction step may have become
      // unnecessary — verify before removing it.
      const result = classifier.classify(
        googleFetchError({ status: 400, statusText: 'Bad Request', vendorMessage: 'API key not valid.', reasons: ['API_KEY_INVALID'] }),
      );

      expect(result.detail).toContain('AIzaSyFAKEKEYVALUE1234');
    });
  });
});
