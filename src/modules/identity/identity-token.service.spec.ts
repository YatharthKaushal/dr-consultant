import type { JwtService } from '@nestjs/jwt';

const ENV = {
  JWT_ACCESS_SECRET: 'access-secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  JWT_ADMIN_REFRESH_TTL: '12h',
  JWT_REFRESH_TTL: '30d',
  JWT_ACCESS_TTL: '15m',
  JWT_ISSUER: 'dr-consultant-test',
};

jest.mock('../../config/env/env.validation', () => ({
  getEnv: () => ENV,
}));

import { IdentityTokenService } from './identity-token.service';

function createDeps() {
  const jwt = {
    signAsync: jest.fn().mockResolvedValue('signed.jwt.token'),
    verifyAsync: jest.fn(),
  } as unknown as jest.Mocked<JwtService>;

  const service = new IdentityTokenService(jwt);
  return { service, jwt };
}

describe('IdentityTokenService', () => {
  describe('mintTokenPair', () => {
    it('signs the access token with the access secret/TTL and typ "access"', async () => {
      const { service, jwt } = createDeps();

      await service.mintTokenPair('patient', 'patient-1', 3);

      expect(jwt.signAsync).toHaveBeenNthCalledWith(
        1,
        { sub: 'patient-1', act: 'patient', tv: 3, typ: 'access' },
        { secret: 'access-secret', expiresIn: 15 * 60, issuer: 'dr-consultant-test' },
      );
    });

    it('uses the standard (non-admin) refresh TTL for a patient/doctor account', async () => {
      const { service, jwt } = createDeps();

      await service.mintTokenPair('doctor', 'doctor-1', 0);

      expect(jwt.signAsync).toHaveBeenNthCalledWith(
        2,
        { sub: 'doctor-1', act: 'doctor', tv: 0, typ: 'refresh' },
        { secret: 'refresh-secret', expiresIn: 30 * 86400, issuer: 'dr-consultant-test' },
      );
    });

    it('uses the LONGER admin-specific refresh TTL for an admin account', async () => {
      const { service, jwt } = createDeps();

      await service.mintTokenPair('admin', 'admin-1', 0);

      expect(jwt.signAsync).toHaveBeenNthCalledWith(
        2,
        { sub: 'admin-1', act: 'admin', tv: 0, typ: 'refresh' },
        { secret: 'refresh-secret', expiresIn: 12 * 3600, issuer: 'dr-consultant-test' },
      );
    });

    it('reports expiresIn as the access-token TTL in seconds', async () => {
      const { service } = createDeps();

      const result = await service.mintTokenPair('patient', 'patient-1', 0);

      expect(result.expiresIn).toBe(15 * 60);
      expect(result.accessToken).toBe('signed.jwt.token');
      expect(result.refreshToken).toBe('signed.jwt.token');
    });
  });

  describe('verifyAccessToken', () => {
    it('returns the payload when the signature verifies and typ is "access"', async () => {
      const { service, jwt } = createDeps();
      const payload = { sub: 'patient-1', act: 'patient', tv: 0, typ: 'access', iss: 'x', iat: 0, exp: 0 };
      (jwt.verifyAsync as jest.Mock).mockResolvedValue(payload);

      await expect(service.verifyAccessToken('tok')).resolves.toEqual(payload);
      expect(jwt.verifyAsync).toHaveBeenCalledWith('tok', { secret: 'access-secret', issuer: 'dr-consultant-test' });
    });

    it('returns null when the token verifies but carries typ "refresh" (wrong token kind used at the wrong endpoint)', async () => {
      const { service, jwt } = createDeps();
      (jwt.verifyAsync as jest.Mock).mockResolvedValue({ sub: 'patient-1', act: 'patient', tv: 0, typ: 'refresh' });

      await expect(service.verifyAccessToken('tok')).resolves.toBeNull();
    });

    it('returns null (never throws) when verification fails — expired, malformed, wrong secret, or wrong issuer', async () => {
      const { service, jwt } = createDeps();
      (jwt.verifyAsync as jest.Mock).mockRejectedValue(new Error('jwt expired'));

      await expect(service.verifyAccessToken('tok')).resolves.toBeNull();
    });
  });

  describe('verifyRefreshToken', () => {
    it('verifies against the REFRESH secret, not the access secret', async () => {
      const { service, jwt } = createDeps();
      (jwt.verifyAsync as jest.Mock).mockResolvedValue({ sub: 'a', act: 'admin', tv: 0, typ: 'refresh' });

      await service.verifyRefreshToken('tok');

      expect(jwt.verifyAsync).toHaveBeenCalledWith('tok', { secret: 'refresh-secret', issuer: 'dr-consultant-test' });
    });

    it('returns null when the token verifies but carries typ "access"', async () => {
      const { service, jwt } = createDeps();
      (jwt.verifyAsync as jest.Mock).mockResolvedValue({ sub: 'a', act: 'admin', tv: 0, typ: 'access' });

      await expect(service.verifyRefreshToken('tok')).resolves.toBeNull();
    });

    it('returns null (never throws) on verification failure', async () => {
      const { service, jwt } = createDeps();
      (jwt.verifyAsync as jest.Mock).mockRejectedValue(new Error('invalid signature'));

      await expect(service.verifyRefreshToken('tok')).resolves.toBeNull();
    });
  });
});
