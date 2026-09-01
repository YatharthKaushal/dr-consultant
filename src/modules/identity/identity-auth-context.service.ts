import { Injectable } from '@nestjs/common';
import type { AccountType } from '../../schema/enums.schema';
import type { AuthContext, AuthContextResolver } from '../../shared/auth/auth.types';
import type { PermissionKey } from '../../shared/auth/permission.catalog';
import { IdentityAccessService } from './identity-access.service';
import { IdentityRepository, type AccountAuthState } from './identity.repository';
import { IdentityTokenService } from './identity-token.service';

/**
 * Implements `AuthContextResolver` — the bridge object `IdentityModule`
 * binds to the `AUTH_CONTEXT_RESOLVER` token that `shared/auth`'s guards
 * depend on. Deliberately thin: it only composes the token service, the
 * account repository, and the access service, all of which already exist
 * for their own reasons.
 */
@Injectable()
export class IdentityAuthContextService implements AuthContextResolver {
  constructor(
    private readonly tokenService: IdentityTokenService,
    private readonly repo: IdentityRepository,
    private readonly accessService: IdentityAccessService,
  ) {}

  async resolveAccessToken(token: string): Promise<AuthContext | null> {
    const payload = await this.tokenService.verifyAccessToken(token);
    if (!payload) {
      return null;
    }

    const state = await this.getAuthState(payload.act, payload.sub);
    if (!state || !state.isActive || state.tokenVersion !== payload.tv) {
      return null;
    }

    return { accountType: payload.act, accountId: payload.sub };
  }

  async hasAllPermissions(adminId: string, keys: readonly PermissionKey[]): Promise<boolean> {
    return this.accessService.hasAllPermissions(adminId, keys);
  }

  async listEffectivePermissions(adminId: string): Promise<PermissionKey[]> {
    return this.accessService.listEffectivePermissions(adminId);
  }

  private async getAuthState(accountType: AccountType, id: string): Promise<AccountAuthState | null> {
    if (accountType === 'patient') return this.repo.findPatientAuthStateById(id);
    if (accountType === 'doctor') return this.repo.findDoctorAuthStateById(id);
    return this.repo.findAdminAuthStateById(id);
  }
}
