import { AnthropicClassifier } from './anthropic.classifier';

/**
 * Fixtures modelled on what `@anthropic-ai/sdk@0.120.0` actually throws,
 * verified against the installed SDK's `core/error.js` and
 * `resources/shared.d.ts`. Two shapes here differ from OpenAI's and would
 * each silently break a classifier that assumed the OpenAI layout:
 *
 *   - `err.error` is the WHOLE body (`{ type: "error", error: {...},
 *     request_id }`), NOT the unwrapped inner object. The discriminator is
 *     one level deeper.
 *   - `err.message` is the SERIALISED JSON body prefixed with the status,
 *     because `makeMessage` looks for a top-level `message` field that
 *     Anthropic's body does not have. It is not a sentence.
 */
function anthropicError(params: {
  status?: number;
  type?: string;
  vendorMessage?: string;
  headers?: Record<string, string> | Headers;
  lc_error_code?: string;
}): Record<string, unknown> {
  const body = {
    type: 'error',
    error: { type: params.type, message: params.vendorMessage ?? '' },
    request_id: 'req_011CS1',
  };
  return {
    status: params.status,
    // The SDK lifts `body.error.type` to the top level as `type`.
    type: params.type,
    error: body,
    headers: params.headers,
    message: `${params.status} ${JSON.stringify(body)}`,
    lc_error_code: params.lc_error_code,
  };
}

