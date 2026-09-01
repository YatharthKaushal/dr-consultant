import { IsIn, IsOptional, IsPhoneNumber, IsString, IsUUID, Length, Matches } from 'class-validator';
import { ACCOUNT_TYPES, type AccountType } from '../../schema/enums.schema';

export class OtpRequestDto {
  @IsPhoneNumber('IN')
  mobileNumber!: string;

  @IsIn(ACCOUNT_TYPES)
  audience!: AccountType;

  /** Matches otp_challenges.device_id's varchar(120) — without this cap an oversized value hits the DB constraint directly and surfaces as a raw 500 instead of a clean 400. */
  @IsOptional()
  @IsString()
  @Length(1, 120)
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
