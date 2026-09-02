import { IdentityAccessService } from './identity-access.service';
import { IdentityFacade } from './identity.facade';
import { IdentityRepository } from './identity.repository';
import { IdentityService } from './identity.service';

function createDeps() {
  const accessService = {
    listEffectivePermissions: jest.fn(),
    hasAllPermissions: jest.fn(),
  } as unknown as jest.Mocked<IdentityAccessService>;

  const identityService = {
    logoutAll: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<IdentityService>;

  const repo = {
    findPatientAuthStateById: jest.fn(),
    findDoctorAuthStateById: jest.fn(),
    findAdminAuthStateById: jest.fn(),
    getContactMobileNumber: jest.fn(),
  } as unknown as jest.Mocked<IdentityRepository>;

  const facade = new IdentityFacade(accessService, identityService, repo);
  return { facade, accessService, identityService, repo };
}

describe('IdentityFacade', () => {
  describe('getEffectivePermissions / hasPermission', () => {
    it('getEffectivePermissions delegates to the access service', async () => {
      const { facade, accessService } = createDeps();
      accessService.listEffectivePermissions.mockResolvedValue(['doctors.verify'] as never);

      await expect(facade.getEffectivePermissions('admin-1')).resolves.toEqual(['doctors.verify']);
    });

    it('hasPermission wraps the single key into a one-element array for the underlying ANY-of-N check', async () => {
      const { facade, accessService } = createDeps();
      accessService.hasAllPermissions.mockResolvedValue(true);

      await expect(facade.hasPermission('admin-1', 'doctors.verify')).resolves.toBe(true);
      expect(accessService.hasAllPermissions).toHaveBeenCalledWith('admin-1', ['doctors.verify']);
    });
  });

  describe('revokeAllSessions', () => {
    it('delegates to IdentityService.logoutAll with the same accountType/id', async () => {
      const { facade, identityService } = createDeps();

      await facade.revokeAllSessions('doctor', 'doctor-1');

      expect(identityService.logoutAll).toHaveBeenCalledWith('doctor', 'doctor-1');
    });
  });

  describe('getContactIdentity', () => {
    it('returns null when the account does not exist', async () => {
      const { facade, repo } = createDeps();
      repo.findPatientAuthStateById.mockResolvedValue(null);

      await expect(facade.getContactIdentity('patient', 'missing')).resolves.toBeNull();
      expect(repo.getContactMobileNumber).not.toHaveBeenCalled();
    });

    it('returns null when the account exists but has no mobile number on record', async () => {
      const { facade, repo } = createDeps();
      repo.findDoctorAuthStateById.mockResolvedValue({ id: 'doctor-1', isActive: true, tokenVersion: 0 });
      repo.getContactMobileNumber.mockResolvedValue(null);

      await expect(facade.getContactIdentity('doctor', 'doctor-1')).resolves.toBeNull();
    });

    it('returns the full contact identity, including isActive, when both lookups succeed', async () => {
      const { facade, repo } = createDeps();
      repo.findAdminAuthStateById.mockResolvedValue({ id: 'admin-1', isActive: true, tokenVersion: 0 });
      repo.getContactMobileNumber.mockResolvedValue('+919876543210');

      await expect(facade.getContactIdentity('admin', 'admin-1')).resolves.toEqual({
        id: 'admin-1',
        accountType: 'admin',
        isActive: true,
        mobileNumber: '+919876543210',
      });
    });

    it('surfaces isActive:false for an inactive account rather than filtering it out', async () => {
      const { facade, repo } = createDeps();
      repo.findPatientAuthStateById.mockResolvedValue({ id: 'patient-1', isActive: false, tokenVersion: 0 });
      repo.getContactMobileNumber.mockResolvedValue('+919876543210');

      await expect(facade.getContactIdentity('patient', 'patient-1')).resolves.toEqual(
        expect.objectContaining({ isActive: false }),
      );
    });
  });
});
