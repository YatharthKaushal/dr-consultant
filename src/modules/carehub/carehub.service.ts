import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { getEnv } from '../../config/env/env.validation';
import type { ContentItemRow } from '../../schema/content-items.schema';
import { CONTENT_ITEM_TYPES, type ContentItemType, type ContentReviewStatus } from '../../schema/enums.schema';
import { AuditService } from '../../shared/audit/audit.service';
import { isUniqueConstraintViolation } from '../../shared/errors/postgres-error.util';
import { BookingFacade } from '../booking/booking.facade';
import { CatalogueFacade } from '../catalogue/catalogue.facade';
import { CARE_HUB_AUDIT_ENTITY_TYPES, CARE_HUB_ERROR_CODES, CARE_HUB_SHARE_LINK_TTL_DAYS, PATIENT_FACING_ITEM_TYPES } from './carehub.constants';
import type {
  AdminContentItemView,
  ContentItemView,
  RecommendationView,
  RecommendedContentItem,
} from './carehub.contract';
import { CarehubRepository } from './carehub.repository';
import type { AddRecommendationsDto, CreateContentItemDto, ListAdminContentQueryDto, ListPublishedContentQueryDto, UpdateContentItemDto } from './carehub.dto';
import { toAdminContentItemView, toContentItemView, toRecommendationView, toRecommendedContentItem } from './carehub.mapper';

/** Types not shown on the patient browse/recommend surface — see `PATIENT_FACING_ITEM_TYPES`'s class doc comment for why `clinical_reference` is the one exclusion. */
const NON_PATIENT_FACING_ITEM_TYPES: readonly ContentItemType[] = CONTENT_ITEM_TYPES.filter(
  (type) => !PATIENT_FACING_ITEM_TYPES.includes(type),
);

/**
 * M-18's rules (`backend/README.md` §2: "services hold the rules").
 *
 * Covers the whole module: patient browsing and sharing, the doctor's
 * recommendation write path, and admin authoring/review — the same "one
 * service, several controllers" shape `ClinicalService` uses (its own
 * `getRecordForAdmin` sits beside `saveDraft`/`finalise` in one file).
 */
@Injectable()
export class CarehubService {
  constructor(
    private readonly repo: CarehubRepository,
    private readonly catalogue: CatalogueFacade,
    private readonly bookings: BookingFacade,
    private readonly audit: AuditService,
  ) {}

  /* ── Patient browse (FR-15.1/15.2/15.3/15.6/15.7) ────────────────────── */

  /** Published content only, `clinical_reference` always excluded — see `PATIENT_FACING_ITEM_TYPES`. */
  async listPublished(filter: ListPublishedContentQueryDto): Promise<ContentItemView[]> {
    if (filter.itemType && !PATIENT_FACING_ITEM_TYPES.includes(filter.itemType)) {
      // Asking for `clinical_reference` explicitly gets an empty shelf, not an
      // error — the same "collapse rather than leak" reasoning
      // `promotion-link.controller.ts` gives for an unknown slug: a caller
      // probing item types learns nothing about what exists.
      return [];
    }
    const rows = await this.repo.listPublished({
      itemType: filter.itemType,
      concernId: filter.concernId,
      excludeItemTypes: filter.itemType ? undefined : NON_PATIENT_FACING_ITEM_TYPES,
    });
    return rows.map(toContentItemView);
  }

  /** One published item. 404 collapses "does not exist" and "not published yet" — a patient must not be able to tell a draft exists. */
  async getPublishedById(id: string): Promise<ContentItemView> {
    const row = await this.repo.findById(id);
    if (!row || row.reviewStatus !== 'published' || !PATIENT_FACING_ITEM_TYPES.includes(row.itemType)) {
      throw contentItemNotFound();
    }
    return toContentItemView(row);
  }

  /* ── FR-15.5: caregiver-guide sharing ────────────────────────────────── */

