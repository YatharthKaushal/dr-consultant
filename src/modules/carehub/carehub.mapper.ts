import type { ContentItemRow } from '../../schema/content-items.schema';
import type { ContentRecommendationRow } from '../../schema/content-recommendations.schema';
import type { AdminContentItemView, ContentItemView, RecommendationView, RecommendedContentItem } from './carehub.contract';

/**
 * `content_items` row -> the public view.
 *
 * *** `isVerifiedOrg` IS COERCED TO A BOOLEAN, NEVER PASSED THROUGH RAW. ***
 * The column is nullable (an admin has not assessed the org yet), and the
 * brief's own instruction is "never present one as verified when it isn't" —
 * `null` is not verified, so it renders as `false` here, at the one place
 * every caller's view is built, rather than trusting every call site to
 * remember the coercion.
 */
export function toContentItemView(row: ContentItemRow): ContentItemView {
  return {
    id: row.id,
    itemType: row.itemType,
    slug: row.slug,
    title: row.title,
    summary: row.summary,
    body: row.body,
    concernId: row.concernId,
    specialtyId: row.specialtyId,
    coverStorageKey: row.coverStorageKey,
    isVerifiedOrg: row.isVerifiedOrg === true,
    reviewStatus: row.reviewStatus,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The admin authoring view — the public fields plus the review trail. */
export function toAdminContentItemView(row: ContentItemRow): AdminContentItemView {
  return {
    ...toContentItemView(row),
    reviewedByAdminId: row.reviewedByAdminId,
    reviewedAt: row.reviewedAt,
  };
}

/** One `content_recommendations` row, joined with its content item. */
export function toRecommendationView(row: ContentRecommendationRow, contentItem: ContentItemRow): RecommendationView {
  return {
    id: row.id,
    consultationId: row.consultationId,
    contentItem: toContentItemView(contentItem),
    createdAt: row.createdAt,
  };
}

/**
 * The `CareHubContract#getRecommendedForConsultation` / `CareHubPort
 * #getRecommendedForConsultation` projection — `contentId`/`title`/`kind`,
 * field-for-field, no rename needed at the post-merge rebind. See
 * `carehub.contract.ts`'s class doc comment on `RecommendedContentItem`.
 */
export function toRecommendedContentItem(contentItem: ContentItemRow): RecommendedContentItem {
  return {
    contentId: contentItem.id,
    title: contentItem.title,
    kind: contentItem.itemType,
  };
}
