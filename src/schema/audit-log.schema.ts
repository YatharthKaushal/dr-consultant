import { bigserial, index, inet, jsonb, pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { actorTypeEnum, auditActionEnum } from './enums.schema';

/**
 * Append-only. Absorbs the login-attempt log (`action = login`, which rate
 * limiting reads) and the credential sign-off trail (`action = verify`). No
 * summary column — the viewer composes a line from actor_type, action and
 * entity_type; anything more specific is already in `metadata`.
 *
 * `entity_id` and `consultation_id` are deliberately untyped/unconstrained
 * (no FK) — this table outlives and cross-cuts every other table's lifecycle,
 * and `entity_type` is polymorphic.
 */
export const auditLogTable = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    actorType: actorTypeEnum('actor_type').notNull(),
    /** Null for system. */
    actorId: uuid('actor_id'),
    action: auditActionEnum('action').notNull(),
    entityType: varchar('entity_type', { length: 80 }).notNull(),
    entityId: varchar('entity_id', { length: 80 }).notNull(),
    consultationId: uuid('consultation_id'),
    /** Before/after for config, raw payload for webhooks, identifier for login attempts, document id for verification. */
    metadata: jsonb('metadata').$type<unknown>(),
    ipAddress: inet('ip_address'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index().on(table.actorType, table.actorId, table.createdAt),
    index().on(table.entityType, table.entityId),
    index().on(table.action, table.createdAt),
    index().on(table.consultationId),
  ],
);

export type AuditLogRow = typeof auditLogTable.$inferSelect;
export type NewAuditLogRow = typeof auditLogTable.$inferInsert;
