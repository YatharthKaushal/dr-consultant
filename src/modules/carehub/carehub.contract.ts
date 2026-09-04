import type { ContentItemType, ContentReviewStatus } from '../../schema/enums.schema';

/**
 * A published `content_items` row as any caller outside this module sees it
 * (and as the public browse/detail routes return it too — there is no
 * narrower public shape, unlike `ClinicalRecordView`/`ClinicalCarePlanView`,
 * because nothing about this content is sensitive once it is published).
 *
 * `isVerifiedOrg` is ALWAYS a `boolean` here, never `null` — the column is
 * nullable (an admin has not assessed it yet), but a caller must never be
 * able to mistake "not yet assessed" for "verified". See
 * `carehub.mapper.ts#toContentItemView`.
 */
export interface ContentItemView {
  id: string;
  itemType: ContentItemType;
  slug: string;
  title: string;
  summary: string | null;
  body: unknown;
  concernId: string | null;
  specialtyId: string | null;
  coverStorageKey: string | null;
  /** `item_type = support_org` only. `false` for every other type and for an unassessed org — see the class doc comment. */
  isVerifiedOrg: boolean;
  reviewStatus: ContentReviewStatus;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

/** The admin authoring view — everything `ContentItemView` has, plus the review trail no patient ever sees. */
export interface AdminContentItemView extends ContentItemView {
  reviewedByAdminId: string | null;
  reviewedAt: Date | null;
}

/**
 * FR-15.4: one `content_recommendations` row, as the patient/doctor sees it —
 * "recorded against a consultation ID, with no clinical data held here", so
 * this carries nothing about the consultation beyond its id.
 */
export interface RecommendationView {
  id: string;
  consultationId: string;
  contentItem: ContentItemView;
  createdAt: Date;
}

/**
 * *** THE M-16 <-> M-18 SEAM, FROM THIS SIDE. ***
 *
 * `modules/followup/followup-care-hub.contract.ts` declares `CareHubPort`
 * (`getRecommendedForConsultation(consultationId): Promise<{contentId,
 * title, kind}[]>`) as "a guess, not a frozen contract" it wrote before this
 * module existed, and binds `CARE_HUB_PORT` to a null object until the
 * coordinator rebinds it to `CareHubFacade` post-merge.
 *
 * *** THIS MODULE DOES NOT IMPORT THAT FILE. *** `backend/README.md` §2
 * forbids a deep cross-module import, and the whole point of a port is that
 * the module on this side never needs to see it — `CareHubFacade` below
 * satisfies it STRUCTURALLY. `RecommendedContentItem` here is deliberately
 * shaped to match `RecommendedCareHubItem` field-for-field
 * (`contentId`/`title`/`kind`) so the coordinator's one-line rebind
 * (`{ provide: CARE_HUB_PORT, useExisting: CareHubFacade }`) needs no
 * adapter — exactly what that file's own comment predicted ("a real
 * `CareHubPort` can satisfy it with little more than a field rename", and no
 * rename was even needed).
 */
export interface RecommendedContentItem {
  contentId: string;
  title: string;
  /** `content_items.item_type` as a plain string — matches the port's own comment that its vocabulary is deliberately loose until M-18 exists. */
  kind: string;
}

/**
 * M-18's public surface (`backend/README.md` §2). Read-only, and narrow —
 * exactly the one cross-module read the port above needs, plus the same read
 * `FollowupService#getCarePlan`'s eventual composition needs it for.
 *
 * *** NO WRITE IS EXPOSED. *** Recording a recommendation is the treating
 * doctor's act, reached through this module's own controller with their own
 * credentials and its own ownership check — a facade method that let another
 * module write one on a doctor's behalf would be exactly the kind of
 * convention-only enforcement FR-11.5's "enforced by the system" line (this
 * module's own analogue of it) warns against.
 */
export interface CareHubContract {
  /**
   * Doctor-recommended items for one consultation, oldest first. Empty array
   * — never a throw — when there is nothing recommended, mirroring the
   * port's own "empty array, never a throw" contract exactly. No ownership
   * check: a trusted module-to-module read, the caller authorizes, the same
   * rule `ClinicalContract`/`BookingContract.findById` both state.
   */
  getRecommendedForConsultation(consultationId: string): Promise<RecommendedContentItem[]>;

  /**
   * ADDITIVE (M-21/data rights execution): `DataRightsFacade#previewExecution`
   * needs a READ-ONLY row count of `content_recommendations` for a patient's
   * approved data-deletion request, across every consultation the caller has
   * already resolved for that patient — without touching a single row.
   * `content_recommendations` is RETAIN in the M-21 compliance survey (SRS
   * §5.3), so nothing this method reads is ever anonymized or deleted. Empty
   * `consultationIds` in, `0` out — no query issued.
   */
  countRecommendationsForConsultations(consultationIds: readonly string[]): Promise<number>;
}
