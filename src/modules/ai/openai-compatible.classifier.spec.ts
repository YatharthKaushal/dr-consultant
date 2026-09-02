import { OpenAiCompatibleClassifier } from './openai-compatible.classifier';

/**
 * Fixtures modelled on what `openai@7.9.0` actually throws, verified against
 * the installed SDK's own `core/error.js`: the vendor body's `code`/`type`
 * are LIFTED onto the error, `error` holds the UNWRAPPED `body.error`,
 * `headers` is a real `Headers`, and `message` is `` `${status} ${body
 * message}` ``.
 *
 * Where LangChain mutates the error on its way out (a Troubleshooting URL
 * appended to `message`, an `lc_error_code` added, `name` overwritten on a
 * 429), the fixtures carry those too — the classifier sees the mutated
 * object in production, so testing the pristine SDK shape alone would test a
 * thing that never reaches it.
 */
function openAiError(params: {
  status?: number;
  code?: string | null;
  type?: string;
  message: string;
  headers?: Record<string, string> | Headers;
  lc_error_code?: string;
  name?: string;
  retryAfterMs?: number;
}): Record<string, unknown> {
  const { message, headers, ...rest } = params;
  return {
    ...rest,
    message,
    headers,
    error: { message, type: params.type ?? null, param: null, code: params.code ?? null },
  };
}

/** The suffix `@langchain/openai` appends to recognised errors. Present so the tests prove message matching survives it. */
const LC_SUFFIX = '\n\nTroubleshooting URL: https://docs.langchain.com/oss/javascript/langchain/errors/MODEL_AUTHENTICATION/\n';

