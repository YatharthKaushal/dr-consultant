import { Type } from 'class-transformer';
import { IsIn, IsObject, IsOptional, IsString, Matches, ValidateNested } from 'class-validator';
import { PUSH_APP_KEYS } from '../notification/notification-push.types';
import { RELEASE_PLATFORMS } from './release.constants';

const VERSION_PATTERN = /^\d+(\.\d+)*$/;

/** `GET /api/app/release-status?app=patient&platform=android&version=1.2.3` — public, no session. */
export class ReleaseStatusQueryDto {
  @IsIn([...PUSH_APP_KEYS])
  app!: (typeof PUSH_APP_KEYS)[number];

  @IsIn([...RELEASE_PLATFORMS])
  platform!: (typeof RELEASE_PLATFORMS)[number];

  @IsString()
  @Matches(VERSION_PATTERN, { message: 'version must be numeric segments like "1.2.3".' })
  version!: string;
}

class ReleasePolicyEntryDto {
  @IsString()
  @Matches(VERSION_PATTERN, { message: 'minimumSupportedVersion must be numeric segments like "1.2.3".' })
  minimumSupportedVersion!: string;

  @IsString()
  @Matches(VERSION_PATTERN, { message: 'latestVersion must be numeric segments like "1.2.3".' })
  latestVersion!: string;

  @IsOptional()
  @IsString()
  storeUrl?: string | null;

  @IsOptional()
  @IsString()
  message?: string | null;
}

class ReleaseAppPlatformsDto {
  @ValidateNested()
  @Type(() => ReleasePolicyEntryDto)
  ios!: ReleasePolicyEntryDto;

  @ValidateNested()
  @Type(() => ReleasePolicyEntryDto)
  android!: ReleasePolicyEntryDto;
}

/** `PUT /api/admin/release-policy` — a full-document replace, same reasoning as `release-config.service.ts#update`'s own doc comment. */
export class UpdateReleasePolicyDto {
  @IsObject()
  @ValidateNested()
  @Type(() => ReleaseAppPlatformsDto)
  patient!: ReleaseAppPlatformsDto;

  @IsObject()
  @ValidateNested()
  @Type(() => ReleaseAppPlatformsDto)
  doctor!: ReleaseAppPlatformsDto;
}
