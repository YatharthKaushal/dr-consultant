import type { ZodType } from 'zod';

/**
 * *** THE M-09 -> AI-MODULE SEAM. READ BEFORE TOUCHING. ***
 *
 * `modules/ai` is being built in a parallel worktree and does not exist in
 * this one, so a direct `import from '../ai/ai.contract'` would not compile.
 * This file declares the interface LOCALLY and binds it to the
 * `SEARCH_AI_PORT` DI token (`search.constants.ts`) — the same pattern
 * `availability.contract.ts` uses for `BusyIntervalProvider` (declared
 * locally, bound to `BUSY_INTERVAL_PROVIDER`, currently satisfied by a
 * placeholder because M-11 doesn't exist yet) and `shared/auth/auth.types.ts`
 * uses for `AuthContextResolver`.
 *
 * The three types below are a VERBATIM mirror of `modules/ai`'s own fixed
 * signature. Because TypeScript is structural, `AiFacade` will satisfy
 * `SearchAiPort` with no adapter, no cast and no change on either side — the
 * coordinator binds it at the token and this file can then be deleted or
 * kept as documentation. Do NOT "fix" this into a cross-module import of
 * `modules/ai`: `backend/README.md` §2 says a module's only public surface is
 * its facade, resolved through DI, and that is exactly what the token gives
 * us. If the AI module's signature ever changes, change it HERE too — a
 * structural mismatch will surface as a `tsc` error at the binding in
 * `search.module.ts`, which is the point.
 */

export interface AiCompletionRequest<T> {
  system: string;
  user: string;
  schema: ZodType<T>;
  maxTokens?: number;
}

export interface AiCompletionResult<T> {
  value: T;
  profileId: string;
  model: string;
  latencyMs: number;
}

export interface SearchAiPort {
  /** Cheap probe: is any credential currently usable. Never throws. */
  isAvailable(): Promise<boolean>;

  /**
   * Throws with error code `AI_UNAVAILABLE` once every credential is
   * exhausted, and may throw for any other provider-side reason.
   *
   * *** `query-interpreter.service.ts` MUST catch ANY throw from this and
   * fall back to the deterministic matcher. *** An AI failure is never a
   * patient-visible error: the patient asked where to go for help, and
   * "where to go for help" is answerable from the curated taxonomy alone.
   */
  completeStructured<T>(request: AiCompletionRequest<T>): Promise<AiCompletionResult<T>>;
}
