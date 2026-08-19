import { type EventEmitterModule } from '@nestjs/event-emitter';
import { getEnv, type Env } from '../env/env.validation';

/**
 * Event emitter and transactional outbox configuration layer.
 *
 * Provides typed, validated settings for the in-process event bus and the
 * asynchronous outbox worker.
 */

/** Injection token for the combined events configuration. */
export const EVENTS_CONFIG = Symbol('EVENTS_CONFIG');

/** Injection token for the transactional outbox worker configuration. */
export const OUTBOX_CONFIG = Symbol('OUTBOX_CONFIG');

/* -------------------------------------------------------------------------- */
/* Configuration Types                                                        */
/* -------------------------------------------------------------------------- */

/** Configuration options passed to `EventEmitterModule.forRoot`. */
export type EventEmitterModuleOptions = NonNullable<
  Parameters<typeof EventEmitterModule.forRoot>[0]
>;

export interface OutboxConfig {
  /** How often the outbox worker polls for pending events in milliseconds. */
  pollIntervalMs: number;
  /** Maximum number of pending events processed in a single batch. */
  batchSize: number;
  /** Maximum retry attempts before marking an event as failed. */
  maxRetries: number;
  /** Base delay between retries in milliseconds. */
  retryBackoffMs: number;
}

export interface EventsConfig {
  /** In-memory event emitter options passed to `@nestjs/event-emitter`. */
  emitter: EventEmitterModuleOptions;
  /** Outbox poller and processor options. */
  outbox: OutboxConfig;
}

/* -------------------------------------------------------------------------- */
/* Configuration Builders                                                     */
/* -------------------------------------------------------------------------- */

function resolveEnv(env?: Env): Env | null {
  if (env) {
    return env;
  }
  if (process.env.DATABASE_URL) {
    return getEnv();
  }
  return null;
}

/**
 * Builds the `@nestjs/event-emitter` configuration from validated environment settings.
 */
export function buildEventEmitterConfig(env?: Env): EventEmitterModuleOptions {
  const resolved = resolveEnv(env);
  return {
    wildcard: resolved?.EVENTS_WILDCARD ?? true,
    delimiter: resolved?.EVENTS_DELIMITER ?? '.',
    maxListeners: resolved?.EVENTS_MAX_LISTENERS ?? 20,
    verboseMemoryLeak: resolved?.EVENTS_VERBOSE_MEMORY_LEAK ?? false,
    ignoreErrors: false,
    global: true,
  };
}

/**
 * Builds the transactional outbox worker configuration from validated environment settings.
 */
export function buildOutboxConfig(env?: Env): OutboxConfig {
  const resolved = resolveEnv(env);
  return {
    pollIntervalMs: resolved?.OUTBOX_POLL_INTERVAL_MS ?? 2000,
    batchSize: resolved?.OUTBOX_BATCH_SIZE ?? 50,
    maxRetries: resolved?.OUTBOX_MAX_RETRIES ?? 5,
    retryBackoffMs: resolved?.OUTBOX_RETRY_BACKOFF_MS ?? 1000,
  };
}

/**
 * Builds the combined events and outbox configuration object.
 */
export function buildEventsConfig(env?: Env): EventsConfig {
  return {
    emitter: buildEventEmitterConfig(env),
    outbox: buildOutboxConfig(env),
  };
}
