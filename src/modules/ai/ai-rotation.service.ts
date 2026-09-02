import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { AgentCredentialRow } from '../../schema/agent-credentials.schema';
import { AppConfigService } from '../../shared/app-config/app-config.service';
import { AgentCredentialRepository, type RotationCandidate } from './agent-credential.repository';
import { redactSecret } from './ai-redaction.util';
import { AiCryptoService } from './ai-crypto.service';
import {
  AI_CONFIG_FALLBACKS,
  AI_CONFIG_KEYS,
  AI_ERROR_CODES,
  AI_MAX_ATTEMPTS_PER_REQUEST,
  AI_TRANSIENT_RETRY_BASE_MS,
  AI_TRANSIENT_RETRY_MAX_MS,
  type LlmFailureKind,
} from './ai.constants';
import type { AiCompletionRequest, AiCompletionResult } from './ai.contract';
import { isProviderNotConfiguredError } from './llm-error.util';
import { LlmProviderRegistry } from './llm-provider.registry';
import type { LlmCompletionParams, LlmFailure } from './llm-provider.types';

/**
 * Failures that will fail IDENTICALLY on every other provider, so rotating is
 * pure waste — a second, third and fourth billed call that cannot succeed.
 * The request itself is the problem: the prompt does not fit any context
 * window, or every mainstream safety layer refuses it.
 */
const FAIL_FAST_KINDS: ReadonlySet<LlmFailureKind> = new Set<LlmFailureKind>(['context_length', 'content_filtered']);

/**
 * Failures worth ONE more go on the SAME credential before moving on. A blip
 * (a reset connection, a 503 under load, a slow first token) says nothing
 * about the key, and rotating away from a perfectly good key on the first
 * hiccup would drain the priority order for no reason.
 */
const RETRY_SAME_CREDENTIAL_KINDS: ReadonlySet<LlmFailureKind> = new Set<LlmFailureKind>(['transient', 'timeout']);

/** One attempt's outcome. `ok: false` always carries a classified failure — the vendor error itself never leaves this file. */
type AttemptOutcome<T> =
  | { ok: true; value: T; latencyMs: number }
  | {
      ok: false;
      failure: LlmFailure;
      latencyMs: number;
      /** The adapter refused before any call was made (today: the `BedrockAdapter` stub). Carried separately from `failure.kind` because it is a DEPLOYMENT problem, not a provider one. */
      providerNotConfigured: boolean;
    };

/** What `POST /admin/ai/credentials/:id/test` needs back. `detail` is already redacted. */
export interface CredentialProbeOutcome {
  ok: boolean;
  failureKind: LlmFailureKind | null;
  detail: string | null;
  latencyMs: number;
  /** True when no call was attempted because this build has no working client for the profile's provider. The caller answers 503 `PROVIDER_NOT_CONFIGURED` rather than reporting a provider failure that never happened. */
  providerNotConfigured: boolean;
}

