import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

/**
 * Single source of truth for every environment variable the server understands.
 *
 * Add new variables to exactly one of the two schemas below:
 *   - `requiredEnv` -> the server refuses to boot without it.
 *   - `optionalEnv` -> has a default, or is genuinely allowed to be absent.
 *
 * Nothing else in the codebase should read `process.env` directly; import the
 * validated, typed object from `getEnv()` instead.
 */

export const NODE_ENVS = ['local', 'development', 'production', 'test'] as const;
export type NodeEnv = (typeof NODE_ENVS)[number];

/** Parses the common truthy/falsy spellings that show up in .env files. */
const booleanFromEnv = (defaultValue: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .default(defaultValue ? 'true' : 'false')
    .transform((value) => value === 'true' || value === '1');

/* -------------------------------------------------------------------------- */
/* REQUIRED — absence of any of these terminates the process at startup.       */
/* -------------------------------------------------------------------------- */

const requiredEnv = z.object({
  /** postgres://user:password@host:port/database */
  DATABASE_URL: z.string().min(1, 'must be a non-empty PostgreSQL connection string'),

  // Auth. Two distinct secrets, not one plus a `type` claim: a leaked
  // access-verification secret must not be enough to mint a refresh token.
  // `validateEnv` additionally asserts they are not equal to each other.
  JWT_ACCESS_SECRET: z.string().min(32, 'must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'must be at least 32 characters'),

  // Slide (slide.synquic.in) — the OTP vendor. See otp-challenges.schema.ts.
  SLIDE_API_KEY: z.string().min(1),
  /** ID of the OTP widget configured in the Slide dashboard (length, expiry, resend rules, channel). */
  SLIDE_OTP_WIDGET_ID: z.string().min(1),

  /**
   * Master key for the AES-256-GCM envelope around `agent_credentials.
   * encrypted_key` (`modules/ai/ai-crypto.service.ts`). 64 hex characters =
   * the exact 32 bytes AES-256 requires; validated here so a truncated or
   * mistyped key fails at boot rather than on the first LLM call, when the
   * only symptom would be every provider credential failing to decrypt at
   * once.
   *
   * REQUIRED, not optional-with-a-default: a compiled-in default would mean
   * every deployment that forgot to set one shares a key that is in the git
   * history, and admin-entered third-party API keys are billed to the client
   * at actuals. Rotating it re-encrypts nothing — existing rows become
   * undecryptable and the keys must be re-entered.
   */
  AI_CREDENTIAL_ENCRYPTION_KEY: z
    .string()
    .regex(
      /^[0-9a-fA-F]{64}$/,
      'must be exactly 64 hexadecimal characters (32 bytes) — generate one with `openssl rand -hex 32`',
    ),
});

/* -------------------------------------------------------------------------- */
/* OPTIONAL — defaulted or freely absent. Never logged when missing.           */
/* -------------------------------------------------------------------------- */

const optionalEnv = z.object({
  NODE_ENV: z.enum(NODE_ENVS).default('local'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  // Database pool tuning.
  DB_SSL: booleanFromEnv(false),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  DB_IDLE_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(30_000),
  DB_CONNECTION_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  DB_CONNECT_RETRIES: z.coerce.number().int().nonnegative().default(5),
  DB_CONNECT_RETRY_DELAY_MS: z.coerce.number().int().nonnegative().default(1_000),

  // Event emitter tuning.
  EVENTS_MAX_LISTENERS: z.coerce.number().int().positive().default(20),
  EVENTS_WILDCARD: booleanFromEnv(true),
  EVENTS_DELIMITER: z.string().min(1).default('.'),
  EVENTS_VERBOSE_MEMORY_LEAK: booleanFromEnv(false),

  // Transactional Outbox worker tuning.
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2_000),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().positive().default(50),
  OUTBOX_MAX_RETRIES: z.coerce.number().int().nonnegative().default(5),
  OUTBOX_RETRY_BACKOFF_MS: z.coerce.number().int().nonnegative().default(1_000),

  // HTTP.
  CORS_ORIGIN: z.string().optional(),
  // Set true behind a load balancer/reverse proxy, so `request.ip` is the
  // real client IP (X-Forwarded-For) rather than the proxy's — otherwise
  // every request collapses into one IP for the OTP per-IP rate limit.
  TRUST_PROXY: booleanFromEnv(false),

  // Auth / JWT tuning. TTLs are a bare `<number><unit>` (s/m/h/d) — both
  // `jsonwebtoken`'s `expiresIn` and identity-token.service.ts's own
  // seconds conversion for the API response parse this shape; validating
  // it here fails fast at boot instead of on the first token mint.
  JWT_ISSUER: z.string().min(1).default('dr-consultation'),
  JWT_ACCESS_TTL: z
    .string()
    .regex(/^\d+[smhd]$/, 'must look like "15m", "12h", or "30d"')
    .default('15m'),
  /** Patient and doctor app sessions. */
  JWT_REFRESH_TTL: z
    .string()
    .regex(/^\d+[smhd]$/, 'must look like "15m", "12h", or "30d"')
    .default('30d'),
  /** Shorter than the patient/doctor refresh TTL — SRS 6.1's tighter posture for panel access. */
  JWT_ADMIN_REFRESH_TTL: z
    .string()
    .regex(/^\d+[smhd]$/, 'must look like "15m", "12h", or "30d"')
    .default('12h'),

  // Slide. Omit to use the SDK's own default base URL.
  SLIDE_BASE_URL: z.string().url().optional(),

  // db:seed only — creates one bootstrap super_admin when set, skips
  // admin creation entirely when absent. Never read outside the seed script.
  BOOTSTRAP_SUPER_ADMIN_MOBILE: z.string().optional(),
  BOOTSTRAP_SUPER_ADMIN_NAME: z.string().min(1).default('Platform Owner'),

  // modules/storage — S3 (primary). Deliberately OPTIONAL, unlike
  // AI_CREDENTIAL_ENCRYPTION_KEY: a deployment may legitimately run with only
  // one blob-storage provider configured (e.g. Cloudinary alone during early
  // development, or S3 alone once Cloudinary is decommissioned). A missing
  // credential here just means that one provider is unusable — exactly as if
  // it started failing every call — never a boot failure. Non-secret settings
  // (bucket, region, optional custom endpoint) are admin-editable, not env:
  // see `storage_providers.config` (`storage-providers.schema.ts`).
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),

  // modules/storage — Cloudinary (automatic secondary). Optional for the
  // same reason. Non-secret `cloudName` lives in `storage_providers.config`.
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),
});

