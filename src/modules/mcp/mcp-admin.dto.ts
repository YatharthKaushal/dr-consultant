import { ArrayMaxSize, IsArray, IsBoolean, IsOptional, IsString, Length } from 'class-validator';

/** Ceiling on `scopes` — there are five tools; 50 is generous headroom that still bounds the payload. */
const MAX_SCOPES = 50;

export class CreateMcpClientDto {
  @IsString()
  @Length(1, 120)
  name!: string;

  /**
   * Tool names this client may call. Optional and defaulting to EMPTY:
   * a client created without scopes can authenticate but call nothing, so
   * omitting them fails closed rather than granting everything.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_SCOPES)
  @IsString({ each: true })
  @Length(1, 120, { each: true })
  scopes?: string[];
}

export class UpdateMcpClientDto {
  @IsOptional()
  @IsString()
  @Length(1, 120)
  name?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_SCOPES)
  @IsString({ each: true })
  @Length(1, 120, { each: true })
  scopes?: string[];

  /** Deactivating is the revocation mechanism: the key stops working immediately, the row and its audit history stay. */
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
