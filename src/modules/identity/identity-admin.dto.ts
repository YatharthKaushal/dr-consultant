import { IsIn, IsOptional, IsPhoneNumber, IsString, IsUUID, Length } from 'class-validator';
import { ACCOUNT_STATUSES, type AccountStatus } from '../../schema/enums.schema';

export class CreateAdminDto {
  @IsPhoneNumber('IN')
  mobileNumber!: string;

  @IsString()
  @Length(1, 160)
  fullName!: string;
}

export class UpdateAdminDto {
  @IsOptional()
  @IsString()
  @Length(1, 160)
  fullName?: string;

  /** Setting `suspended`/`deleted` bumps `tokenVersion` in the same transaction — see identity-access.service.ts. */
  @IsOptional()
  @IsIn(ACCOUNT_STATUSES)
  status?: AccountStatus;
}

export class AssignRoleDto {
  @IsUUID()
  roleId!: string;
}

export class GrantPermissionDto {
  @IsUUID()
  permissionId!: string;

  @IsOptional()
  @IsString()
  @Length(1, 500)
  reason?: string;
}
