import { IdentityAccessService } from './identity-access.service';
import { IdentityAuthContextService } from './identity-auth-context.service';
import { IdentityRepository } from './identity.repository';
import { IdentityTokenService } from './identity-token.service';

function createDeps() {
  const tokenService = {
    verifyAccessToken: jest.fn(),
  } as unknown as jest.Mocked<IdentityTokenService>;

  const repo = {
    findPatientAuthStateById: jest.fn(),
    findDoctorAuthStateById: jest.fn(),
    findAdminAuthStateById: jest.fn(),
  } as unknown as jest.Mocked<IdentityRepository>;

  const accessService = {
    hasAllPermissions: jest.fn(),
    listEffectivePermissions: jest.fn(),
  } as unknown as jest.Mocked<IdentityAccessService>;

  const service = new IdentityAuthContextService(tokenService, repo, accessService);
  return { service, tokenService, repo, accessService };
}

describe('IdentityAuthContextService', () => {
  describe('resolveAccessToken', () => {
    it('returns null when the token itself fails to verify', async () => {
      const { service, tokenService, repo } = createDeps();
      tokenService.verifyAccessToken.mockResolvedValue(null);

      await expect(service.resolveAccessToken('bad')).resolves.toBeNull();
      expect(repo.findPatientAuthStateById).not.toHaveBeenCalled();
    });

    it('returns null when the account no longer exists', async () => {
      const { service, tokenService, repo } = createDeps();
      tokenService.verifyAccessToken.mockResolvedValue({ sub: 'patient-1', act: 'patient', tv: 0, typ: 'access', iss: 'x', iat: 0, exp: 0 });
      repo.findPatientAuthStateById.mockResolvedValue(null);

      await expect(service.resolveAccessToken('tok')).resolves.toBeNull();
    });

    it('returns null when the account is inactive (suspended/deleted/rejected)', async () => {
      const { service, tokenService, repo } = createDeps();
      tokenService.verifyAccessToken.mockResolvedValue({ sub: 'doctor-1', act: 'doctor', tv: 0, typ: 'access', iss: 'x', iat: 0, exp: 0 });
      repo.findDoctorAuthStateById.mockResolvedValue({ id: 'doctor-1', isActive: false, tokenVersion: 0 });

      await expect(service.resolveAccessToken('tok')).resolves.toBeNull();
    });

    it('returns null on a tokenVersion mismatch (revoked by a logout-all/suspension since mint)', async () => {
      const { service, tokenService, repo } = createDeps();
      tokenService.verifyAccessToken.mockResolvedValue({ sub: 'admin-1', act: 'admin', tv: 1, typ: 'access', iss: 'x', iat: 0, exp: 0 });
      repo.findAdminAuthStateById.mockResolvedValue({ id: 'admin-1', isActive: true, tokenVersion: 2 });

      await expect(service.resolveAccessToken('tok')).resolves.toBeNull();
    });

    it('resolves the auth context when the token is valid, the account is active, and tokenVersion matches', async () => {
      const { service, tokenService, repo } = createDeps();
      tokenService.verifyAccessToken.mockResolvedValue({ sub: 'admin-1', act: 'admin', tv: 2, typ: 'access', iss: 'x', iat: 0, exp: 0 });
      repo.findAdminAuthStateById.mockResolvedValue({ id: 'admin-1', isActive: true, tokenVersion: 2 });

      await expect(service.resolveAccessToken('tok')).resolves.toEqual({ accountType: 'admin', accountId: 'admin-1' });
    });

    it('dispatches to the correct auth-state lookup per account type', async () => {
      const { service, tokenService, repo } = createDeps();
      tokenService.verifyAccessToken.mockResolvedValue({ sub: 'patient-1', act: 'patient', tv: 0, typ: 'access', iss: 'x', iat: 0, exp: 0 });
      repo.findPatientAuthStateById.mockResolvedValue({ id: 'patient-1', isActive: true, tokenVersion: 0 });

      await service.resolveAccessToken('tok');

      expect(repo.findPatientAuthStateById).toHaveBeenCalledWith('patient-1');
      expect(repo.findDoctorAuthStateById).not.toHaveBeenCalled();
      expect(repo.findAdminAuthStateById).not.toHaveBeenCalled();
    });
  });

  describe('permission passthroughs (used by PermissionGuard)', () => {
    it('hasAllPermissions delegates to the access service', async () => {
      const { service, accessService } = createDeps();
      accessService.hasAllPermissions.mockResolvedValue(true);

      await expect(service.hasAllPermissions('admin-1', ['doctors.verify' as never])).resolves.toBe(true);
      expect(accessService.hasAllPermissions).toHaveBeenCalledWith('admin-1', ['doctors.verify']);
    });

    it('listEffectivePermissions delegates to the access service', async () => {
      const { service, accessService } = createDeps();
      accessService.listEffectivePermissions.mockResolvedValue(['doctors.verify'] as never);

      await expect(service.listEffectivePermissions('admin-1')).resolves.toEqual(['doctors.verify']);
    });
  });
});