describe('AnthropicClassifier', () => {
  const classifier = new AnthropicClassifier();

  describe('invalid_key', () => {
    it('classifies authentication_error', () => {
      const result = classifier.classify(
        anthropicError({ status: 401, type: 'authentication_error', vendorMessage: 'invalid x-api-key' }),
      );

      expect(result.kind).toBe('invalid_key');
    });

    it('classifies a raw response body that never went through the SDK', () => {
      // A gateway that returns Anthropic's JSON verbatim: no `status`, no
      // lifted `type`, just the body. The nested-path fallback has to find it.
      const result = classifier.classify({
        type: 'error',
        error: { type: 'authentication_error', message: 'invalid x-api-key' },
      });

      expect(result.kind).toBe('invalid_key');
    });

    it('falls back to a bare 401 when the body carried no type', () => {
      expect(classifier.classify({ status: 401, message: '401 Unauthorized' }).kind).toBe('invalid_key');
    });
  });

  describe('insufficient_quota', () => {
    it('classifies billing_error — Anthropic’s explicit "this account cannot be charged"', () => {
      const result = classifier.classify(
        anthropicError({
          status: 400,
          type: 'billing_error',
          vendorMessage: 'Your credit balance is too low to access the Anthropic API.',
        }),
      );

      expect(result.kind).toBe('insufficient_quota');
    });

    it('classifies a low-balance invalid_request_error by message', () => {
      const result = classifier.classify(
        anthropicError({
          status: 400,
          type: 'invalid_request_error',
          vendorMessage:
            'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
        }),
      );

      expect(result.kind).toBe('insufficient_quota');
    });
  });

  describe('rate_limited', () => {
    it('classifies rate_limit_error and reads Retry-After', () => {
      const result = classifier.classify(
        anthropicError({
          status: 429,
          type: 'rate_limit_error',
          vendorMessage: 'Number of request tokens has exceeded your per-minute rate limit.',
          headers: new Headers({ 'retry-after': '13' }),
        }),
      );

      expect(result.kind).toBe('rate_limited');
      expect(result.retryAfterMs).toBe(13_000);
    });

    it('classifies rate_limit_error with no Retry-After and carries no hint', () => {
      const result = classifier.classify(
        anthropicError({ status: 429, type: 'rate_limit_error', vendorMessage: 'rate limit' }),
      );

      expect(result.kind).toBe('rate_limited');
      expect(result.retryAfterMs).toBeUndefined();
    });
  });

  describe('transient', () => {
    it('classifies overloaded_error, which the SDK maps to InternalServerError not an overload class', () => {
      // HTTP 529. Classifying on the ERROR CLASS would mislabel this; the
      // typed `error.type` is the reliable signal.
      const result = classifier.classify(
        anthropicError({ status: 529, type: 'overloaded_error', vendorMessage: 'Overloaded' }),
      );

      expect(result.kind).toBe('transient');
    });

    it('classifies api_error', () => {
      expect(
        classifier.classify(anthropicError({ status: 500, type: 'api_error', vendorMessage: 'Internal server error' }))
          .kind,
      ).toBe('transient');
    });

    it('classifies a 5xx with no typed body at all', () => {
      expect(classifier.classify({ status: 502, message: '502 Bad Gateway' }).kind).toBe('transient');
    });

    it('classifies a connection failure', () => {
      expect(classifier.classify({ name: 'APIConnectionError', message: 'Connection error.' }).kind).toBe('transient');
    });
  });

  describe('model_unavailable', () => {
    it('classifies not_found_error', () => {
      expect(
        classifier.classify(
          anthropicError({
            status: 404,
            type: 'not_found_error',
            vendorMessage: 'model: claude-nonexistent-1',
          }),
        ).kind,
      ).toBe('model_unavailable');
    });

    it('classifies permission_error', () => {
      expect(
        classifier.classify(
          anthropicError({
            status: 403,
            type: 'permission_error',
            vendorMessage: 'Your API key does not have permission to use the specified resource.',
          }),
        ).kind,
      ).toBe('model_unavailable');
    });
  });

  describe('context_length — must never rotate', () => {
    it('classifies the "prompt is too long" invalid_request_error', () => {
      const result = classifier.classify(
        anthropicError({
          status: 400,
          type: 'invalid_request_error',
          vendorMessage: 'prompt is too long: 250000 tokens > 200000 maximum',
        }),
      );

      expect(result.kind).toBe('context_length');
    });

    it('classifies LangChain’s ContextOverflowError, which lost the status on conversion', () => {
      expect(
        classifier.classify({
          name: 'ContextOverflowError',
          lc_error_code: 'CONTEXT_OVERFLOW',
          message: 'prompt is too long',
        }).kind,
      ).toBe('context_length');
    });
  });

  describe('content_filtered — must never rotate', () => {
    it('classifies a refusal, which Anthropic has no error TYPE for', () => {
      // Anthropic signals a refusal with `stop_reason: "refusal"` on a
      // SUCCESSFUL response; the adapter surfaces it as an error carrying the
      // word. Message matching is the only signal that exists.
      expect(
        classifier.classify({ message: 'Model returned stop_reason "refusal" and produced no structured output.' })
          .kind,
      ).toBe('content_filtered');
    });
  });

  describe('timeout', () => {
    it('classifies timeout_error', () => {
      expect(
        classifier.classify(anthropicError({ status: 504, type: 'timeout_error', vendorMessage: 'Request timeout' }))
          .kind,
      ).toBe('timeout');
    });

    it('classifies an aborted request', () => {
      expect(classifier.classify({ name: 'AbortError', message: 'Request was aborted.' }).kind).toBe('timeout');
    });
  });

  describe('unknown', () => {
    it('rotates (does not fail fast) on a generic invalid_request_error', () => {
      // Deliberate: the two invalid_request cases that must NOT rotate
      // (oversized prompt, refusal) are caught by message shape above. What
      // is left is most often a vendor-specific schema-translation problem,
      // and another provider may well accept the same zod schema.
      const result = classifier.classify(
        anthropicError({
          status: 400,
          type: 'invalid_request_error',
          vendorMessage: 'tools.0.custom.input_schema: Extra inputs are not permitted',
        }),
      );

      expect(result.kind).toBe('unknown');
    });

    it('classifies an unrecognised error object', () => {
      expect(classifier.classify({ status: 418, message: "418 I'm a teapot" }).kind).toBe('unknown');
    });

    it('handles null without throwing', () => {
      expect(classifier.classify(null).kind).toBe('unknown');
    });
  });
});
