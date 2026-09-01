import { Logger } from '@nestjs/common';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';
import { getEnv, type Env } from '../env/env.validation';

/**
 * PostgreSQL connection layer.
 *
 * Owns a single lazily-created `pg.Pool` and the Drizzle instance bound to it.
 * Importing this module does not open a socket — connection happens only when
 * `connectDatabase()` (or the first `getDb()`) is called.
 */

const logger = new Logger('Database');

/** Drizzle instance type. Pass your schema here once tables are defined. */
export type Database = NodePgDatabase<Record<string, never>>;

/**
 * The handle passed to `db.transaction(async (tx) => ...)`. Structurally
 * interchangeable with `Database` for query-builder calls (insert/select/
 * update/delete), so a repository method that should work either standalone
 * or nested inside a caller's transaction can type its executor parameter as
 * `Database | DatabaseTransaction` — see `shared/audit/audit.service.ts` for
 * the pattern (transactional writes must roll back with the state change
 * they audit; best-effort writes, like a login, must not).
 */
export type DatabaseTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

let pool: Pool | null = null;
let db: Database | null = null;

/* -------------------------------------------------------------------------- */
/* Configuration                                                               */
/* -------------------------------------------------------------------------- */

/** Translates validated env into a `pg` pool configuration. */
export function buildPoolConfig(env: Env = getEnv()): PoolConfig {
  return {
    connectionString: env.DATABASE_URL,
    max: env.DB_POOL_MAX,
    idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: env.DB_CONNECTION_TIMEOUT_MS,
    // Managed Postgres (RDS, Neon, Supabase) presents certs the local CA store
    // does not know; verification is relaxed only when SSL is explicitly on.
    ssl: env.DB_SSL ? { rejectUnauthorized: false } : false,
  };
}

/** Strips credentials so a connection string is safe to log. */
export function redactConnectionString(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    return `${url.protocol}//${url.username || 'postgres'}:***@${url.host}${url.pathname}`;
  } catch {
    return '<unparsable DATABASE_URL>';
  }
}

/* -------------------------------------------------------------------------- */
/* Connection lifecycle                                                        */
/* -------------------------------------------------------------------------- */

/** Returns the live pool, creating it if needed. Does not verify connectivity. */
export function getPool(): Pool {
  if (pool === null) {
    const env = getEnv();
    pool = new Pool(buildPoolConfig(env));

    // A pool-level error means an *idle* client died (network blip, DB restart).
    // Swallowing it here keeps the process alive; pg discards the bad client.
    pool.on('error', (error: Error) => {
      logger.error(`Idle client error: ${error.message}`);
    });
  }

  return pool;
}

/** Returns the Drizzle instance bound to the pool, creating it if needed. */
export function getDb(): Database {
  if (db === null) {
    db = drizzle(getPool());
  }

  return db;
}

/**
 * Opens the pool and verifies it can actually reach PostgreSQL, retrying on
 * failure per `DB_CONNECT_RETRIES` / `DB_CONNECT_RETRY_DELAY_MS`.
 *
 * Throws once retries are exhausted so the caller can decide to abort startup.
 */
export async function connectDatabase(): Promise<Database> {
  const env = getEnv();
  const attempts = env.DB_CONNECT_RETRIES + 1;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const { serverVersion, database } = await pingDatabase();

      logger.log(`Connected to ${redactConnectionString(env.DATABASE_URL)}`);
      logger.log(
        `PostgreSQL ${serverVersion} | database "${database}" | pool max ${env.DB_POOL_MAX}`,
      );

      return getDb();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (attempt === attempts) {
        logger.error(`Database connection failed after ${attempts} attempt(s): ${message}`);
        throw error;
      }

      logger.warn(`Database connection attempt ${attempt}/${attempts} failed: ${message}`);
      await delay(env.DB_CONNECT_RETRY_DELAY_MS);
    }
  }

  // Unreachable: the loop either returns or throws.
  throw new Error('Database connection failed.');
}

/** Round-trips a trivial query. Throws if the database is unreachable. */
export async function pingDatabase(): Promise<{ serverVersion: string; database: string }> {
  const client = await getPool().connect();

  try {
    const result = await client.query<{ version: string; database: string }>(
      "select current_setting('server_version') as version, current_database() as database",
    );

    return {
      serverVersion: result.rows[0]?.version ?? 'unknown',
      database: result.rows[0]?.database ?? 'unknown',
    };
  } finally {
    client.release();
  }
}

/** Non-throwing connectivity probe, suitable for a health endpoint. */
export async function isDatabaseHealthy(): Promise<boolean> {
  try {
    await pingDatabase();
    return true;
  } catch {
    return false;
  }
}

/** Drains the pool. Safe to call when never connected. */
export async function disconnectDatabase(): Promise<void> {
  if (pool === null) {
    return;
  }

  const closing = pool;
  pool = null;
  db = null;

  await closing.end();
  logger.log('Connection pool closed.');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