/**
 * The heart of the module: turn "call an LLM" into "call an LLM as long as
 * ANY working key exists".
 *
 * The candidate list is every active credential of every active profile,
 * ordered `(profile.priority, credential.priority, credential.id)` — cheapest
 * provider first, preferred key first within it, and a stable tiebreak so the
 * same configuration always tries the same key first and a failure is
 * reproducible.
 *
 * Policy per classified failure, and the reasoning for each:
 *
 *   | kind                | rotate? | retry same key? | cooldown              |
 *   |---------------------|---------|-----------------|-----------------------|
 *   | transient, timeout  | after 1 | yes, once       | none                  |
 *   | rate_limited        | now     | no              | Retry-After, else 60s |
 *   | insufficient_quota  | now     | no              | 15 min                |
 *   | invalid_key         | now     | no              | 15 min                |
 *   | model_unavailable   | now     | no              | 60s                   |
 *   | unknown             | now     | no              | 60s                   |
 *   | context_length      | NO      | no              | none                  |
 *   | content_filtered    | NO      | no              | none                  |
 *
 * `invalid_key` and `insufficient_quota` get the LONG cooldown because
 * neither fixes itself on a per-minute timescale: a revoked key stays revoked
 * and an empty balance stays empty until a human acts. Retrying them every 60
 * seconds would be the "hammering a dead key" this module exists to avoid,
 * and it is billed to the client at actuals.
 *
 * `transient`/`timeout` get NO cooldown: the one same-credential retry has
 * already happened, and sidelining a healthy key for a minute over a blip
 * would slowly drain the preferred end of the priority order.
 *
 * ────────────────────────────────────────────────────────────────────────
 * NEVER AUTO-DISABLE A CREDENTIAL. Nothing in this file — or anywhere else in
 * this module — writes `agent_credentials.is_active`. Enable/disable is the
 * ADMIN'S decision, exclusively.
 *
 * This is not caution, it is the correct behaviour, and it will look like a
 * missing feature to someone reading `consecutive_failures` and thinking "we
 * should turn it off after ten". Do not add it. A key that fails ten times in
 * a row is very often a key behind a provider having a bad hour, and the
 * consequence of getting it wrong is asymmetric: `cooldown_until` expires by
 * itself and costs nothing, while `is_active = false` is invisible until an
 * admin happens to look at the panel — by which point the client's AI
 * features have been silently degraded for however long it took someone to
 * notice. Cooldown is the automatic mechanism. Disabling is not.
 * ────────────────────────────────────────────────────────────────────────
 */
@Injectable()
export class AiRotationService {
  private readonly logger = new Logger(AiRotationService.name);

  constructor(
    private readonly credentialRepo: AgentCredentialRepository,
    private readonly registry: LlmProviderRegistry,
    private readonly crypto: AiCryptoService,
    private readonly appConfig: AppConfigService,
  ) {}

  /**
   * Cheap "is there any point calling us" check, backing
   * `AiContract.isAvailable`. Deliberately reuses the same candidate query
   * and the same cooldown predicate the real call uses, rather than a
   * hand-written `COUNT(*)` with the predicate inlined: two implementations
   * of "usable credential" would eventually disagree, and the one that
   * disagreed silently would be this one.
   */
  async isAvailable(): Promise<boolean> {
    const candidates = await this.credentialRepo.listRotationCandidates();
    return this.usableCandidates(candidates, new Date()).length > 0;
  }

  /** See the class comment for the full policy table. */
  async completeStructured<T>(req: AiCompletionRequest<T>): Promise<AiCompletionResult<T>> {
    const all = await this.credentialRepo.listRotationCandidates();
    const usable = this.usableCandidates(all, new Date());

    if (usable.length === 0) {
      throw this.unavailable(0, null);
    }

    // Bounded: a client with fifty dead keys must not turn one search into
    // fifty upstream calls and a multi-minute hang. The ones not reached this
    // time are not skipped forever — they carry no cooldown, so the next
    // request starts from the top of the same order.
    const attempts = usable.slice(0, AI_MAX_ATTEMPTS_PER_REQUEST);
    let lastKind: LlmFailureKind | null = null;

    for (const candidate of attempts) {
      const outcome = await this.attemptWithRetry(candidate, req);

      if (outcome.ok) {
        return {
          value: outcome.value,
          profileId: candidate.profile.id,
          model: candidate.profile.model,
          latencyMs: outcome.latencyMs,
        };
      }

      lastKind = outcome.failure.kind;

      if (FAIL_FAST_KINDS.has(outcome.failure.kind)) {
        // Every remaining candidate would fail the same way. Stop, and answer
        // with a 4xx that says the REQUEST is the problem — a caller that
        // retried this against a 503 would loop forever.
        throw new BadRequestException({
          code: AI_ERROR_CODES.AI_REQUEST_INVALID,
          message:
            outcome.failure.kind === 'context_length'
              ? 'The request is too long for the configured model.'
              : 'The request was refused by the provider’s content policy.',
          failureKind: outcome.failure.kind,
        });
      }
    }

    throw this.unavailable(attempts.length, lastKind);
  }