export const envSchema = requiredEnv.extend(optionalEnv.shape);

export type Env = z.infer<typeof envSchema>;

/** Names of the variables that gate server startup. Derived, never hand-written. */
export const REQUIRED_ENV_KEYS: readonly string[] = Object.keys(requiredEnv.shape);

/* -------------------------------------------------------------------------- */
/* Loading                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * .env files in precedence order (first file to define a key wins, and a real
 * process/shell variable always beats a file).
 */
export function envFilePaths(nodeEnv: string, cwd: string = process.cwd()): string[] {
  const candidates = [`.env.${nodeEnv}.local`, `.env.${nodeEnv}`, '.env.local', '.env'];

  return [...new Set(candidates)]
    .map((file) => resolve(cwd, file))
    .filter((path) => existsSync(path));
}

/** Reads the appropriate .env files into `process.env` without overriding real vars. */
export function loadEnvFiles(cwd: string = process.cwd()): string[] {
  const nodeEnv = process.env.NODE_ENV ?? 'local';
  const paths = envFilePaths(nodeEnv, cwd);

  if (paths.length > 0) {
    loadDotenv({ path: paths, override: false, quiet: true });
  }

  return paths;
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

interface InvalidEnv {
  key: string;
  message: string;
}

/**
 * Validates `source` against the schema.
 *
 * Returns the typed config on success. On failure it prints exactly which
 * required variables are missing (and which present ones are malformed), then
 * terminates the process with exit code 1. Missing *optional* variables are
 * silent by construction — they simply take their default.
 */
export function validateEnv(source: Record<string, unknown> = process.env): Env {
  const result = envSchema.safeParse(source);

  if (result.success) {
    // A cross-field check, not expressible as a per-field zod rule without
    // turning envSchema into a ZodEffects and losing `.shape` (which
    // REQUIRED_ENV_KEYS and this file's own tests read directly) — so it is
    // a plain assertion here, reported through the same `invalid` path as
    // every other malformed value.
    if (result.data.JWT_ACCESS_SECRET === result.data.JWT_REFRESH_SECRET) {
      reportAndExit(
        [],
        [
          {
            key: 'JWT_REFRESH_SECRET',
            message:
              'must be different from JWT_ACCESS_SECRET — a shared secret would let an access token be replayed as a refresh token',
          },
        ],
      );
    }

    return result.data;
  }

  const missing = new Set<string>();
  const invalid: InvalidEnv[] = [];

  for (const issue of result.error.issues) {
    const key = String(issue.path[0] ?? '<unknown>');
    const raw = source[key];

    // Absent or blank means "not provided"; anything else is a bad value.
    if (raw === undefined || raw === null || raw === '') {
      missing.add(key);
    } else {
      invalid.push({ key, message: issue.message });
    }
  }

  reportAndExit([...missing], invalid);
}

function reportAndExit(missing: string[], invalid: InvalidEnv[]): never {
  const lines: string[] = ['', 'Environment validation failed. Server will not start.', ''];

  if (missing.length > 0) {
    lines.push(`Missing required environment variable${missing.length === 1 ? '' : 's'}:`);
    for (const key of missing.sort()) {
      lines.push(`  - ${key}`);
    }
    lines.push('');
  }

  if (invalid.length > 0) {
    lines.push(`Invalid environment variable${invalid.length === 1 ? '' : 's'}:`);
    for (const { key, message } of invalid.sort((a, b) => a.key.localeCompare(b.key))) {
      lines.push(`  - ${key}: ${message}`);
    }
    lines.push('');
  }

  process.stderr.write(`${lines.join('\n')}\n`);
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/* Accessor                                                                    */
/* -------------------------------------------------------------------------- */

let cachedEnv: Env | null = null;

/**
 * Loads .env files (once), validates, and memoizes the result.
 * Safe to call from anywhere; the process has already exited if it was invalid.
 */
export function getEnv(): Env {
  if (cachedEnv === null) {
    loadEnvFiles();
    cachedEnv = validateEnv();
  }

  return cachedEnv;
}

/** Test seam — drops the memoized value so the next `getEnv()` re-reads. */
export function resetEnvCache(): void {
  cachedEnv = null;
}