  /**
   * *** THE PATIENT'S EXPLICIT ACTION IS THE CONSENT. *** Per the brief:
   * `consent.contract.ts` has nothing about sharing, so this is not an M-03
   * formal-consent flow — generating (or re-generating, to "re-send") this
   * link IS what FR-15.5 means by "shareable with the patient's consent".
   *
   * A signed, self-expiring token, no `content_share_links` row — mirrors
   * `affiliate.service.ts#mintAttributionToken` exactly, including why: no
   * new table for an anonymous-recipient link (the caregiver has no account
   * here to attach a row to), the server is authoritative on nothing but the
   * token's own signature and expiry, and `linkTokenKey()`'s domain-separated
   * derivation from `JWT_ACCESS_SECRET` avoids a new required env var.
   */
  async mintShareLink(contentItemId: string, patientId: string): Promise<{ token: string; expiresAt: Date }> {
    const row = await this.repo.findById(contentItemId);
    if (!row || row.reviewStatus !== 'published') throw contentItemNotFound();
    if (row.itemType !== 'caregiver_guide') throw notShareable();

    const expiresAt = new Date(Date.now() + CARE_HUB_SHARE_LINK_TTL_DAYS * 24 * 60 * 60 * 1000);
    const payload = Buffer.from(
      JSON.stringify({ c: contentItemId, e: Math.floor(expiresAt.getTime() / 1000) }),
      'utf8',
    ).toString('base64url');
    const signature = createHmac('sha256', shareLinkKey()).update(payload).digest('base64url');
    const token = `v1.${payload}.${signature}`;

    await this.audit.write({
      actorType: 'patient',
      actorId: patientId,
      action: 'create',
      entityType: CARE_HUB_AUDIT_ENTITY_TYPES.CONTENT_SHARE_LINK,
      entityId: contentItemId,
      metadata: { expiresAt: expiresAt.toISOString() },
    });

    return { token, expiresAt };
  }

  /** `GET /care-hub/shared/:token` — public, no account. Same 404 for a bad signature, an expired token, or content since unpublished/retyped: nothing here should tell an anonymous caller which case it is. */
  async resolveSharedContent(token: string): Promise<ContentItemView> {
    const verified = verifyShareLinkToken(token);
    if (!verified) throw shareLinkInvalid();
    const row = await this.repo.findById(verified.contentItemId);
    if (!row || row.reviewStatus !== 'published' || row.itemType !== 'caregiver_guide') throw shareLinkInvalid();
    return toContentItemView(row);
  }

  /* ── FR-15.4: the doctor's recommendation write path ─────────────────── */

  /**
   * *** THE OWNERSHIP CHECK. *** Same 404-not-403 shape
   * `clinical.controller.ts`/`document-consultation.controller.ts` both use,
   * via `BookingFacade.getBooking` — the brief's own named seam — so a
   * doctor cannot probe for another doctor's consultations.
   */
  async addRecommendations(consultationId: string, doctorId: string, dto: AddRecommendationsDto): Promise<RecommendationView[]> {
    await this.assertDoctorOwnsConsultation(consultationId, doctorId);

    const items = await this.repo.findByIds(dto.contentItemIds);
    const byId = new Map(items.map((item) => [item.id, item]));
    for (const contentItemId of dto.contentItemIds) {
      const item = byId.get(contentItemId);
      if (!item || item.reviewStatus !== 'published' || !PATIENT_FACING_ITEM_TYPES.includes(item.itemType)) {
        throw contentItemNotRecommendable(contentItemId);
      }
    }

    for (const contentItemId of dto.contentItemIds) {
      const created = await this.repo.addRecommendationIfAbsent({ consultationId, contentItemId });
      if (created) {
        await this.audit.write({
          actorType: 'doctor',
          actorId: doctorId,
          action: 'create',
          entityType: CARE_HUB_AUDIT_ENTITY_TYPES.CONTENT_RECOMMENDATION,
          entityId: created.id,
          consultationId,
          metadata: { contentItemId },
        });
      }
    }

    return this.listRecommendationsForDoctor(consultationId, doctorId);
  }

  async removeRecommendation(consultationId: string, doctorId: string, contentItemId: string): Promise<void> {
    await this.assertDoctorOwnsConsultation(consultationId, doctorId);
    const removed = await this.repo.removeRecommendation(consultationId, contentItemId);
    if (removed) {
      await this.audit.write({
        actorType: 'doctor',
        actorId: doctorId,
        action: 'delete',
        entityType: CARE_HUB_AUDIT_ENTITY_TYPES.CONTENT_RECOMMENDATION,
        entityId: contentItemId,
        consultationId,
      });
    }
  }

  async listRecommendationsForDoctor(consultationId: string, doctorId: string): Promise<RecommendationView[]> {
    await this.assertDoctorOwnsConsultation(consultationId, doctorId);
    return this.listRecommendations(consultationId);
  }

