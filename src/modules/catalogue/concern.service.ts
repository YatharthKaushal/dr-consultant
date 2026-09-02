import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../../shared/audit/audit.service';
import type { CreateConcernDto, UpdateConcernDto, UpdateConcernMappingDto } from './concern-admin.dto';
import { CATALOGUE_AUDIT_ENTITY_TYPES, CATALOGUE_ERROR_CODES } from './catalogue.constants';
import type { PublicConcern } from './catalogue.contract';
import { toPublicConcern } from './concern.mapper';
import type { ConcernRow } from '../../schema/concerns.schema';
import { ConcernRepository, type ConcernGeneralFieldsUpdate, type ConcernMappingUpdate } from './concern.repository';
import { specialtyNotFound, SpecialtyService } from './specialty.service';

/** Shared 404 shape for a missing concern id. */
export function concernNotFound(): NotFoundException {
  return new NotFoundException({ code: CATALOGUE_ERROR_CODES.CONCERN_NOT_FOUND, message: 'Concern not found.' });
}

/**
 * `concerns` entity operations: admin CRUD (general fields + the
 * separately-permissioned search-mapping fields) and the public/
 * contract-backing reads. `specialties` itself is this module's own table
 * (not a cross-module read) — `SpecialtyService` is injected directly, same
 * as `doctor-specialty.service.ts` injects `DoctorRepository` for its own
 * intra-module existence checks.
 */
@Injectable()
export class ConcernService {
  constructor(
    private readonly repo: ConcernRepository,
    private readonly specialtyService: SpecialtyService,
    private readonly audit: AuditService,
  ) {}

  /* ---------------------------------------------------------------------- */
  /* Admin CRUD (admin/concerns)                                             */
  /* ---------------------------------------------------------------------- */

  async adminList(specialtyId?: string): Promise<ConcernRow[]> {
    return this.repo.list(specialtyId);
  }

  async adminGetById(id: string): Promise<ConcernRow> {
    const concern = await this.repo.findById(id);
    if (!concern) throw concernNotFound();
    return concern;
  }

  /** Validates the specialty exists (404 if not) before creating, then rejects a duplicate (specialtyId, code) pair (409) — the same shape as `doctor-specialty.service.ts#assign`'s specialty-existence check. */
  async adminCreate(actingAdminId: string, dto: CreateConcernDto): Promise<ConcernRow> {
    const specialty = await this.specialtyService.findRawById(dto.specialtyId);
    if (!specialty) throw specialtyNotFound();

    const existing = await this.repo.findBySpecialtyAndCode(dto.specialtyId, dto.code);
    if (existing) {
      throw new ConflictException({
        code: CATALOGUE_ERROR_CODES.CONCERN_CODE_TAKEN,
        message: 'A concern with this code already exists under this specialty.',
      });
    }

    const concern = await this.repo.create({
      specialtyId: dto.specialtyId,
      code: dto.code,
      name: dto.name,
      matchPhrases: dto.matchPhrases,
      matchWeight: dto.matchWeight,
      isActive: dto.isActive,
    });

    await this.audit.write({
      actorType: 'admin',
      actorId: actingAdminId,
      action: 'create',
      entityType: CATALOGUE_AUDIT_ENTITY_TYPES.CONCERN,
      entityId: concern.id,
      metadata: { after: this.definedGeneralAndCreateFields(dto) },
    });
    return concern;
  }

