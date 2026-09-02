import { ChatAnthropic } from '@langchain/anthropic';
import { Injectable } from '@nestjs/common';
import { AnthropicClassifier } from './anthropic.classifier';
import type { LlmCompletionParams, LlmProviderAdapter, ProviderErrorClassifier } from './llm-provider.types';
import { invokeNativeStructured } from './llm-structured-output.util';

/**
 * Anthropic's Messages API, via `@langchain/anthropic` -> `@anthropic-ai/sdk`.
 *
 * STRUCTURED OUTPUT: native only, via `functionCalling` — LangChain's own
 * default for this provider, and the right one. Anthropic's structured output
 * IS tool use: `withStructuredOutput` sends the zod schema as a single tool
 * definition with `tool_choice` forcing it, and every Claude model worth
 * configuring implements tool use. There is no JSON-mode fallback here
 * (unlike `OpenAiCompatibleAdapter`) because there is no second host to
 * accommodate: this adapter talks to exactly one vendor, and that vendor
 * implements the mechanism.
 *
 * `maxTokens` matters more here than elsewhere: Anthropic's API requires a
 * `max_tokens` on every request, so when the profile does not set one
 * LangChain substitutes a per-model default. Passing `undefined` through is
 * therefore safe and is what lets a profile leave the field unset.
 *
 * Two shape differences from `ChatOpenAI`, both verified against the
 * installed SDK rather than assumed:
 *   - there is NO top-level `timeout` option; it goes in `clientOptions`.
 *   - `clientOptions.apiKey` and `clientOptions.maxRetries` would be
 *     overwritten by the wrapper, so the API key is passed at the top level
 *     and retries are disabled the same way as everywhere else.
 */
@Injectable()
export class AnthropicAdapter implements LlmProviderAdapter {
  readonly provider = 'anthropic' as const;
  readonly classifier: ProviderErrorClassifier = new AnthropicClassifier();

  async complete<T>(params: LlmCompletionParams<T>): Promise<T> {
    const model = new ChatAnthropic({
      apiKey: params.apiKey,
      model: params.model,
      temperature: params.temperature,
      maxTokens: params.maxTokens,
      // Rotation owns retries — `@langchain/core` would otherwise retry six
      // times and sleep on a `Retry-After`. See `openai-compatible.adapter.ts`.
      maxRetries: 0,
      clientOptions: { timeout: params.timeoutMs },
    });

    // `agent_profiles.base_url` is deliberately ignored for this provider.
    // There is no Anthropic-compatible third-party host the way there is for
    // the OpenAI wire format, so honouring it would only let an admin point
    // Anthropic credentials at an arbitrary endpoint — an exfiltration path
    // for a live API key, in exchange for no capability anyone wants.
    return invokeNativeStructured(model, params, 'functionCalling');
  }
}
