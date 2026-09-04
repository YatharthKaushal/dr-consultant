import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Database } from '../../config/db/database.config';
import { DATABASE } from '../../config/db/database.module';
import type { FollowupPathwayRow } from '../../schema/followup-pathways.schema';
import { AuditService } from '../../shared/audit/audit.service';
import { isUniqueConstraintViolation } from '../../shared/errors/postgres-error.util';
import { FOLLOWUP_AUDIT_ENTITY_TYPES, FOLLOWUP_ERROR_CODES } from './followup.constants';
import type { FollowupPathwayView } from './followup.contract';
import { toPathwayView } from './followup.mapper';
import { validateQuestions, validateRedFlagRules } from './followup-scoring.util';
import { FollowupPathwayRepository } from './followup-pathway.repository';

export interface CreatePathwayVersionInput {
  code: string;
  name: string;
  version: number;
  durationDays: number;
  questions: unknown;
  redFlagRules: unknown;
  /** `true` makes this version current in the SAME transaction — the common admin action, and the one that avoids a window where v2 exists but v1 is still what patients are assigned. */
  publish: boolean;
}

/**
 * FR-13.7: "Pathway question sets and red-flag rules are configurable from
 * the admin panel without an app release." A pathway is versioned WHOLE
 * (`followup_pathways.schema.ts`'s own header), never edited in place — an
 * admin authors a complete new version and, optionally, publishes it.
 *
 * *** "EXACTLY ONE CURRENT VERSION PER CODE" IS THE SAME INVARIANT
 * `legal-document.service.ts` HOLDS FOR `legal_documents`, GUARDED THE SAME
 * WAY. *** An advisory lock (`followup-pathway.repository.ts#lockCodeGuard`),
 * taken BEFORE the read that decides who is current, serializes every publish
 * decision for one `code` so two admins publishing at once cannot both leave
 * `is_current = true` on two rows. `consent.current-version.integration.spec
 * .ts` proved this invariant under real concurrency for `legal_documents` with
 * 15 dedicated tests; `followup-pathway.integration.spec.ts` applies the same
 * rigor here.
 */
