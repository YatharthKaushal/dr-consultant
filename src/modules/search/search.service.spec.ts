import { HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { SearchQueryRow } from '../../schema/search-queries.schema';
import type { AvailabilityFacade } from '../availability/availability.facade';
import type { CatalogueFacade } from '../catalogue/catalogue.facade';
import type { PublicConcern, PublicSpecialty } from '../catalogue/catalogue.contract';
import type { DoctorFacade } from '../doctor/doctor.facade';
import { ConcernMatcherService } from './concern-matcher.service';
import type { CrisisDetectorService } from './crisis-detector.service';
import { DoctorRankerService } from './doctor-ranker.service';
import type { QueryInterpreterService } from './query-interpreter.service';
import { ResponseValidatorService } from './response-validator.service';
import type { SearchConfigService } from './search-config.service';
import type { SearchRepository } from './search.repository';
import { SearchService } from './search.service';
import { SEARCH_CONFIG_FALLBACKS } from './search.constants';

const PSYCHIATRY: PublicSpecialty = {
  id: 'sp-psychiatry',
  code: 'psychiatry',
  name: 'Psychiatry',
  description: null,
  canPrescribe: true,
  intakeForm: null,
  firstConsultForm: null,
  requiredDocuments: [],
  isActive: true,
};

const SLEEP: PublicConcern = {
  id: 'c-sleep',
  specialtyId: PSYCHIATRY.id,
  code: 'sleep',
  name: 'Sleep problems',
  matchPhrases: ['cannot sleep'],
  matchWeight: 5,
  isActive: true,
};

const RESOLVED_CONFIG = {
  crisisKeywords: [...SEARCH_CONFIG_FALLBACKS.CRISIS_KEYWORDS],
  crisisGuidance: SEARCH_CONFIG_FALLBACKS.CRISIS_GUIDANCE,
  popularSearches: [{ label: 'Sleep', query: 'cannot sleep' }],
  aiEnabled: false,
  maxResults: 20,
  rateLimitPerHour: 3,
};

function queryRow(overrides: Partial<SearchQueryRow> & { queryText: string }): SearchQueryRow {
  return {
    id: 1,
    patientId: 'patient-1',
    source: 'app',
    isVoiceInput: false,
    matchedConcernIds: [],
    resultCount: 2,
    crisisGuardrailFired: false,
    createdAt: new Date('2026-09-07T10:00:00Z'),
    ...overrides,
  };
}

function createService(options: { rateLimitPerHour?: number; countAiAttempts?: number; aiEnabled?: boolean } = {}) {
  const repo = {
    logQuery: jest.fn().mockResolvedValue(undefined),
    listRecentByPatient: jest.fn().mockResolvedValue([]),
    listForAdmin: jest.fn().mockResolvedValue([]),
    recordAiAttempt: jest.fn().mockResolvedValue(undefined),
    countAiAttempts: jest.fn().mockResolvedValue(options.countAiAttempts ?? 0),
  } as unknown as jest.Mocked<SearchRepository>;

  const config = {
    getResolved: jest.fn().mockResolvedValue({
      ...RESOLVED_CONFIG,
      rateLimitPerHour: options.rateLimitPerHour ?? RESOLVED_CONFIG.rateLimitPerHour,
      aiEnabled: options.aiEnabled ?? RESOLVED_CONFIG.aiEnabled,
    }),
  } as unknown as jest.Mocked<SearchConfigService>;

  const crisisDetector = {
    screen: jest.fn().mockResolvedValue({ fired: false, matchedKeyword: null }),
  } as unknown as jest.Mocked<CrisisDetectorService>;

  const interpreter = {
    isAiEnabled: jest.fn().mockResolvedValue(options.aiEnabled ?? false),
    // Mirrors the real interpreter: the budget hook is invoked only when a
    // model call is genuinely about to happen.
    interpret: jest.fn().mockImplementation(async (_query, _specialties, _concerns, beforeModelCall) => {
      await beforeModelCall?.();
      return { source: 'deterministic', reason: 'unavailable' };
    }),
  } as unknown as jest.Mocked<QueryInterpreterService>;

  const catalogue = {
    listActiveSpecialties: jest.fn().mockResolvedValue([PSYCHIATRY]),
    listActiveConcerns: jest.fn().mockResolvedValue([SLEEP]),
    getConcernsByIds: jest.fn().mockResolvedValue([]),
  } as unknown as jest.Mocked<CatalogueFacade>;

  const doctors = {
    listListedDoctors: jest.fn().mockResolvedValue([
      {
        id: 'doctor-a',
        fullName: 'Dr A',
        languages: ['English'],
        qualification: 'MD',
        registrationNumber: 'R1',
        yearsOfExperience: 5,
        consultationFeeInr: '1000.00',
        consultationDurationMinutes: 30,
        specialties: [{ id: PSYCHIATRY.id, code: 'psychiatry', name: 'Psychiatry', isPrimary: true }],
      },
    ]),
  } as unknown as jest.Mocked<DoctorFacade>;

  const availability = {
    getEarliestBookableSlots: jest.fn().mockResolvedValue([{ doctorId: 'doctor-a', earliestStartsAt: null }]),
  } as unknown as jest.Mocked<AvailabilityFacade>;

  const service = new SearchService(
    repo,
    config,
    crisisDetector,
    interpreter,
    new ConcernMatcherService(),
    new DoctorRankerService(),
    new ResponseValidatorService(),
    catalogue,
    doctors,
    availability,
  );

  return { service, repo, config, crisisDetector, interpreter, catalogue, doctors, availability };
}

function discoverRequest(overrides: Record<string, unknown> = {}) {
  return { patientId: 'patient-1', source: 'app' as const, queryText: 'i cannot sleep', ...overrides };
}

describe('SearchService.discover — query logging', () => {
  it('logs the query with the matched concern ids, the result count and the crisis flag', async () => {
    const { service, repo } = createService();

    await service.discover(discoverRequest({ isVoiceInput: true }));

    expect(repo.logQuery).toHaveBeenCalledWith({
      patientId: 'patient-1',
      source: 'app',
      queryText: 'i cannot sleep',
      isVoiceInput: true,
      matchedConcernIds: ['c-sleep'],
      resultCount: 1,
      crisisGuardrailFired: false,
    });
  });

  it('logs crisisGuardrailFired: true and a zero result count for a crisis query', async () => {
    const { service, repo, crisisDetector } = createService();
    crisisDetector.screen.mockResolvedValue({ fired: true, matchedKeyword: 'want to die' });

    await service.discover(discoverRequest({ queryText: 'i want to die' }));

    expect(repo.logQuery).toHaveBeenCalledWith(
      expect.objectContaining({ crisisGuardrailFired: true, resultCount: 0, matchedConcernIds: [] }),
    );
  });

  it('logs an unattributed query with a null patient id', async () => {
    const { service, repo } = createService();
    await service.discover(discoverRequest({ patientId: null, source: 'mcp' }));
    expect(repo.logQuery).toHaveBeenCalledWith(expect.objectContaining({ patientId: null, source: 'mcp' }));
  });

  it('is BEST-EFFORT — a logging failure never turns a working search into a 500', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { service, repo } = createService();
    repo.logQuery.mockRejectedValue(new Error('insert failed'));

    const response = await service.discover(discoverRequest());

    expect(response.results.length).toBeGreaterThan(0);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe('SearchService.discover — the AI rate limit', () => {
  it('does NOT touch the rate limiter on the deterministic path (kill switch off)', async () => {
    const { service, repo } = createService({ aiEnabled: false });

    await service.discover(discoverRequest());

    expect(repo.countAiAttempts).not.toHaveBeenCalled();
    expect(repo.recordAiAttempt).not.toHaveBeenCalled();
  });

  it('records the attempt BEFORE the model call, so a failed call still spends its budget', async () => {
    const { service, repo } = createService({ aiEnabled: true, countAiAttempts: 0 });

    await service.discover(discoverRequest());

    expect(repo.recordAiAttempt).toHaveBeenCalledWith('patient-1', 'app');
  });

  it('does NOT spend budget when the interpreter never reaches the model (an outage must not also throttle)', async () => {
    const { service, repo, interpreter } = createService({ aiEnabled: true });
    // An unavailable port: the interpreter returns without invoking the hook.
    (interpreter.interpret as jest.Mock).mockResolvedValue({ source: 'deterministic', reason: 'unavailable' });

    await service.discover(discoverRequest());

    expect(repo.countAiAttempts).not.toHaveBeenCalled();
    expect(repo.recordAiAttempt).not.toHaveBeenCalled();
  });

  it('ALLOWS the request one below the limit', async () => {
    const { service, repo } = createService({ aiEnabled: true, rateLimitPerHour: 3, countAiAttempts: 2 });

    await expect(service.discover(discoverRequest())).resolves.toBeDefined();
    expect(repo.recordAiAttempt).toHaveBeenCalled();
  });

  it('REJECTS at the limit (count === limit) with 429 and a retryAfterSeconds', async () => {
    const { service, repo } = createService({ aiEnabled: true, rateLimitPerHour: 3, countAiAttempts: 3 });

    await expect(service.discover(discoverRequest())).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });
    expect(repo.recordAiAttempt).not.toHaveBeenCalled();

    await service.discover(discoverRequest()).catch((error: HttpException) => {
      expect(error.getResponse()).toMatchObject({ code: 'SEARCH_RATE_LIMITED', retryAfterSeconds: 3600 });
    });
  });

  it('REJECTS over the limit', async () => {
    const { service } = createService({ aiEnabled: true, rateLimitPerHour: 3, countAiAttempts: 99 });
    await expect(service.discover(discoverRequest())).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });
  });

  it('*** STILL RETURNS THE CRISIS GUARDRAIL WHEN RATE LIMITED *** — a throttle must not swallow a safety response', async () => {
    const { service, repo, crisisDetector } = createService({ aiEnabled: true, rateLimitPerHour: 1, countAiAttempts: 999 });
    crisisDetector.screen.mockResolvedValue({ fired: true, matchedKeyword: 'want to die' });

    const response = await service.discover(discoverRequest({ queryText: 'i want to die' }));

    expect(response.crisis).not.toBeNull();
    expect(response.results).toEqual([]);
    expect(repo.countAiAttempts).not.toHaveBeenCalled();
  });

  it('counts against the calling patient over a one-hour window', async () => {
    const { service, repo } = createService({ aiEnabled: true });

    await service.discover(discoverRequest());

    const [patientId, source, since] = repo.countAiAttempts.mock.calls[0] as [string, string, Date];
    expect(patientId).toBe('patient-1');
    expect(source).toBe('app');
    expect(Date.now() - since.getTime()).toBeGreaterThanOrEqual(60 * 60 * 1000 - 5000);
  });
});