  /**
   * One live probe of one credential, for the admin credential-test endpoint.
   * Records health exactly like a real attempt — the point of the button is
   * to find out whether the key works AND to clear a stale cooldown when it
   * turns out it does.
   *
   * No same-credential retry here, unlike `completeStructured`: the admin
   * asked what happens when we call with this key, and answering with the
   * result of a second, hidden call would be a less honest answer.
   */
  async probe<T>(candidate: RotationCandidate, req: AiCompletionRequest<T>): Promise<CredentialProbeOutcome> {
    const outcome = await this.attemptOnce(candidate, req);

    if (outcome.ok) {
      return {
        ok: true,
        failureKind: null,
        detail: null,
        latencyMs: outcome.latencyMs,
        providerNotConfigured: false,
      };
    }
    return {
      ok: false,
      failureKind: outcome.failure.kind,
      detail: outcome.failure.detail,
      latencyMs: outcome.latencyMs,
      providerNotConfigured: outcome.providerNotConfigured,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Candidate selection                                                     */
  /* ---------------------------------------------------------------------- */

  /**
   * The candidate list minus the two things that make a row unusable RIGHT
   * NOW, in the order the repository returned.
   *
   *   - cooling down: `cooldown_until` in the future. The only automatic
   *     take-out-of-rotation mechanism there is.
   *   - unserviceable: `agent_profiles.provider` has no adapter in this
   *     build. Skipped rather than fatal, so one row restored from a dump
   *     written by a newer build cannot take down every completion.
   */
  private usableCandidates(candidates: RotationCandidate[], now: Date): RotationCandidate[] {
    return candidates.filter((candidate) => {
      if (isCoolingDown(candidate.credential, now)) return false;

      if (this.registry.find(candidate.profile.provider) === null) {
        this.logger.warn(
          `Skipping agent profile ${candidate.profile.id}: no adapter for provider "${candidate.profile.provider}".`,
        );
        return false;
      }
      return true;
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Attempts                                                                */
  /* ---------------------------------------------------------------------- */

  /** One candidate, with the single same-credential retry a `transient`/`timeout` earns. */
  private async attemptWithRetry<T>(
    candidate: RotationCandidate,
    req: AiCompletionRequest<T>,
  ): Promise<AttemptOutcome<T>> {
    const first = await this.attemptOnce(candidate, req);
    if (first.ok || !RETRY_SAME_CREDENTIAL_KINDS.has(first.failure.kind)) {
      return first;
    }

    // Jittered so a burst of concurrent requests that all hit the same blip
    // do not all come back at the same instant and reproduce it.
    await delay(jitteredBackoffMs());

    return this.attemptOnce(candidate, req);
  }

  /**
   * One call. Decrypts, dispatches, classifies, and records health — and is
   * the ONLY place a plaintext key exists, for the duration of this method.
   */
  private async attemptOnce<T>(candidate: RotationCandidate, req: AiCompletionRequest<T>): Promise<AttemptOutcome<T>> {
    const { credential, profile } = candidate;
    const startedAt = Date.now();

    const adapter = this.registry.find(profile.provider);
    if (!adapter) {
      // Unreachable from `completeStructured` (filtered out already), but the
      // probe path reaches this method directly.
      const failure: LlmFailure = {
        kind: 'model_unavailable',
        detail: `No adapter for provider "${profile.provider}".`,
      };
      await this.recordFailure(credential, failure);
      return { ok: false, failure, latencyMs: Date.now() - startedAt, providerNotConfigured: true };
    }

    let apiKey: string;
    try {
      apiKey = this.crypto.decrypt(credential.encryptedKey);
    } catch (error) {
      // A credential we cannot decrypt is a credential we cannot use — a
      // rotated master key, or a corrupted row. Classified as `invalid_key`
      // so it earns the long cooldown and rotation moves on, rather than
      // failing the whole request over one bad row. The message deliberately
      // says nothing about the ciphertext.
      const failure: LlmFailure = {
        kind: 'invalid_key',
        detail: `Stored credential could not be decrypted: ${error instanceof Error ? error.message : 'unknown error'}`,
      };
      this.logger.error(
        `Credential ${credential.id} (profile ${profile.id}) could not be decrypted — check AI_CREDENTIAL_ENCRYPTION_KEY.`,
      );
      await this.recordFailure(credential, failure);
      return { ok: false, failure, latencyMs: Date.now() - startedAt, providerNotConfigured: false };
    }

    try {
      const params = await this.buildParams(candidate, req, apiKey);
      const value = await adapter.complete(params);
      const latencyMs = Date.now() - startedAt;

      await this.recordSuccess(credential);
      return { ok: true, value, latencyMs };
    } catch (error) {
      const raw = adapter.classifier.classify(error);
      // Vendor error text is not trusted to be free of key material — Google
      // puts the API key in a query parameter, so an error echoing a request
      // URL echoes the key. Scrubbed HERE, with the key that was actually
      // used, because this is the only scope where both halves are known.
      const failure: LlmFailure = {
        ...raw,
        detail: redactSecret(raw.detail, apiKey, credential.keyLast4),
      };

      this.logger.warn(
        `LLM attempt failed [profile=${profile.id} credential=${credential.id} key=****${credential.keyLast4} kind=${failure.kind}]: ${failure.detail}`,
      );

      await this.recordFailure(credential, failure);
      return {
        ok: false,
        failure,
        latencyMs: Date.now() - startedAt,
        providerNotConfigured: isProviderNotConfiguredError(error, AI_ERROR_CODES.PROVIDER_NOT_CONFIGURED),
      };
    }
  }

  /** Resolves the per-call knobs: the request wins over the profile, the profile wins over `app_config`, `app_config` wins over the compiled-in fallback. */
  private async buildParams<T>(
    candidate: RotationCandidate,
    req: AiCompletionRequest<T>,
    apiKey: string,
  ): Promise<LlmCompletionParams<T>> {
    const { profile } = candidate;
    const config = profile.config ?? {};

    const timeoutMs =
      config.timeoutMs ??
      (await this.appConfig.getNumber(AI_CONFIG_KEYS.REQUEST_TIMEOUT_MS, AI_CONFIG_FALLBACKS.REQUEST_TIMEOUT_MS));

    return {
      system: req.system,
      user: req.user,
      schema: req.schema,
      model: profile.model,
      apiKey,
      baseUrl: profile.baseUrl,
      temperature: config.temperature,
      maxTokens: req.maxTokens ?? config.maxTokens,
      timeoutMs,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Health bookkeeping — best-effort, never fatal                           */
  /* ---------------------------------------------------------------------- */

  /**
   * BEST-EFFORT, deliberately — the same discipline `AuditService`'s
   * no-transaction mode uses, and for the same reason.
   *
   * A completion that SUCCEEDED and then failed to write `last_succeeded_at`
   * must still be returned to the caller. Throwing here would turn a working
   * LLM call the client has already been billed for into a 500, because a
   * bookkeeping row would not write. The failure is logged and swallowed; the
   * worst consequence is a stale health column until the next attempt.
   */
  private async recordSuccess(credential: AgentCredentialRow): Promise<void> {
    try {
      await this.credentialRepo.recordSuccess(credential.id, new Date());
    } catch (error) {
      this.logger.error(
        `Failed to record success for credential ${credential.id} (best-effort, swallowed): ${messageOf(error)}`,
      );
    }
  }

  /** Same best-effort contract as `recordSuccess` — a failed health write must never change what the caller sees. */
  private async recordFailure(credential: AgentCredentialRow, failure: LlmFailure): Promise<void> {
    try {
      const now = new Date();
      const cooldownUntil = await this.cooldownUntil(failure, now);
      await this.credentialRepo.recordFailure(credential.id, { at: now, kind: failure.kind, cooldownUntil });
    } catch (error) {
      this.logger.error(
        `Failed to record failure for credential ${credential.id} (best-effort, swallowed): ${messageOf(error)}`,
      );
    }
  }

  /**
   * When this credential becomes eligible again, or `null` for a failure that
   * earns no cooldown. See the policy table in the class comment.
   *
   * A vendor-supplied `retryAfterMs` is always preferred — the vendor knows
   * when its own limit clears and we are guessing — but is still capped at
   * `ai.max_cooldown_seconds`, so a buggy or hostile `Retry-After: 604800`
   * cannot park a working key for a week.
   */
  private async cooldownUntil(failure: LlmFailure, now: Date): Promise<Date | null> {
    const maxSeconds = await this.appConfig.getNumber(
      AI_CONFIG_KEYS.MAX_COOLDOWN_SECONDS,
      AI_CONFIG_FALLBACKS.MAX_COOLDOWN_SECONDS,
    );

    const seconds = await this.baseCooldownSeconds(failure);
    if (seconds === null) return null;

    const capped = Math.min(seconds, maxSeconds);
    return new Date(now.getTime() + capped * 1_000);
  }

  private async baseCooldownSeconds(failure: LlmFailure): Promise<number | null> {
    switch (failure.kind) {
      case 'invalid_key':
      case 'insufficient_quota':
        return this.appConfig.getNumber(
          AI_CONFIG_KEYS.HARD_FAILURE_COOLDOWN_SECONDS,
          AI_CONFIG_FALLBACKS.HARD_FAILURE_COOLDOWN_SECONDS,
        );

      case 'rate_limited':
        if (failure.retryAfterMs !== undefined) {
          // Ceil, not round: coming back a fraction of a second early is
          // another 429 and another cooldown.
          return Math.ceil(failure.retryAfterMs / 1_000);
        }
        return this.defaultCooldownSeconds();

      case 'model_unavailable':
      case 'unknown':
        return this.defaultCooldownSeconds();

      // Not the credential's fault, or already retried once — see the class
      // comment's policy table.
      case 'transient':
      case 'timeout':
      case 'context_length':
      case 'content_filtered':
        return null;
    }
  }

  private defaultCooldownSeconds(): Promise<number> {
    return this.appConfig.getNumber(
      AI_CONFIG_KEYS.DEFAULT_COOLDOWN_SECONDS,
      AI_CONFIG_FALLBACKS.DEFAULT_COOLDOWN_SECONDS,
    );
  }

  /**
   * 503, and the reasoning is in `ai.constants.ts`: nothing is broken in this
   * service, a third party is unusable, and the condition clears on its own.
   * `attempted` and `lastFailureKind` are safe to expose (neither is vendor
   * text) and are what an operator needs to tell "no keys configured" from
   * "six keys, all out of quota".
   */
  private unavailable(attempted: number, lastKind: LlmFailureKind | null): ServiceUnavailableException {
    this.logger.error(
      `AI unavailable: ${attempted} candidate(s) attempted, last failure kind: ${lastKind ?? 'none (no usable credentials)'}.`,
    );
    return new ServiceUnavailableException({
      code: AI_ERROR_CODES.AI_UNAVAILABLE,
      message: 'AI features are temporarily unavailable. Please try again shortly.',
      attempted,
      lastFailureKind: lastKind,
    });
  }
}

/** A credential is out of rotation while `cooldown_until` is in the future. A null column means "never cooled down". */
export function isCoolingDown(credential: AgentCredentialRow, now: Date): boolean {
  return credential.cooldownUntil !== null && credential.cooldownUntil.getTime() > now.getTime();
}

/** Base delay plus up to the same again, bounded — enough to decorrelate concurrent retries without making a request feel stalled. */
function jitteredBackoffMs(): number {
  const jittered = AI_TRANSIENT_RETRY_BASE_MS + Math.random() * AI_TRANSIENT_RETRY_BASE_MS;
  return Math.min(jittered, AI_TRANSIENT_RETRY_MAX_MS);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
