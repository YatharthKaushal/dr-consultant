import type { AccountType } from '../../schema/enums.schema';

export interface ContactIdentity {
  id: string;
  accountType: AccountType;
  isActive: boolean;
  mobileNumber: string;
}

/**
 * Identity's public surface — every other module talks to identity through
 * this, never through its tables directly (`backend/README.md` §2). Each
 * method has a named future consumer:
 *   - getEffectivePermissions / hasPermission: any module gating a
 *     non-HTTP action (a background job, an event handler) that isn't
 *     covered by the `@RequirePermission` guard on a controller route.
 *   - revokeAllSessions: M-05 on doctor suspension, M-21 on data-deletion execution.
 *   - getContactIdentity: M-08, which needs a mobile number to send an SMS/push.
 */
export interface IdentityContract {
  getEffectivePermissions(adminId: string): Promise<string[]>;
  hasPermission(adminId: string, key: string): Promise<boolean>;
  revokeAllSessions(accountType: AccountType, id: string): Promise<void>;
  getContactIdentity(accountType: AccountType, id: string): Promise<ContactIdentity | null>;
}
