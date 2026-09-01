import { IsIn, IsOptional, IsPhoneNumber, IsString, IsUUID, Matches } from 'class-validator';
import { ACCOUNT_TYPES, type AccountType } from '../../schema/enums.schema';

export class OtpRequestDto {
  @IsPhoneNumber('IN')
  mobileNumber!: string;

  @IsIn(ACCOUNT_TYPES)
  audience!: AccountType;

  @IsOptional()
  @IsString()
  deviceId?: string;
}

export class OtpResendDto {
  @IsUUID()
  challengeId!: string;
}

export class OtpVerifyDto {
  @IsUUID()
  challengeId!: string;

  /** The code as the user typed it — Slide owns length/format per the OTP widget config, so this only rejects obvious garbage. */
  @Matches(/^\d{4,8}$/, { message: 'code must be 4 to 8 digits' })
  code!: string;
}

export class RefreshTokenDto {
  @IsString()
  refreshToken!: string;
}
