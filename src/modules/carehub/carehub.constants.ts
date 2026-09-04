import type { ContentItemType, ContentReviewStatus } from '../../schema/enums.schema';

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * *** `clinical_reference` IS DELIBERATELY EXCLUDED FROM THE PATIENT SURFACE. ***
 *
 * `content-items.schema.ts` documents seven `item_type` values, but
 * `docs/SRS.md` §4.15 (FR-15.1 through FR-15.7) only ever names six of them —
 * `self_help_tool`, `education_module`, `blog_article`, `caregiver_guide`,
 * `support_org`, `emergency_guidance`. `clinical_reference` maps to no FR-15
 * line at all, and its own column comment ties it to `specialtyId` ("Used by
 * item_type = clinical_reference") rather than to `concernId`, which every
 * patient-facing type uses to slot into the condition-wise library (FR-15.2).
 * That is the signature of doctor-facing reference material — a specialty's
 * clinical crib sheet, not something FR-15 asks to be shown to a patient.
 *
 * So this module treats `clinical_reference` as authorable and reviewable
 * (the same draft -> review -> published workflow, FR-18.7's "no release"
 * promise applies to it too) but keeps it OFF both the public browse surface
 * and the doctor recommendation surface: `listPublished`/`getPublished`
 * exclude it, and `content_recommendations` refuses to reference one. A
 * doctor-facing "browse clinical references" reading surface is not
 * something FR-15/M-18's feature list asks for and is left for a future round
 * if the client wants one.
 */
export const PATIENT_FACING_ITEM_TYPES: readonly ContentItemType[] = [
  'self_help_tool',
  'education_module',
  'blog_article',
  'caregiver_guide',
  'emergency_guidance',
  'support_org',
];

/* -------------------------------------------------------------------------- */
/* The review-status state machine                                            */
/* -------------------------------------------------------------------------- */

/**
 * *** THE CONTENT REVIEW STATE MACHINE. *** `content_review_status`:
 * `draft -> in_clinical_review -> published -> archived`.
 *
 * Read each entry the same direction `video.constants.ts`'s
 * `LEGAL_VIDEO_STATUS_TRANSITIONS` and `booking.service.ts`'s
 * `ConsultationStatusTransitionInput.from` both do: "a content item may ENTER
 * <key> from any of <value>" — so a caller writes
 * `CONTENT_REVIEW_STATUS_TRANSITIONS[target]` and cannot hand-roll a subtly
 * different set at one call site.
 *
 *   draft               <- in_clinical_review (the reviewer sends it back for
 *                          changes), <- archived (an admin revives a retired
 *                          item to start editing it again)
 *   in_clinical_review   <- draft (the author submits it for sign-off)
 *   published            <- in_clinical_review (*** THE CLINICAL REVIEWER'S
 *                          SIGN-OFF *** — `reviewedByAdminId`/`reviewedAt` are
 *                          set on exactly this move, nowhere else)
 *   archived             <- published, draft, in_clinical_review (content can
 *                          be taken down, or a draft/in-review item can be
 *                          discarded, from any active state)
 *
 * `published -> archived` and `in_clinical_review -> draft`/`-> published` are
 * gated behind `content.publish` (`permission.catalog.ts`: "publishing is by
 * construction a different role's act"); every other move is `content.author`.
 * See `carehub-admin.controller.ts` for exactly which endpoint asks for which.
 */
export const CONTENT_REVIEW_STATUS_TRANSITIONS = {
  draft: ['in_clinical_review', 'archived'],
  in_clinical_review: ['draft'],
  published: ['in_clinical_review'],
  archived: ['published', 'draft', 'in_clinical_review'],
} as const satisfies Record<ContentReviewStatus, readonly ContentReviewStatus[]>;

/* -------------------------------------------------------------------------- */
/* Sharing (FR-15.5)                                                          */
/* -------------------------------------------------------------------------- */

/**
 * How long a caregiver-guide share link stays good. Not `app_config` — unlike
 * `video.join_token_ttl_seconds` (named explicitly in `app_config`'s own
 * table comment as a business rule an admin tunes), nothing in `docs/SRS.md`
 * or `docs/MODULES.md` calls this out as admin-tunable, and a caregiver guide
 * is static reference material with no time-sensitive access pattern the way
 * a video join window has. Thirty days: long enough that "re-sending it"
 * (the brief's own phrase for the patient's repeat-consent action) is rarely
 * needed, short enough that a link is not effectively permanent.
 */
export const CARE_HUB_SHARE_LINK_TTL_DAYS = 30;

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export const CARE_HUB_ERROR_CODES = {
  CONTENT_ITEM_NOT_FOUND: 'CARE_HUB_CONTENT_ITEM_NOT_FOUND',
  SLUG_TAKEN: 'CARE_HUB_SLUG_TAKEN',
  ILLEGAL_REVIEW_TRANSITION: 'CARE_HUB_ILLEGAL_REVIEW_TRANSITION',
  /** `concernId`/`specialtyId` was set to an id `CatalogueFacade` does not recognise. */
  UNKNOWN_TAXONOMY_REFERENCE: 'CARE_HUB_UNKNOWN_TAXONOMY_REFERENCE',
  /** `isVerifiedOrg` set on anything but `item_type = support_org`. */
  VERIFIED_ORG_NOT_APPLICABLE: 'CARE_HUB_VERIFIED_ORG_NOT_APPLICABLE',
  /** `specialtyId` set on anything but `item_type = clinical_reference`. */
  SPECIALTY_NOT_APPLICABLE: 'CARE_HUB_SPECIALTY_NOT_APPLICABLE',
  /** One code for "does not exist", "belongs to another doctor/patient" and "isn't a booking's" — a caller must not be able to probe for another party's consultation. */
  CONSULTATION_NOT_FOUND: 'CARE_HUB_CONSULTATION_NOT_FOUND',
  /** A content item recommended (or shared) is not published, or is `clinical_reference` — see `PATIENT_FACING_ITEM_TYPES`. */
  CONTENT_ITEM_NOT_RECOMMENDABLE: 'CARE_HUB_CONTENT_ITEM_NOT_RECOMMENDABLE',
  /** FR-15.5: a share link was minted for something other than `caregiver_guide`. */
  NOT_SHAREABLE: 'CARE_HUB_NOT_SHAREABLE',
  /** The share token failed to verify: malformed, bad signature, or expired. */
  SHARE_LINK_INVALID: 'CARE_HUB_SHARE_LINK_INVALID',
} as const;
export type CareHubErrorCode = (typeof CARE_HUB_ERROR_CODES)[keyof typeof CARE_HUB_ERROR_CODES];

/* -------------------------------------------------------------------------- */
/* Audit                                                                       */
/* -------------------------------------------------------------------------- */

export const CARE_HUB_AUDIT_ENTITY_TYPES = {
  CONTENT_ITEM: 'content_item',
  CONTENT_RECOMMENDATION: 'content_recommendation',
  CONTENT_SHARE_LINK: 'content_share_link',
} as const;
