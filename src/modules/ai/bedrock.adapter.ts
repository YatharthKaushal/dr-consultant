import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { BedrockClassifier } from './bedrock.classifier';
import { AI_ERROR_CODES } from './ai.constants';
import type { LlmCompletionParams, LlmProviderAdapter, ProviderErrorClassifier } from './llm-provider.types';

/**
 * AWS Bedrock — DELIBERATELY A STUB. It is registered, it classifies errors,
 * and it refuses every call with `PROVIDER_NOT_CONFIGURED`.
 *
 * Two independent reasons, either of which alone would justify it:
 *
 * 1. **Cost of the dependency.** `@langchain/aws@1.4.5` pulls
 *    `@aws-sdk/client-bedrock-runtime`, `@aws-sdk/client-bedrock-agent-
 *    runtime`, `@aws-sdk/credential-provider-node` AND
 *    `@aws-sdk/client-kendra` — Kendra being an unrelated enterprise-search
 *    product. Measured on this tree: **102 packages**, including the entire
 *    esbuild platform-binary matrix (android/darwin/freebsd/win32), against
 *    **22 packages** for `@langchain/openai` + `@langchain/anthropic` +
 *    `@langchain/google-genai` combined. That is a five-fold increase in
 *    third-party surface for a provider the client has not asked for, in a
 *    healthcare backend where every dependency is an audit liability.
 *
 * 2. **Bedrock does not fit this module's credential model, and that is the
 *    stronger reason.** Every other provider here authenticates with ONE
 *    opaque string, which is exactly what `agent_credentials.encrypted_key`
 *    stores. Bedrock authenticates with SigV4: an access key id, a secret
 *    access key, optionally a session token, and a region — which is not one
 *    secret but a small structured credential, and the region is not a secret
 *    at all (it belongs on the profile, next to `base_url`). Wiring it in
 *    would mean either packing several fields into one encrypted blob (a
 *    format nothing validates and the admin panel cannot render) or adding
 *    columns that only one of four providers uses. Neither is a decision to
 *    make in passing while building the other three; it is a schema change
 *    with its own admin UI, and it should be made when someone actually wants
 *    Bedrock.
 *
 * What this stub is NOT: a hole in rotation. `BedrockClassifier` maps this
 * refusal to `model_unavailable`, so a Bedrock profile behaves exactly like a
 * decommissioned model — rotation cools it down and moves to the next
 * candidate rather than failing the request. A deployment with a Bedrock
 * profile plus a working OpenAI profile serves completions normally.
 *
 * Finishing it is one file plus one dependency. `BedrockClassifier` is
 * already written and tested against the real AWS SDK v3 error shapes
 * (`ThrottlingException`, `AccessDeniedException`, `ValidationException`,
 * `$metadata.httpStatusCode`), so the work left is this class's `complete`
 * and the credential-shape decision above — nothing else in the module
 * changes, which is the design working as intended.
 */
@Injectable()
export class BedrockAdapter implements LlmProviderAdapter {
  readonly provider = 'bedrock' as const;
  readonly classifier: ProviderErrorClassifier = new BedrockClassifier();

  /** Always throws. `async` so the refusal arrives as a rejected promise, exactly like a real provider failure — rotation's `catch` handles both identically. */
  async complete<T>(_params: LlmCompletionParams<T>): Promise<T> {
    throw new ServiceUnavailableException({
      code: AI_ERROR_CODES.PROVIDER_NOT_CONFIGURED,
      message:
        'AWS Bedrock is not configured in this build. Install @langchain/aws and implement BedrockAdapter.complete, or use another provider.',
    });
  }
}
