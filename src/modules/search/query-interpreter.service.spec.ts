import { Logger, ServiceUnavailableException } from '@nestjs/common';
import type { AppConfigService } from '../../shared/app-config/app-config.service';
import type { PublicConcern, PublicSpecialty } from '../catalogue/catalogue.contract';
import { QueryInterpreterService, buildSystemPrompt } from './query-interpreter.service';
import type { SearchAiPort } from './search-ai.contract';

function specialty(overrides: Partial<PublicSpecialty> & { code: string }): PublicSpecialty {
  return {
    id: `sp-${overrides.code}`,
    name: overrides.code,
    description: null,
    canPrescribe: false,
    intakeForm: null,
    firstConsultForm: null,
    requiredDocuments: [],
    isActive: true,
    ...overrides,
  };
}

function concern(overrides: Partial<PublicConcern> & { code: string }): PublicConcern {
  return {
    id: `c-${overrides.code}`,
    specialtyId: 'sp-psychiatry',
    name: overrides.code,
    matchPhrases: [],
    matchWeight: 1,
    isActive: true,
    ...overrides,
  };
}

const SPECIALTIES = [specialty({ code: 'psychiatry', name: 'Psychiatry' })];
const CONCERNS = [concern({ code: 'sleep', name: 'Sleep problems', matchPhrases: ['cannot sleep', 'neend nahi aati'] })];

const VALID_OUTPUT = {
  concernCodes: ['sleep'],
  professionalTypes: ['psychiatry'],
  guidance: 'You can talk to a {{specialty:psychiatry}} about {{concern:sleep}}.',
};

/**
 * `aiEnabled` is what `AppConfigService.getJson` RESOLVES TO — not what is
 * in the row. Note the distinction the interpreter relies on: an absent row
 * makes `getJson` return the compiled-in fallback (`true`), whereas a row
 * holding `null` or a wrong type resolves to that value and must be treated
 * as off.
 */
function createService(options: { aiEnabled?: unknown; isAvailable?: jest.Mock; completeStructured?: jest.Mock } = {}) {
  const ai = {
    isAvailable: options.isAvailable ?? jest.fn().mockResolvedValue(true),
    completeStructured:
      options.completeStructured ??
      jest.fn().mockResolvedValue({ value: VALID_OUTPUT, profileId: 'p1', model: 'test-model', latencyMs: 42 }),
  } as unknown as jest.Mocked<SearchAiPort>;

  const appConfig = {
    getJson: jest.fn().mockResolvedValue('aiEnabled' in options ? options.aiEnabled : true),
  } as unknown as jest.Mocked<AppConfigService>;

  return { service: new QueryInterpreterService(ai, appConfig), ai, appConfig };
}

describe('buildSystemPrompt', () => {
  it('lists the LIVE taxonomy, so a specialty added in the admin panel reaches the model with NO code change (FR-19.1)', () => {
    const withNewSpecialty = [...SPECIALTIES, specialty({ code: 'dermatology', name: 'Dermatology' })];
    const prompt = buildSystemPrompt(withNewSpecialty, CONCERNS);

    expect(prompt).toContain('dermatology - Dermatology');
    expect(prompt).toContain('psychiatry - Psychiatry');
  });

  it('includes each concern with its specialty and its curated synonyms, so an admin phrase edit reaches the AI path too', () => {
    const prompt = buildSystemPrompt(SPECIALTIES, CONCERNS);
    expect(prompt).toContain('sleep - Sleep problems [psychiatry]');
    expect(prompt).toContain('also written as: cannot sleep, neend nahi aati');
  });

  it('states the clinical prohibitions and the token-only rule to the model', () => {
    const prompt = buildSystemPrompt(SPECIALTIES, CONCERNS);
    expect(prompt).toContain('MUST NOT');
    expect(prompt).toContain('{{specialty:CODE}}');
    expect(prompt).toContain('{{concern:CODE}}');
  });

  it('degrades gracefully to a well-formed prompt when the taxonomy is empty', () => {
    const prompt = buildSystemPrompt([], []);
    expect(prompt).toContain('(none configured)');
  });
});

