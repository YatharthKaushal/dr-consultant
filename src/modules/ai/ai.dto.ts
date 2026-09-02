import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { PROVIDER_CODES, type ProviderCode } from './ai.constants';

/**
 * `agent_profiles.config` — the per-profile model tuning, validated field by
 * field rather than accepted as an opaque object. It ends up in a `jsonb`
 * column with no CHECK behind it, so this DTO is the only thing standing
 * between an admin typo and a request the vendor rejects (or, worse, a
 * `maxTokens` of 10 million that a provider happily bills for).
 */
export class AgentProfileConfigDto {
  /** 0–2 is the range every provider here accepts; Gemini's SDK throws outside it at construction time. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(2)
  temperature?: number;

  /** Generous ceiling — the largest output windows in service are ~128k tokens; beyond that it is certainly a typo. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200_000)
  maxTokens?: number;

  /** Floor of 1s (anything less cannot complete), ceiling of 5min (longer than any HTTP client will wait anyway). */
  @IsOptional()
  @IsInt()
  @Min(1_000)
  @Max(300_000)
  timeoutMs?: number;
}

export class CreateAgentProfileDto {
  @IsString()
  @Length(1, 120)
  name!: string;

  /** Validated against `PROVIDER_CODES` here — the column itself is a bare `varchar` by design (see `agent-profiles.schema.ts`), so this is where the value set is actually enforced. */
  @IsIn(PROVIDER_CODES, {
    message: `provider must be one of: ${PROVIDER_CODES.join(', ')}.`,
  })
  provider!: ProviderCode;

  @IsString()
  @Length(1, 120)
  model!: string;

  /**
   * `require_tld: false` so a private/on-prem gateway (`http://llm-gw:8000/v1`)
   * is accepted, and `protocols` pinned so nothing but HTTP(S) can ever be
   * dialled — this value becomes an outbound request from our server, so an
   * unrestricted string here would be an SSRF primitive handed to whoever
   * holds `ai.manage`.
   */
  @IsOptional()
  @IsUrl({ require_tld: false, protocols: ['http', 'https'], require_protocol: true })
  @Length(1, 2_048)
  baseUrl?: string | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => AgentProfileConfigDto)
  config?: AgentProfileConfigDto;

  /** `smallint` column — bounded to its Postgres range. Lower runs first. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(32_767)
  priority?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/**
 * Every field optional. `provider`/`model` ARE editable (unlike
 * `concerns.code`): a client switching from one model to a newer one on the
 * same account is the single most likely edit this table will ever see, and
 * forcing a delete-and-recreate would destroy the profile's credentials with
 * it.
 *
 * `baseUrl` is optional AND nullable — `undefined` (omitted) leaves the
 * column untouched, explicit `null` clears it back to "the SDK's own default
 * endpoint", the same `@IsOptional()`-covers-both pattern
 * `UpdateSchedulingSettingsDto` uses.
 */
export class UpdateAgentProfileDto {
  @IsOptional()
  @IsString()
  @Length(1, 120)
  name?: string;

  @IsOptional()
  @IsIn(PROVIDER_CODES, {
    message: `provider must be one of: ${PROVIDER_CODES.join(', ')}.`,
  })
  provider?: ProviderCode;

  @IsOptional()
  @IsString()
  @Length(1, 120)
  model?: string;

  @IsOptional()
  @IsUrl({ require_tld: false, protocols: ['http', 'https'], require_protocol: true })
  @Length(1, 2_048)
  baseUrl?: string | null;

  @IsOptional()
  @ValidateNested()
  @Type(() => AgentProfileConfigDto)
  config?: AgentProfileConfigDto;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(32_767)
  priority?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CreateAgentCredentialDto {
  /** How the admin tells two keys apart — they can never see the keys themselves. Unique per profile. */
  @IsString()
  @Length(1, 120)
  label!: string;

  /**
   * The plaintext provider API key. The ONLY place in this codebase a
   * plaintext key legitimately appears, and it stops here: the service
   * encrypts it immediately, keeps `keyLast4` for display, and neither the
   * response, the audit row, nor any log line carries it onward.
   *
   * Lower bound of 8 rejects an obviously-empty paste. Upper bound of 4096 is
   * far above any real provider key (the longest in service are a few hundred
   * characters) while still bounding the request body.
   */
  @IsString()
  @Length(8, 4_096)
  key!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(32_767)
  priority?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/**
 * `key` is optional here: omitting it leaves the stored key untouched
 * (relabelling or reprioritising a credential must not require re-typing a
 * secret the admin may not still have), and supplying it rotates the key in
 * place, keeping the credential's id and its position in the rotation order.
 */
export class UpdateAgentCredentialDto {
  @IsOptional()
  @IsString()
  @Length(1, 120)
  label?: string;

  @IsOptional()
  @IsString()
  @Length(8, 4_096)
  key?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(32_767)
  priority?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
