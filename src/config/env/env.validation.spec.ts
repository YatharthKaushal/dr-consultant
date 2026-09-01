import { REQUIRED_ENV_KEYS, envSchema, validateEnv } from './env.validation';

const VALID: Record<string, string> = {
  DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/dr_consultation',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
  SLIDE_API_KEY: 'sk_test_1234567890',
  SLIDE_OTP_WIDGET_ID: 'wgt_test_1234567890',
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
    expect(env.TRUST_PROXY).toBe(false);
    expect(env.JWT_ISSUER).toBe('dr-consultation');
    expect(env.JWT_ACCESS_TTL).toBe('15m');
    expect(env.JWT_REFRESH_TTL).toBe('30d');
    expect(env.JWT_ADMIN_REFRESH_TTL).toBe('12h');
    expect(env.BOOTSTRAP_SUPER_ADMIN_NAME).toBe('Platform Owner');
    expect(exitSpy).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('stays silent when an optional variable without a default is absent', () => {
    const env = validateEnv({ ...VALID });

    expect(env.CORS_ORIGIN).toBeUndefined();
    expect(env.SLIDE_BASE_URL).toBeUndefined();
    expect(env.BOOTSTRAP_SUPER_ADMIN_MOBILE).toBeUndefined();
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
      TRUST_PROXY: 'true',
    });

    expect(env.PORT).toBe(8080);
    expect(env.TRUST_PROXY).toBe(true);
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
    expect(output).toContain('- JWT_ACCESS_SECRET');
    expect(output).toContain('- SLIDE_API_KEY');
  });

  it('exits(1) when JWT_ACCESS_SECRET and JWT_REFRESH_SECRET are equal', () => {
    expect(() =>
      validateEnv({ ...VALID, JWT_REFRESH_SECRET: VALID.JWT_ACCESS_SECRET }),
    ).toThrow('process.exit:1');

    const output = stderrSpy.mock.calls.map((call) => String(call[0])).join('');
    expect(output).toContain('Invalid environment variable');
    expect(output).toContain('- JWT_REFRESH_SECRET');
    expect(output).toContain('must be different from JWT_ACCESS_SECRET');
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
    expect(REQUIRED_ENV_KEYS).toEqual([
      'DATABASE_URL',
      'JWT_ACCESS_SECRET',
      'JWT_REFRESH_SECRET',
      'SLIDE_API_KEY',
      'SLIDE_OTP_WIDGET_ID',
    ]);
    expect(Object.keys(envSchema.shape)).toContain('CORS_ORIGIN');
  });
});