  /** The patient's own read of "what my doctor recommended" for one of their consultations — same ownership-check shape, checked against the patient instead of the doctor. */
  async listRecommendationsForPatient(consultationId: string, patientId: string): Promise<RecommendationView[]> {
    const booking = await this.bookings.getBooking(consultationId);
    if (!booking || booking.patientId !== patientId) throw consultationNotFound();
    return this.listRecommendations(consultationId);
  }

  /** *** THE `CareHubContract`/`CareHubPort` READ. *** No ownership check — a trusted module-to-module call, the caller authorizes (see `carehub.contract.ts`). */
  async getRecommendedForConsultation(consultationId: string): Promise<RecommendedContentItem[]> {
    const rows = await this.repo.listRecommendationsForConsultation(consultationId);
    if (rows.length === 0) return [];
    const items = await this.repo.findByIds(rows.map((row) => row.contentItemId));
    const byId = new Map(items.map((item) => [item.id, item]));
    return rows
      .map((row) => byId.get(row.contentItemId))
      .filter((item): item is ContentItemRow => item !== undefined)
      .map(toRecommendedContentItem);
  }

  private async listRecommendations(consultationId: string): Promise<RecommendationView[]> {
    const rows = await this.repo.listRecommendationsForConsultation(consultationId);
    if (rows.length === 0) return [];
    const items = await this.repo.findByIds(rows.map((row) => row.contentItemId));
    const byId = new Map(items.map((item) => [item.id, item]));
    return rows
      .filter((row) => byId.has(row.contentItemId))
      .map((row) => toRecommendationView(row, byId.get(row.contentItemId)!));
  }

  private async assertDoctorOwnsConsultation(consultationId: string, doctorId: string): Promise<void> {
    const booking = await this.bookings.getBooking(consultationId);
    if (!booking || booking.doctorId !== doctorId) throw consultationNotFound();
  }

  /* ── Admin authoring (FR-18.7) ────────────────────────────────────────── */

  async listForAdmin(filter: ListAdminContentQueryDto): Promise<AdminContentItemView[]> {
    const rows = await this.repo.listForAdmin(filter);
    return rows.map(toAdminContentItemView);
  }

  async getForAdmin(id: string): Promise<AdminContentItemView> {
    const row = await this.repo.findById(id);
    if (!row) throw contentItemNotFound();
    return toAdminContentItemView(row);
  }

  async create(dto: CreateContentItemDto, actorAdminId: string): Promise<AdminContentItemView> {
    await this.assertTaxonomyReferences(dto.concernId, dto.specialtyId);
    this.assertItemTypeFieldRules(dto.itemType, { isVerifiedOrg: dto.isVerifiedOrg, specialtyId: dto.specialtyId });

    try {
      const row = await this.repo.create({
        itemType: dto.itemType,
        slug: dto.slug,
        title: dto.title,
        summary: dto.summary ?? null,
        body: dto.body,
        concernId: dto.concernId ?? null,
        specialtyId: dto.specialtyId ?? null,
        coverStorageKey: dto.coverStorageKey ?? null,
        isVerifiedOrg: dto.isVerifiedOrg ?? null,
        sortOrder: dto.sortOrder ?? 0,
      });
      await this.audit.write({
        actorType: 'admin',
        actorId: actorAdminId,
        action: 'create',
        entityType: CARE_HUB_AUDIT_ENTITY_TYPES.CONTENT_ITEM,
        entityId: row.id,
        metadata: { itemType: row.itemType, slug: row.slug },
      });
      return toAdminContentItemView(row);
    } catch (error) {
      if (isUniqueConstraintViolation(error)) throw slugTaken();
      throw error;
    }
  }

