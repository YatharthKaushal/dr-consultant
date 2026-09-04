/**
 * *** THE M-16 -> M-01/IDENTITY "ADMINS BY PERMISSION" GAP. SEE
 * `followup.constants.ts#ADMIN_DIRECTORY_PORT` FOR THE FULL ACCOUNT. ***
 *
 * FR-13.4's red-status alert is raised "to the doctor and to the admin or
 * care coordinator" — in practice, every admin holding `governance
 * .act_alerts`. `IdentityContract` has no method for "admins holding
 * permission X" today, and this worktree's guardrails leave
 * `src/modules/identity/*` untouched, so the real lookup cannot be built here.
 *
 * Bound to `UnavailableAdminDirectoryProvider` (`[]`) in `followup.module.ts`.
 * The coordinator closes this by adding `listAdminIdsWithPermission` to
 * `IdentityContract`/`IdentityFacade` (a straightforward join over
 * `admin_roles`/`role_permissions`, the same tables
 * `identity-access.service.ts#listAdminRoleCodes` already reads) and
 * rebinding this token — the same one-line handover every other port in this
 * codebase gets.
 */
export interface AdminDirectoryPort {
  /** Admin ids currently holding `permission` (e.g. `governance.act_alerts`), via ANY role. Empty array, never a throw, when none hold it or the provider is unavailable. */
  listAdminIdsWithPermission(permission: string): Promise<string[]>;
}
