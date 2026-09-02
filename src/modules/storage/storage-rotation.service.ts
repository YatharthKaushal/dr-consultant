import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  type OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { StorageProviderRow } from '../../schema/storage-providers.schema';
import { StorageProviderRepository } from './storage-provider.repository';
import { StorageProviderRegistry } from './storage-provider.registry';
import { parseStorageKey } from './storage-key.util';
import {
  STORAGE_COOLDOWN_SECONDS,
  STORAGE_DEFAULT_SIGNED_URL_EXPIRY_SECONDS,
  STORAGE_ERROR_CODES,
  STORAGE_MAX_ATTEMPTS_PER_REQUEST,
  STORAGE_MAX_FILE_SIZE_BYTES,
  STORAGE_TRANSIENT_RETRY_BASE_MS,
  STORAGE_TRANSIENT_RETRY_MAX_MS,
  type StorageFailureKind,
} from './storage.constants';
import type { StoreFileInput, StoredFileResult } from './storage.contract';
import type { StorageFailure, StorageProviderAdapter } from './storage-provider.types';

/** One attempt's outcome. `ok: false` always carries a classified failure — the vendor error itself never leaves this file, mirroring `ai-rotation.service.ts`'s `AttemptOutcome`. */
type AttemptOutcome<T> = { ok: true; value: T } | { ok: false; failure: StorageFailure };

/**
 * The heart of the module: turn "store this file" into "store this file as
 * long as ANY usable provider exists", and turn "fetch/delete this specific
 * object" into a clean, honest answer about the ONE provider that can
 * possibly serve it. Mirrors `ai-rotation.service.ts` closely — this is the
 * same shape of problem (multiple providers behind one facade, automatic
 * failover, health tracking, cooldowns) with a much smaller failure taxonomy
 * (`STORAGE_FAILURE_KINDS`, `storage.constants.ts`) because a blob store has
 * far fewer failure modes than an LLM vendor does.
 *
 * Candidate list for `store()`: every ACTIVE `storage_providers` row, ordered
 * by `priority` (S3 first by the seeded default), filtered to ones that are
 * not cooling down AND whose adapter reports `isConfigured()` — i.e. its
 * required environment credentials are actually present. A row `isActive:
 * true` in the database but missing its env vars is NOT usable; see
 * `onModuleInit` for the one-time boot warning and `usableCandidates` for why
 * that mismatch is silent on every subsequent request rather than logged
 * again and again.
 *
 * Policy per classified failure (`store()` only — see below for why
 * `getSignedUrl`/`delete` never reach this table at all):
 *
 *   | kind                 | rotate? | retry same provider? | cooldown |
 *   |----------------------|---------|-----------------------|----------|
 *   | network_or_timeout   | after 1 | yes, once             | none     |
 *   | invalid_credentials  | now     | no                    | 5 min    |
 *   | access_denied        | now     | no                    | 5 min    |
 *   | not_found            | now     | no                    | 5 min    |
 *   | unknown              | now     | no                    | 5 min    |
 *
 * `network_or_timeout` gets NO cooldown, same reasoning as AI's
 * `transient`/`timeout`: the one same-provider retry already happened, and
 * sidelining a healthy provider for five minutes over a blip would leave
 * only the secondary for that whole window over nothing the provider did
 * wrong. Every other kind is auth/config-shaped and will not fix itself on a
 * per-minute timescale, so it earns `STORAGE_COOLDOWN_SECONDS`.
 *
 * ────────────────────────────────────────────────────────────────────────
 * `getSignedUrl`/`delete` DO NOT ROTATE. They target a specific, already-
 * stored object whose provider is fixed by its key's `<provider>:` prefix
 * (`storage-key.util.ts`) — the object physically lives on ONE provider, so
 * there is no second candidate to fall back to the way `store()` has one. If
 * that provider is currently unusable (inactive, unconfigured, or cooling
 * down), the honest answer is `STORAGE_PROVIDER_UNAVAILABLE_FOR_KEY`, not a
 * retry against a provider that does not have the object. DO NOT "fix" this
 * into a fake rotation attempt later — there is nothing to rotate TO.
 * ────────────────────────────────────────────────────────────────────────
 *
 * `row.config` (bucket/region/endpoint, or cloudName) is read FRESH from the
 * repository on every call and handed to the adapter as-is — never cached on
 * this service or on an adapter instance. An admin editing the bucket via
 * `PATCH /admin/storage/providers/:id` takes effect on the very next
 * operation. This is a deliberate choice over caching-with-invalidation: a
 * `storage_providers` row is a handful of bytes behind a primary-key lookup
 * (`findByProvider`, a UNIQUE-indexed column), an admin edits it rarely, and
 * "always correct, one cheap query per operation" beats "usually correct,
 * plus an invalidation hook that has to be wired into every write path and
 * can be forgotten." See the matching note on `S3StorageAdapter#buildClient`.
 */
