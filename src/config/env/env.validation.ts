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

  // HTTP.
  CORS_ORIGIN: z.string().optional(),
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
  const candidates = [
    `.env.${nodeEnv}.local`,
    `.env.${nodeEnv}`,
    '.env.local',
    '.env',
  ];

  return [...new Set(candidates)].map((file) => resolve(cwd, file)).filter((path) => existsSync(path));
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
