import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { Injectable } from '@nestjs/common';
import { GoogleGenAiClassifier } from './google-genai.classifier';
import type { LlmCompletionParams, LlmProviderAdapter, ProviderErrorClassifier } from './llm-provider.types';
import { invokeNativeStructured } from './llm-structured-output.util';

/**
 * Google Gemini, via `@langchain/google-genai@2.3.0` -> the legacy
 * `@google/generative-ai@0.24.1` SDK.
 *
 * STRUCTURED OUTPUT: native only, via `jsonSchema` — which for this provider
 * means Gemini's own `responseSchema` + `responseMimeType:
 * "application/json"`, a first-class API feature rather than a prompt
 * convention. It is also the only sensible choice: this SDK REJECTS
 * `method: "jsonMode"` outright (it throws rather than falling back), so a
 * JSON-mode path here would be a compile-time-plausible, runtime-impossible
 * branch.
 *
 * Option-name differences from the other two adapters, every one of them a
 * silent no-op if got wrong (these are plain optional fields — a typo does
 * not fail to compile, it just gets ignored):
 *   - `maxOutputTokens`, NOT `maxTokens`. There is no `maxTokens` option.
 *   - `baseUrl` with a lowercase `u`, NOT `baseURL` and not nested under
 *     `configuration`.
 *   - NO `timeout` option at all. The per-call `{ timeout }` passed to
 *     `invoke` is the only way to bound a Gemini request, and
 *     `invokeNativeStructured` always passes it.
 *   - `maxRetries` must be set on the CONSTRUCTOR. Unlike the other two, this
 *     model does not forward a per-call `maxRetries` — `completionWithRetry`
 *     forwards only `{ signal }` — so the constructor is the only place it
 *     takes effect.
 *
 * `temperature` is validated 0–2 by the SDK constructor, which THROWS outside
 * that range. `AgentProfileConfigDto` enforces the same bounds, so a stored
 * profile cannot reach here out of range.
 */
@Injectable()
export class GoogleGenAiAdapter implements LlmProviderAdapter {
  readonly provider = 'google_genai' as const;
  readonly classifier: ProviderErrorClassifier = new GoogleGenAiClassifier();

  async complete<T>(params: LlmCompletionParams<T>): Promise<T> {
    const model = new ChatGoogleGenerativeAI({
      apiKey: params.apiKey,
      model: params.model,
      temperature: params.temperature,
      maxOutputTokens: params.maxTokens,
      // Rotation owns retries. Constructor-only for this provider — see the
      // class comment.
      maxRetries: 0,
      // Honoured here (unlike in the Anthropic adapter) because Google
      // publishes regional and proxy endpoints for this API that are
      // legitimately worth pointing a profile at.
      ...(params.baseUrl ? { baseUrl: params.baseUrl } : {}),
    });

    return invokeNativeStructured(model, params, 'jsonSchema');
  }
}
