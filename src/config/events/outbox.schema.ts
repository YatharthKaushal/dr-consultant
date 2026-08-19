import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

/**
 * PostgreSQL Schema definition for the Transactional Outbox pattern.
 *
 * Persists domain and integration events atomically within the database transaction
 * that changed the aggregate state, guaranteeing at-least-once delivery to other
 * decoupled modules or external services.
 */

export const OUTBOX_STATUSES = ['pending', 'processing', 'published', 'failed'] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

export const outboxStatusEnum = pgEnum('outbox_status', OUTBOX_STATUSES);

export const outboxTable = pgTable(
  'outbox_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    aggregateType: varchar('aggregate_type', { length: 255 }).notNull(),
    aggregateId: varchar('aggregate_id', { length: 255 }).notNull(),
    eventType: varchar('event_type', { length: 255 }).notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    status: outboxStatusEnum('status').default('pending').notNull(),
    retryCount: integer('retry_count').default(0).notNull(),
    maxRetries: integer('max_retries').default(5).notNull(),
    lastError: text('last_error'),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_outbox_status_scheduled').on(table.status, table.scheduledFor),
    index('idx_outbox_aggregate').on(table.aggregateType, table.aggregateId),
    index('idx_outbox_event_type').on(table.eventType),
    index('idx_outbox_created_at').on(table.createdAt),
  ],
);

export type OutboxEvent = typeof outboxTable.$inferSelect;
export type NewOutboxEvent = typeof outboxTable.$inferInsert;
