import { REQUIRED_ENV_KEYS, envSchema, validateEnv } from './env.validation';

const VALID: Record<string, string> = {
  DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/dr_consultation',
};

describe('env.validation', () => {
  let exitSpy: jest.SpyInstance;
  let stderrSpy: jest.SpyInstance;

  beforeEach(() => {
    // process.exit is typed `never`; make it throw so the test can observe it.
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as never);
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('applies defaults for omitted optional variables', () => {
    const env = validateEnv({ ...VALID });

    expect(env.NODE_ENV).toBe('local');
    expect(env.PORT).toBe(3000);
    expect(env.DB_SSL).toBe(false);
    expect(env.DB_POOL_MAX).toBe(10);
    expect(env.EVENTS_MAX_LISTENERS).toBe(20);
    expect(env.EVENTS_WILDCARD).toBe(true);
    expect(env.EVENTS_DELIMITER).toBe('.');
    expect(env.EVENTS_VERBOSE_MEMORY_LEAK).toBe(false);
    expect(env.OUTBOX_POLL_INTERVAL_MS).toBe(2000);
    expect(env.OUTBOX_BATCH_SIZE).toBe(50);
    expect(env.OUTBOX_MAX_RETRIES).toBe(5);
    expect(env.OUTBOX_RETRY_BACKOFF_MS).toBe(1000);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('stays silent when an optional variable without a default is absent', () => {
    const env = validateEnv({ ...VALID });

    expect(env.CORS_ORIGIN).toBeUndefined();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('coerces numeric and boolean strings', () => {
    const env = validateEnv({
      ...VALID,
      PORT: '8080',
      DB_SSL: '1',
      DB_POOL_MAX: '25',
      EVENTS_MAX_LISTENERS: '50',
      EVENTS_WILDCARD: 'false',
      EVENTS_DELIMITER: ':',
      EVENTS_VERBOSE_MEMORY_LEAK: 'true',
      OUTBOX_POLL_INTERVAL_MS: '5000',
      OUTBOX_BATCH_SIZE: '100',
      OUTBOX_MAX_RETRIES: '10',
      OUTBOX_RETRY_BACKOFF_MS: '2500',
    });

    expect(env.PORT).toBe(8080);
    expect(env.DB_SSL).toBe(true);
    expect(env.DB_POOL_MAX).toBe(25);
    expect(env.EVENTS_MAX_LISTENERS).toBe(50);
    expect(env.EVENTS_WILDCARD).toBe(false);
    expect(env.EVENTS_DELIMITER).toBe(':');
    expect(env.EVENTS_VERBOSE_MEMORY_LEAK).toBe(true);
    expect(env.OUTBOX_POLL_INTERVAL_MS).toBe(5000);
    expect(env.OUTBOX_BATCH_SIZE).toBe(100);
    expect(env.OUTBOX_MAX_RETRIES).toBe(10);
    expect(env.OUTBOX_RETRY_BACKOFF_MS).toBe(2500);
  });

  it('exits(1) naming the missing required variable', () => {
    expect(() => validateEnv({})).toThrow('process.exit:1');

    const output = stderrSpy.mock.calls.map((call) => String(call[0])).join('');
    expect(output).toContain('Missing required environment variable');
    expect(output).toContain('- DATABASE_URL');
  });

  it('treats a blank required variable as missing, not invalid', () => {
    expect(() => validateEnv({ DATABASE_URL: '' })).toThrow('process.exit:1');

    const output = stderrSpy.mock.calls.map((call) => String(call[0])).join('');
    expect(output).toContain('Missing required environment variable');
    expect(output).not.toContain('Invalid environment variable');
  });

  it('reports a present-but-malformed value as invalid', () => {
    expect(() => validateEnv({ ...VALID, PORT: 'not-a-port' })).toThrow('process.exit:1');

    const output = stderrSpy.mock.calls.map((call) => String(call[0])).join('');
    expect(output).toContain('Invalid environment variable');
    expect(output).toContain('- PORT');
  });

  it('derives the required key list from the schema', () => {
    expect(REQUIRED_ENV_KEYS).toEqual(['DATABASE_URL']);
    expect(Object.keys(envSchema.shape)).toContain('CORS_ORIGIN');
  });
});