@Injectable()
export class StorageRotationService implements OnModuleInit {
  private readonly logger = new Logger(StorageRotationService.name);

  constructor(
    private readonly repo: StorageProviderRepository,
    private readonly registry: StorageProviderRegistry,
  ) {}

  /**
   * One-time boot check: an active provider row whose environment
   * credentials are missing is a deployment mistake worth surfacing loudly
   * ONCE, not on every request thereafter (`usableCandidates` skips it
   * silently on the request path — seeing the same warning on every upload
   * would drown out everything else in the log). Never throws: a missing
   * credential degrades that ONE provider, exactly like a failing call
   * would, and must not crash the server — see `env.validation.ts`'s
   * comment on why these four variables are optional, not required.
   */
  async onModuleInit(): Promise<void> {
    try {
      const rows = await this.repo.list();
      for (const row of rows) {
        if (!row.isActive) continue;

        const adapter = this.registry.find(row.provider);
        if (!adapter) continue; // No adapter for this provider string — defensive; unreachable through any write path this build offers.

        if (!adapter.isConfigured()) {
          this.logger.warn(
            `Storage provider "${row.provider}" is active in the database but its environment credentials are not set (see .env.example) — it will be skipped until configured.`,
          );
        }
      }
    } catch (error) {
      // Never block boot on this diagnostic — best-effort, same discipline as
      // every other health/bookkeeping write in this service.
      this.logger.warn(`Could not run the storage-provider configuration check at boot: ${messageOf(error)}`);
    }
  }

  /**
   * Cheap "is there any point calling us" check, backing
   * `StorageContract.isAvailable`. Reuses the same candidate query and
   * cooldown predicate `store()` uses, rather than a hand-written count with
   * the predicate inlined — two implementations of "usable provider" would
   * eventually disagree.
   */
  async isAvailable(): Promise<boolean> {
    const rows = await this.repo.listActive();
    return this.usableCandidates(rows, new Date()).length > 0;
  }

  /** See the class comment for the full policy table. */
  async store(input: StoreFileInput): Promise<StoredFileResult> {
    if (input.buffer.byteLength > STORAGE_MAX_FILE_SIZE_BYTES) {
      throw new BadRequestException({
        code: STORAGE_ERROR_CODES.STORAGE_FILE_TOO_LARGE,
        message: `The file is ${input.buffer.byteLength} bytes, which exceeds the ${STORAGE_MAX_FILE_SIZE_BYTES}-byte storage ceiling.`,
      });
    }

    const rows = await this.repo.listActive();
    const usable = this.usableCandidates(rows, new Date());

    if (usable.length === 0) {
      throw this.unavailable(0, null);
    }

    // Bounded — see `STORAGE_MAX_ATTEMPTS_PER_REQUEST`.
    const attempts = usable.slice(0, STORAGE_MAX_ATTEMPTS_PER_REQUEST);
    let lastKind: StorageFailureKind | null = null;

    for (const row of attempts) {
      const outcome = await this.attemptStoreWithRetry(row, input);

      if (outcome.ok) {
        return { storageKey: outcome.value.storageKey, sizeBytes: outcome.value.sizeBytes };
      }

      lastKind = outcome.failure.kind;
    }

    throw this.unavailable(attempts.length, lastKind);
  }

