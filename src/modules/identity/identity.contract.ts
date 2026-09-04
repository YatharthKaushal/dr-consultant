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
   * ADDITIVE (M-16): every ACTIVE admin holding `key`, by role or direct
   * grant — the reverse of `hasPermission`. Built for `followup`'s
   * `ADMIN_DIRECTORY_PORT` (FR-13.4's red-alert fan-out to
   * `governance.act_alerts` holders); shaped generally, not follow-up
   * specific. See `identity-access.repository.ts#listAdminIdsWithPermission`.
   */
  listAdminIdsWithPermission(key: string): Promise<string[]>;
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

  /**
   * ADDITIVE (M-21/data rights execution). `mobileNumber` is the sign-in
   * identifier and, per `patient.repository.ts`'s own doc comment, stays
   * exclusively identity's to write — `patients`/`doctors`/`admins` never
   * touch it directly, even for their own row. A data-deletion execution
   * that anonymizes a patient's profile therefore cannot null this column
   * itself; it must come through here.
   *
   * Replaces the NOT NULL UNIQUE `mobile_number` with a deterministic,
   * collision-safe placeholder derived from the account's own id — never a
   * real E.164 number (no leading `+`), so it can never collide with one,
   * and deterministic so a retried execution (after a partial failure) is a
   * no-op rather than churning a fresh placeholder each time. See
   * `identity.repository.ts#anonymizedMobilePlaceholder`.
   *
   * Does NOT revoke sessions or change status — callers that need those
   * still call `revokeAllSessions` / their own status write separately, the
   * same split `patient.service.ts#updateStatus` already makes. Returns
   * `changed: false` (no write) when the account does not exist or its
   * mobile number is already the deterministic placeholder for its id.
   */
  anonymizeMobileNumber(accountType: AccountType, id: string): Promise<{ changed: boolean }>;
}
