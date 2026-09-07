import { boolean, index, pgTable, text, timestamp, unique, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import { contentFormatEnum, legalAudienceEnum, legalDocumentTypeEnum } from './enums.schema';

/**
 * No locale — single-language at launch. No `published_at` — `is_current`
 * decides what is served, and `created_at` records when the row was written.
 *
 * `(id, document_type)` carries a composite UNIQUE CONSTRAINT (not a bare
 * `uniqueIndex()`) so `consents` can hold a composite FK on those two
 * columns — see `consents.schema.ts`. This must be a table constraint, not
 * a standalone index: drizzle-kit inlines a `unique()` constraint into this
 * table's own `CREATE TABLE` statement, so it exists before any later
 * migration statement can reference it. A `uniqueIndex()` here instead
 * generates a separate `CREATE UNIQUE INDEX` that drizzle-kit does not order
 * ahead of a cross-table FK depending on it, and the migration fails with
 * "there is no unique constraint matching given keys for referenced table".
 *
 * `audience`/`contentFormat` are ADDITIVE (public rich-text pages, force-
 * update round). `audience` joins the "one current version" uniqueness and
 * index: `(document_type, version)` -> `(document_type, audience, version)`
 * and `(document_type, is_current)` -> `(document_type, audience,
 * is_current)`, so a per-app override and the shared `'all'` document of the
 * same type can each independently have their own current version. Every
 * existing row migrates to `audience = 'all'`, `content_format =
 * 'markdown'` — see the migration's own comment for why that is safe.
 */
export const legalDocumentsTable = pgTable(
  'legal_documents',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    documentType: legalDocumentTypeEnum('document_type').notNull(),
    audience: legalAudienceEnum('audience').notNull().default('all'),
    /** Client-set. A new version is a NEW ROW — never edit one people have accepted. */
    version: varchar('version', { length: 20 }).notNull(),
    title: varchar('title', { length: 200 }).notNull(),
    /** Client-supplied copy — Markdown by default, see `contentFormat`. */
    body: text('body').notNull(),
    contentFormat: contentFormatEnum('content_format').notNull().default('markdown'),
    /** The version new users must accept. */
    isCurrent: boolean('is_current').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex().on(table.documentType, table.audience, table.version),
    index().on(table.documentType, table.audience, table.isCurrent),
    unique('legal_documents_id_document_type_key').on(table.id, table.documentType),
  ],
);

export type LegalDocumentRow = typeof legalDocumentsTable.$inferSelect;
export type NewLegalDocumentRow = typeof legalDocumentsTable.$inferInsert;
