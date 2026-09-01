import { Body, Controller, Get, HttpCode, HttpStatus, Ip, Post } from '@nestjs/common';
import { CurrentUser, Public } from '../../shared/auth/auth.decorator';
import type { AuthContext } from '../../shared/auth/auth.types';
import { OtpRequestDto, OtpResendDto, OtpVerifyDto, RefreshTokenDto } from './identity.dto';
import { IdentityService } from './identity.service';

/** No logic here — parse, pull request metadata (IP), delegate. */
@Controller('auth')
export class IdentityController {
  constructor(private readonly identity: IdentityService) {}

  @Public()
  @Post('otp/request')
  requestOtp(@Body() dto: OtpRequestDto, @Ip() ip: string) {
    return this.identity.requestOtp(dto, ip);
  }

  @Public()
  @Post('otp/resend')
  resendOtp(@Body() dto: OtpResendDto) {
    return this.identity.resendOtp(dto);
  }

  @Public()
  @Post('otp/verify')
  verifyOtp(@Body() dto: OtpVerifyDto, @Ip() ip: string) {
    return this.identity.verifyOtp(dto, ip);
  }

  @Public()
  @Post('token/refresh')
  refreshToken(@Body() dto: RefreshTokenDto) {
    return this.identity.refreshToken(dto);
  }

  @Get('me')
  getMe(@CurrentUser() auth: AuthContext) {
    return this.identity.getMe(auth);
  }

  /** No single-device logout by construction (no session table) — bumps `tokenVersion`, revoking every token for the account at once. */
  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logoutAll(@CurrentUser() auth: AuthContext): Promise<void> {
    await this.identity.logoutAll(auth.accountType, auth.accountId);
  }
}
