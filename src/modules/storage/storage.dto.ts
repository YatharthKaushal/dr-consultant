import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, IsUrl, Length, Max, Min, ValidateNested } from 'class-validator';

/**
 * `storage_providers.config` — validated field by field rather than accepted
 * as opaque jsonb, same reasoning as `AgentProfileConfigDto`. Carries every
 * field EITHER provider might use; `storage-provider.service.ts#adminUpdate`
 * is what rejects a key that does not belong to the TARGET ROW's provider
 * (e.g. `cloudName` sent for the `s3` row) — this DTO alone cannot do that,
 * because which keys are valid depends on which row is being patched, and
 * `provider` is immutable (no POST/DELETE — see `storage-providers.schema.ts`).
 */
export class StorageProviderConfigDto {
  /** `provider = 's3'` only. */
  @IsOptional()
  @IsString()
  @Length(1, 255)
  bucket?: string;

  /** `provider = 's3'` only. */
  @IsOptional()
  @IsString()
  @Length(1, 60)
  region?: string;

  /**
   * `provider = 's3'` only. Override endpoint for an S3-compatible host.
   * `require_tld: false` so a private/self-hosted gateway is accepted, and
   * `protocols` pinned to http(s) — this value becomes an outbound request
   * host from our server, so an unrestricted string here would be an SSRF
   * primitive handed to whoever holds `storage.manage`. Mirrors
   * `CreateAgentProfileDto.baseUrl`.
   */
  @IsOptional()
  @IsUrl({ require_tld: false, protocols: ['http', 'https'], require_protocol: true })
  @Length(1, 2_048)
  endpoint?: string;

  /** `provider = 'cloudinary'` only. */
  @IsOptional()
  @IsString()
  @Length(1, 255)
  cloudName?: string;
}

/**
 * `provider`/`isActive`/`priority` per the brief: PATCH-only surface,
 * `config` is the sole nested shape. Every field optional — an admin PATCHes
 * whichever subset changed, and `storage-provider.service.ts#adminUpdate`
 * skips the write (and the audit row) entirely when nothing is defined, same
 * discipline as `catalogue/specialty.service.ts#adminUpdate`.
 *
 * `config`, when present, REPLACES the stored object wholesale rather than
 * being deep-merged with what is already there — same semantics as
 * `UpdateAgentProfileDto.config`. An admin who wants to change only `region`
 * on the `s3` row still sends `{bucket, region, endpoint}` in full if all
 * three are meant to survive; this is documented here rather than silently
 * differing from the field-level "omit to leave untouched" semantics
 * `isActive`/`priority` use at the top level.
 */
export class UpdateStorageProviderDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => StorageProviderConfigDto)
  config?: StorageProviderConfigDto;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  /** `smallint` column — bounded to its Postgres range. Lower runs first. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(32_767)
  priority?: number;
}