describe('SearchService.listRecent — FR-5.11, this patient only', () => {
  it('scopes the read to the CALLING patient and never accepts another id', async () => {
    const { service, repo } = createService();

    await service.listRecent('patient-1');

    expect(repo.listRecentByPatient).toHaveBeenCalledTimes(1);
    expect(repo.listRecentByPatient.mock.calls[0]?.[0]).toBe('patient-1');
  });

  it('returns nothing when this patient has no history, even if others do', async () => {
    const { service, repo } = createService();
    repo.listRecentByPatient.mockResolvedValue([]);

    await expect(service.listRecent('patient-2')).resolves.toEqual([]);
    expect(repo.listRecentByPatient.mock.calls[0]?.[0]).toBe('patient-2');
  });

  it('de-duplicates by normalised text, keeping the newest', async () => {
    const { service, repo } = createService();
    repo.listRecentByPatient.mockResolvedValue([
      queryRow({ queryText: 'Cannot Sleep', createdAt: new Date('2026-09-07T12:00:00Z') }),
      queryRow({ queryText: 'cannot sleep ', createdAt: new Date('2026-09-06T12:00:00Z') }),
      queryRow({ queryText: 'panic at night', createdAt: new Date('2026-09-05T12:00:00Z') }),
    ]);

    const recent = await service.listRecent('patient-1');

    expect(recent.map((r) => r.queryText)).toEqual(['Cannot Sleep', 'panic at night']);
  });

  it('caps the returned list and clamps a silly limit', async () => {
    const { service, repo } = createService();
    repo.listRecentByPatient.mockResolvedValue(
      Array.from({ length: 40 }, (_, index) => queryRow({ queryText: `query ${index}` })),
    );

    await expect(service.listRecent('patient-1', 3).then((r) => r.length)).resolves.toBe(3);
    await expect(service.listRecent('patient-1', 999).then((r) => r.length)).resolves.toBe(10);
  });

  it('over-fetches so de-duplication can still fill the row', async () => {
    const { service, repo } = createService();
    await service.listRecent('patient-1', 5);
    expect(repo.listRecentByPatient.mock.calls[0]?.[1]).toBeGreaterThan(5);
  });

  it('serialises createdAt as ISO 8601', async () => {
    const { service, repo } = createService();
    repo.listRecentByPatient.mockResolvedValue([queryRow({ queryText: 'cannot sleep' })]);

    await expect(service.listRecent('patient-1').then((r) => r[0]?.createdAt)).resolves.toBe('2026-09-07T10:00:00.000Z');
  });
});

