import { ChatOpenAI } from '@langchain/openai';
import { Injectable } from '@nestjs/common';
import type { LlmCompletionParams, LlmProviderAdapter, ProviderErrorClassifier } from './llm-provider.types';
import {
  invokeJsonPromptFallback,
  invokeNativeStructured,
  looksLikeUnsupportedStructuredOutput,
  type StructuredOutputMethod,
} from './llm-structured-output.util';
import { OpenAiCompatibleClassifier } from './openai-compatible.classifier';

/**
 * The highest-value adapter: one class for OpenAI itself and for every host
 * that speaks its wire format — Groq, OpenRouter, Together, DeepSeek, xAI,
 * Fireworks, Alibaba/DashScope and anything else with an `/v1/chat/
 * completions` endpoint. Pointing `agent_profiles.base_url` at the host is
 * the whole configuration; none of them needs code here.
 *
 * STRUCTURED OUTPUT — two paths, chosen by whether a `baseUrl` is set:
 *
 *   - **No `baseUrl` (real OpenAI): `jsonSchema`.** `response_format:
 *     { type: "json_schema" }` is OpenAI's strongest guarantee and its
 *     current models all implement it.
 *   - **A `baseUrl` (a third-party host): `functionCalling`.** This is the
 *     deliberate part. `jsonSchema` is LangChain's default and it is the
 *     WRONG default here: strict JSON-schema response formats are unevenly
 *     implemented across the compatible family (DeepSeek offers `json_object`
 *     only; OpenRouter's support depends on which upstream model a request is
 *     routed to; several hosts accept the parameter and ignore it). Tool
 *     calling is implemented near-universally by the same hosts, so it is the
 *     mechanism most likely to work on a host we have never seen.
 *
 * If the native attempt fails in a way that names a capability the host does
 * not have, it falls back ONCE to JSON-mode prompting on the same credential
 * (`invokeJsonPromptFallback`). That second call is gated narrowly — see
 * `looksLikeUnsupportedStructuredOutput` — because it costs the client
 * another billed request.
 *
 * `maxRetries: 0` is load-bearing, not tidiness. `@langchain/core`'s
 * `AsyncCaller` retries SIX times by default with exponential backoff, and on
 * a 429 carrying a `Retry-After` it SLEEPS in-process. Left at the default, a
 * dead key would burn seven upstream requests and tens of seconds before
 * rotation ever saw the failure, and the client would be billed for all
 * seven. Retry policy belongs to `ai-rotation.service.ts` alone.
 */
@Injectable()
export class OpenAiCompatibleAdapter implements LlmProviderAdapter {
  readonly provider = 'openai_compatible' as const;
  readonly classifier: ProviderErrorClassifier = new OpenAiCompatibleClassifier();

  async complete<T>(params: LlmCompletionParams<T>): Promise<T> {
    const model = this.buildModel(params);
    const method: StructuredOutputMethod = params.baseUrl ? 'functionCalling' : 'jsonSchema';

    try {
      return await invokeNativeStructured(model, params, method);
    } catch (error) {
      if (!looksLikeUnsupportedStructuredOutput(error)) {
        throw error;
      }
      // The host does not implement the mechanism. One more attempt, same
      // credential, prompting for JSON instead. If THIS throws, it throws —
      // the classifier sees the second error, which is the one that describes
      // the state we actually ended in.
      return invokeJsonPromptFallback(model, params);
    }
  }

  private buildModel<T>(params: LlmCompletionParams<T>): ChatOpenAI {
    return new ChatOpenAI({
      apiKey: params.apiKey,
      model: params.model,
      temperature: params.temperature,
      maxTokens: params.maxTokens,
      timeout: params.timeoutMs,
      // See the class comment — rotation owns retries.
      maxRetries: 0,
      // The base URL lives under `configuration`, NOT as a top-level
      // `baseURL`: `ChatOpenAI` forwards `configuration` verbatim to the
      // `openai` client's own `ClientOptions`, and a top-level `baseURL` is
      // silently ignored.
      ...(params.baseUrl ? { configuration: { baseURL: params.baseUrl } } : {}),
    });
  }
}
