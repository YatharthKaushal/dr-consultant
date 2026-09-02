import { BadRequestException, Injectable } from '@nestjs/common';
import { AnthropicAdapter } from './anthropic.adapter';
import { BedrockAdapter } from './bedrock.adapter';
import { AI_ERROR_CODES, PROVIDER_CODES, type ProviderCode } from './ai.constants';
import { GoogleGenAiAdapter } from './google-genai.adapter';
import type { LlmProviderAdapter } from './llm-provider.types';
import { OpenAiCompatibleAdapter } from './openai-compatible.adapter';

/**
 * `ProviderCode` -> adapter. The single place that knows which class serves
 * which provider.
 *
 * The map is typed `Record<ProviderCode, LlmProviderAdapter>`, which is the
 * whole trick: adding a code to `PROVIDER_CODES` without adding a line here
 * is a COMPILE ERROR, not a runtime surprise on the first request that
 * happens to select it. So "adding a provider is one new class and one
 * registry line" is enforced by the type system rather than by a comment
 * asking people to remember.
 *
 * The full checklist for a new provider, and it is genuinely all of it:
 *   1. one entry in `PROVIDER_CODES` (`ai.constants.ts`);
 *   2. one adapter class implementing `LlmProviderAdapter`, with its own
 *      classifier;
 *   3. one line in the constructor's map below, and the same class in
 *      `ai.module.ts`'s `providers` so Nest can inject it.
 * No migration (`agent_profiles.provider` is a bare `varchar` — see that
 * schema file), no DTO change (`@IsIn(PROVIDER_CODES)` picks it up), no
 * change to rotation, the facade, the controller or any mapper.
 */
@Injectable()
export class LlmProviderRegistry {
  private readonly adapters: Record<ProviderCode, LlmProviderAdapter>;

  constructor(
    openAiCompatible: OpenAiCompatibleAdapter,
    anthropic: AnthropicAdapter,
    googleGenAi: GoogleGenAiAdapter,
    bedrock: BedrockAdapter,
  ) {
    this.adapters = {
      openai_compatible: openAiCompatible,
      anthropic,
      google_genai: googleGenAi,
      bedrock,
    };
  }

  /**
   * The adapter for a stored `agent_profiles.provider` string, or `null` if
   * this build has none.
   *
   * Returns null rather than throwing because the caller that matters —
   * `ai-rotation.service.ts` — must SKIP a profile it cannot serve and carry
   * on with the rest of the candidate list. One unserviceable profile (a row
   * restored from a dump written by a newer build) must not take down every
   * completion. The admin-facing callers use `require()` instead, where a
   * clear 400 is the right answer.
   */
  find(provider: string): LlmProviderAdapter | null {
    return isProviderCode(provider) ? this.adapters[provider] : null;
  }

  /** As `find`, but throws the 400 `UNSUPPORTED_PROVIDER` an admin endpoint should answer with. */
  require(provider: string): LlmProviderAdapter {
    const adapter = this.find(provider);
    if (!adapter) {
      throw new BadRequestException({
        code: AI_ERROR_CODES.UNSUPPORTED_PROVIDER,
        message: `This build has no adapter for provider "${provider}". Supported providers: ${PROVIDER_CODES.join(', ')}.`,
      });
    }
    return adapter;
  }
}

function isProviderCode(value: string): value is ProviderCode {
  return (PROVIDER_CODES as readonly string[]).includes(value);
}