describe('SearchService — browse reads', () => {
  it('returns the ADMIN-EDITED popular list from config, never one computed from the log', async () => {
    const { service, repo } = createService();

    await expect(service.listPopular()).resolves.toEqual([{ label: 'Sleep', query: 'cannot sleep' }]);
    expect(repo.listForAdmin).not.toHaveBeenCalled();
  });

  it('lists active concerns, optionally under one specialty', async () => {
    const { service, catalogue } = createService();

    await expect(service.listConcerns('sp-psychiatry')).resolves.toEqual([
      { id: 'c-sleep', code: 'sleep', name: 'Sleep problems', specialtyId: 'sp-psychiatry' },
    ]);
    expect(catalogue.listActiveConcerns).toHaveBeenCalledWith('sp-psychiatry');
  });

  it('lists professional types from active specialties', async () => {
    const { service } = createService();
    await expect(service.listProfessionalTypes()).resolves.toEqual([
      { id: 'sp-psychiatry', code: 'psychiatry', name: 'Psychiatry', description: null },
    ]);
  });
});

describe('SearchService.listDoctors — FR-4.4 filter and sort', () => {
  function withDoctors() {
    const created = createService();
    (created.doctors.listListedDoctors as jest.Mock).mockResolvedValue([
      {
        id: 'doctor-cheap',
        fullName: 'Dr Cheap',
        languages: ['Hindi'],
        qualification: null,
        registrationNumber: null,
        yearsOfExperience: null,
        consultationFeeInr: '500.00',
        consultationDurationMinutes: 30,
        specialties: [],
      },
      {
        id: 'doctor-soon',
        fullName: 'Dr Soon',
        languages: ['Hindi'],
        qualification: null,
        registrationNumber: null,
        yearsOfExperience: null,
        consultationFeeInr: '2000.00',
        consultationDurationMinutes: 30,
        specialties: [],
      },
    ]);
    (created.availability.getEarliestBookableSlots as jest.Mock).mockResolvedValue([
      { doctorId: 'doctor-cheap', earliestStartsAt: new Date(Date.now() + 10 * 24 * 3600_000) },
      { doctorId: 'doctor-soon', earliestStartsAt: new Date(Date.now() + 3600_000) },
    ]);
    return created;
  }

  it('sorts by fee ascending', async () => {
    const { service } = withDoctors();
    const results = await service.listDoctors({ sort: 'fee_asc' });
    expect(results.map((r) => r.doctorId)).toEqual(['doctor-cheap', 'doctor-soon']);
  });

  it('sorts by soonest availability', async () => {
    const { service } = withDoctors();
    const results = await service.listDoctors({ sort: 'availability' });
    expect(results.map((r) => r.doctorId)).toEqual(['doctor-soon', 'doctor-cheap']);
  });

  it('passes filters through to the doctor facade', async () => {
    const { service, doctors } = withDoctors();

    await service.listDoctors({ specialtyId: 'sp-psychiatry', languages: ['Hindi'], maxFeeInr: '2500' });

    expect(doctors.listListedDoctors).toHaveBeenCalledWith(
      expect.objectContaining({ specialtyIds: ['sp-psychiatry'], languages: ['Hindi'], maxFeeInr: '2500' }),
    );
  });

  it('returns an empty list (not an error) when no doctor is listed', async () => {
    const { service, doctors, availability } = createService();
    (doctors.listListedDoctors as jest.Mock).mockResolvedValue([]);

    await expect(service.listDoctors({})).resolves.toEqual([]);
    expect(availability.getEarliestBookableSlots).not.toHaveBeenCalled();
  });

  it('batches availability into ONE call for the whole page', async () => {
    const { service, availability } = withDoctors();
    await service.listDoctors({});
    expect(availability.getEarliestBookableSlots).toHaveBeenCalledTimes(1);
  });
});

describe('SearchService.screenForCrisis', () => {
  it('exposes the guardrail alone, without the rest of the pipeline', async () => {
    const { service, crisisDetector, doctors } = createService();
    crisisDetector.screen.mockResolvedValue({ fired: true, matchedKeyword: 'want to die' });

    await expect(service.screenForCrisis('i want to die')).resolves.toEqual({ fired: true });
    expect(doctors.listListedDoctors).not.toHaveBeenCalled();
  });

  it('does not leak the matched keyword to the caller', async () => {
    const { service, crisisDetector } = createService();
    crisisDetector.screen.mockResolvedValue({ fired: true, matchedKeyword: 'want to die' });

    const result = await service.screenForCrisis('i want to die');

    expect(Object.keys(result)).toEqual(['fired']);
  });
});