  /**
   * Resolves the provider from the key prefix and, if it is currently
   * usable, asks its adapter for a signed URL. Does NOT rotate — see the
   * class comment.
   */
  async getSignedUrl(storageKey: string, expirySeconds: number = STORAGE_DEFAULT_SIGNED_URL_EXPIRY_SECONDS): Promise<string> {
    const { provider, rest } = parseStorageKey(storageKey);
    const { row, adapter } = await this.requireUsableForKey(provider);

    try {
      const url = await adapter.getSignedUrl(rest, expirySeconds, row.config);
      await this.recordSuccess(row);
      return url;
    } catch (error) {
      const failure = adapter.classifier.classify(error);
      this.logger.warn(
        `Storage getSignedUrl failed [provider=${provider} id=${row.id} kind=${failure.kind}]: ${failure.detail}`,
      );
      await this.recordFailure(row, failure);
      throw this.operationFailed(failure);
    }
  }

  /** Resolves the provider from the key prefix and, if it is currently usable, asks its adapter to delete the object. Does NOT rotate — see the class comment. */
  async delete(storageKey: string): Promise<void> {
    const { provider, rest } = parseStorageKey(storageKey);
    const { row, adapter } = await this.requireUsableForKey(provider);

    try {
      await adapter.delete(rest, row.config);
      await this.recordSuccess(row);
    } catch (error) {
      const failure = adapter.classifier.classify(error);
      this.logger.warn(`Storage delete failed [provider=${provider} id=${row.id} kind=${failure.kind}]: ${failure.detail}`);
      await this.recordFailure(row, failure);
      throw this.operationFailed(failure);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Candidate selection                                                     */
  /* ---------------------------------------------------------------------- */

  /**
   * The candidate list minus the three things that make a row unusable RIGHT
   * NOW, in the order the repository returned (priority ascending):
   *   - cooling down: `cooldown_until` in the future.
   *   - unserviceable: `storage_providers.provider` has no adapter in this
   *     build (defensive — unreachable through any write path today).
   *   - unconfigured: the adapter's required env credentials are absent.
   *     Silent here on purpose — `onModuleInit` already warned once; warning
   *     again on every `store()` call would spam the log for an ongoing,
   *     already-known condition instead of a new one.
   */
  private usableCandidates(rows: StorageProviderRow[], now: Date): StorageProviderRow[] {
    return rows.filter((row) => {
      if (isCoolingDown(row, now)) return false;

      const adapter = this.registry.find(row.provider);
      if (!adapter) return false;

      return adapter.isConfigured();
    });
  }

  /** For `getSignedUrl`/`delete`: the specific provider a key names, and whether it is usable right now. Throws the honest `STORAGE_PROVIDER_UNAVAILABLE_FOR_KEY` rather than returning a nullable — every caller needs both the row and a live adapter to proceed, so there is no useful "not usable" value short of throwing. */
  private async requireUsableForKey(provider: string): Promise<{ row: StorageProviderRow; adapter: StorageProviderAdapter }> {
    const row = await this.repo.findByProvider(provider);
    const adapter = this.registry.find(provider);

    if (!row || !adapter || !row.isActive || isCoolingDown(row, new Date()) || !adapter.isConfigured()) {
      this.logger.warn(
        `Storage provider "${provider}" is currently unusable (missing row, inactive, unconfigured, or cooling down) — cannot serve a key stored there.`,
      );
      throw new ServiceUnavailableException({
        code: STORAGE_ERROR_CODES.STORAGE_PROVIDER_UNAVAILABLE_FOR_KEY,
        message: 'The storage provider for this file is temporarily unavailable. Please try again shortly.',
      });
    }

    return { row, adapter };
  }

  /* ---------------------------------------------------------------------- */
  /* Attempts (store() only)                                                 */
  /* ---------------------------------------------------------------------- */

  /** One provider, with the single same-provider retry a `network_or_timeout` failure earns. */
  private async attemptStoreWithRetry(row: StorageProviderRow, input: StoreFileInput): Promise<AttemptOutcome<StoredFileResult>> {
    const first = await this.attemptStoreOnce(row, input);
    if (first.ok || first.failure.kind !== 'network_or_timeout') {
      return first;
    }

    // Jittered so a burst of concurrent uploads that all hit the same blip
    // do not all retry at the same instant and reproduce it.
    await delay(jitteredBackoffMs());
    return this.attemptStoreOnce(row, input);
  }

  private async attemptStoreOnce(row: StorageProviderRow, input: StoreFileInput): Promise<AttemptOutcome<StoredFileResult>> {
    const adapter = this.registry.find(row.provider);
    if (!adapter) {
      // Unreachable from `store()` (already filtered out by `usableCandidates`) — defensive only.
      const failure: StorageFailure = { kind: 'unknown', detail: `No adapter for provider "${row.provider}".` };
      await this.recordFailure(row, failure);
      return { ok: false, failure };
    }

    try {
      const result = await adapter.upload(input, row.config);
      await this.recordSuccess(row);
      return { ok: true, value: result };
    } catch (error) {
      const failure = adapter.classifier.classify(error);
      this.logger.warn(`Storage upload attempt failed [provider=${row.provider} id=${row.id} kind=${failure.kind}]: ${failure.detail}`);
      await this.recordFailure(row, failure);
      return { ok: false, failure };
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Health bookkeeping — best-effort, never fatal                           */
  /* ---------------------------------------------------------------------- */

  /**
   * BEST-EFFORT, deliberately — same discipline as `AuditService`'s
   * no-transaction mode and `ai-rotation.service.ts#recordSuccess`. A store
   * that SUCCEEDED and then failed to write `last_succeeded_at` must still
   * return the storage key to the caller; the failure is logged and
   * swallowed, never thrown.
   */
  private async recordSuccess(row: StorageProviderRow): Promise<void> {
    try {
      await this.repo.recordSuccess(row.id, new Date());
    } catch (error) {
      this.logger.error(`Failed to record success for storage provider ${row.id} (best-effort, swallowed): ${messageOf(error)}`);
    }
  }

  /** Same best-effort contract as `recordSuccess` — a failed health write must never change what the caller sees. */
  private async recordFailure(row: StorageProviderRow, failure: StorageFailure): Promise<void> {
    try {
      const now = new Date();
      const cooldownUntil = failure.kind === 'network_or_timeout' ? null : new Date(now.getTime() + STORAGE_COOLDOWN_SECONDS * 1_000);
      await this.repo.recordFailure(row.id, { at: now, kind: failure.kind, cooldownUntil });
    } catch (error) {
      this.logger.error(`Failed to record failure for storage provider ${row.id} (best-effort, swallowed): ${messageOf(error)}`);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Errors                                                                  */
  /* ---------------------------------------------------------------------- */

  /** 503 — see `STORAGE_ERROR_CODES.STORAGE_UNAVAILABLE`'s comment for the reasoning. */
  private unavailable(attempted: number, lastKind: StorageFailureKind | null): ServiceUnavailableException {
    this.logger.error(`Storage unavailable: ${attempted} candidate(s) attempted, last failure kind: ${lastKind ?? 'none (no usable providers)'}.`);
    return new ServiceUnavailableException({
      code: STORAGE_ERROR_CODES.STORAGE_UNAVAILABLE,
      message: 'File storage is temporarily unavailable. Please try again shortly.',
      attempted,
      lastFailureKind: lastKind,
    });
  }

  /** 502 — see `STORAGE_ERROR_CODES.STORAGE_OPERATION_FAILED`'s comment for why this is distinct from `unavailableForKey`. */
  private operationFailed(failure: StorageFailure): BadGatewayException {
    return new BadGatewayException({
      code: STORAGE_ERROR_CODES.STORAGE_OPERATION_FAILED,
      message: 'The storage provider rejected this request.',
      failureKind: failure.kind,
    });
  }
}

/** A provider is out of rotation while `cooldown_until` is in the future. A null column means "never cooled down". Mirrors `ai-rotation.service.ts#isCoolingDown`. */
export function isCoolingDown(row: StorageProviderRow, now: Date): boolean {
  return row.cooldownUntil !== null && row.cooldownUntil.getTime() > now.getTime();
}

/** Base delay plus up to the same again, bounded — mirrors `ai-rotation.service.ts#jitteredBackoffMs`. */
function jitteredBackoffMs(): number {
  const jittered = STORAGE_TRANSIENT_RETRY_BASE_MS + Math.random() * STORAGE_TRANSIENT_RETRY_BASE_MS;
  return Math.min(jittered, STORAGE_TRANSIENT_RETRY_MAX_MS);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
