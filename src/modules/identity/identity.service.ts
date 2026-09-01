import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { DATABASE } from '../../config/db/database.module';
import type { Database, DatabaseTransaction } from '../../config/db/database.config';
import type { AccountType } from '../../schema/enums.schema';
import type { OtpChallengeRow } from '../../schema/otp-challenges.schema';
import { AppConfigService } from '../../shared/app-config/app-config.service';
import { AuditService } from '../../shared/audit/audit.service';
import type { AuthContext } from '../../shared/auth/auth.types';
import { IdentityAccessService } from './identity-access.service';
import type { OtpRequestDto, OtpResendDto, OtpVerifyDto, RefreshTokenDto } from './identity.dto';
import { IdentityOtpService } from './identity-otp.service';
import { normalizeMobileNumber } from './identity-phone.util';
import { IdentityRepository } from './identity.repository';
import { IdentityTokenService, type TokenPair } from './identity-token.service';
import { IDENTITY_APP_CONFIG_DEFAULTS, IDENTITY_APP_CONFIG_KEYS, IDENTITY_AUDIT_ENTITY_TYPES, IDENTITY_ERROR_CODES } from './identity.constants';

export interface OtpChallengeResponse {
  challengeId: string;
  expiresAt: string;
  resendAvailableAt: string;
  resendsRemaining: number;
}

export interface VerifyOtpResponse extends TokenPair {
  account: {
    id: string;
    accountType: AccountType;
    isNewAccount: boolean;
  };
}

export interface MeResponse {
  id: string;
  accountType: AccountType;
  fullName: string | null;
  mobileNumber: string;
  roles?: string[];
  permissions?: string[];
}

/**
 * Sign-in orchestration for all three account types: request -> resend ->
 * verify -> account resolution -> token mint; token refresh; logout-all.
 * RBAC/ABAC and admin account management live in `identity-access.service.ts`
 * — this file stays scoped to the OTP flow itself.
 */
@Injectable()
export class IdentityService {
  private readonly logger = new Logger(IdentityService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly repo: IdentityRepository,
    private readonly otp: IdentityOtpService,
    private readonly tokenService: IdentityTokenService,
    private readonly accessService: IdentityAccessService,
    private readonly appConfig: AppConfigService,
    private readonly audit: AuditService,
  ) {}

  /* ---------------------------------------------------------------------- */
  /* OTP request / resend                                                    */
  /* ---------------------------------------------------------------------- */

  async requestOtp(dto: OtpRequestDto, ipAddress?: string): Promise<OtpChallengeResponse> {
    const mobileNumber = normalizeMobileNumber(dto.mobileNumber);

    // Rate limit FIRST, before the existence check below and before Slide
    // is ever called. This is what stops the doctor/admin existence check
    // from being an unthrottled account-enumeration oracle: that check is
    // refused locally (no otp_challenges row, no Slide call), so counting
    // only otp_challenges rows would never see it — otp_request_attempts
    // records every call to this endpoint regardless of what happens next.
    await this.assertNotRateLimited(mobileNumber, ipAddress);
    await this.repo.recordRequestAttempt(mobileNumber, dto.audience, ipAddress);

    // Doctor/admin: must already exist and be signable — refused with a
    // plain message before Slide is ever called (MODULES M-02: "a sign-in
    // with the wrong role for that app is refused with a plain message").
    // Patients always proceed (FR-1.1 self sign-up); the open population
    // leaks nothing this check would protect.
    if (dto.audience !== 'patient') {
      const state =
        dto.audience === 'doctor'
          ? await this.repo.findDoctorAuthStateByMobile(mobileNumber)
          : await this.repo.findAdminAuthStateByMobile(mobileNumber);
      if (!state || !state.isActive) {
        throw new ForbiddenException({
          code: IDENTITY_ERROR_CODES.ACCOUNT_NOT_FOUND_FOR_ROLE,
          message: `No ${dto.audience} account found for this number.`,
        });
      }
    }

    const { requestId } = await this.otp.send(mobileNumber);
    const ttlSeconds = await this.getConfigNumber(IDENTITY_APP_CONFIG_KEYS.OTP_CHALLENGE_TTL_SECONDS);
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    const challenge = await this.repo.insertChallenge({
      mobileNumber,
      audience: dto.audience,
      providerRequestId: requestId,
      expiresAt,
      ipAddress,
      deviceId: dto.deviceId,
    });

    return this.toChallengeResponse(challenge);
  }

