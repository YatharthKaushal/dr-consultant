import { REQUIRED_ENV_KEYS, envSchema, validateEnv } from './env.validation';

const VALID: Record<string, string> = {
  DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/dr_consultation',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
  SLIDE_API_KEY: 'sk_test_1234567890',
  SLIDE_OTP_WIDGET_ID: 'wgt_test_1234567890',
  AI_CREDENTIAL_ENCRYPTION_KEY: 'a'.repeat(64),
  RAZORPAY_KEY_ID: 'rzp_test_1234567890',
  RAZORPAY_KEY_SECRET: 'rzp_secret_1234567890',
  RAZORPAY_WEBHOOK_SECRET: 'whsec_1234567890',
  LIVEKIT_URL: 'wss://livekit.test.invalid',
  LIVEKIT_API_KEY: 'devkey_test',
  LIVEKIT_API_SECRET: 'livekit_secret_1234567890',
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
    expect(env.S3_ACCESS_KEY_ID).toBeUndefined();
    expect(env.S3_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.CLOUDINARY_API_KEY).toBeUndefined();
    expect(env.CLOUDINARY_API_SECRET).toBeUndefined();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('boots with no storage-provider credentials at all — a missing one degrades that provider, never the server', () => {
    // modules/storage: unlike AI_CREDENTIAL_ENCRYPTION_KEY, none of the four
    // S3/Cloudinary variables are in requiredEnv, so a build with neither
    // provider configured must still validate cleanly.
    expect(() => validateEnv({ ...VALID })).not.toThrow();
    expect(REQUIRED_ENV_KEYS).not.toContain('S3_ACCESS_KEY_ID');
    expect(REQUIRED_ENV_KEYS).not.toContain('S3_SECRET_ACCESS_KEY');
    expect(REQUIRED_ENV_KEYS).not.toContain('CLOUDINARY_API_KEY');
    expect(REQUIRED_ENV_KEYS).not.toContain('CLOUDINARY_API_SECRET');
  });

  it('accepts S3/Cloudinary credentials when only one provider is configured', () => {
    const env = validateEnv({ ...VALID, S3_ACCESS_KEY_ID: 'AKIAEXAMPLE', S3_SECRET_ACCESS_KEY: 'shhh' });

    expect(env.S3_ACCESS_KEY_ID).toBe('AKIAEXAMPLE');
    expect(env.S3_SECRET_ACCESS_KEY).toBe('shhh');
    expect(env.CLOUDINARY_API_KEY).toBeUndefined();
    expect(env.CLOUDINARY_API_SECRET).toBeUndefined();
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
      'AI_CREDENTIAL_ENCRYPTION_KEY',
      'RAZORPAY_KEY_ID',
      'RAZORPAY_KEY_SECRET',
      'RAZORPAY_WEBHOOK_SECRET',
      'LIVEKIT_URL',
      'LIVEKIT_API_KEY',
      'LIVEKIT_API_SECRET',
    ]);
    expect(Object.keys(envSchema.shape)).toContain('CORS_ORIGIN');
  });

  /**
   * modules/payment (M-12). Razorpay's three variables are REQUIRED, in
   * deliberate contrast to the four optional S3/Cloudinary ones above.
   *
   * The difference is that blob storage has two providers, so a missing
   * credential only makes one of them unusable. Razorpay is the SOLE payment
   * gateway this release integrates (`payments.schema.ts`: "No `gateway`
   * column: Razorpay is the only one this release integrates"), so there is no
   * fallback — a deployment missing a key cannot take a single payment, and
   * finding that out at the first checkout instead of at boot is strictly
   * worse. Same precedent as `SLIDE_API_KEY`.
   */
  /**
   * modules/video (M-14). LiveKit's three variables are REQUIRED for the same
   * reason Razorpay's are and the OPPOSITE reason the FCM ones are optional:
   * it is the sole video provider, it is SELF-HOSTED so there is no managed
   * fallback, and a deployment missing a key cannot run a single consultation.
   * A push that fails degrades to "recorded, not delivered"; a video join that
   * fails is the consultation not happening.
   */
  it.each([['LIVEKIT_URL'], ['LIVEKIT_API_KEY'], ['LIVEKIT_API_SECRET']])(
    'exits(1) when %s is missing — video has no fallback provider',
    (key) => {
      const incomplete = { ...VALID };
      delete (incomplete as Record<string, unknown>)[key];

      expect(() => validateEnv(incomplete)).toThrow('process.exit:1');
      expect(stderrSpy.mock.calls.map((call) => String(call[0])).join('')).toContain(`- ${key}`);
    },
  );

  it('exposes the LiveKit credentials typed', () => {
    const env = validateEnv(VALID);

    expect(env.LIVEKIT_URL).toBe('wss://livekit.test.invalid');
    expect(env.LIVEKIT_API_KEY).toBe('devkey_test');
    expect(env.LIVEKIT_API_SECRET).toBe('livekit_secret_1234567890');
  });

  it.each([['RAZORPAY_KEY_ID'], ['RAZORPAY_KEY_SECRET'], ['RAZORPAY_WEBHOOK_SECRET']])(
    'refuses to boot without %s — Razorpay is the only gateway, so there is no degraded mode',
    (key) => {
      const withoutKey = { ...VALID };
      delete withoutKey[key];

      expect(() => validateEnv(withoutKey)).toThrow('process.exit:1');

      const output = stderrSpy.mock.calls.map((call) => String(call[0])).join('');
      expect(output).toContain('Missing required environment variable');
      expect(output).toContain(`- ${key}`);
    },
  );

  it('accepts the Razorpay credentials and exposes them typed', () => {
    const env = validateEnv({ ...VALID });
    expect(env.RAZORPAY_KEY_ID).toBe('rzp_test_1234567890');
    expect(env.RAZORPAY_KEY_SECRET).toBe('rzp_secret_1234567890');
    // The webhook secret is a SEPARATE secret from the API key pair — it is
    // set independently when the webhook is registered, and it is the entire
    // auth boundary for the public webhook route.
    expect(env.RAZORPAY_WEBHOOK_SECRET).toBe('whsec_1234567890');
    expect(env.RAZORPAY_WEBHOOK_SECRET).not.toBe(env.RAZORPAY_KEY_SECRET);
  });

  it('rejects an empty Razorpay key rather than treating it as absent-and-fine', () => {
    expect(() => validateEnv({ ...VALID, RAZORPAY_KEY_ID: '' })).toThrow('process.exit:1');
    const output = stderrSpy.mock.calls.map((call) => String(call[0])).join('');
    expect(output).toContain('- RAZORPAY_KEY_ID');
  });

  it('rejects an AI_CREDENTIAL_ENCRYPTION_KEY that is not 64 hex characters', () => {
    // Present but malformed (31 bytes, not 32) — reported as invalid, not
    // missing, so the operator is told what is wrong with the value they set.
    expect(() => validateEnv({ ...VALID, AI_CREDENTIAL_ENCRYPTION_KEY: 'a'.repeat(62) })).toThrow('process.exit:1');

    const output = stderrSpy.mock.calls.map((call) => String(call[0])).join('');
    expect(output).toContain('Invalid environment variable');
    expect(output).toContain('- AI_CREDENTIAL_ENCRYPTION_KEY');
    expect(output).toContain('openssl rand -hex 32');
  });

  it('rejects an AI_CREDENTIAL_ENCRYPTION_KEY of the right length that is not hex', () => {
    expect(() => validateEnv({ ...VALID, AI_CREDENTIAL_ENCRYPTION_KEY: 'z'.repeat(64) })).toThrow('process.exit:1');

    const output = stderrSpy.mock.calls.map((call) => String(call[0])).join('');
    expect(output).toContain('- AI_CREDENTIAL_ENCRYPTION_KEY');
  });
});