@Injectable()
export class FollowupPathwayService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly repo: FollowupPathwayRepository,
    private readonly audit: AuditService,
  ) {}

  /* ---------------------------------------------------------------------- */
  /* Admin (admin/followup-pathways)                                         */
  /* ---------------------------------------------------------------------- */

  /** One row per pathway code — its current version, or (if never published) its highest — the admin index. */
  async adminListLatest(): Promise<FollowupPathwayView[]> {
    const rows = await this.repo.listLatestPerCode();
    return rows.map(toPathwayView);
  }

  /** The full version history for one code, newest first. */
  async adminListVersions(code: string): Promise<FollowupPathwayView[]> {
    const rows = await this.repo.listByCode(code);
    return rows.map(toPathwayView);
  }

  async adminGetById(id: string): Promise<FollowupPathwayView> {
    return toPathwayView(await this.getRowOrThrow(id));
  }

  /**
   * Writes a new version, validating the question set and red-flag rules
   * against each other on the way in (`validateQuestions`/
   * `validateRedFlagRules` — see `followup-scoring.util.ts`'s header: "a
   * malformed question set must never reach a patient's check-in screen").
   * The insert, the demotion of the previous current version and the audit
   * entry share one transaction — same reasoning as `legal-document.service
   * .ts#adminCreate`: a published version with no record of who published it
   * is not an acceptable half-success.
   */
  async adminCreateVersion(actingAdminId: string, input: CreatePathwayVersionInput): Promise<FollowupPathwayView> {
    if (!Number.isInteger(input.version) || input.version < 1) {
      throw new BadRequestException({ code: FOLLOWUP_ERROR_CODES.INVALID_QUESTION_SET, message: 'version must be a positive integer.' });
    }
    if (!Number.isInteger(input.durationDays) || input.durationDays < 1 || input.durationDays > 90) {
      throw new BadRequestException({
        code: FOLLOWUP_ERROR_CODES.INVALID_QUESTION_SET,
        message: 'durationDays must be an integer between 1 and 90.',
      });
    }

    const questions = validateQuestions(input.questions);
    const redFlagRules = validateRedFlagRules(input.redFlagRules, questions);

    const duplicate = await this.repo.findByCodeAndVersion(input.code, input.version);
    if (duplicate) throw this.versionTaken();

    try {
      const row = await this.db.transaction(async (tx) => {
        if (input.publish) await this.repo.lockCodeGuard(input.code, tx);

        const created = await this.repo.create(
          {
            code: input.code,
            name: input.name,
            version: input.version,
            durationDays: input.durationDays,
            questions,
            redFlagRules,
            isCurrent: false,
          },
          tx,
        );

        const demoted = input.publish ? await this.repo.clearCurrent(input.code, created.id, tx) : [];
        const published = input.publish ? await this.repo.setCurrent(created.id, tx) : null;
        const result = published ?? created;

        await this.audit.write(
          {
            actorType: 'admin',
            actorId: actingAdminId,
            action: 'create',
            entityType: FOLLOWUP_AUDIT_ENTITY_TYPES.FOLLOWUP_PATHWAY,
            entityId: result.id,
            metadata: {
              code: result.code,
              version: result.version,
              published: result.isCurrent,
              supersededVersions: demoted.map((previous) => previous.version),
            },
          },
          tx,
        );

        return result;
      });

      return toPathwayView(row);
    } catch (error) {
      // Safety net for the check-then-insert race on `(code, version)` — two
      // admins can both pass `findByCodeAndVersion` before either inserts.
      if (isUniqueConstraintViolation(error)) throw this.versionTaken();
      throw error;
    }
  }

  /**
   * Makes one existing version current for its code, demoting whoever held
   * that place. Idempotent: publishing the already-current version demotes
   * nothing and still records who asked.
   */
  async adminPublish(actingAdminId: string, id: string): Promise<FollowupPathwayView> {
    const target = await this.getRowOrThrow(id);

    const row = await this.db.transaction(async (tx) => {
      await this.repo.lockCodeGuard(target.code, tx);

      const fresh = await this.repo.findById(id, tx);
      if (!fresh) throw this.pathwayNotFound();

      const demoted = await this.repo.clearCurrent(fresh.code, fresh.id, tx);
      const published = await this.repo.setCurrent(fresh.id, tx);
      if (!published) throw this.pathwayNotFound();

      await this.audit.write(
        {
          actorType: 'admin',
          actorId: actingAdminId,
          action: 'update',
          entityType: FOLLOWUP_AUDIT_ENTITY_TYPES.FOLLOWUP_PATHWAY,
          entityId: published.id,
          metadata: {
            code: published.code,
            version: published.version,
            published: true,
            alreadyCurrent: fresh.isCurrent,
            supersededVersions: demoted.map((previous) => previous.version),
          },
        },
        tx,
      );

      return published;
    });

    return toPathwayView(row);
  }

  /* ---------------------------------------------------------------------- */
  /* Internal — used by `followup.service.ts#assignPathway`                 */
  /* ---------------------------------------------------------------------- */

  /** The row a new assignment pins to. Throws when the code has never been published — an admin must publish at least one version before this pathway can be assigned. */
  async getCurrentByCodeOrThrow(code: string): Promise<FollowupPathwayRow> {
    const row = await this.repo.findCurrentByCode(code);
    if (!row) {
      throw new NotFoundException({
        code: FOLLOWUP_ERROR_CODES.NO_CURRENT_PATHWAY,
        message: `No current version is published for pathway "${code}".`,
      });
    }
    return row;
  }

  async getByIdOrThrow(id: string): Promise<FollowupPathwayRow> {
    return this.getRowOrThrow(id);
  }

  /* ---------------------------------------------------------------------- */

  private async getRowOrThrow(id: string): Promise<FollowupPathwayRow> {
    const row = await this.repo.findById(id);
    if (!row) throw this.pathwayNotFound();
    return row;
  }

  private pathwayNotFound(): NotFoundException {
    return new NotFoundException({ code: FOLLOWUP_ERROR_CODES.PATHWAY_NOT_FOUND, message: 'Follow-up pathway not found.' });
  }

  private versionTaken(): ConflictException {
    return new ConflictException({
      code: FOLLOWUP_ERROR_CODES.PATHWAY_VERSION_TAKEN,
      message: 'This version already exists for this pathway code.',
    });
  }
}