describe('QueryInterpreterService.interpret', () => {
  afterEach(() => jest.restoreAllMocks());

  describe('the kill switch (search.ai_enabled)', () => {
    it('NEVER CALLS THE AI PORT when the kill switch is off', async () => {
      const { service, ai } = createService({ aiEnabled: false });

      const outcome = await service.interpret('cannot sleep', SPECIALTIES, CONCERNS);

      expect(outcome).toEqual({ source: 'deterministic', reason: 'kill_switch' });
      expect(ai.isAvailable).not.toHaveBeenCalled();
      expect(ai.completeStructured).not.toHaveBeenCalled();
    });

    it.each([
      ['the string "true"', 'true'],
      ['the number 1', 1],
      ['null', null],
      ['an object', {}],
      ['an empty string', ''],
    ])('treats a stored %s as OFF — a kill switch fails safe', async (_label, value) => {
      const { service, ai } = createService({ aiEnabled: value });

      await expect(service.interpret('x', SPECIALTIES, CONCERNS)).resolves.toMatchObject({ reason: 'kill_switch' });
      expect(ai.completeStructured).not.toHaveBeenCalled();
    });

    it('defaults to ON when the app_config row is absent entirely (getJson returns the compiled fallback)', async () => {
      const { service, ai } = createService({ aiEnabled: true });
      await expect(service.interpret('x', SPECIALTIES, CONCERNS)).resolves.toMatchObject({ source: 'ai' });
      expect(ai.completeStructured).toHaveBeenCalled();
    });

    it('calls the model when the switch is on', async () => {
      const { service, ai } = createService({ aiEnabled: true });
      const outcome = await service.interpret('cannot sleep', SPECIALTIES, CONCERNS);
      expect(outcome.source).toBe('ai');
      expect(ai.completeStructured).toHaveBeenCalledTimes(1);
    });
  });

  describe('availability', () => {
    it('falls back without calling completeStructured when the port reports unavailable', async () => {
      const { service, ai } = createService({ isAvailable: jest.fn().mockResolvedValue(false) });

      await expect(service.interpret('x', SPECIALTIES, CONCERNS)).resolves.toEqual({
        source: 'deterministic',
        reason: 'unavailable',
      });
      expect(ai.completeStructured).not.toHaveBeenCalled();
    });

    it('falls back when the availability probe itself throws', async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const { service, ai } = createService({ isAvailable: jest.fn().mockRejectedValue(new Error('boom')) });

      await expect(service.interpret('x', SPECIALTIES, CONCERNS)).resolves.toMatchObject({ reason: 'unavailable' });
      expect(ai.completeStructured).not.toHaveBeenCalled();
    });
  });

  describe('failure never reaches the patient', () => {
    it('falls back on AI_UNAVAILABLE rather than propagating it', async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const { service } = createService({
        completeStructured: jest
          .fn()
          .mockRejectedValue(new ServiceUnavailableException({ code: 'AI_UNAVAILABLE', message: 'exhausted' })),
      });

      await expect(service.interpret('x', SPECIALTIES, CONCERNS)).resolves.toEqual({
        source: 'deterministic',
        reason: 'call_failed',
      });
    });

    it.each([
      ['a network error', new Error('ECONNRESET')],
      ['a timeout', new Error('timeout of 10000ms exceeded')],
      ['a non-Error throw', 'something odd'],
    ])('falls back on %s', async (_label, thrown) => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const { service } = createService({ completeStructured: jest.fn().mockRejectedValue(thrown) });

      await expect(service.interpret('x', SPECIALTIES, CONCERNS)).resolves.toMatchObject({
        source: 'deterministic',
        reason: 'call_failed',
      });
    });

    it('logs the fallback at WARN — a designed path, not an incident', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const { service } = createService({ completeStructured: jest.fn().mockRejectedValue(new Error('boom')) });

      await service.interpret('x', SPECIALTIES, CONCERNS);

      expect(warn).toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    });
  });

  describe('malformed output', () => {
    it.each([
      ['a missing field', { concernCodes: ['sleep'], professionalTypes: ['psychiatry'] }],
      ['wrong types', { concernCodes: 'sleep', professionalTypes: [], guidance: 'ok' }],
      ['null', null],
      ['a bare string', 'just text'],
      ['too many concern codes', { concernCodes: ['a', 'b', 'c', 'd', 'e', 'f'], professionalTypes: [], guidance: 'ok' }],
    ])('falls back to the deterministic matcher on %s', async (_label, value) => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const { service } = createService({
        completeStructured: jest.fn().mockResolvedValue({ value, profileId: 'p', model: 'm', latencyMs: 1 }),
      });

      await expect(service.interpret('x', SPECIALTIES, CONCERNS)).resolves.toEqual({
        source: 'deterministic',
        reason: 'invalid_output',
      });
    });
  });

  describe('the happy path', () => {
    it('returns the parsed interpretation with the model and latency', async () => {
      const { service } = createService();

      const outcome = await service.interpret('cannot sleep', SPECIALTIES, CONCERNS);

      expect(outcome).toEqual({ source: 'ai', value: VALID_OUTPUT, model: 'test-model', latencyMs: 42 });
    });

    it('passes the live-taxonomy system prompt, the raw query and a token cap', async () => {
      const { service, ai } = createService();

      await service.interpret('mujhe neend nahi aati', SPECIALTIES, CONCERNS);

      const request = (ai.completeStructured as jest.Mock).mock.calls[0][0];
      expect(request.user).toBe('mujhe neend nahi aati');
      expect(request.system).toContain('psychiatry - Psychiatry');
      expect(request.maxTokens).toBeGreaterThan(0);
      expect(request.schema).toBeDefined();
    });
  });

  describe('the beforeModelCall budget hook', () => {
    it('is invoked exactly once, immediately before the model call', async () => {
      const { service, ai } = createService();
      const beforeModelCall = jest.fn().mockResolvedValue(undefined);

      await service.interpret('x', SPECIALTIES, CONCERNS, beforeModelCall);

      expect(beforeModelCall).toHaveBeenCalledTimes(1);
      expect(beforeModelCall.mock.invocationCallOrder[0]).toBeLessThan(
        (ai.completeStructured as jest.Mock).mock.invocationCallOrder[0],
      );
    });

    it('is NOT invoked when the kill switch is off — a deterministic search must never spend budget', async () => {
      const { service } = createService({ aiEnabled: false });
      const beforeModelCall = jest.fn();

      await service.interpret('x', SPECIALTIES, CONCERNS, beforeModelCall);

      expect(beforeModelCall).not.toHaveBeenCalled();
    });

    it('is NOT invoked when the port is unavailable — an outage must not also throttle', async () => {
      const { service } = createService({ isAvailable: jest.fn().mockResolvedValue(false) });
      const beforeModelCall = jest.fn();

      await service.interpret('x', SPECIALTIES, CONCERNS, beforeModelCall);

      expect(beforeModelCall).not.toHaveBeenCalled();
    });

    it('PROPAGATES a throw from the hook (429) instead of degrading to the fallback', async () => {
      const { service, ai } = createService();
      const rateLimited = Object.assign(new Error('rate limited'), { code: 'SEARCH_RATE_LIMITED' });

      await expect(service.interpret('x', SPECIALTIES, CONCERNS, jest.fn().mockRejectedValue(rateLimited))).rejects.toBe(
        rateLimited,
      );
      expect(ai.completeStructured).not.toHaveBeenCalled();
    });

    it('is optional — omitting it still interprets normally', async () => {
      const { service } = createService();
      await expect(service.interpret('x', SPECIALTIES, CONCERNS)).resolves.toMatchObject({ source: 'ai' });
    });
  });

  describe('isAiEnabled', () => {
    it('reads the kill switch from app_config with the compiled-in default as fallback', async () => {
      const { service, appConfig } = createService({ aiEnabled: true });
      await expect(service.isAiEnabled()).resolves.toBe(true);
      expect(appConfig.getJson).toHaveBeenCalledWith('search.ai_enabled', true);
    });
  });
});
