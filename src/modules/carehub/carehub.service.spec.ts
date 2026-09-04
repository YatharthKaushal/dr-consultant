import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { ContentItemRow } from '../../schema/content-items.schema';
import type { ContentRecommendationRow } from '../../schema/content-recommendations.schema';
import type { AuditService } from '../../shared/audit/audit.service';
import type { BookingFacade } from '../booking/booking.facade';
import type { BookingView } from '../booking/booking.contract';
import type { CatalogueFacade } from '../catalogue/catalogue.facade';
import type { PublicConcern, PublicSpecialty } from '../catalogue/catalogue.contract';
import { CARE_HUB_ERROR_CODES } from './carehub.constants';
import type { CarehubRepository } from './carehub.repository';
import { CarehubService } from './carehub.service';

const CONTENT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_CONTENT_ID = '22222222-2222-4222-8222-222222222222';
const CONSULTATION_ID = '33333333-3333-4333-8333-333333333333';
const DOCTOR_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_DOCTOR_ID = '55555555-5555-4555-8555-555555555555';
const PATIENT_ID = '66666666-6666-4666-8666-666666666666';
const OTHER_PATIENT_ID = '77777777-7777-4777-8777-777777777777';
const CONCERN_ID = '88888888-8888-4888-8888-888888888888';
const SPECIALTY_ID = '99999999-9999-4999-8999-999999999999';
const ADMIN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function contentItem(overrides: Partial<ContentItemRow> = {}): ContentItemRow {
  return {
    id: CONTENT_ID,
    itemType: 'caregiver_guide',
    slug: 'caregiver-warning-signs',
    title: 'Warning signs for caregivers',
    summary: 'What to watch for.',
    body: { blocks: [] },
    concernId: null,
    specialtyId: null,
    coverStorageKey: null,
    isVerifiedOrg: null,
    reviewStatus: 'published',
    reviewedByAdminId: null,
    reviewedAt: null,
    sortOrder: 0,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function recommendation(overrides: Partial<ContentRecommendationRow> = {}): ContentRecommendationRow {
  return {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    consultationId: CONSULTATION_ID,
    contentItemId: CONTENT_ID,
    createdAt: new Date('2026-01-02T00:00:00Z'),
    ...overrides,
  };
}

function booking(overrides: Partial<BookingView> = {}): BookingView {
  return {
    id: CONSULTATION_ID,
    referenceCode: 'DC-2026-000001',
    patientId: PATIENT_ID,
    doctorId: DOCTOR_ID,
    specialtyId: SPECIALTY_ID,
    concernId: null,
    mode: 'scheduled',
    status: 'completed',
    scheduledStartAt: new Date('2026-01-01T10:00:00Z'),
    durationMinutes: 30,
    intakeAnswers: null,
    rescheduledFromConsultationId: null,
    cancelledAt: null,
    cancelledByParty: null,
    cancellationReason: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function createService() {
  const repo = {
    findById: jest.fn(),
    findByIds: jest.fn().mockResolvedValue([]),
    listPublished: jest.fn().mockResolvedValue([]),
    listForAdmin: jest.fn().mockResolvedValue([]),
    create: jest.fn(),
    update: jest.fn(),
    transitionReviewStatus: jest.fn(),
    addRecommendationIfAbsent: jest.fn(),
    removeRecommendation: jest.fn().mockResolvedValue(false),
    listRecommendationsForConsultation: jest.fn().mockResolvedValue([]),
  };
  const catalogue = {
    getConcernById: jest.fn().mockResolvedValue({ id: CONCERN_ID } as PublicConcern),
    getSpecialtyById: jest.fn().mockResolvedValue({ id: SPECIALTY_ID } as PublicSpecialty),
  };
  const bookings = {
    getBooking: jest.fn().mockResolvedValue(booking()),
  };
  const audit = { write: jest.fn().mockResolvedValue(undefined) };

  const service = new CarehubService(
    repo as unknown as CarehubRepository,
    catalogue as unknown as CatalogueFacade,
    bookings as unknown as BookingFacade,
    audit as unknown as AuditService,
  );
  return { service, repo, catalogue, bookings, audit };
}

describe('CarehubService', () => {
  /* ── Patient browse ─────────────────────────────────────────────────── */

  describe('listPublished', () => {
    it('excludes clinical_reference by default (no itemType filter)', async () => {
      const { service, repo } = createService();
      await service.listPublished({});
      expect(repo.listPublished).toHaveBeenCalledWith(
        expect.objectContaining({ excludeItemTypes: expect.arrayContaining(['clinical_reference']) }),
      );
    });

    it('returns an empty shelf, not an error, when clinical_reference is explicitly requested', async () => {
      const { service, repo } = createService();
      const result = await service.listPublished({ itemType: 'clinical_reference' });
      expect(result).toEqual([]);
      expect(repo.listPublished).not.toHaveBeenCalled();
    });

    it('coerces a null isVerifiedOrg to false on an unassessed support_org', async () => {
      const { service, repo } = createService();
      repo.listPublished.mockResolvedValue([contentItem({ itemType: 'support_org', isVerifiedOrg: null })]);
      const [result] = await service.listPublished({ itemType: 'support_org' });
      expect(result!.isVerifiedOrg).toBe(false);
    });

    it('never coerces a genuinely verified org to false', async () => {
      const { service, repo } = createService();
      repo.listPublished.mockResolvedValue([contentItem({ itemType: 'support_org', isVerifiedOrg: true })]);
      const [result] = await service.listPublished({ itemType: 'support_org' });
      expect(result!.isVerifiedOrg).toBe(true);
    });
  });

  describe('getPublishedById', () => {
    it('404s for a draft item — same code as a missing one', async () => {
      const { service, repo } = createService();
      repo.findById.mockResolvedValue(contentItem({ reviewStatus: 'draft' }));
      await expect(service.getPublishedById(CONTENT_ID)).rejects.toThrow(NotFoundException);
    });

    it('404s for a published clinical_reference — never on the patient surface', async () => {
      const { service, repo } = createService();
      repo.findById.mockResolvedValue(contentItem({ itemType: 'clinical_reference', reviewStatus: 'published' }));
      await expect(service.getPublishedById(CONTENT_ID)).rejects.toThrow(NotFoundException);
    });

    it('returns a published, patient-facing item', async () => {
      const { service, repo } = createService();
      repo.findById.mockResolvedValue(contentItem());
      const result = await service.getPublishedById(CONTENT_ID);
      expect(result.id).toBe(CONTENT_ID);
    });
  });

  /* ── FR-15.5: sharing ───────────────────────────────────────────────── */

  describe('mintShareLink / resolveSharedContent', () => {
    it('refuses to mint a link for anything but caregiver_guide', async () => {
      const { service, repo } = createService();
      repo.findById.mockResolvedValue(contentItem({ itemType: 'blog_article' }));
      await expect(service.mintShareLink(CONTENT_ID, PATIENT_ID)).rejects.toThrow(BadRequestException);
    });

    it('refuses to mint a link for an unpublished caregiver_guide', async () => {
      const { service, repo } = createService();
      repo.findById.mockResolvedValue(contentItem({ itemType: 'caregiver_guide', reviewStatus: 'draft' }));
      await expect(service.mintShareLink(CONTENT_ID, PATIENT_ID)).rejects.toThrow(NotFoundException);
    });

    it('mints a token that resolves back to the same content item', async () => {
      const { service, repo } = createService();
      repo.findById.mockResolvedValue(contentItem());
      const { token, expiresAt } = await service.mintShareLink(CONTENT_ID, PATIENT_ID);
      expect(token).toMatch(/^v1\./);
      expect(expiresAt.getTime()).toBeGreaterThan(Date.now());

      const resolved = await service.resolveSharedContent(token);
      expect(resolved.id).toBe(CONTENT_ID);
    });

    it('rejects a malformed token', async () => {
      const { service } = createService();
      await expect(service.resolveSharedContent('not-a-real-token')).rejects.toThrow(NotFoundException);
    });

    it('rejects a token whose signature was tampered with', async () => {
      const { service, repo } = createService();
      repo.findById.mockResolvedValue(contentItem());
      const { token } = await service.mintShareLink(CONTENT_ID, PATIENT_ID);
      const [v, payload] = token.split('.');
      await expect(service.resolveSharedContent(`${v}.${payload}.forgedsignature`)).rejects.toThrow(NotFoundException);
    });

    it('rejects a token for content that has since been archived', async () => {
      const { service, repo } = createService();
      repo.findById.mockResolvedValue(contentItem());
      const { token } = await service.mintShareLink(CONTENT_ID, PATIENT_ID);

      repo.findById.mockResolvedValue(contentItem({ reviewStatus: 'archived' }));
      await expect(service.resolveSharedContent(token)).rejects.toThrow(NotFoundException);
    });
  });

  /* ── FR-15.4: doctor recommendations ────────────────────────────────── */

  describe('addRecommendations', () => {
    it('404s when the consultation is not this doctor’s (never 403 — cannot be probed)', async () => {
      const { service, bookings } = createService();
      bookings.getBooking.mockResolvedValue(booking({ doctorId: OTHER_DOCTOR_ID }));
      await expect(
        service.addRecommendations(CONSULTATION_ID, DOCTOR_ID, { contentItemIds: [CONTENT_ID] }),
      ).rejects.toMatchObject({ status: 404 });
    });

    it('404s when the consultation does not exist', async () => {
      const { service, bookings } = createService();
      bookings.getBooking.mockResolvedValue(null);
      await expect(
        service.addRecommendations(CONSULTATION_ID, DOCTOR_ID, { contentItemIds: [CONTENT_ID] }),
      ).rejects.toMatchObject({ status: 404 });
    });

    it('refuses a content item that is not published', async () => {
      const { service, repo } = createService();
      repo.findByIds.mockResolvedValue([contentItem({ reviewStatus: 'draft' })]);
      await expect(
        service.addRecommendations(CONSULTATION_ID, DOCTOR_ID, { contentItemIds: [CONTENT_ID] }),
      ).rejects.toThrow(BadRequestException);
    });

    it('refuses a clinical_reference item — never patient-facing', async () => {
      const { service, repo } = createService();
      repo.findByIds.mockResolvedValue([contentItem({ itemType: 'clinical_reference' })]);
      await expect(
        service.addRecommendations(CONSULTATION_ID, DOCTOR_ID, { contentItemIds: [CONTENT_ID] }),
      ).rejects.toThrow(BadRequestException);
    });

    it('inserts each item and is idempotent on a repeat select (unique index no-op)', async () => {
      const { service, repo, audit } = createService();
      repo.findByIds.mockResolvedValue([contentItem()]);
      repo.addRecommendationIfAbsent.mockResolvedValue(null); // already existed
      repo.listRecommendationsForConsultation.mockResolvedValue([recommendation()]);
      repo.findByIds.mockResolvedValueOnce([contentItem()]).mockResolvedValueOnce([contentItem()]);

      const result = await service.addRecommendations(CONSULTATION_ID, DOCTOR_ID, { contentItemIds: [CONTENT_ID] });

      expect(result).toHaveLength(1);
      // No audit write for an already-existing pair.
      expect(audit.write).not.toHaveBeenCalled();
    });

    it('audits a genuinely new recommendation', async () => {
      const { service, repo, audit } = createService();
      repo.findByIds.mockResolvedValue([contentItem()]);
      repo.addRecommendationIfAbsent.mockResolvedValue(recommendation());
      repo.listRecommendationsForConsultation.mockResolvedValue([recommendation()]);

      await service.addRecommendations(CONSULTATION_ID, DOCTOR_ID, { contentItemIds: [CONTENT_ID] });

      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({ actorType: 'doctor', actorId: DOCTOR_ID, consultationId: CONSULTATION_ID }),
      );
    });
  });

  describe('listRecommendationsForPatient', () => {
    it('404s when the consultation is not this patient’s', async () => {
      const { service, bookings } = createService();
      bookings.getBooking.mockResolvedValue(booking({ patientId: OTHER_PATIENT_ID }));
      await expect(service.listRecommendationsForPatient(CONSULTATION_ID, PATIENT_ID)).rejects.toMatchObject({
        status: 404,
      });
    });

    it('returns the recommended items joined with their content', async () => {
      const { service, bookings, repo } = createService();
      bookings.getBooking.mockResolvedValue(booking({ patientId: PATIENT_ID }));
      repo.listRecommendationsForConsultation.mockResolvedValue([recommendation()]);
      repo.findByIds.mockResolvedValue([contentItem()]);

      const result = await service.listRecommendationsForPatient(CONSULTATION_ID, PATIENT_ID);
      expect(result).toHaveLength(1);
      expect(result[0]!.contentItem.id).toBe(CONTENT_ID);
    });
  });

  describe('getRecommendedForConsultation (the CareHubContract/CareHubPort read)', () => {
    it('applies NO ownership check — trusted caller', async () => {
      const { service, bookings, repo } = createService();
      repo.listRecommendationsForConsultation.mockResolvedValue([recommendation()]);
      repo.findByIds.mockResolvedValue([contentItem()]);

      await service.getRecommendedForConsultation(CONSULTATION_ID);

      expect(bookings.getBooking).not.toHaveBeenCalled();
    });

    it('returns [] rather than throwing when nothing is recommended', async () => {
      const { service, repo } = createService();
      repo.listRecommendationsForConsultation.mockResolvedValue([]);
      await expect(service.getRecommendedForConsultation(CONSULTATION_ID)).resolves.toEqual([]);
    });

    it('projects to {contentId, title, kind} — field-for-field the CareHubPort shape', async () => {
      const { service, repo } = createService();
      repo.listRecommendationsForConsultation.mockResolvedValue([recommendation()]);
      repo.findByIds.mockResolvedValue([contentItem({ title: 'Breathing exercise', itemType: 'self_help_tool' })]);

      const [result] = await service.getRecommendedForConsultation(CONSULTATION_ID);

      expect(result).toEqual({ contentId: CONTENT_ID, title: 'Breathing exercise', kind: 'self_help_tool' });
    });
  });

  /* ── Admin authoring ────────────────────────────────────────────────── */

  describe('create', () => {
    it('rejects an unknown concernId', async () => {
      const { service, catalogue } = createService();
      catalogue.getConcernById.mockResolvedValue(null);
      await expect(
        service.create(
          { itemType: 'education_module', slug: 's', title: 't', body: {}, concernId: CONCERN_ID },
          ADMIN_ID,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects isVerifiedOrg on anything but support_org', async () => {
      const { service } = createService();
      await expect(
        service.create({ itemType: 'blog_article', slug: 's', title: 't', body: {}, isVerifiedOrg: true }, ADMIN_ID),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects specialtyId on anything but clinical_reference', async () => {
      const { service } = createService();
      await expect(
        service.create({ itemType: 'blog_article', slug: 's', title: 't', body: {}, specialtyId: SPECIALTY_ID }, ADMIN_ID),
      ).rejects.toThrow(BadRequestException);
    });

    it('accepts isVerifiedOrg on support_org and lands as draft', async () => {
      const { service, repo, audit } = createService();
      repo.create.mockResolvedValue(contentItem({ itemType: 'support_org', reviewStatus: 'draft', isVerifiedOrg: false }));

      const result = await service.create(
        { itemType: 'support_org', slug: 'ngo-x', title: 'NGO X', body: {}, isVerifiedOrg: false },
        ADMIN_ID,
      );

      expect(result.reviewStatus).toBe('draft');
      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ isVerifiedOrg: false }));
      expect(audit.write).toHaveBeenCalled();
    });

    it('turns a slug collision into a 409, not a 500', async () => {
      const { service, repo } = createService();
      repo.create.mockRejectedValue(Object.assign(new Error('duplicate'), { code: '23505' }));
      await expect(
        service.create({ itemType: 'blog_article', slug: 'taken', title: 't', body: {} }, ADMIN_ID),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('update', () => {
    it('404s for an unknown id', async () => {
      const { service, repo } = createService();
      repo.findById.mockResolvedValue(null);
      await expect(service.update(CONTENT_ID, { title: 'New' }, ADMIN_ID)).rejects.toThrow(NotFoundException);
    });

    it('validates itemType field rules against the EXISTING row, not the patch (itemType is not editable)', async () => {
      const { service, repo } = createService();
      repo.findById.mockResolvedValue(contentItem({ itemType: 'blog_article' }));
      await expect(service.update(CONTENT_ID, { isVerifiedOrg: true }, ADMIN_ID)).rejects.toThrow(BadRequestException);
    });

    it('patches only the provided fields', async () => {
      const { service, repo } = createService();
      repo.findById.mockResolvedValue(contentItem());
      repo.update.mockResolvedValue(contentItem({ title: 'Updated title' }));

      await service.update(CONTENT_ID, { title: 'Updated title' }, ADMIN_ID);

      expect(repo.update).toHaveBeenCalledWith(CONTENT_ID, { title: 'Updated title' });
    });
  });

  /* ── The review state machine ───────────────────────────────────────── */

  describe('the review-status transitions', () => {
    it('submitForReview: draft -> in_clinical_review, no sign-off', async () => {
      const { service, repo } = createService();
      repo.findById.mockResolvedValue(contentItem({ reviewStatus: 'draft' }));
      repo.transitionReviewStatus.mockResolvedValue(contentItem({ reviewStatus: 'in_clinical_review' }));

      await service.submitForReview(CONTENT_ID, ADMIN_ID);

      expect(repo.transitionReviewStatus).toHaveBeenCalledWith(CONTENT_ID, 'in_clinical_review', ['draft'], null);
    });

    it('publish sets reviewedByAdminId/reviewedAt — the clinical reviewer’s sign-off', async () => {
      const { service, repo } = createService();
      repo.findById.mockResolvedValue(contentItem({ reviewStatus: 'in_clinical_review' }));
      repo.transitionReviewStatus.mockResolvedValue(
        contentItem({ reviewStatus: 'published', reviewedByAdminId: ADMIN_ID, reviewedAt: new Date() }),
      );

      const result = await service.publish(CONTENT_ID, ADMIN_ID);

      expect(repo.transitionReviewStatus).toHaveBeenCalledWith(
        CONTENT_ID,
        'published',
        ['in_clinical_review'],
        expect.objectContaining({ reviewedByAdminId: ADMIN_ID }),
      );
      expect(result.reviewedByAdminId).toBe(ADMIN_ID);
    });

    it('reject does NOT sign off — it is a rejection, not an approval', async () => {
      const { service, repo } = createService();
      repo.findById.mockResolvedValue(contentItem({ reviewStatus: 'in_clinical_review' }));
      repo.transitionReviewStatus.mockResolvedValue(contentItem({ reviewStatus: 'draft' }));

      await service.reject(CONTENT_ID, ADMIN_ID);

      expect(repo.transitionReviewStatus).toHaveBeenCalledWith(CONTENT_ID, 'draft', ['in_clinical_review'], null);
    });

    it('an illegal move (e.g. publishing straight from draft) is a 409, not a silent no-op', async () => {
      const { service, repo } = createService();
      repo.findById.mockResolvedValue(contentItem({ reviewStatus: 'draft' }));
      repo.transitionReviewStatus.mockResolvedValue(null); // guarded UPDATE matched nothing

      await expect(service.publish(CONTENT_ID, ADMIN_ID)).rejects.toMatchObject({
        status: 409,
        response: expect.objectContaining({ code: CARE_HUB_ERROR_CODES.ILLEGAL_REVIEW_TRANSITION }),
      });
    });

    it('is idempotent: re-publishing an already-published item is a no-op, not an error', async () => {
      const { service, repo } = createService();
      repo.findById.mockResolvedValue(contentItem({ reviewStatus: 'published' }));

      const result = await service.publish(CONTENT_ID, ADMIN_ID);

      expect(repo.transitionReviewStatus).not.toHaveBeenCalled();
      expect(result.reviewStatus).toBe('published');
    });

    it('withdraw retires a never-published draft or in-review item', async () => {
      const { service, repo } = createService();
      repo.findById.mockResolvedValue(contentItem({ reviewStatus: 'in_clinical_review' }));
      repo.transitionReviewStatus.mockResolvedValue(contentItem({ reviewStatus: 'archived' }));

      await service.withdraw(CONTENT_ID, ADMIN_ID);

      expect(repo.transitionReviewStatus).toHaveBeenCalledWith(CONTENT_ID, 'archived', ['draft', 'in_clinical_review'], null);
    });

    it('retire only accepts FROM published', async () => {
      const { service, repo } = createService();
      repo.findById.mockResolvedValue(contentItem({ reviewStatus: 'published' }));
      repo.transitionReviewStatus.mockResolvedValue(contentItem({ reviewStatus: 'archived' }));

      await service.retire(CONTENT_ID, ADMIN_ID);

      expect(repo.transitionReviewStatus).toHaveBeenCalledWith(CONTENT_ID, 'archived', ['published'], null);
    });

    it('restore revives an archived item back to draft', async () => {
      const { service, repo } = createService();
      repo.findById.mockResolvedValue(contentItem({ reviewStatus: 'archived' }));
      repo.transitionReviewStatus.mockResolvedValue(contentItem({ reviewStatus: 'draft' }));

      await service.restore(CONTENT_ID, ADMIN_ID);

      expect(repo.transitionReviewStatus).toHaveBeenCalledWith(CONTENT_ID, 'draft', ['archived'], null);
    });
  });
});
