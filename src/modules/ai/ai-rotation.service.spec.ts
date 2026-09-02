import { BadRequestException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { z } from 'zod';
import type { AgentCredentialRow } from '../../schema/agent-credentials.schema';
import type { AgentProfileRow } from '../../schema/agent-profiles.schema';
import type { AppConfigService } from '../../shared/app-config/app-config.service';
import type { AgentCredentialRepository, RotationCandidate } from './agent-credential.repository';
import type { AiCryptoService } from './ai-crypto.service';
import { AiRotationService, isCoolingDown } from './ai-rotation.service';
import { AI_CONFIG_FALLBACKS, AI_CONFIG_KEYS, type LlmFailureKind } from './ai.constants';
import type { AiCompletionRequest } from './ai.contract';
import type { LlmProviderRegistry } from './llm-provider.registry';
import type { LlmFailure, LlmProviderAdapter } from './llm-provider.types';

const SCHEMA = z.object({ answer: z.string() });

const REQUEST: AiCompletionRequest<{ answer: string }> = {
  system: 'You are a test.',
  user: 'Say hello.',
  schema: SCHEMA,
};

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

function profileRow(overrides: Partial<AgentProfileRow> = {}): AgentProfileRow {
  return {
    id: 'profile-1',
    name: 'Primary',
    provider: 'openai_compatible',
    model: 'gpt-4o-mini',
    baseUrl: null,
    config: {},
    priority: 100,
    isActive: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function credentialRow(overrides: Partial<AgentCredentialRow> = {}): AgentCredentialRow {
  return {
    id: 'credential-1',
    profileId: 'profile-1',
    label: 'key one',
    encryptedKey: 'v1:enc:tag:cipher',
    keyLast4: '1111',
    priority: 100,
    isActive: true,
    consecutiveFailures: 0,
    lastFailureAt: null,
    lastFailureKind: null,
    cooldownUntil: null,
    lastSucceededAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function candidate(
  credential: Partial<AgentCredentialRow> = {},
  profile: Partial<AgentProfileRow> = {},
): RotationCandidate {
  return { credential: credentialRow(credential), profile: profileRow(profile) };
}

/**
 * A rejection whose classified kind is decided by the test. The mocked
 * classifier reads `__kind` back off it, which keeps each test's intent
 * ("this attempt fails as a rate limit") on one readable line instead of
 * behind a realistic-but-noisy vendor fixture — the vendor fixtures are
 * exhaustively covered in the four `*.classifier.spec.ts` files.
 */
function failsAs(kind: LlmFailureKind, extra: { retryAfterMs?: number; detail?: string } = {}): Error {
  const error = new Error(extra.detail ?? `simulated ${kind}`);
  return Object.assign(error, { __kind: kind, __retryAfterMs: extra.retryAfterMs });
}

function createDeps() {
  const repo = {
    listRotationCandidates: jest.fn<Promise<RotationCandidate[]>, []>().mockResolvedValue([]),
    recordSuccess: jest.fn().mockResolvedValue(undefined),
    recordFailure: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<AgentCredentialRepository>;

  const complete = jest.fn();
  const adapter: LlmProviderAdapter = {
    provider: 'openai_compatible',
    classifier: {
      classify: (error: unknown): LlmFailure => {
        const record = error as { __kind?: LlmFailureKind; __retryAfterMs?: number; message?: string };
        const failure: LlmFailure = { kind: record.__kind ?? 'unknown', detail: record.message ?? 'failed' };
        return record.__retryAfterMs === undefined ? failure : { ...failure, retryAfterMs: record.__retryAfterMs };
      },
    },
    complete,
  };

  const registry = { find: jest.fn().mockReturnValue(adapter), require: jest.fn() } as unknown as jest.Mocked<LlmProviderRegistry>;

  const crypto = {
    decrypt: jest.fn((stored: string) => `plaintext-for-${stored}`),
    encrypt: jest.fn(),
    lastFour: jest.fn(),
    matches: jest.fn(),
  } as unknown as jest.Mocked<AiCryptoService>;

  const appConfig = {
    // Every test runs on the compiled-in fallbacks unless it overrides this.
    getNumber: jest.fn(async (_key: string, fallback: number) => fallback),
    getJson: jest.fn(),
    invalidate: jest.fn(),
  } as unknown as jest.Mocked<AppConfigService>;

  const service = new AiRotationService(repo, registry, crypto, appConfig);
  return { service, repo, registry, crypto, appConfig, complete, adapter };
}

/** The module logs failures at warn/error by design; silence it so a passing run is readable. */
beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

afterAll(() => {
  jest.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */

describe('AiRotationService', () => {
  describe('rotation across credentials', () => {
    it('returns the second credential’s result when the first fails', async () => {
      const { service, repo, complete } = createDeps();
      repo.listRotationCandidates.mockResolvedValue([
        candidate({ id: 'cred-a', encryptedKey: 'enc-a' }),
        candidate({ id: 'cred-b', encryptedKey: 'enc-b' }),
      ]);
      complete.mockRejectedValueOnce(failsAs('invalid_key')).mockResolvedValueOnce({ answer: 'hello' });

      const result = await service.completeStructured(REQUEST);

      expect(result.value).toEqual({ answer: 'hello' });
      expect(complete).toHaveBeenCalledTimes(2);
      // The SECOND key served it, and the caller is told which profile/model.
      expect(result.profileId).toBe('profile-1');
      expect(result.model).toBe('gpt-4o-mini');
      expect(typeof result.latencyMs).toBe('number');
    });

    it('rotates across PROFILES, not just keys within one', async () => {
      const { service, repo, complete } = createDeps();
      repo.listRotationCandidates.mockResolvedValue([
        candidate({ id: 'cred-a' }, { id: 'profile-a', model: 'gpt-4o-mini' }),
        candidate({ id: 'cred-b' }, { id: 'profile-b', model: 'claude-sonnet-4-5', provider: 'anthropic' }),
      ]);
      complete.mockRejectedValueOnce(failsAs('insufficient_quota')).mockResolvedValueOnce({ answer: 'from anthropic' });

      const result = await service.completeStructured(REQUEST);

      expect(result.profileId).toBe('profile-b');
      expect(result.model).toBe('claude-sonnet-4-5');
    });

    it('throws AI_UNAVAILABLE (503) when every candidate fails', async () => {
      const { service, repo, complete } = createDeps();
      repo.listRotationCandidates.mockResolvedValue([
        candidate({ id: 'cred-a' }),
        candidate({ id: 'cred-b' }),
        candidate({ id: 'cred-c' }),
      ]);
      complete.mockRejectedValue(failsAs('invalid_key'));

      await expect(service.completeStructured(REQUEST)).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(complete).toHaveBeenCalledTimes(3);
    });

    it('AI_UNAVAILABLE carries the code, the attempt count and the last failure kind', async () => {
      const { service, repo, complete } = createDeps();
      repo.listRotationCandidates.mockResolvedValue([candidate({ id: 'cred-a' }), candidate({ id: 'cred-b' })]);
      complete.mockRejectedValue(failsAs('rate_limited'));

      const error = await service.completeStructured(REQUEST).catch((e: unknown) => e);

      expect((error as ServiceUnavailableException).getResponse()).toEqual({
        code: 'AI_UNAVAILABLE',
        message: expect.any(String),
        attempted: 2,
        lastFailureKind: 'rate_limited',
      });
    });

    it('throws AI_UNAVAILABLE with attempted: 0 when nothing is configured at all', async () => {
      const { service, repo, complete } = createDeps();
      repo.listRotationCandidates.mockResolvedValue([]);

      const error = await service.completeStructured(REQUEST).catch((e: unknown) => e);

      expect(complete).not.toHaveBeenCalled();
      expect((error as ServiceUnavailableException).getResponse()).toMatchObject({
        code: 'AI_UNAVAILABLE',
        attempted: 0,
        lastFailureKind: null,
      });
    });

    it('stops after the per-request attempt cap even with more candidates available', async () => {
      const { service, repo, complete } = createDeps();
      repo.listRotationCandidates.mockResolvedValue(
        Array.from({ length: 20 }, (_, i) => candidate({ id: `cred-${i}` })),
      );
      complete.mockRejectedValue(failsAs('invalid_key'));

      await expect(service.completeStructured(REQUEST)).rejects.toBeInstanceOf(ServiceUnavailableException);

      // Bounded: one search request must not become twenty upstream calls.
      expect(complete).toHaveBeenCalledTimes(6);
    });
  });

  describe('ordering', () => {
    it('attempts candidates in exactly the order the repository returned them', async () => {
      // The ORDER BY (profile.priority, credential.priority, credential.id)
      // is the repository's job and is asserted in
      // `agent-credential.repository.spec.ts`. What this asserts is that the
      // service does not re-sort, shuffle or parallelise that order.
      const { service, repo, complete } = createDeps();
      repo.listRotationCandidates.mockResolvedValue([
        candidate({ id: 'cheap-primary', priority: 10 }, { id: 'profile-cheap', priority: 10 }),
        candidate({ id: 'cheap-secondary', priority: 20 }, { id: 'profile-cheap', priority: 10 }),
        candidate({ id: 'expensive-primary', priority: 10 }, { id: 'profile-expensive', priority: 90 }),
      ]);
      complete.mockRejectedValue(failsAs('invalid_key'));

      await expect(service.completeStructured(REQUEST)).rejects.toBeInstanceOf(ServiceUnavailableException);

      expect(complete.mock.calls.map((call) => (call[0] as { apiKey: string }).apiKey)).toEqual([
        'plaintext-for-v1:enc:tag:cipher',
        'plaintext-for-v1:enc:tag:cipher',
        'plaintext-for-v1:enc:tag:cipher',
      ]);
      // The health writes name the credentials, in order.
      expect((repo.recordFailure as jest.Mock).mock.calls.map((call) => call[0])).toEqual([
        'cheap-primary',
        'cheap-secondary',
        'expensive-primary',
      ]);
    });
  });

  describe('cooldown skipping', () => {
    it('skips a credential whose cooldownUntil is in the future', async () => {
      const { service, repo, complete } = createDeps();
      const future = new Date(Date.now() + 60_000);
      repo.listRotationCandidates.mockResolvedValue([
        candidate({ id: 'cooling', cooldownUntil: future }),
        candidate({ id: 'ready' }),
      ]);
      complete.mockResolvedValue({ answer: 'served by the ready key' });

      await service.completeStructured(REQUEST);

      expect(complete).toHaveBeenCalledTimes(1);
      expect(repo.recordSuccess).toHaveBeenCalledWith('ready', expect.any(Date));
    });

    it('uses a credential whose cooldownUntil has already passed', async () => {
      const { service, repo, complete } = createDeps();
      repo.listRotationCandidates.mockResolvedValue([
        candidate({ id: 'expired-cooldown', cooldownUntil: new Date(Date.now() - 1_000) }),
      ]);
      complete.mockResolvedValue({ answer: 'ok' });

      await service.completeStructured(REQUEST);

      expect(complete).toHaveBeenCalledTimes(1);
    });

    it('throws AI_UNAVAILABLE when every candidate is cooling down', async () => {
      const { service, repo, complete } = createDeps();
      repo.listRotationCandidates.mockResolvedValue([
        candidate({ id: 'a', cooldownUntil: new Date(Date.now() + 60_000) }),
        candidate({ id: 'b', cooldownUntil: new Date(Date.now() + 60_000) }),
      ]);

      await expect(service.completeStructured(REQUEST)).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(complete).not.toHaveBeenCalled();
    });

    it('isCoolingDown treats a null column as "never cooled down"', () => {
      const now = new Date('2026-06-01T12:00:00.000Z');
      expect(isCoolingDown(credentialRow({ cooldownUntil: null }), now)).toBe(false);
      expect(isCoolingDown(credentialRow({ cooldownUntil: new Date('2026-06-01T12:00:01.000Z') }), now)).toBe(true);
      expect(isCoolingDown(credentialRow({ cooldownUntil: new Date('2026-06-01T11:59:59.000Z') }), now)).toBe(false);
    });
  });

  describe('fail-fast kinds do NOT rotate', () => {
    it('stops after ONE attempt on context_length and throws AI_REQUEST_INVALID (400)', async () => {
      const { service, repo, complete } = createDeps();
      repo.listRotationCandidates.mockResolvedValue([
        candidate({ id: 'cred-a' }),
        candidate({ id: 'cred-b' }),
        candidate({ id: 'cred-c' }),
      ]);
      complete.mockRejectedValue(failsAs('context_length'));

      const error = await service.completeStructured(REQUEST).catch((e: unknown) => e);

      // The whole point: a prompt that does not fit will not fit anywhere, so
      // trying the other two keys is pure spend.
      expect(complete).toHaveBeenCalledTimes(1);
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        code: 'AI_REQUEST_INVALID',
        failureKind: 'context_length',
      });
    });

    it('stops after ONE attempt on content_filtered', async () => {
      const { service, repo, complete } = createDeps();
      repo.listRotationCandidates.mockResolvedValue([candidate({ id: 'cred-a' }), candidate({ id: 'cred-b' })]);
      complete.mockRejectedValue(failsAs('content_filtered'));

      const error = await service.completeStructured(REQUEST).catch((e: unknown) => e);

      expect(complete).toHaveBeenCalledTimes(1);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        code: 'AI_REQUEST_INVALID',
        failureKind: 'content_filtered',
      });
    });

    it('neither fail-fast kind sets a cooldown — the credential is not at fault', async () => {
      const { service, repo, complete } = createDeps();
      repo.listRotationCandidates.mockResolvedValue([candidate({ id: 'cred-a' })]);
      complete.mockRejectedValue(failsAs('context_length'));

      await service.completeStructured(REQUEST).catch(() => undefined);

      expect(repo.recordFailure).toHaveBeenCalledWith('cred-a', {
        at: expect.any(Date),
        kind: 'context_length',
        cooldownUntil: null,
      });
    });
  });

  describe('transient/timeout retry on the SAME credential', () => {
    it('retries once on the same credential, then rotates', async () => {
      const { service, repo, complete } = createDeps();
      repo.listRotationCandidates.mockResolvedValue([
        candidate({ id: 'flaky', encryptedKey: 'enc-flaky' }),
        candidate({ id: 'healthy', encryptedKey: 'enc-healthy' }),
      ]);
      complete
        .mockRejectedValueOnce(failsAs('transient'))
        .mockRejectedValueOnce(failsAs('transient'))
        .mockResolvedValueOnce({ answer: 'ok' });

      const result = await service.completeStructured(REQUEST);

      expect(result.value).toEqual({ answer: 'ok' });
      expect(complete).toHaveBeenCalledTimes(3);
      // Attempts 1 and 2 used the SAME key; attempt 3 rotated.
      const keys = complete.mock.calls.map((call) => (call[0] as { apiKey: string }).apiKey);
      expect(keys).toEqual([
        'plaintext-for-enc-flaky',
        'plaintext-for-enc-flaky',
        'plaintext-for-enc-healthy',
      ]);
    });

    it('succeeds on the retry without ever rotating', async () => {
      const { service, repo, complete } = createDeps();
      repo.listRotationCandidates.mockResolvedValue([candidate({ id: 'flaky' }), candidate({ id: 'other' })]);
      complete.mockRejectedValueOnce(failsAs('timeout')).mockResolvedValueOnce({ answer: 'ok' });

      await service.completeStructured(REQUEST);

      expect(complete).toHaveBeenCalledTimes(2);
      expect(repo.recordSuccess).toHaveBeenCalledWith('flaky', expect.any(Date));
    });

    it('does NOT retry the same credential for a non-transient kind', async () => {
      const { service, repo, complete } = createDeps();
      repo.listRotationCandidates.mockResolvedValue([candidate({ id: 'a' }), candidate({ id: 'b' })]);
      complete.mockRejectedValueOnce(failsAs('rate_limited')).mockResolvedValueOnce({ answer: 'ok' });

      await service.completeStructured(REQUEST);

      // Exactly two calls: one per credential, no same-key retry.
      expect(complete).toHaveBeenCalledTimes(2);
    });
  });

  describe('health columns', () => {
    it('records success on the credential that worked', async () => {
      const { service, repo, complete } = createDeps();
      repo.listRotationCandidates.mockResolvedValue([candidate({ id: 'winner' })]);
      complete.mockResolvedValue({ answer: 'ok' });

      await service.completeStructured(REQUEST);

      expect(repo.recordSuccess).toHaveBeenCalledWith('winner', expect.any(Date));
      expect(repo.recordFailure).not.toHaveBeenCalled();
    });

    it('records a failure with its classified kind', async () => {
      const { service, repo, complete } = createDeps();
      repo.listRotationCandidates.mockResolvedValue([candidate({ id: 'loser' })]);
      complete.mockRejectedValue(failsAs('invalid_key'));

      await service.completeStructured(REQUEST).catch(() => undefined);

      expect(repo.recordFailure).toHaveBeenCalledWith('loser', {
        at: expect.any(Date),
        kind: 'invalid_key',
        cooldownUntil: expect.any(Date),
      });
    });

    it('gives invalid_key the LONG cooldown, not the default one', async () => {
      const { service, repo, complete } = createDeps();
      repo.listRotationCandidates.mockResolvedValue([candidate({ id: 'dead' })]);
      complete.mockRejectedValue(failsAs('invalid_key'));

      const before = Date.now();
      await service.completeStructured(REQUEST).catch(() => undefined);

      const { cooldownUntil } = (repo.recordFailure as jest.Mock).mock.calls[0][1] as { cooldownUntil: Date };
      const seconds = Math.round((cooldownUntil.getTime() - before) / 1_000);
      expect(seconds).toBe(AI_CONFIG_FALLBACKS.HARD_FAILURE_COOLDOWN_SECONDS);
    });

    it('gives insufficient_quota the LONG cooldown too', async () => {
      const { service, repo, complete } = createDeps();
      repo.listRotationCandidates.mockResolvedValue([candidate({ id: 'broke' })]);
      complete.mockRejectedValue(failsAs('insufficient_quota'));

      const before = Date.now();
      await service.completeStructured(REQUEST).catch(() => undefined);

      const { cooldownUntil } = (repo.recordFailure as jest.Mock).mock.calls[0][1] as { cooldownUntil: Date };
      expect(Math.round((cooldownUntil.getTime() - before) / 1_000)).toBe(
        AI_CONFIG_FALLBACKS.HARD_FAILURE_COOLDOWN_SECONDS,
      );
    });

    it('prefers the vendor’s own Retry-After over the configured default', async () => {
      const { service, repo, complete } = createDeps();
      repo.listRotationCandidates.mockResolvedValue([candidate({ id: 'throttled' })]);
      complete.mockRejectedValue(failsAs('rate_limited', { retryAfterMs: 7_000 }));

      const before = Date.now();
      await service.completeStructured(REQUEST).catch(() => undefined);

      const { cooldownUntil } = (repo.recordFailure as jest.Mock).mock.calls[0][1] as { cooldownUntil: Date };
      expect(Math.round((cooldownUntil.getTime() - before) / 1_000)).toBe(7);
    });

    it('caps a hostile Retry-After at ai.max_cooldown_seconds', async () => {
      const { service, repo, complete } = createDeps();
      repo.listRotationCandidates.mockResolvedValue([candidate({ id: 'throttled' })]);
      // A week. Left uncapped this would park a working key until someone noticed.
      complete.mockRejectedValue(failsAs('rate_limited', { retryAfterMs: 604_800_000 }));

      const before = Date.now();
      await service.completeStructured(REQUEST).catch(() => undefined);

      const { cooldownUntil } = (repo.recordFailure as jest.Mock).mock.calls[0][1] as { cooldownUntil: Date };
      expect(Math.round((cooldownUntil.getTime() - before) / 1_000)).toBe(AI_CONFIG_FALLBACKS.MAX_COOLDOWN_SECONDS);
    });

    it('sets NO cooldown for transient/timeout — a blip must not sideline a healthy key', async () => {
      const { service, repo, complete } = createDeps();
      repo.listRotationCandidates.mockResolvedValue([candidate({ id: 'flaky' })]);
      complete.mockRejectedValue(failsAs('transient'));

      await service.completeStructured(REQUEST).catch(() => undefined);

      const calls = (repo.recordFailure as jest.Mock).mock.calls as [string, { cooldownUntil: Date | null }][];
      for (const [, params] of calls) {
        expect(params.cooldownUntil).toBeNull();
      }
    });

    it('reads the cooldown from app_config when an admin has overridden it', async () => {
      const { service, repo, complete, appConfig } = createDeps();
      repo.listRotationCandidates.mockResolvedValue([candidate({ id: 'x' })]);
      complete.mockRejectedValue(failsAs('model_unavailable'));
      (appConfig.getNumber as jest.Mock).mockImplementation(async (key: string, fallback: number) =>
        key === AI_CONFIG_KEYS.DEFAULT_COOLDOWN_SECONDS ? 42 : fallback,
      );

      const before = Date.now();
      await service.completeStructured(REQUEST).catch(() => undefined);

      const { cooldownUntil } = (repo.recordFailure as jest.Mock).mock.calls[0][1] as { cooldownUntil: Date };
      expect(Math.round((cooldownUntil.getTime() - before) / 1_000)).toBe(42);
    });

    it('NEVER writes is_active — disabling is the admin’s decision alone', async () => {
      const { service, repo, complete } = createDeps();
      repo.listRotationCandidates.mockResolvedValue([candidate({ id: 'a', consecutiveFailures: 99 })]);
      complete.mockRejectedValue(failsAs('invalid_key'));

      await service.completeStructured(REQUEST).catch(() => undefined);

      // The repository exposes no method that could disable a credential from
      // here; `update` is the admin path and rotation must never reach it.
      expect((repo as unknown as Record<string, unknown>).update).toBeUndefined();
      const [, params] = (repo.recordFailure as jest.Mock).mock.calls[0] as [string, Record<string, unknown>];
      expect(params).not.toHaveProperty('isActive');
    });
  });

  describe('health writes are best-effort', () => {
    it('a failed success-write does NOT fail an otherwise successful completion', async () => {
      const { service, repo, complete } = createDeps();
      repo.listRotationCandidates.mockResolvedValue([candidate({ id: 'winner' })]);
      complete.mockResolvedValue({ answer: 'the completion the client paid for' });
      (repo.recordSuccess as jest.Mock).mockRejectedValue(new Error('deadlock detected'));

      const result = await service.completeStructured(REQUEST);

      // The client has already been billed for this call. Turning it into a
      // 500 because a bookkeeping row would not write is a self-inflicted
      // outage — same discipline as AuditService's best-effort mode.
      expect(result.value).toEqual({ answer: 'the completion the client paid for' });
    });

    it('a failed failure-write does not stop rotation reaching a working key', async () => {
      const { service, repo, complete } = createDeps();
      repo.listRotationCandidates.mockResolvedValue([candidate({ id: 'a' }), candidate({ id: 'b' })]);
      complete.mockRejectedValueOnce(failsAs('invalid_key')).mockResolvedValueOnce({ answer: 'ok' });
      (repo.recordFailure as jest.Mock).mockRejectedValue(new Error('connection terminated'));

      await expect(service.completeStructured(REQUEST)).resolves.toMatchObject({ value: { answer: 'ok' } });
    });
  });

  describe('undecryptable credentials', () => {
    it('classifies a decrypt failure as invalid_key and rotates past it', async () => {
      const { service, repo, complete, crypto } = createDeps();
      repo.listRotationCandidates.mockResolvedValue([
        candidate({ id: 'corrupt', encryptedKey: 'bad' }),
        candidate({ id: 'good', encryptedKey: 'enc-good' }),
      ]);
      (crypto.decrypt as jest.Mock).mockImplementation((stored: string) => {
        if (stored === 'bad') throw new Error('Unsupported state or unable to authenticate data');
        return `plaintext-for-${stored}`;
      });
      complete.mockResolvedValue({ answer: 'ok' });

      const result = await service.completeStructured(REQUEST);

      expect(result.value).toEqual({ answer: 'ok' });
      // Never attempted the corrupt one — no upstream call was made with it.
      expect(complete).toHaveBeenCalledTimes(1);
      expect(repo.recordFailure).toHaveBeenCalledWith('corrupt', expect.objectContaining({ kind: 'invalid_key' }));
    });
  });

  describe('unserviceable providers', () => {
    it('skips a profile whose provider has no adapter, rather than failing the request', async () => {
      const { service, repo, complete, registry } = createDeps();
      const adapter = (registry.find as jest.Mock).getMockImplementation
        ? (registry.find as jest.Mock)('openai_compatible')
        : null;
      repo.listRotationCandidates.mockResolvedValue([
        candidate({ id: 'future' }, { id: 'p-future', provider: 'some_future_provider' }),
        candidate({ id: 'known' }, { id: 'p-known', provider: 'openai_compatible' }),
      ]);
      (registry.find as jest.Mock).mockImplementation((provider: string) =>
        provider === 'openai_compatible' ? adapter : null,
      );
      complete.mockResolvedValue({ answer: 'ok' });

      const result = await service.completeStructured(REQUEST);

      expect(result.profileId).toBe('p-known');
      expect(complete).toHaveBeenCalledTimes(1);
    });
  });

  describe('per-call parameters', () => {
    it('passes the profile’s model, baseUrl and config through to the adapter', async () => {
      const { service, repo, complete } = createDeps();
      repo.listRotationCandidates.mockResolvedValue([
        candidate(
          { encryptedKey: 'enc-x' },
          { model: 'llama-3.3-70b', baseUrl: 'https://api.groq.com/openai/v1', config: { temperature: 0.2, maxTokens: 512, timeoutMs: 9_000 } },
        ),
      ]);
      complete.mockResolvedValue({ answer: 'ok' });

      await service.completeStructured(REQUEST);

      expect(complete).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'llama-3.3-70b',
          baseUrl: 'https://api.groq.com/openai/v1',
          temperature: 0.2,
          maxTokens: 512,
          timeoutMs: 9_000,
          apiKey: 'plaintext-for-enc-x',
          system: REQUEST.system,
          user: REQUEST.user,
        }),
      );
    });

    it('lets the request’s maxTokens override the profile’s', async () => {
      const { service, repo, complete } = createDeps();
      repo.listRotationCandidates.mockResolvedValue([candidate({}, { config: { maxTokens: 512 } })]);
      complete.mockResolvedValue({ answer: 'ok' });

      await service.completeStructured({ ...REQUEST, maxTokens: 64 });

      expect(complete).toHaveBeenCalledWith(expect.objectContaining({ maxTokens: 64 }));
    });

    it('falls back to the configured request timeout when the profile sets none', async () => {
      const { service, repo, complete } = createDeps();
      repo.listRotationCandidates.mockResolvedValue([candidate({}, { config: {} })]);
      complete.mockResolvedValue({ answer: 'ok' });

      await service.completeStructured(REQUEST);

      expect(complete).toHaveBeenCalledWith(
        expect.objectContaining({ timeoutMs: AI_CONFIG_FALLBACKS.REQUEST_TIMEOUT_MS }),
      );
    });
  });

  describe('isAvailable', () => {
    it('is true when at least one active, non-cooled-down credential exists', async () => {
      const { service, repo } = createDeps();
      repo.listRotationCandidates.mockResolvedValue([candidate({ id: 'a' })]);

      await expect(service.isAvailable()).resolves.toBe(true);
    });

    it('is false when there are no credentials at all', async () => {
      const { service, repo } = createDeps();
      repo.listRotationCandidates.mockResolvedValue([]);

      await expect(service.isAvailable()).resolves.toBe(false);
    });

    it('is false when every credential is cooling down', async () => {
      const { service, repo } = createDeps();
      repo.listRotationCandidates.mockResolvedValue([
        candidate({ id: 'a', cooldownUntil: new Date(Date.now() + 30_000) }),
      ]);

      await expect(service.isAvailable()).resolves.toBe(false);
    });

    it('makes no upstream call — it is a kill-switch check, not a live probe', async () => {
      const { service, repo, complete } = createDeps();
      repo.listRotationCandidates.mockResolvedValue([candidate({ id: 'a' })]);

      await service.isAvailable();

      expect(complete).not.toHaveBeenCalled();
    });
  });

  describe('probe (the admin credential-test path)', () => {
    it('returns ok on success and records it', async () => {
      const { service, repo, complete } = createDeps();
      complete.mockResolvedValue({ answer: 'ok' });

      const outcome = await service.probe(candidate({ id: 'probed' }), REQUEST);

      expect(outcome).toMatchObject({ ok: true, failureKind: null, detail: null, providerNotConfigured: false });
      expect(repo.recordSuccess).toHaveBeenCalledWith('probed', expect.any(Date));
    });

    it('returns the classified kind on failure rather than throwing', async () => {
      const { service, complete } = createDeps();
      complete.mockRejectedValue(failsAs('insufficient_quota', { detail: 'You exceeded your current quota' }));

      const outcome = await service.probe(candidate({ id: 'probed' }), REQUEST);

      expect(outcome.ok).toBe(false);
      expect(outcome.failureKind).toBe('insufficient_quota');
      expect(outcome.detail).toContain('exceeded your current quota');
    });

    it('does NOT retry, even for a transient failure — the admin asked what one call does', async () => {
      const { service, complete } = createDeps();
      complete.mockRejectedValue(failsAs('transient'));

      await service.probe(candidate({ id: 'probed' }), REQUEST);

      expect(complete).toHaveBeenCalledTimes(1);
    });

    it('flags providerNotConfigured when the adapter refused before calling out', async () => {
      const { service, complete } = createDeps();
      complete.mockRejectedValue(
        Object.assign(new Error('not configured'), {
          __kind: 'model_unavailable' as const,
          response: { code: 'PROVIDER_NOT_CONFIGURED', message: 'not configured' },
        }),
      );

      const outcome = await service.probe(candidate({ id: 'bedrock-cred' }), REQUEST);

      expect(outcome.providerNotConfigured).toBe(true);
    });
  });

  describe('secret redaction', () => {
    it('scrubs the plaintext key out of vendor error text before it can be returned or logged', async () => {
      // Gemini embeds the API key in the request URL, and the SDK embeds the
      // URL in the error message. Without this step the key would land in an
      // admin response and in the server log.
      const { service, complete, crypto } = createDeps();
      const plaintextKey = 'AIzaSyDUMMYKEYVALUE9876';
      (crypto.decrypt as jest.Mock).mockReturnValue(plaintextKey);
      complete.mockRejectedValue(
        failsAs('invalid_key', {
          detail: `Error fetching from https://generativelanguage.googleapis.com/v1beta/models/x:generateContent?key=${plaintextKey}: [400 Bad Request] API key not valid.`,
        }),
      );

      const outcome = await service.probe(candidate({ keyLast4: '9876' }), REQUEST);

      expect(outcome.detail).not.toContain(plaintextKey);
      expect(outcome.detail).toContain('****9876');
    });
  });
});
