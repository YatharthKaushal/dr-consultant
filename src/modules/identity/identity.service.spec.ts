import { ForbiddenException, HttpException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { Database } from '../../config/db/database.config';
import type { AppConfigService } from '../../shared/app-config/app-config.service';
import type { AuditService } from '../../shared/audit/audit.service';
import { IdentityAccessService } from './identity-access.service';
import { IdentityOtpService } from './identity-otp.service';
import { IdentityRepository } from './identity.repository';
import { IdentityService } from './identity.service';
import { IdentityTokenService } from './identity-token.service';

function createDb(): Database {
  return {
    transaction: jest.fn(async (fn: (tx: Database) => Promise<unknown>) => fn({} as Database)),
  } as unknown as Database;
}

const NOW = new Date('2026-01-01T00:00:00.000Z');

function baseChallenge(overrides: Record<string, unknown> = {}) {
  return {
    id: 'challenge-1',
    mobileNumber: '+919876543210',
    audience: 'patient',
    providerRequestId: 'otpreq_1',
    attemptCount: 0,
    resendCount: 0,
    lastSentAt: NOW,
    expiresAt: new Date(NOW.getTime() + 5 * 60 * 1000),
    verifiedAt: null,
    ipAddress: null,
    deviceId: null,
    createdAt: NOW,
    ...overrides,
  };
}

function createDeps() {
  const db = createDb();
  const repo = {
    findChallengeById: jest.fn(),
    insertChallenge: jest.fn(),
    bumpAttemptCount: jest.fn(),
    recordResend: jest.fn(),
    markVerified: jest.fn(),
    recordRequestAttempt: jest.fn().mockResolvedValue(undefined),
    countRecentAttemptsByMobile: jest.fn().mockResolvedValue(0),
    countRecentAttemptsByIp: jest.fn().mockResolvedValue(0),
    findDoctorAuthStateByMobile: jest.fn(),
    findAdminAuthStateByMobile: jest.fn(),
    findPatientAuthStateById: jest.fn(),
    findDoctorAuthStateById: jest.fn(),
    findAdminAuthStateById: jest.fn(),
    findOrCreatePatientByMobile: jest.fn(),
    setDoctorMobileVerifiedIfUnset: jest.fn(),
    setAdminMobileVerifiedIfUnset: jest.fn(),
    bumpTokenVersion: jest.fn(),
    getAccountSummary: jest.fn(),
  } as unknown as jest.Mocked<IdentityRepository>;

  const otp = {
    send: jest.fn(),
    retry: jest.fn(),
    verify: jest.fn(),
    verifyToken: jest.fn(),
  } as unknown as jest.Mocked<IdentityOtpService>;

  const tokenService = {
    mintTokenPair: jest.fn().mockResolvedValue({ accessToken: 'access', refreshToken: 'refresh', expiresIn: 900 }),
    verifyAccessToken: jest.fn(),
    verifyRefreshToken: jest.fn(),
  } as unknown as jest.Mocked<IdentityTokenService>;

  const accessService = {
    listAdminRoleCodes: jest.fn(),
    listEffectivePermissions: jest.fn(),
  } as unknown as jest.Mocked<IdentityAccessService>;

  const appConfig = {
    getNumber: jest.fn().mockImplementation((_key: string, fallback: number) => Promise.resolve(fallback)),
  } as unknown as AppConfigService;

  const audit = { write: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;

  const service = new IdentityService(db, repo, otp, tokenService, accessService, appConfig, audit);
  return { service, db, repo, otp, tokenService, accessService, appConfig, audit };
}

describe('IdentityService', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('requestOtp', () => {
    it('refuses a doctor-audience request when no doctor account exists, without ever calling Slide', async () => {
      const { service, repo, otp } = createDeps();
      repo.findDoctorAuthStateByMobile.mockResolvedValue(null);

      await expect(
        service.requestOtp({ mobileNumber: '+919876543210', audience: 'doctor' }, '1.1.1.1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(otp.send).not.toHaveBeenCalled();
    });

    it('refuses a doctor-audience request when the account is rejected/suspended', async () => {
      const { service, repo, otp } = createDeps();
      repo.findDoctorAuthStateByMobile.mockResolvedValue({ id: 'doc-1', isActive: false, tokenVersion: 0 });

      await expect(
        service.requestOtp({ mobileNumber: '+919876543210', audience: 'doctor' }, '1.1.1.1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(otp.send).not.toHaveBeenCalled();
    });

    it('always proceeds for patient audience, even with no existing account', async () => {
      const { service, repo, otp } = createDeps();
      otp.send.mockResolvedValue({ requestId: 'otpreq_1' });
      repo.insertChallenge.mockResolvedValue(baseChallenge() as never);

      await service.requestOtp({ mobileNumber: '+919876543210', audience: 'patient' }, '1.1.1.1');

      expect(otp.send).toHaveBeenCalledWith('+919876543210');
    });

    it('rate-limits by mobile number before ever calling Slide', async () => {
      const { service, repo, otp, appConfig } = createDeps();
      (appConfig.getNumber as jest.Mock).mockImplementation((key: string) =>
        Promise.resolve(key.includes('max_per_number') ? 3 : 999),
      );
      repo.countRecentAttemptsByMobile.mockResolvedValue(3);

      await expect(service.requestOtp({ mobileNumber: '+919876543210', audience: 'patient' })).rejects.toBeInstanceOf(
        HttpException,
      );
      expect(otp.send).not.toHaveBeenCalled();
      expect(repo.recordRequestAttempt).not.toHaveBeenCalled();
    });

    it('rate-limits the doctor/admin existence check itself — a rejected lookup still counts against the IP', async () => {
      // Regression test: countRecentAttempts* reads otp_request_attempts,
      // NOT otp_challenges, specifically so that a run of "account not
      // found" rejections (which never touch otp_challenges or Slide) are
      // still throttled. Before this fix, this endpoint was an unlimited
      // account-enumeration oracle for doctor/admin numbers.
      const { service, repo, otp, appConfig } = createDeps();
      (appConfig.getNumber as jest.Mock).mockImplementation((key: string) =>
        Promise.resolve(key.includes('max_per_ip') ? 5 : 999),
      );
      repo.countRecentAttemptsByIp.mockResolvedValue(5);

      await expect(
        service.requestOtp({ mobileNumber: '+919876543210', audience: 'doctor' }, '1.1.1.1'),
      ).rejects.toBeInstanceOf(HttpException);
      // Never even reached the existence check, let alone Slide.
      expect(repo.findDoctorAuthStateByMobile).not.toHaveBeenCalled();
      expect(otp.send).not.toHaveBeenCalled();
    });

    it('records the attempt before the doctor/admin existence check, so a rejected lookup is still counted for next time', async () => {
      const { service, repo } = createDeps();
      repo.findDoctorAuthStateByMobile.mockResolvedValue(null);

      await expect(service.requestOtp({ mobileNumber: '+919876543210', audience: 'doctor' }, '1.1.1.1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );

      expect(repo.recordRequestAttempt).toHaveBeenCalledWith('+919876543210', 'doctor', '1.1.1.1');
    });
  });

  describe('verifyOtp', () => {
    it('404s when the challenge does not exist', async () => {
      const { service, repo } = createDeps();
      repo.findChallengeById.mockResolvedValue(null);

      await expect(service.verifyOtp({ challengeId: 'missing', code: '123456' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('refuses an already-verified challenge without calling Slide again — our own replay stop', async () => {
      const { service, repo, otp } = createDeps();
      repo.findChallengeById.mockResolvedValue(baseChallenge({ verifiedAt: NOW }) as never);

      await expect(service.verifyOtp({ challengeId: 'challenge-1', code: '123456' })).rejects.toBeInstanceOf(
        HttpException,
      );
      expect(otp.verify).not.toHaveBeenCalled();
    });

    it('refuses a locally-expired challenge without calling Slide — fails fast instead of wasting a Slide call', async () => {
      const { service, repo, otp } = createDeps();
      repo.findChallengeById.mockResolvedValue(
        baseChallenge({ expiresAt: new Date(NOW.getTime() - 1000) }) as never,
      );

      await expect(service.verifyOtp({ challengeId: 'challenge-1', code: '123456' })).rejects.toBeInstanceOf(
        HttpException,
      );
      expect(otp.verify).not.toHaveBeenCalled();
    });

    it('locks out after too many attempts WITHOUT calling Slide, so a lockout costs no vendor quota', async () => {
      const { service, repo, otp } = createDeps();
      repo.findChallengeById.mockResolvedValue(baseChallenge({ attemptCount: 5 }) as never);

      await expect(service.verifyOtp({ challengeId: 'challenge-1', code: '123456' })).rejects.toBeInstanceOf(
        HttpException,
      );
      expect(otp.verify).not.toHaveBeenCalled();
    });

    it('bumps attemptCount and rethrows the same error when Slide rejects the code', async () => {
      const { service, repo, otp } = createDeps();
      repo.findChallengeById.mockResolvedValue(baseChallenge() as never);
      const slideError = new HttpException('bad code', 400);
      otp.verify.mockRejectedValue(slideError);

      await expect(service.verifyOtp({ challengeId: 'challenge-1', code: '000000' })).rejects.toBe(slideError);
      expect(repo.bumpAttemptCount).toHaveBeenCalledWith('challenge-1');
    });

    it('rejects when the verified identifier does not match the challenge mobile number, and never marks it verified', async () => {
      const { service, repo, otp } = createDeps();
      repo.findChallengeById.mockResolvedValue(baseChallenge() as never);
      otp.verify.mockResolvedValue({ accessToken: 'slide.jwt' });
      otp.verifyToken.mockResolvedValue({ verified: true, identifier: '+911111111111', verifiedAt: NOW.toISOString() });

      await expect(service.verifyOtp({ challengeId: 'challenge-1', code: '123456' })).rejects.toBeInstanceOf(
        HttpException,
      );
      expect(repo.markVerified).not.toHaveBeenCalled();
    });

    it('on success: marks the challenge verified, resolves/creates the account, mints tokens, and best-effort audits the login', async () => {
      const { service, repo, otp, tokenService, audit } = createDeps();
      repo.findChallengeById.mockResolvedValue(baseChallenge() as never);
      otp.verify.mockResolvedValue({ accessToken: 'slide.jwt' });
      otp.verifyToken.mockResolvedValue({ verified: true, identifier: '+919876543210', verifiedAt: NOW.toISOString() });
      repo.findOrCreatePatientByMobile.mockResolvedValue({ id: 'patient-1', isNewAccount: true, tokenVersion: 0 });

      const result = await service.verifyOtp({ challengeId: 'challenge-1', code: '123456' }, '1.1.1.1');

      expect(repo.markVerified).toHaveBeenCalledWith('challenge-1', expect.any(Date), expect.anything());
      expect(tokenService.mintTokenPair).toHaveBeenCalledWith('patient', 'patient-1', 0);
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'login', actorType: 'patient', actorId: 'patient-1' }),
      );
      expect(result.account).toEqual({ id: 'patient-1', accountType: 'patient', isNewAccount: true });
      expect(result.accessToken).toBe('access');
    });

    it('calls verifyToken exactly once even on a successful verify (single-use, no re-check retry)', async () => {
      const { service, repo, otp } = createDeps();
      repo.findChallengeById.mockResolvedValue(baseChallenge() as never);
      otp.verify.mockResolvedValue({ accessToken: 'slide.jwt' });
      otp.verifyToken.mockResolvedValue({ verified: true, identifier: '+919876543210', verifiedAt: NOW.toISOString() });
      repo.findOrCreatePatientByMobile.mockResolvedValue({ id: 'patient-1', isNewAccount: false, tokenVersion: 0 });

      await service.verifyOtp({ challengeId: 'challenge-1', code: '123456' });

      expect(otp.verifyToken).toHaveBeenCalledTimes(1);
    });
  });

  describe('logoutAll', () => {
    it('bumps tokenVersion and audits the reason', async () => {
      const { service, repo, audit } = createDeps();
      repo.bumpTokenVersion.mockResolvedValue(7);

      await service.logoutAll('patient', 'patient-1');

      expect(repo.bumpTokenVersion).toHaveBeenCalledWith('patient', 'patient-1');
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: expect.objectContaining({ reason: 'logout_all', newTokenVersion: 7 }) }),
      );
    });
  });

  describe('resendOtp', () => {
    it('404s when the challenge does not exist', async () => {
      const { service, repo } = createDeps();
      repo.findChallengeById.mockResolvedValue(null);

      await expect(service.resendOtp({ challengeId: 'missing' })).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses an already-verified challenge', async () => {
      const { service, repo, otp } = createDeps();
      repo.findChallengeById.mockResolvedValue(baseChallenge({ verifiedAt: NOW }) as never);

      await expect(service.resendOtp({ challengeId: 'challenge-1' })).rejects.toBeInstanceOf(HttpException);
      expect(otp.retry).not.toHaveBeenCalled();
    });

    it('refuses a locally-expired challenge', async () => {
      const { service, repo, otp } = createDeps();
      repo.findChallengeById.mockResolvedValue(baseChallenge({ expiresAt: new Date(NOW.getTime() - 1000) }) as never);

      await expect(service.resendOtp({ challengeId: 'challenge-1' })).rejects.toBeInstanceOf(HttpException);
      expect(otp.retry).not.toHaveBeenCalled();
    });

    it('rejects at exactly the max resend count, without calling Slide', async () => {
      const { service, repo, otp, appConfig } = createDeps();
      (appConfig.getNumber as jest.Mock).mockImplementation((key: string) =>
        Promise.resolve(key.includes('resend.max_per_challenge') ? 3 : 999),
      );
      repo.findChallengeById.mockResolvedValue(baseChallenge({ resendCount: 3 }) as never);

      await expect(service.resendOtp({ challengeId: 'challenge-1' })).rejects.toBeInstanceOf(HttpException);
      expect(otp.retry).not.toHaveBeenCalled();
    });

    it('allows a resend one below the max resend count', async () => {
      const { service, repo, otp, appConfig } = createDeps();
      (appConfig.getNumber as jest.Mock).mockImplementation((key: string) =>
        Promise.resolve(key.includes('resend.max_per_challenge') ? 3 : key.includes('cooldown') ? 0 : 999),
      );
      repo.findChallengeById.mockResolvedValueOnce(baseChallenge({ resendCount: 2 }) as never);
      otp.retry.mockResolvedValue({ requestId: 'otpreq_1' });
      repo.recordResend.mockResolvedValue(undefined);
      repo.findChallengeById.mockResolvedValueOnce(baseChallenge({ resendCount: 3 }) as never);

      await service.resendOtp({ challengeId: 'challenge-1' });

      expect(otp.retry).toHaveBeenCalledWith('otpreq_1');
      expect(repo.recordResend).toHaveBeenCalledWith('challenge-1', expect.any(Date));
    });

    it('rejects while still inside the cooldown window', async () => {
      const { service, repo, otp, appConfig } = createDeps();
      (appConfig.getNumber as jest.Mock).mockImplementation((key: string) =>
        Promise.resolve(key.includes('cooldown') ? 30 : 999),
      );
      repo.findChallengeById.mockResolvedValue(baseChallenge({ lastSentAt: NOW }) as never);

      await expect(service.resendOtp({ challengeId: 'challenge-1' })).rejects.toBeInstanceOf(HttpException);
      expect(otp.retry).not.toHaveBeenCalled();
    });

    it('allows a resend exactly when the cooldown has elapsed', async () => {
      const { service, repo, otp, appConfig } = createDeps();
      (appConfig.getNumber as jest.Mock).mockImplementation((key: string) =>
        Promise.resolve(key.includes('cooldown') ? 30 : 999),
      );
      const lastSentAt = new Date(NOW.getTime() - 30 * 1000);
      repo.findChallengeById.mockResolvedValueOnce(baseChallenge({ lastSentAt }) as never);
      otp.retry.mockResolvedValue({ requestId: 'otpreq_1' });
      repo.findChallengeById.mockResolvedValueOnce(baseChallenge({ lastSentAt }) as never);

      await expect(service.resendOtp({ challengeId: 'challenge-1' })).resolves.toBeDefined();
    });

    it('reuses the same providerRequestId — calls otp.retry, never otp.send', async () => {
      const { service, repo, otp } = createDeps();
      const lastSentAt = new Date(NOW.getTime() - 60 * 1000);
      repo.findChallengeById.mockResolvedValueOnce(baseChallenge({ lastSentAt }) as never);
      otp.retry.mockResolvedValue({ requestId: 'otpreq_1' });
      repo.findChallengeById.mockResolvedValueOnce(baseChallenge({ resendCount: 1, lastSentAt }) as never);

      await service.resendOtp({ challengeId: 'challenge-1' });

      expect(otp.retry).toHaveBeenCalledWith('otpreq_1');
      expect(otp.send).not.toHaveBeenCalled();
    });

    it('throws if the challenge vanishes immediately after its own resend (should be unreachable)', async () => {
      const { service, repo, otp } = createDeps();
      const lastSentAt = new Date(NOW.getTime() - 60 * 1000);
      repo.findChallengeById.mockResolvedValueOnce(baseChallenge({ lastSentAt }) as never);
      otp.retry.mockResolvedValue({ requestId: 'otpreq_1' });
      repo.findChallengeById.mockResolvedValueOnce(null);

      await expect(service.resendOtp({ challengeId: 'challenge-1' })).rejects.toThrow(
        'Challenge vanished immediately after its own resend',
      );
    });
  });

  describe('refreshToken', () => {
    it('rejects an unparseable/invalid refresh token', async () => {
      const { service, tokenService } = createDeps();
      (tokenService.verifyRefreshToken as jest.Mock).mockResolvedValue(null);

      await expect(service.refreshToken({ refreshToken: 'bad' })).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects when the account is no longer active', async () => {
      const { service, repo, tokenService } = createDeps();
      (tokenService.verifyRefreshToken as jest.Mock).mockResolvedValue({ sub: 'patient-1', act: 'patient', tv: 0, typ: 'refresh' });
      repo.findPatientAuthStateById.mockResolvedValue({ id: 'patient-1', isActive: false, tokenVersion: 0 });

      await expect(service.refreshToken({ refreshToken: 'tok' })).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects on a tokenVersion mismatch (the token was revoked by a logout-all since it was minted)', async () => {
      const { service, repo, tokenService } = createDeps();
      (tokenService.verifyRefreshToken as jest.Mock).mockResolvedValue({ sub: 'patient-1', act: 'patient', tv: 0, typ: 'refresh' });
      repo.findPatientAuthStateById.mockResolvedValue({ id: 'patient-1', isActive: true, tokenVersion: 1 });

      await expect(service.refreshToken({ refreshToken: 'tok' })).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects when the account no longer exists', async () => {
      const { service, repo, tokenService } = createDeps();
      (tokenService.verifyRefreshToken as jest.Mock).mockResolvedValue({ sub: 'doctor-1', act: 'doctor', tv: 0, typ: 'refresh' });
      repo.findDoctorAuthStateById.mockResolvedValue(null);

      await expect(service.refreshToken({ refreshToken: 'tok' })).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('mints a fresh token pair with the current tokenVersion when the refresh token is valid', async () => {
      const { service, repo, tokenService } = createDeps();
      (tokenService.verifyRefreshToken as jest.Mock).mockResolvedValue({ sub: 'admin-1', act: 'admin', tv: 2, typ: 'refresh' });
      repo.findAdminAuthStateById.mockResolvedValue({ id: 'admin-1', isActive: true, tokenVersion: 2 });

      const result = await service.refreshToken({ refreshToken: 'tok' });

      expect(tokenService.mintTokenPair).toHaveBeenCalledWith('admin', 'admin-1', 2);
      expect(result.accessToken).toBe('access');
    });
  });

  describe('getMe', () => {
    it('404s when the account no longer exists', async () => {
      const { service, repo } = createDeps();
      repo.getAccountSummary.mockResolvedValue(null);

      await expect(service.getMe({ accountType: 'patient', accountId: 'patient-1' })).rejects.toBeInstanceOf(NotFoundException);
    });

    it('returns the base profile without roles/permissions for a patient', async () => {
      const { service, repo, accessService } = createDeps();
      repo.getAccountSummary.mockResolvedValue({ id: 'patient-1', mobileNumber: '+919876543210', fullName: 'Jane' });

      const result = await service.getMe({ accountType: 'patient', accountId: 'patient-1' });

      expect(result).toEqual({
        id: 'patient-1',
        accountType: 'patient',
        fullName: 'Jane',
        mobileNumber: '+919876543210',
      });
      expect(accessService.listAdminRoleCodes).not.toHaveBeenCalled();
    });

    it('returns the base profile without roles/permissions for a doctor', async () => {
      const { service, repo, accessService } = createDeps();
      repo.getAccountSummary.mockResolvedValue({ id: 'doctor-1', mobileNumber: '+919876543210', fullName: 'Dr. X' });

      const result = await service.getMe({ accountType: 'doctor', accountId: 'doctor-1' });

      expect(result).not.toHaveProperty('roles');
      expect(accessService.listAdminRoleCodes).not.toHaveBeenCalled();
    });

    it('includes roles and permissions for an admin', async () => {
      const { service, repo, accessService } = createDeps();
      repo.getAccountSummary.mockResolvedValue({ id: 'admin-1', mobileNumber: '+919876543210', fullName: 'Admin' });
      accessService.listAdminRoleCodes.mockResolvedValue(['operations']);
      accessService.listEffectivePermissions.mockResolvedValue(['doctors.verify'] as never);

      const result = await service.getMe({ accountType: 'admin', accountId: 'admin-1' });

      expect(result.roles).toEqual(['operations']);
      expect(result.permissions).toEqual(['doctors.verify']);
    });
  });
});
