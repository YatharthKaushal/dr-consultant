import { boolean, index, jsonb, pgTable, smallint, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { adminsTable } from './admins.schema';
import { concernsTable } from './concerns.schema';
import { contentItemTypeEnum, contentReviewStatusEnum } from './enums.schema';
import { specialtiesTable } from './specialties.schema';

/**
 * No `locale` — a multilingual app is Phase 3, so every row is in the launch
 * language. No `published_at` — `review_status = published` says it, and
 * `sort_order` plus `created_at` order the shelf.
 */
export const contentItemsTable = pgTable(
  'content_items',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    itemType: contentItemTypeEnum('item_type').notNull(),
    slug: varchar('slug', { length: 160 }).notNull().unique(),
    title: varchar('title', { length: 200 }).notNull(),
    summary: varchar('summary', { length: 400 }),
    /** Structured blocks. For item_type = support_org this holds phone, address, timings. */
    body: jsonb('body').$type<unknown>().notNull(),
    concernId: uuid('concern_id').references(() => concernsTable.id),
    /** Used by item_type = clinical_reference. */
    specialtyId: uuid('specialty_id').references(() => specialtiesTable.id),
    /** Admin-uploaded cover image. Held as a storage key, NOT a patient_files row — content media has no patient owner. */
    coverStorageKey: text('cover_storage_key'),
    /** item_type = support_org only — has this helpline or NGO been checked. */
    isVerifiedOrg: boolean('is_verified_org'),
    reviewStatus: contentReviewStatusEnum('review_status').notNull().default('draft'),
    /** The clinical reviewer is the client, not the developer. */
    reviewedByAdminId: uuid('reviewed_by_admin_id').references(() => adminsTable.id),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true, mode: 'date' }),
    sortOrder: smallint('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index().on(table.itemType, table.reviewStatus),
    index().on(table.concernId, table.itemType),
  ],
);

export type ContentItemRow = typeof contentItemsTable.$inferSelect;
export type NewContentItemRow = typeof contentItemsTable.$inferInsert;
