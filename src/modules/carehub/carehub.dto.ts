import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDefined,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Min,
} from 'class-validator';
import { CONTENT_ITEM_TYPES, CONTENT_REVIEW_STATUSES, type ContentItemType, type ContentReviewStatus } from '../../schema/enums.schema';

/** `GET /care-hub/content` — the patient browse filter, FR-15.1/15.2/15.6's "condition-wise" and per-type shelves. */
export class ListPublishedContentQueryDto {
  @IsOptional()
  @IsIn([...CONTENT_ITEM_TYPES], { message: `itemType must be one of: ${CONTENT_ITEM_TYPES.join(', ')}.` })
  itemType?: ContentItemType;

  @IsOptional()
  @IsUUID('4', { message: 'concernId must be a valid UUID.' })
  concernId?: string;
}

/** `GET /admin/care-hub/content` — the admin listing, every review status. */
export class ListAdminContentQueryDto {
  @IsOptional()
  @IsIn([...CONTENT_ITEM_TYPES], { message: `itemType must be one of: ${CONTENT_ITEM_TYPES.join(', ')}.` })
  itemType?: ContentItemType;

  @IsOptional()
  @IsIn([...CONTENT_REVIEW_STATUSES], { message: `reviewStatus must be one of: ${CONTENT_REVIEW_STATUSES.join(', ')}.` })
  reviewStatus?: ContentReviewStatus;

  @IsOptional()
  @IsUUID('4', { message: 'concernId must be a valid UUID.' })
  concernId?: string;
}

/**
 * `POST /admin/care-hub/content` — admin authoring (FR-18.7). Always lands
 * as `review_status = 'draft'` (the column default); there is no field for
 * it here, the same way `SaveClinicalRecordDto` has no `doctorId` — a
 * starting state is not the caller's to set, a transition is.
 *
 * `isVerifiedOrg`/`specialtyId` are accepted from any caller here but
 * enforced against `itemType` in `carehub.service.ts` (`support_org` /
 * `clinical_reference` only respectively) — the same "DTO is the first line,
 * not the rule" reasoning `clinical.dto.ts`'s own header gives, because the
 * cross-field rule (which field is legal depends on another field's value)
 * is not expressible as a single field's decorator.
 */
export class CreateContentItemDto {
  @IsIn([...CONTENT_ITEM_TYPES], { message: `itemType must be one of: ${CONTENT_ITEM_TYPES.join(', ')}.` })
  itemType!: ContentItemType;

  @IsString()
  @Length(1, 160)
  slug!: string;

  @IsString()
  @Length(1, 200)
  title!: string;

  @IsOptional()
  @IsString()
  @Length(1, 400)
  summary?: string;

  /** Structured blocks — shape varies by `itemType` (see `content-items.schema.ts`), so validated only for presence here. */
  @IsDefined()
  body!: unknown;

  @IsOptional()
  @IsUUID('4', { message: 'concernId must be a valid UUID.' })
  concernId?: string;

  /** `item_type = clinical_reference` only. */
  @IsOptional()
  @IsUUID('4', { message: 'specialtyId must be a valid UUID.' })
  specialtyId?: string;

  @IsOptional()
  @IsString()
  coverStorageKey?: string;

  /** `item_type = support_org` only. */
  @IsOptional()
  @IsBoolean()
  isVerifiedOrg?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

/**
 * `PUT /admin/care-hub/content/:id` — every field optional, a patch. `itemType`
 * is DELIBERATELY ABSENT: changing what kind of content a row is would
 * silently repurpose `concernId`/`specialtyId`/`isVerifiedOrg`'s meaning out
 * from under it — a new item type is a new row, not an edit to an old one.
 */
export class UpdateContentItemDto {
  @IsOptional()
  @IsString()
  @Length(1, 160)
  slug?: string;

  @IsOptional()
  @IsString()
  @Length(1, 200)
  title?: string;

  @IsOptional()
  @IsString()
  @Length(1, 400)
  summary?: string;

  @IsOptional()
  body?: unknown;

  @IsOptional()
  @IsUUID('4', { message: 'concernId must be a valid UUID.' })
  concernId?: string;

  @IsOptional()
  @IsUUID('4', { message: 'specialtyId must be a valid UUID.' })
  specialtyId?: string;

  @IsOptional()
  @IsString()
  coverStorageKey?: string;

  @IsOptional()
  @IsBoolean()
  isVerifiedOrg?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

/**
 * `POST /consultations/:id/care-hub/recommendations` (FR-15.4) — the doctor's
 * selection after a consult. A batch, not one-at-a-time: the doctor picks a
 * set of items in one screen action.
 */
export class AddRecommendationsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsUUID('4', { each: true, message: 'contentItemIds must all be valid UUIDs.' })
  contentItemIds!: string[];
}
