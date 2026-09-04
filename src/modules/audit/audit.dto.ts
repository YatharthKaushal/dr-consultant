import { Type } from 'class-transformer';
import { IsIn, IsISO8601, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import { ACTOR_TYPES, AUDIT_ACTIONS } from '../../schema/enums.schema';
import { AUDIT_MAX_OFFSET, AUDIT_MAX_PAGE_SIZE, AUDIT_RETENTION_DAYS_BOUNDS } from './audit.constants';

/**
 * Shared filter fields for both `GET /admin/audit/log` (`AuditSearchQueryDto`)
 * and `GET /admin/audit/export` (`ExportAuditLogDto`) — "search by actor,
 * module and date, with export" (`docs/MODULES.md` M-21) is one filter set
 * used two ways, mirroring `search-admin.dto.ts#ListSearchQueriesDto`'s shape
 * for the same kind of log.
 */
class AuditLogFilterDto {
  @IsOptional()
  @IsIn([...ACTOR_TYPES])
  actorType?: (typeof ACTOR_TYPES)[number];

  /** Not `@IsUUID()` — `system` actors carry a null `actorId`, and every other actor type's account id IS a uuid, but nothing here needs to reject a caller-supplied non-uuid string beyond it simply matching nothing. */
  @IsOptional()
  @IsString()
  @Length(1, 100)
  actorId?: string;

  /** The "module" filter (`docs/MODULES.md`'s wording) — `audit_log.entity_type` is a free-form `varchar(80)` written by every module's own constants file, so this is a plain string match, not a closed enum. */
  @IsOptional()
  @IsString()
  @Length(1, 80)
  entityType?: string;

  @IsOptional()
  @IsIn([...AUDIT_ACTIONS])
  action?: (typeof AUDIT_ACTIONS)[number];

  @IsOptional()
  @IsISO8601({}, { message: 'from must be an ISO 8601 timestamp.' })
  from?: string;

  @IsOptional()
  @IsISO8601({}, { message: 'to must be an ISO 8601 timestamp.' })
  to?: string;
}

export class AuditSearchQueryDto extends AuditLogFilterDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(AUDIT_MAX_PAGE_SIZE)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(AUDIT_MAX_OFFSET)
  offset?: number;
}

/** No `limit`/`offset` — an export is capped at `AUDIT_EXPORT_MAX_ROWS` from the start, not paged (see `audit-export.service.ts`). */
export class ExportAuditLogDto extends AuditLogFilterDto {}

/** `PUT /admin/audit/config` — the one `audit.*` key this module owns today. */
export class UpdateAuditConfigDto {
  /** `0` disables purging. A non-zero value must be within `AUDIT_RETENTION_DAYS_BOUNDS`; `audit-config.service.ts` re-checks this bound — services hold the rules, not just the HTTP layer. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(AUDIT_RETENTION_DAYS_BOUNDS.max)
  retentionDays?: number;
}
