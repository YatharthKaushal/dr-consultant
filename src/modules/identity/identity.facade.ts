import { Injectable } from '@nestjs/common';
import type { AccountType } from '../../schema/enums.schema';
import type { PermissionKey } from '../../shared/auth/permission.catalog';
import { IdentityAccessService } from './identity-access.service';
import type { AuditActorOverride, ContactIdentity, IdentityContract } from './identity.contract';
import { IdentityRepository, type AccountAuthState } from './identity.repository';
import { IdentityService } from './identity.service';

@Injectable()
export class IdentityFacade implements IdentityContract {
  constructor(
    private readonly accessService: IdentityAccessService,
    private readonly identityService: IdentityService,
    private readonly repo: IdentityRepository,
  ) {}

  async getEffectivePermissions(adminId: string): Promise<string[]> {
    return this.accessService.listEffectivePermissions(adminId);
  }

  async hasPermission(adminId: string, key: string): Promise<boolean> {
    return this.accessService.hasAllPermissions(adminId, [key as PermissionKey]);
  }

  async listAdminIdsWithPermission(key: string): Promise<string[]> {
    return this.accessService.listAdminIdsWithPermission(key as PermissionKey);
  }

  async revokeAllSessions(accountType: AccountType, id: string, actor?: AuditActorOverride): Promise<void> {
    await this.identityService.logoutAll(accountType, id, actor);
  }

  async getContactIdentity(accountType: AccountType, id: string): Promise<ContactIdentity | null> {
    const state = await this.getAuthState(accountType, id);
    if (!state) {
      return null;
    }
    const mobileNumber = await this.repo.getContactMobileNumber(accountType, id);
    if (!mobileNumber) {
      return null;
    }
    return { id: state.id, accountType, isActive: state.isActive, mobileNumber };
  }

  private async getAuthState(accountType: AccountType, id: string): Promise<AccountAuthState | null> {
    if (accountType === 'patient') return this.repo.findPatientAuthStateById(id);
    if (accountType === 'doctor') return this.repo.findDoctorAuthStateById(id);
    return this.repo.findAdminAuthStateById(id);
  }
}
