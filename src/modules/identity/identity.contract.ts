import type { AccountType, ActorType } from '../../schema/enums.schema';

export interface ContactIdentity {
  id: string;
  accountType: AccountType;
  isActive: boolean;
  mobileNumber: string;
}

/**
 * Who to attribute a `revokeAllSessions` call's `audit_log` entry to, when
 * it isn't the account revoking its own sessions — e.g. an admin suspending
 * a doctor/patient. See `revokeAllSessions`'s doc comment.
 */
export interface AuditActorOverride {
  actorType: ActorType;
  actorId: string;
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
  /**
   * Revokes every live session for `(accountType, id)`. The resulting
   * `audit_log` entry is attributed to `actor` when given (e.g. the admin
   * who suspended this account); it defaults to self-attribution
   * (`actorType: accountType, actorId: id`) when omitted, which is what
   * `POST /auth/logout-all`'s own self-service call relies on. A caller
   * acting on someone else's account — `PatientService`/
   * `DoctorVerificationService` on suspension — MUST pass `actor` explicitly,
   * or the audit trail wrongly reads as the affected account logging itself
   * out.
   */
  revokeAllSessions(accountType: AccountType, id: string, actor?: AuditActorOverride): Promise<void>;
  getContactIdentity(accountType: AccountType, id: string): Promise<ContactIdentity | null>;
}
