import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { StorageProviderRow } from '../../schema/storage-providers.schema';
import { AuditService } from '../../shared/audit/audit.service';
import { StorageProviderRepository, type StorageProviderUpdate } from './storage-provider.repository';
import { STORAGE_AUDIT_ENTITY_TYPES, STORAGE_ERROR_CODES } from './storage.constants';
import type { StorageProviderConfigDto, UpdateStorageProviderDto } from './storage.dto';

/** Which `config` keys are valid for which provider — see `storage.dto.ts`'s comment on why the DTO alone cannot enforce this (the valid shape depends on the TARGET ROW, and `provider` is immutable). */
const CONFIG_KEYS_BY_PROVIDER: Record<string, readonly (keyof StorageProviderConfigDto)[]> = {
  s3: ['bucket', 'region', 'endpoint'],
  cloudinary: ['cloudName'],
};

/** Every field `StorageProviderConfigDto` declares, across both providers — see `assertConfigMatchesProvider`'s comment on why membership is checked against this fixed list rather than `Object.keys()`. */
const ALL_CONFIG_KEYS: readonly (keyof StorageProviderConfigDto)[] = ['bucket', 'region', 'endpoint', 'cloudName'];

function providerNotFound(): NotFoundException {
  return new NotFoundException({
    code: STORAGE_ERROR_CODES.STORAGE_PROVIDER_NOT_FOUND,
    message: 'Storage provider not found.',
  });
}

/**
 * `storage_providers` admin CRUD — PATCH only. There is no `adminCreate`/
 * `adminDelete`: exactly two rows always exist, seeded once by
 * `storage.seed.ts` and never created or removed through this API (see
 * `storage-providers.schema.ts`'s comment on why `provider` is unique and
 * immutable).
 *
 * Every mutation writes an `audit_log` row with before/after — this table
 * decides which bucket/cloud account file uploads land in and whether a
 * provider is even reachable, so "who changed the bucket" has to be
 * answerable, same weight class as `AgentProfileService`.
 */
@Injectable()
export class StorageProviderService {
  constructor(
    private readonly repo: StorageProviderRepository,
    private readonly audit: AuditService,
  ) {}

  async adminList(): Promise<StorageProviderRow[]> {
    return this.repo.list();
  }

  async adminGetById(id: string): Promise<StorageProviderRow> {
    const row = await this.repo.findById(id);
    if (!row) throw providerNotFound();
    return row;
  }

  /**
   * Skips the update AND the audit write entirely when the DTO carries no
   * defined fields — same discipline as `catalogue/specialty.service.ts#
   * adminUpdate` and `AgentProfileService#adminUpdate`.
   */
  async adminUpdate(actingAdminId: string, id: string, dto: UpdateStorageProviderDto): Promise<StorageProviderRow> {
    const row = await this.repo.findById(id);
    if (!row) throw providerNotFound();

    if (dto.config !== undefined) {
      this.assertConfigMatchesProvider(row.provider, dto.config);
    }

    const fields = this.definedFieldsOnly(dto);
    if (Object.keys(fields).length === 0) {
      return row;
    }

    const before = this.extractBefore(row, fields);
    const updated = await this.repo.update(id, fields);
    if (!updated) throw providerNotFound();

    await this.audit.write({
      actorType: 'admin',
      actorId: actingAdminId,
      action: 'update',
      entityType: STORAGE_AUDIT_ENTITY_TYPES.STORAGE_PROVIDER,
      entityId: id,
      metadata: { before, after: fields },
    });
    return updated;
  }

  /**
   * `config`'s valid shape is a property of the ROW (its `provider`), not of
   * the request — `provider` is immutable, so this is knowable without the
   * caller stating it. Rejects (400) the first key that does not belong,
   * rather than silently dropping it: a dropped key would look like a
   * successful edit to the admin who sent it.
   *
   * Checks each of `StorageProviderConfigDto`'s FOUR known fields by VALUE
   * (`!== undefined`), not `Object.keys(config)` — this project compiles
   * with `target: ES2024`, so TypeScript's ES2022+ "define" class-field
   * semantics mean every declared field on a `class-transformer`-built
   * instance is already an own enumerable property (set to `undefined`)
   * the moment the object is constructed, whether or not the caller's JSON
   * body actually named it. `Object.keys()` on such an instance therefore
   * always lists all four fields regardless of what was sent — confirmed
   * live (`GET`/`PATCH` through the real `ValidationPipe`, not a hand-built
   * plain object as this file's own `.spec.ts` uses) during this module's
   * verification pass, where it misfired rejecting a same-provider PATCH
   * that named no foreign key at all. Reading each field's VALUE instead is
   * correct under both a class instance and a plain object.
   */
  private assertConfigMatchesProvider(provider: string, config: StorageProviderConfigDto): void {
    const allowedKeys = new Set<string>(CONFIG_KEYS_BY_PROVIDER[provider] ?? []);
    const unexpected = ALL_CONFIG_KEYS.find((key) => config[key] !== undefined && !allowedKeys.has(key));

    if (unexpected) {
      throw new BadRequestException({
        code: STORAGE_ERROR_CODES.STORAGE_PROVIDER_CONFIG_INVALID,
        message: `config.${unexpected} is not valid for provider "${provider}". Allowed keys: ${[...allowedKeys].join(', ') || '(none)'}.`,
      });
    }
  }

  private definedFieldsOnly(dto: UpdateStorageProviderDto): StorageProviderUpdate {
    const fields: StorageProviderUpdate = {};
    if (dto.config !== undefined) fields.config = dto.config;
    if (dto.isActive !== undefined) fields.isActive = dto.isActive;
    if (dto.priority !== undefined) fields.priority = dto.priority;
    return fields;
  }

  private extractBefore(row: StorageProviderRow, fields: object): Record<string, unknown> {
    const before: Record<string, unknown> = {};
    for (const key of Object.keys(fields)) {
      before[key] = (row as unknown as Record<string, unknown>)[key];
    }
    return before;
  }
}
