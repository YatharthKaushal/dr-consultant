/**
 * *** THE M-16 -> M-08 (NOTIFICATIONS) SEAM. ***
 *
 * `modules/notification` IS already merged in this worktree, so — unlike
 * `instant-notification.contract.ts`, which was written against a module that
 * did not exist yet — there is no waiting period here. `followup.module.ts`
 * binds `FOLLOWUP_NOTIFICATION_PORT` directly to the real `NotificationFacade`.
 *
 * The port is still declared LOCALLY rather than imported, for the same
 * reason every module in this codebase does it even when the dependency is
 * real: `backend/README.md` §2 — a module's only public surface is its
 * facade, resolved through DI, never a direct import of another module's
 * files. The shape below is a VERBATIM mirror of `notification.contract.ts`'s
 * `NotificationContract`/`NotificationRequest`/`NotificationResult` — because
 * TypeScript is structural, `NotificationFacade` satisfies this with no
 * adapter and no cast.
 */

export interface FollowupNotificationRequest {
  /** e.g. `red_flag_alert` — see `followup.constants.ts#FOLLOWUP_NOTIFICATION_TEMPLATES`. Resolved against the admin-editable template set. */
  templateCode: string;
  audience: { kind: 'patient' | 'doctor' | 'admin'; id: string };
  /** MUST NOT carry a diagnosis (FR-16.2). This module never passes one. */
  variables?: Record<string, string | number>;
  consultationId?: string;
  deepLinkData?: Record<string, unknown>;
}

export interface FollowupNotificationResult {
  queued: boolean;
  notificationId: number | null;
  reason?: string;
}

export interface FollowupNotificationPort {
  /** Best-effort. MUST NOT throw into the caller's flow — a failed notification never blocks a red-flag alert from being recorded. */
  notify(request: FollowupNotificationRequest): Promise<FollowupNotificationResult>;
}