  async resendOtp(dto: OtpResendDto): Promise<OtpChallengeResponse> {
    const challenge = await this.getLiveChallengeOrThrow(dto.challengeId);

    const [maxResends, cooldownSeconds, ttlSeconds] = await Promise.all([
      this.getConfigNumber(IDENTITY_APP_CONFIG_KEYS.OTP_RESEND_MAX_PER_CHALLENGE),
      this.getConfigNumber(IDENTITY_APP_CONFIG_KEYS.OTP_RESEND_COOLDOWN_SECONDS),
      this.getConfigNumber(IDENTITY_APP_CONFIG_KEYS.OTP_CHALLENGE_TTL_SECONDS),
    ]);

    if (challenge.resendCount >= maxResends) {
      throw new HttpException(
        { code: IDENTITY_ERROR_CODES.RESEND_LIMIT_REACHED, message: 'You have reached the maximum number of resends for this request.' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const cooldownEndsAt = challenge.lastSentAt.getTime() + cooldownSeconds * 1000;
    if (cooldownEndsAt > Date.now()) {
      throw new HttpException(
        { code: IDENTITY_ERROR_CODES.RESEND_COOLDOWN, message: 'Please wait before requesting another code.' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // otp.retry reuses the same requestId — this updates the existing row,
    // it never inserts a new one.
    await this.otp.retry(challenge.providerRequestId);
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    await this.repo.recordResend(challenge.id, expiresAt);

    const updated = await this.repo.findChallengeById(challenge.id);
    if (!updated) {
      throw new Error('Challenge vanished immediately after its own resend — should be unreachable.');
    }
    return this.toChallengeResponse(updated);
  }

  /* ---------------------------------------------------------------------- */
  /* OTP verify                                                               */
  /* ---------------------------------------------------------------------- */

  async verifyOtp(dto: OtpVerifyDto, ipAddress?: string): Promise<VerifyOtpResponse> {
    const challenge = await this.getLiveChallengeOrThrow(dto.challengeId);

    const maxAttempts = await this.getConfigNumber(IDENTITY_APP_CONFIG_KEYS.OTP_VERIFY_MAX_ATTEMPTS_PER_CHALLENGE);
    if (challenge.attemptCount >= maxAttempts) {
      // Locally refused, without calling Slide — a locked-out challenge costs no vendor quota.
      throw new HttpException(
        { code: IDENTITY_ERROR_CODES.TOO_MANY_ATTEMPTS, message: 'Too many incorrect attempts. Please request a new code.' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    let verifyResult;
    try {
      verifyResult = await this.otp.verify(challenge.providerRequestId, dto.code);
    } catch (error) {
      await this.repo.bumpAttemptCount(challenge.id);
      throw error;
    }

    // Single-use — called exactly once, never retried.
    const tokenResult = await this.otp.verifyToken(verifyResult.accessToken);

    // Belt-and-suspenders: confirm the identifier Slide just verified is
    // actually the number this challenge was for. Without this check a
    // swapped-token scenario would authenticate the wrong number.
    const verifiedIdentifier = normalizeMobileNumber(tokenResult.identifier);
    if (verifiedIdentifier !== challenge.mobileNumber) {
      this.logger.error(
        `Slide verifyToken identifier mismatch: challenge mobile=${challenge.mobileNumber}, token identifier=${verifiedIdentifier}. This should never happen.`,
      );
      throw new HttpException(
        { code: IDENTITY_ERROR_CODES.INVALID_OTP, message: 'Verification failed. Please try again.' },
        HttpStatus.BAD_REQUEST,
      );
    }

    const verifiedAt = new Date();
    const account = await this.db.transaction(async (tx) => {
      await this.repo.markVerified(challenge.id, verifiedAt, tx);
      return this.resolveAccount(challenge.audience, challenge.mobileNumber, tx);
    });

    const tokens = await this.tokenService.mintTokenPair(challenge.audience, account.id, account.tokenVersion);

    // Best-effort — a login succeeding matters more than its log line.
    await this.audit.write({
      actorType: challenge.audience,
      actorId: account.id,
      action: 'login',
      entityType: IDENTITY_AUDIT_ENTITY_TYPES.SESSION,
      entityId: account.id,
      metadata: { audience: challenge.audience, challengeId: challenge.id, deviceId: challenge.deviceId ?? undefined },
      ipAddress,
    });

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
      account: { id: account.id, accountType: challenge.audience, isNewAccount: account.isNewAccount },
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Session                                                                  */
  /* ---------------------------------------------------------------------- */

  async refreshToken(dto: RefreshTokenDto): Promise<TokenPair> {
    const payload = await this.tokenService.verifyRefreshToken(dto.refreshToken);
    if (!payload) {
      throw new UnauthorizedException({ code: IDENTITY_ERROR_CODES.INVALID_REFRESH_TOKEN, message: 'Invalid or expired refresh token.' });
    }

    const state = await this.getAuthStateFor(payload.act, payload.sub);
    if (!state || !state.isActive || state.tokenVersion !== payload.tv) {
      throw new UnauthorizedException({ code: IDENTITY_ERROR_CODES.INVALID_REFRESH_TOKEN, message: 'Invalid or expired refresh token.' });
    }

    return this.tokenService.mintTokenPair(payload.act, payload.sub, state.tokenVersion);
  }

  /** No single-device logout by construction (no session table) — this bumps `tokenVersion`, revoking every token for the account at once. */
  async logoutAll(accountType: AccountType, accountId: string): Promise<void> {
    const newTokenVersion = await this.repo.bumpTokenVersion(accountType, accountId);
    await this.audit.write({
      actorType: accountType,
      actorId: accountId,
      action: 'update',
      entityType: IDENTITY_AUDIT_ENTITY_TYPES.SESSION,
      entityId: accountId,
      metadata: { reason: 'logout_all', newTokenVersion },
    });
  }

  async getMe(auth: AuthContext): Promise<MeResponse> {
    const summary = await this.repo.getAccountSummary(auth.accountType, auth.accountId);
    if (!summary) {
      throw new NotFoundException({ message: 'Account not found.' });
    }

    const base: MeResponse = {
      id: summary.id,
      accountType: auth.accountType,
      fullName: summary.fullName,
      mobileNumber: summary.mobileNumber,
    };

    if (auth.accountType !== 'admin') {
      return base;
    }

    const [roles, permissions] = await Promise.all([
      this.accessService.listAdminRoleCodes(auth.accountId),
      this.accessService.listEffectivePermissions(auth.accountId),
    ]);
    return { ...base, roles, permissions };
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                                */
  /* ---------------------------------------------------------------------- */

  private async resolveAccount(
    audience: AccountType,
    mobileNumber: string,
    tx: DatabaseTransaction,
  ): Promise<{ id: string; tokenVersion: number; isNewAccount: boolean }> {
    if (audience === 'patient') {
      const result = await this.repo.findOrCreatePatientByMobile(mobileNumber, tx);
      return { id: result.id, tokenVersion: result.tokenVersion, isNewAccount: result.isNewAccount };
    }

    if (audience === 'doctor') {
      const state = await this.repo.findDoctorAuthStateByMobile(mobileNumber, tx);
      if (!state || !state.isActive) {
        throw new ForbiddenException({ code: IDENTITY_ERROR_CODES.ACCOUNT_NOT_FOUND_FOR_ROLE, message: 'No doctor account found for this number.' });
      }
      await this.repo.setDoctorMobileVerifiedIfUnset(state.id, tx);
      return { id: state.id, tokenVersion: state.tokenVersion, isNewAccount: false };
    }

    const state = await this.repo.findAdminAuthStateByMobile(mobileNumber, tx);
    if (!state || !state.isActive) {
      throw new ForbiddenException({ code: IDENTITY_ERROR_CODES.ACCOUNT_NOT_FOUND_FOR_ROLE, message: 'No admin account found for this number.' });
    }
    await this.repo.setAdminMobileVerifiedIfUnset(state.id, tx);
    return { id: state.id, tokenVersion: state.tokenVersion, isNewAccount: false };
  }

  private async getAuthStateFor(accountType: AccountType, id: string) {
    if (accountType === 'patient') return this.repo.findPatientAuthStateById(id);
    if (accountType === 'doctor') return this.repo.findDoctorAuthStateById(id);
    return this.repo.findAdminAuthStateById(id);
  }

  private async getLiveChallengeOrThrow(challengeId: string): Promise<OtpChallengeRow> {
    const challenge = await this.repo.findChallengeById(challengeId);
    if (!challenge) {
      throw new NotFoundException({ code: IDENTITY_ERROR_CODES.CHALLENGE_NOT_FOUND, message: 'OTP request not found.' });
    }
    if (challenge.verifiedAt) {
      // Our own replay stop, independent of Slide's own single-use verifyToken.
      throw new HttpException(
        { code: IDENTITY_ERROR_CODES.CHALLENGE_ALREADY_USED, message: 'This OTP request has already been used.' },
        HttpStatus.GONE,
      );
    }
    if (challenge.expiresAt.getTime() < Date.now()) {
      // Fails fast on our own bookkeeping estimate, same reasoning as the
      // attemptCount lockout below — an obviously-expired challenge is
      // refused without spending a Slide call on `otp.verify`/`otp.retry`,
      // both of which would reject it anyway once it actually reaches
      // Slide (expires_at is deliberately just our estimate, kept roughly
      // in step with the widget's real expiry — see otp-challenges.schema.ts).
      throw new HttpException(
        { code: IDENTITY_ERROR_CODES.CHALLENGE_EXPIRED, message: 'This OTP request has expired. Please request a new code.' },
        HttpStatus.GONE,
      );
    }
    return challenge;
  }

  /**
   * Counts EVERY `/otp/request` call in the window (`otp_request_attempts`),
   * not just ones that reached Slide — see that table's schema comment for
   * why this must include locally-refused doctor/admin lookups too.
   */
  private async assertNotRateLimited(mobileNumber: string, ipAddress?: string): Promise<void> {
    const since = new Date(Date.now() - 60 * 60 * 1000);

    const maxPerNumber = await this.getConfigNumber(IDENTITY_APP_CONFIG_KEYS.OTP_REQUEST_MAX_PER_NUMBER_PER_HOUR);
    const numberCount = await this.repo.countRecentAttemptsByMobile(mobileNumber, since);
    if (numberCount >= maxPerNumber) {
      throw new HttpException(
        { code: IDENTITY_ERROR_CODES.REQUEST_RATE_LIMITED, message: 'Too many OTP requests for this number. Please try again later.' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    if (ipAddress) {
      const maxPerIp = await this.getConfigNumber(IDENTITY_APP_CONFIG_KEYS.OTP_REQUEST_MAX_PER_IP_PER_HOUR);
      const ipCount = await this.repo.countRecentAttemptsByIp(ipAddress, since);
      if (ipCount >= maxPerIp) {
        throw new HttpException(
          { code: IDENTITY_ERROR_CODES.REQUEST_RATE_LIMITED, message: 'Too many OTP requests from this network. Please try again later.' },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }
  }

  private async getConfigNumber(key: string): Promise<number> {
    return this.appConfig.getNumber(key, IDENTITY_APP_CONFIG_DEFAULTS[key] ?? 0);
  }

  private async toChallengeResponse(challenge: OtpChallengeRow): Promise<OtpChallengeResponse> {
    const [maxResends, cooldownSeconds] = await Promise.all([
      this.getConfigNumber(IDENTITY_APP_CONFIG_KEYS.OTP_RESEND_MAX_PER_CHALLENGE),
      this.getConfigNumber(IDENTITY_APP_CONFIG_KEYS.OTP_RESEND_COOLDOWN_SECONDS),
    ]);

    return {
      challengeId: challenge.id,
      expiresAt: challenge.expiresAt.toISOString(),
      resendAvailableAt: new Date(challenge.lastSentAt.getTime() + cooldownSeconds * 1000).toISOString(),
      resendsRemaining: Math.max(0, maxResends - challenge.resendCount),
    };
  }
}