  async update(id: string, dto: UpdateContentItemDto, actorAdminId: string): Promise<AdminContentItemView> {
    const existing = await this.repo.findById(id);
    if (!existing) throw contentItemNotFound();

    await this.assertTaxonomyReferences(dto.concernId, dto.specialtyId);
    this.assertItemTypeFieldRules(existing.itemType, { isVerifiedOrg: dto.isVerifiedOrg, specialtyId: dto.specialtyId });

    try {
      const row = await this.repo.update(id, {
        ...(dto.slug !== undefined ? { slug: dto.slug } : {}),
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.summary !== undefined ? { summary: dto.summary } : {}),
        ...(dto.body !== undefined ? { body: dto.body } : {}),
        ...(dto.concernId !== undefined ? { concernId: dto.concernId } : {}),
        ...(dto.specialtyId !== undefined ? { specialtyId: dto.specialtyId } : {}),
        ...(dto.coverStorageKey !== undefined ? { coverStorageKey: dto.coverStorageKey } : {}),
        ...(dto.isVerifiedOrg !== undefined ? { isVerifiedOrg: dto.isVerifiedOrg } : {}),
        ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
      });
      if (!row) throw contentItemNotFound();
      await this.audit.write({
        actorType: 'admin',
        actorId: actorAdminId,
        action: 'update',
        entityType: CARE_HUB_AUDIT_ENTITY_TYPES.CONTENT_ITEM,
        entityId: id,
        metadata: { fields: Object.keys(dto) },
      });
      return toAdminContentItemView(row);
    } catch (error) {
      if (isUniqueConstraintViolation(error)) throw slugTaken();
      throw error;
    }
  }

  /** `draft -> in_clinical_review`. The author submits their own work for sign-off. `content.author`. */
  async submitForReview(id: string, actorAdminId: string): Promise<AdminContentItemView> {
    return this.transition(id, 'in_clinical_review', ['draft'], actorAdminId, false);
  }

  /** *** THE CLINICAL REVIEWER'S SIGN-OFF. *** `in_clinical_review -> published`; sets `reviewedByAdminId`/`reviewedAt`. `content.publish`. */
  async publish(id: string, actorAdminId: string): Promise<AdminContentItemView> {
    return this.transition(id, 'published', ['in_clinical_review'], actorAdminId, true);
  }

  /** The reviewer sends it back for changes. `in_clinical_review -> draft`. `content.publish` — this is a review decision, not an author action. */
  async reject(id: string, actorAdminId: string): Promise<AdminContentItemView> {
    return this.transition(id, 'draft', ['in_clinical_review'], actorAdminId, false);
  }

  /** The author discards a draft or an in-review submission that never went live. `{draft, in_clinical_review} -> archived`. `content.author`. */
  async withdraw(id: string, actorAdminId: string): Promise<AdminContentItemView> {
    return this.transition(id, 'archived', ['draft', 'in_clinical_review'], actorAdminId, false);
  }

  /** Takes LIVE content down. `published -> archived`. `content.publish` — the same authority that put it live takes it down. */
  async retire(id: string, actorAdminId: string): Promise<AdminContentItemView> {
    return this.transition(id, 'archived', ['published'], actorAdminId, false);
  }

  /** Revives a retired item so it can be edited again. `archived -> draft`. `content.author`. */
  async restore(id: string, actorAdminId: string): Promise<AdminContentItemView> {
    return this.transition(id, 'draft', ['archived'], actorAdminId, false);
  }

  private async transition(
    id: string,
    to: ContentReviewStatus,
    from: readonly ContentReviewStatus[],
    actorAdminId: string,
    signOff: boolean,
  ): Promise<AdminContentItemView> {
    const current = await this.repo.findById(id);
    if (!current) throw contentItemNotFound();

    // Idempotent no-op — a retry must not look like an error.
    if (current.reviewStatus === to) return toAdminContentItemView(current);

    const updated = await this.repo.transitionReviewStatus(
      id,
      to,
      from,
      signOff ? { reviewedByAdminId: actorAdminId, reviewedAt: new Date() } : null,
    );
    if (!updated) throw illegalReviewTransition(current.reviewStatus, to);

    await this.audit.write({
      actorType: 'admin',
      actorId: actorAdminId,
      action: 'update',
      entityType: CARE_HUB_AUDIT_ENTITY_TYPES.CONTENT_ITEM,
      entityId: id,
      metadata: { from: current.reviewStatus, to },
    });
    return toAdminContentItemView(updated);
  }

  /** `concernId`/`specialtyId`, when set, must be real — the same "point of use" read `CatalogueFacade`'s own doc comment describes, not gated on `isActive`. */
  private async assertTaxonomyReferences(concernId: string | undefined, specialtyId: string | undefined): Promise<void> {
    if (concernId) {
      const concern = await this.catalogue.getConcernById(concernId);
      if (!concern) throw unknownTaxonomyReference('concernId');
    }
    if (specialtyId) {
      const specialty = await this.catalogue.getSpecialtyById(specialtyId);
      if (!specialty) throw unknownTaxonomyReference('specialtyId');
    }
  }

  /** `isVerifiedOrg` only for `support_org`; `specialtyId` only for `clinical_reference` — see `content-items.schema.ts`'s own column comments. */
  private assertItemTypeFieldRules(
    itemType: ContentItemType,
    fields: { isVerifiedOrg?: boolean; specialtyId?: string },
  ): void {
    if (fields.isVerifiedOrg !== undefined && itemType !== 'support_org') throw verifiedOrgNotApplicable();
    if (fields.specialtyId !== undefined && itemType !== 'clinical_reference') throw specialtyNotApplicable();
  }
}

