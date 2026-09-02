import type { ZodSchema } from 'zod';

/**
 * One structured-output request. There is no free-text completion method and
 * no streaming, on purpose: every consumer this module exists for (M-09's
 * AI-assisted symptom search first) needs a SHAPE back — a specialty, a set
 * of concerns, a risk flag — not prose. Making the schema mandatory means the
 * caller can never receive something it then has to parse defensively, and it
 * is what lets an adapter choose native structured output or JSON-mode
 * prompting without the caller knowing or caring.
 */
export interface AiCompletionRequest<T> {
  system: string;
  user: string;
  schema: ZodSchema<T>;
  /** Overrides `agent_profiles.config.maxTokens` for this call. */
  maxTokens?: number;
}

export interface AiCompletionResult<T> {
  value: T;
  /** Which `agent_profiles` row actually served the call — the one that succeeded, not the one that was tried first. */
  profileId: string;
  /** The vendor model id that served it, for the caller's own logging/telemetry. */
  model: string;
  latencyMs: number;
}

/**
 * The AI gateway's public surface — every other module talks to it through
 * this, never through `agent_profiles`/`agent_credentials`, an adapter, or
 * the rotation service directly (`backend/README.md` §2).
 *
 * Kept to two methods on purpose. Everything this module actually does —
 * choosing a profile, decrypting a key, rotating past a dead one, applying
 * cooldowns, recording health — is deliberately invisible here. A caller that
 * could see any of it would end up depending on it, and the whole point is
 * that the caller gets a completion as long as ANY working key exists and
 * cannot tell which one it came from.
 *
 * Note what is NOT here: no "list profiles", no "which provider will you
 * use", no way to pin a call to a specific credential. Those are admin
 * concerns, served by `ai-admin.controller.ts` under `ai.read`/`ai.manage`,
 * and exposing them on the contract would let a consuming module route
 * around rotation.
 */
export interface AiContract {
  /** True when at least one active, non-cooled-down credential exists. Cheap — for a kill-switch/health check, not a live probe. */
  isAvailable(): Promise<boolean>;

  /** Structured output only. Throws AI_UNAVAILABLE only when every candidate is exhausted. */
  completeStructured<T>(req: AiCompletionRequest<T>): Promise<AiCompletionResult<T>>;
}
