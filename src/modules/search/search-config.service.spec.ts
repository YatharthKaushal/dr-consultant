import { BadRequestException } from '@nestjs/common';
import type { AppConfigService } from '../../shared/app-config/app-config.service';
import type { AuditService } from '../../shared/audit/audit.service';
import type { SearchConfigRepository } from './search-config.repository';
import { SearchConfigService } from './search-config.service';
import { SEARCH_CONFIG_FALLBACKS, SEARCH_CONFIG_KEYS } from './search.constants';

function createService(stored: Map<string, unknown> = new Map()) {
  const repo = {
    findByKeys: jest.fn().mockResolvedValue(stored),
    upsert: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<SearchConfigRepository>;

  const appConfig = { invalidate: jest.fn() } as unknown as jest.Mocked<AppConfigService>;
  const audit = { write: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<AuditService>;

  return { service: new SearchConfigService(repo, appConfig, audit), repo, appConfig, audit };
}

describe('SearchConfigService.getResolved', () => {
  it('falls back to the compiled-in defaults when nothing is stored', async () => {
    const { service } = createService();

    await expect(service.getResolved()).resolves.toEqual({
      crisisKeywords: [...SEARCH_CONFIG_FALLBACKS.CRISIS_KEYWORDS],
      crisisGuidance: SEARCH_CONFIG_FALLBACKS.CRISIS_GUIDANCE,
      popularSearches: [...SEARCH_CONFIG_FALLBACKS.POPULAR_SEARCHES],
      aiEnabled: true,
      maxResults: SEARCH_CONFIG_FALLBACKS.MAX_RESULTS,
      rateLimitPerHour: SEARCH_CONFIG_FALLBACKS.RATE_LIMIT_PER_HOUR,
    });
  });

  it('reads every key in ONE query, not one per key', async () => {
    const { service, repo } = createService();
    await service.getResolved();
    expect(repo.findByKeys).toHaveBeenCalledTimes(1);
  });

  it('returns stored values when present', async () => {
    const { service } = createService(
      new Map<string, unknown>([
        [SEARCH_CONFIG_KEYS.AI_ENABLED, false],
        [SEARCH_CONFIG_KEYS.MAX_RESULTS, 7],
        [SEARCH_CONFIG_KEYS.RATE_LIMIT_PER_HOUR, 3],
        [SEARCH_CONFIG_KEYS.CRISIS_KEYWORDS, ['custom phrase']],
      ]),
    );

    const resolved = await service.getResolved();

    expect(resolved.aiEnabled).toBe(false);
    expect(resolved.maxResults).toBe(7);
    expect(resolved.rateLimitPerHour).toBe(3);
    expect(resolved.crisisKeywords).toEqual(['custom phrase']);
  });

  describe('tolerant reads of untyped jsonb', () => {
    it.each([
      ['a non-array', 'oops'],
      ['an empty array', []],
      ['an array with no usable strings', [null, '', 42]],
    ])('falls back to the starter crisis keywords for %s', async (_label, value) => {
      const { service } = createService(new Map<string, unknown>([[SEARCH_CONFIG_KEYS.CRISIS_KEYWORDS, value]]));
      await expect(service.getResolved().then((c) => c.crisisKeywords)).resolves.toEqual([
        ...SEARCH_CONFIG_FALLBACKS.CRISIS_KEYWORDS,
      ]);
    });

    it('falls back to compiled crisis guidance when the stored block has no reachable helpline', async () => {
      const { service } = createService(
        new Map<string, unknown>([[SEARCH_CONFIG_KEYS.CRISIS_GUIDANCE, { message: 'hi', helplines: [] }]]),
      );
      await expect(service.getResolved().then((c) => c.crisisGuidance)).resolves.toEqual(
        SEARCH_CONFIG_FALLBACKS.CRISIS_GUIDANCE,
      );
    });

    it('accepts a well-formed stored crisis guidance block', async () => {
      const guidance = { message: 'Call now.', helplines: [{ name: 'Helpline', phone: '111' }] };
      const { service } = createService(new Map<string, unknown>([[SEARCH_CONFIG_KEYS.CRISIS_GUIDANCE, guidance]]));
      await expect(service.getResolved().then((c) => c.crisisGuidance)).resolves.toEqual(guidance);
    });

    it('COERCES bare-string popular searches, which is how an admin will type them', async () => {
      const { service } = createService(new Map<string, unknown>([[SEARCH_CONFIG_KEYS.POPULAR_SEARCHES, ['low mood', 'anxiety']]]));
      await expect(service.getResolved().then((c) => c.popularSearches)).resolves.toEqual([
        { label: 'low mood', query: 'low mood' },
        { label: 'anxiety', query: 'anxiety' },
      ]);
    });

    it('accepts the { label, query } form and drops malformed entries', async () => {
      const { service } = createService(
        new Map<string, unknown>([
          [SEARCH_CONFIG_KEYS.POPULAR_SEARCHES, [{ label: 'Sleep', query: 'cannot sleep' }, { label: 'no query' }, 42]],
        ]),
      );
      await expect(service.getResolved().then((c) => c.popularSearches)).resolves.toEqual([
        { label: 'Sleep', query: 'cannot sleep' },
      ]);
    });

    it('treats a non-number maxResults as absent', async () => {
      const { service } = createService(new Map<string, unknown>([[SEARCH_CONFIG_KEYS.MAX_RESULTS, 'twenty']]));
      await expect(service.getResolved().then((c) => c.maxResults)).resolves.toBe(SEARCH_CONFIG_FALLBACKS.MAX_RESULTS);
    });
  });
});

describe('SearchConfigService.update', () => {
  it('writes only the fields present in the update', async () => {
    const { service, repo } = createService();

    await service.update('admin-1', { aiEnabled: false });

    expect(repo.upsert).toHaveBeenCalledTimes(1);
    expect(repo.upsert).toHaveBeenCalledWith(SEARCH_CONFIG_KEYS.AI_ENABLED, false);
  });

  it('*** INVALIDATES THE CONFIG MEMO *** after every write, or the 30s cache would keep serving the old value', async () => {
    const { service, appConfig } = createService();

    await service.update('admin-1', { aiEnabled: false, maxResults: 5 });

    expect(appConfig.invalidate).toHaveBeenCalledWith(SEARCH_CONFIG_KEYS.AI_ENABLED);
    expect(appConfig.invalidate).toHaveBeenCalledWith(SEARCH_CONFIG_KEYS.MAX_RESULTS);
    expect(appConfig.invalidate).toHaveBeenCalledTimes(2);
  });

  it('writes an audit entry carrying actor and BEFORE/AFTER, keyed by the config key', async () => {
    const { service, audit } = createService(new Map<string, unknown>([[SEARCH_CONFIG_KEYS.AI_ENABLED, true]]));

    await service.update('admin-1', { aiEnabled: false });

    expect(audit.write).toHaveBeenCalledWith({
      actorType: 'admin',
      actorId: 'admin-1',
      action: 'update',
      entityType: 'search_config',
      entityId: SEARCH_CONFIG_KEYS.AI_ENABLED,
      metadata: { before: true, after: false },
    });
  });

  it('records before: null when the key had no row yet', async () => {
    const { service, audit } = createService();
    await service.update('admin-1', { maxResults: 5 });
    expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ metadata: { before: null, after: 5 } }));
  });

  it('writes NOTHING and audits NOTHING for a no-op update', async () => {
    const { service, repo, audit, appConfig } = createService();

    await service.update('admin-1', {});

    expect(repo.upsert).not.toHaveBeenCalled();
    expect(audit.write).not.toHaveBeenCalled();
    expect(appConfig.invalidate).not.toHaveBeenCalled();
  });

  it('updates several keys, each with its own audit row', async () => {
    const { service, repo, audit } = createService();

    await service.update('admin-1', { crisisKeywords: ['a phrase'], aiEnabled: true, rateLimitPerHour: 10 });

    expect(repo.upsert).toHaveBeenCalledTimes(3);
    expect(audit.write).toHaveBeenCalledTimes(3);
  });

  describe('validation — services hold the rules, not just the HTTP layer', () => {
    it('REFUSES an empty crisis keyword list, which would silently disable the guardrail', async () => {
      const { service, repo } = createService();
      await expect(service.update('admin-1', { crisisKeywords: [] })).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.upsert).not.toHaveBeenCalled();
    });

    it('refuses non-string crisis keywords', async () => {
      const { service } = createService();
      await expect(service.update('admin-1', { crisisKeywords: [42 as never] })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses crisis guidance with no message or no helpline', async () => {
      const { service } = createService();
      await expect(
        service.update('admin-1', { crisisGuidance: { message: '  ', helplines: [{ name: 'x', phone: '1' }] } }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.update('admin-1', { crisisGuidance: { message: 'ok', helplines: [] } })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it.each([
      ['maxResults below the floor', { maxResults: 0 }],
      ['maxResults above the ceiling', { maxResults: 500 }],
      ['a non-integer maxResults', { maxResults: 2.5 }],
      ['rateLimitPerHour below the floor', { rateLimitPerHour: 0 }],
      ['rateLimitPerHour above the ceiling', { rateLimitPerHour: 99_999 }],
    ])('refuses %s', async (_label, update) => {
      const { service, repo } = createService();
      await expect(service.update('admin-1', update)).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.upsert).not.toHaveBeenCalled();
    });

    it('refuses a non-boolean aiEnabled', async () => {
      const { service } = createService();
      await expect(service.update('admin-1', { aiEnabled: 'yes' as never })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('VALIDATES EVERY FIELD BEFORE WRITING ANY, so one bad field cannot leave a half-applied update', async () => {
      const { service, repo, audit } = createService();

      await expect(service.update('admin-1', { aiEnabled: false, maxResults: 9999 })).rejects.toBeInstanceOf(
        BadRequestException,
      );

      expect(repo.upsert).not.toHaveBeenCalled();
      expect(audit.write).not.toHaveBeenCalled();
    });
  });

  it('returns the freshly resolved config after writing', async () => {
    const { service, repo } = createService();
    (repo.findByKeys as jest.Mock).mockResolvedValue(new Map<string, unknown>([[SEARCH_CONFIG_KEYS.MAX_RESULTS, 5]]));

    await expect(service.update('admin-1', { maxResults: 5 }).then((c) => c.maxResults)).resolves.toBe(5);
  });
});