/* -------------------------------------------------------------------------- */
/* Share-link token — mirrors `affiliate.service.ts`'s attribution token      */
/* -------------------------------------------------------------------------- */

/** Domain-separated from `JWT_ACCESS_SECRET`, same reasoning `affiliate.service.ts#linkTokenKey` gives: no new required env var, and a token minted here can never be presented as an access token or the reverse. */
function shareLinkKey(): Buffer {
  return createHmac('sha256', getEnv().JWT_ACCESS_SECRET).update('carehub.share_link.v1').digest();
}

function verifyShareLinkToken(token: string): { contentItemId: string; expiresAt: Date } | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return null;

  const expected = createHmac('sha256', shareLinkKey()).update(parts[1]).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(parts[2], 'base64url');
  } catch {
    return null;
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;

  try {
    const decoded = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { c?: unknown; e?: unknown };
    if (typeof decoded.c !== 'string' || typeof decoded.e !== 'number') return null;
    const expiresAt = new Date(decoded.e * 1000);
    if (expiresAt.getTime() <= Date.now()) return null;
    return { contentItemId: decoded.c, expiresAt };
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export function contentItemNotFound(): NotFoundException {
  return new NotFoundException({ code: CARE_HUB_ERROR_CODES.CONTENT_ITEM_NOT_FOUND, message: 'Content item not found.' });
}

export function slugTaken(): ConflictException {
  return new ConflictException({ code: CARE_HUB_ERROR_CODES.SLUG_TAKEN, message: 'This slug is already in use.' });
}

export function illegalReviewTransition(from: ContentReviewStatus, to: ContentReviewStatus): ConflictException {
  return new ConflictException({
    code: CARE_HUB_ERROR_CODES.ILLEGAL_REVIEW_TRANSITION,
    message: `Cannot move a content item from '${from}' to '${to}'.`,
  });
}

export function unknownTaxonomyReference(field: 'concernId' | 'specialtyId'): BadRequestException {
  return new BadRequestException({ code: CARE_HUB_ERROR_CODES.UNKNOWN_TAXONOMY_REFERENCE, message: `${field} does not reference a known record.` });
}

export function verifiedOrgNotApplicable(): BadRequestException {
  return new BadRequestException({
    code: CARE_HUB_ERROR_CODES.VERIFIED_ORG_NOT_APPLICABLE,
    message: 'isVerifiedOrg only applies to itemType support_org.',
  });
}

export function specialtyNotApplicable(): BadRequestException {
  return new BadRequestException({
    code: CARE_HUB_ERROR_CODES.SPECIALTY_NOT_APPLICABLE,
    message: 'specialtyId only applies to itemType clinical_reference.',
  });
}

export function consultationNotFound(): NotFoundException {
  return new NotFoundException({ code: CARE_HUB_ERROR_CODES.CONSULTATION_NOT_FOUND, message: 'Consultation not found.' });
}

export function contentItemNotRecommendable(contentItemId: string): BadRequestException {
  return new BadRequestException({
    code: CARE_HUB_ERROR_CODES.CONTENT_ITEM_NOT_RECOMMENDABLE,
    message: `Content item ${contentItemId} is not published and recommendable.`,
  });
}

export function notShareable(): BadRequestException {
  return new BadRequestException({ code: CARE_HUB_ERROR_CODES.NOT_SHAREABLE, message: 'Only caregiver guides can be shared.' });
}

export function shareLinkInvalid(): NotFoundException {
  return new NotFoundException({ code: CARE_HUB_ERROR_CODES.SHARE_LINK_INVALID, message: 'This share link is invalid or has expired.' });
}