  /**
   * Edits name/isActive/specialtyId. Deliberately does NOT touch
   * `matchPhrases`/`matchWeight` — see `adminUpdateMapping`. Moving a
   * concern to a different specialty validates the new specialty exists
   * (404) and that the move doesn't collide with an existing (specialtyId,
   * code) pair there (409) — `concerns`' own unique index.
   */
  async adminUpdate(actingAdminId: string, id: string, dto: UpdateConcernDto): Promise<ConcernRow> {
    const concern = await this.repo.findById(id);
    if (!concern) throw concernNotFound();

    const fields: ConcernGeneralFieldsUpdate = {};
    if (dto.name !== undefined) fields.name = dto.name;
    if (dto.isActive !== undefined) fields.isActive = dto.isActive;
    if (dto.specialtyId !== undefined) fields.specialtyId = dto.specialtyId;

    if (Object.keys(fields).length === 0) {
      return concern;
    }

    if (fields.specialtyId && fields.specialtyId !== concern.specialtyId) {
      const specialty = await this.specialtyService.findRawById(fields.specialtyId);
      if (!specialty) throw specialtyNotFound();

      const clash = await this.repo.findBySpecialtyAndCode(fields.specialtyId, concern.code);
      if (clash && clash.id !== id) {
        throw new ConflictException({
          code: CATALOGUE_ERROR_CODES.CONCERN_CODE_TAKEN,
          message: 'A concern with this code already exists under the target specialty.',
        });
      }
    }

    const before = this.extractBefore(concern, fields);
    const updated = await this.repo.updateGeneralFields(id, fields);
    if (!updated) throw concernNotFound();

    await this.audit.write({
      actorType: 'admin',
      actorId: actingAdminId,
      action: 'update',
      entityType: CATALOGUE_AUDIT_ENTITY_TYPES.CONCERN,
      entityId: id,
      metadata: { before, after: fields },
    });
    return updated;
  }

  /**
   * `matchPhrases`/`matchWeight` ONLY — gated by `SEARCH_MANAGE_MAPPING`.
   * See `concern-admin.dto.ts#UpdateConcernMappingDto` for why this is split
   * from the general concern edit.
   */
  async adminUpdateMapping(actingAdminId: string, id: string, dto: UpdateConcernMappingDto): Promise<ConcernRow> {
    const concern = await this.repo.findById(id);
    if (!concern) throw concernNotFound();

    const fields: ConcernMappingUpdate = {};
    if (dto.matchPhrases !== undefined) fields.matchPhrases = dto.matchPhrases;
    if (dto.matchWeight !== undefined) fields.matchWeight = dto.matchWeight;

    if (Object.keys(fields).length === 0) {
      return concern;
    }

    const before = this.extractBefore(concern, fields);
    const updated = await this.repo.updateMapping(id, fields);
    if (!updated) throw concernNotFound();

    await this.audit.write({
      actorType: 'admin',
      actorId: actingAdminId,
      action: 'update',
      entityType: CATALOGUE_AUDIT_ENTITY_TYPES.CONCERN,
      entityId: id,
      metadata: { before, after: fields },
    });
    return updated;
  }

  /* ---------------------------------------------------------------------- */
  /* Public read (GET /concerns)                                             */
  /* ---------------------------------------------------------------------- */

  async listActive(specialtyId?: string): Promise<PublicConcern[]> {
    const rows = await this.repo.listActive(specialtyId);
    return rows.map(toPublicConcern);
  }

  /* ---------------------------------------------------------------------- */
  /* Contract-backing reads (catalogue.facade.ts)                            */
  /* ---------------------------------------------------------------------- */

  async getPublicById(id: string): Promise<PublicConcern | null> {
    const concern = await this.repo.findById(id);
    return concern ? toPublicConcern(concern) : null;
  }

  private definedGeneralAndCreateFields(dto: CreateConcernDto): Record<string, unknown> {
    const fields: Record<string, unknown> = { specialtyId: dto.specialtyId, code: dto.code, name: dto.name };
    if (dto.matchPhrases !== undefined) fields.matchPhrases = dto.matchPhrases;
    if (dto.matchWeight !== undefined) fields.matchWeight = dto.matchWeight;
    if (dto.isActive !== undefined) fields.isActive = dto.isActive;
    return fields;
  }

  private extractBefore(row: ConcernRow, fields: object): Record<string, unknown> {
    const before: Record<string, unknown> = {};
    for (const key of Object.keys(fields)) {
      before[key] = (row as unknown as Record<string, unknown>)[key];
    }
    return before;
  }
}