describe('OpenAiCompatibleClassifier', () => {
  const classifier = new OpenAiCompatibleClassifier();

  describe('invalid_key', () => {
    it('classifies a 401 with code invalid_api_key', () => {
      const result = classifier.classify(
        openAiError({
          status: 401,
          code: 'invalid_api_key',
          type: 'invalid_request_error',
          message: `401 Incorrect API key provided: sk-pr***. You can find your API key at https://platform.openai.com/account/api-keys.${LC_SUFFIX}`,
          lc_error_code: 'MODEL_AUTHENTICATION',
        }),
      );

      expect(result.kind).toBe('invalid_key');
      expect(result.detail).toContain('Incorrect API key provided');
    });

    it('classifies a bare 401 from a third-party host with no code at all', () => {
      // Groq/Together/DeepSeek do not always populate `code`.
      expect(classifier.classify(openAiError({ status: 401, message: '401 Invalid API Key' }).valueOf()).kind).toBe(
        'invalid_key',
      );
    });

    it('falls back to lc_error_code when LangChain dropped the status', () => {
      expect(
        classifier.classify({ lc_error_code: 'MODEL_AUTHENTICATION', message: 'authentication failed' }).kind,
      ).toBe('invalid_key');
    });
  });

  describe('insufficient_quota — distinguished from a plain rate limit', () => {
    it('classifies a 429 carrying code insufficient_quota', () => {
      const result = classifier.classify(
        openAiError({
          status: 429,
          code: 'insufficient_quota',
          type: 'insufficient_quota',
          message:
            '429 You exceeded your current quota, please check your plan and billing details. For more information on this error, read the docs.',
        }),
      );

      expect(result.kind).toBe('insufficient_quota');
    });

    it('classifies a 429 whose only signal is the message (a host that omits `code`)', () => {
      expect(
        classifier.classify(openAiError({ status: 429, message: '429 Your credit balance is too low.' })).kind,
      ).toBe('insufficient_quota');
    });

    it('classifies DeepSeek/OpenRouter 402 Payment Required as quota, not unknown', () => {
      expect(classifier.classify(openAiError({ status: 402, message: '402 Insufficient Balance' })).kind).toBe(
        'insufficient_quota',
      );
    });

    it('does NOT mistake a per-minute rate limit for quota exhaustion', () => {
      // The single most important distinction in this file: these two arrive
      // as the same HTTP status and need opposite cooldowns.
      const result = classifier.classify(
        openAiError({
          status: 429,
          code: 'rate_limit_exceeded',
          type: 'requests',
          message:
            '429 Rate limit reached for gpt-4o in organization org-abc on requests per min (RPM): Limit 500, Used 500. Please try again in 120ms.',
        }),
      );

      expect(result.kind).toBe('rate_limited');
    });
  });

  describe('rate_limited and retryAfterMs', () => {
    it('reads Retry-After (seconds) from a real Headers instance', () => {
      const result = classifier.classify(
        openAiError({
          status: 429,
          code: 'rate_limit_exceeded',
          message: '429 Rate limit reached',
          headers: new Headers({ 'retry-after': '20' }),
        }),
      );

      expect(result.kind).toBe('rate_limited');
      expect(result.retryAfterMs).toBe(20_000);
    });

    it('prefers OpenAI’s non-standard retry-after-ms over the whole-second header', () => {
      const result = classifier.classify(
        openAiError({
          status: 429,
          message: '429 Rate limit reached',
          headers: { 'retry-after': '1', 'retry-after-ms': '350' },
        }),
      );

      expect(result.retryAfterMs).toBe(350);
    });

    it('prefers LangChain’s already-normalised retryAfterMs above all headers', () => {
      const result = classifier.classify(
        openAiError({ status: 429, message: '429 Rate limit reached', retryAfterMs: 4_500, headers: { 'retry-after': '9' } }),
      );

      expect(result.retryAfterMs).toBe(4_500);
    });

    it('omits retryAfterMs entirely when the vendor gave no hint', () => {
      const result = classifier.classify(openAiError({ status: 429, message: '429 Rate limit reached' }));

      expect(result.kind).toBe('rate_limited');
      expect(result.retryAfterMs).toBeUndefined();
    });

    it('ignores a nonsensical negative Retry-After rather than cooling down into the past', () => {
      const result = classifier.classify(
        openAiError({ status: 429, message: '429 Rate limit reached', headers: { 'retry-after': '-30' } }),
      );

      expect(result.retryAfterMs).toBeUndefined();
    });
  });

  describe('context_length — must never rotate', () => {
    it('classifies a 400 with code context_length_exceeded', () => {
      const result = classifier.classify(
        openAiError({
          status: 400,
          code: 'context_length_exceeded',
          type: 'invalid_request_error',
          message:
            "400 This model's maximum context length is 128000 tokens. However, your messages resulted in 190000 tokens. Please reduce the length of the messages.",
        }),
      );

      expect(result.kind).toBe('context_length');
    });

    it('classifies LangChain’s ContextOverflowError, which has NO status or code left', () => {
      // The reason the context check runs before every status branch.
      const result = classifier.classify({
        name: 'ContextOverflowError',
        lc_error_code: 'CONTEXT_OVERFLOW',
        message: 'Input tokens exceed the configured limit',
      });

      expect(result.kind).toBe('context_length');
    });
  });

  describe('content_filtered — must never rotate', () => {
    it('classifies an Azure-style content_filter code', () => {
      const result = classifier.classify(
        openAiError({
          status: 400,
          code: 'content_filter',
          type: 'invalid_request_error',
          message:
            "400 The response was filtered due to the prompt triggering Azure OpenAI's content management policy.",
        }),
      );

      expect(result.kind).toBe('content_filtered');
    });

    it('classifies the SDK’s ContentFilterFinishReasonError by message', () => {
      expect(
        classifier.classify({
          name: 'ContentFilterFinishReasonError',
          message: 'Could not parse response content as the request was rejected by the content filter',
        }).kind,
      ).toBe('content_filtered');
    });
  });

  describe('model_unavailable', () => {
    it('classifies a 404 model-not-found', () => {
      expect(
        classifier.classify(
          openAiError({
            status: 404,
            code: 'model_not_found',
            message: '404 The model `gpt-9-turbo` does not exist or you do not have access to it.',
            lc_error_code: 'MODEL_NOT_FOUND',
          }),
        ).kind,
      ).toBe('model_unavailable');
    });

    it('classifies a 403 (this key cannot use this model/region)', () => {
      expect(
        classifier.classify(
          openAiError({ status: 403, message: '403 Country, region, or territory not supported' }),
        ).kind,
      ).toBe('model_unavailable');
    });
  });

  describe('timeout', () => {
    it('classifies LangChain’s replacement plain Error (name TimeoutError, no status)', () => {
      // `instanceof APIConnectionTimeoutError` is FALSE here — LangChain
      // rebuilt the error. `name` is the only signal left.
      expect(classifier.classify({ name: 'TimeoutError', message: 'Request timed out.' }).kind).toBe('timeout');
    });

    it('classifies a raw APIConnectionTimeoutError that never went through LangChain', () => {
      expect(
        classifier.classify({ name: 'APIConnectionTimeoutError', message: 'Request timed out.' }).kind,
      ).toBe('timeout');
    });

    it('classifies a 408', () => {
      expect(classifier.classify(openAiError({ status: 408, message: '408 Request Timeout' })).kind).toBe('timeout');
    });
  });

  describe('transient', () => {
    it('classifies a 500', () => {
      expect(
        classifier.classify(
          openAiError({ status: 500, message: '500 The server had an error while processing your request.' }),
        ).kind,
      ).toBe('transient');
    });

    it('classifies a 503 from an overloaded gateway', () => {
      expect(classifier.classify(openAiError({ status: 503, message: '503 Service Unavailable' })).kind).toBe(
        'transient',
      );
    });

    it('classifies a connection failure with no status at all', () => {
      expect(classifier.classify({ name: 'APIConnectionError', message: 'Connection error.' }).kind).toBe('transient');
    });

    it('classifies a socket-level Node error', () => {
      expect(classifier.classify({ code: 'ECONNRESET', message: 'socket hang up' }).kind).toBe('transient');
    });

    it('classifies a 502 whose body was HTML, not JSON', () => {
      // The SDK leaves `.error`/`.code` undefined when the body is unparseable.
      expect(classifier.classify({ status: 502, message: '502 <html>502 Bad Gateway</html>' }).kind).toBe('transient');
    });
  });

  describe('unknown', () => {
    it('classifies an unrecognised 4xx as unknown — never as benign', () => {
      const result = classifier.classify(openAiError({ status: 418, message: "418 I'm a teapot" }));

      expect(result.kind).toBe('unknown');
      expect(result.detail).toContain('teapot');
    });

    it('classifies an error object with no recognisable fields', () => {
      expect(classifier.classify({}).kind).toBe('unknown');
    });

    it('classifies a thrown string', () => {
      expect(classifier.classify('something went sideways').kind).toBe('unknown');
    });

    it('classifies null/undefined without throwing', () => {
      expect(classifier.classify(null).kind).toBe('unknown');
      expect(classifier.classify(undefined).kind).toBe('unknown');
    });
  });

  describe('detail', () => {
    it('collapses whitespace and truncates very long vendor text', () => {
      const result = classifier.classify(openAiError({ status: 418, message: `400 ${'x'.repeat(1_000)}` }));

      expect(result.detail.length).toBeLessThanOrEqual(301);
      expect(result.detail.endsWith('…')).toBe(true);
    });
  });
});
