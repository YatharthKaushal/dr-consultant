/**
 * *** THE M-03 -> M-08 (NOTIFICATIONS) SEAM. ***
 *
 * `modules/notification` is already merged in this worktree — like
 * `followup-notification.contract.ts`, there is no waiting period, and
 * `consent.module.ts` binds `DATA_DELETION_NOTIFICATION_PORT` directly to
 * the real `NotificationFacade`.
 *
 * The port is still declared LOCALLY rather than imported, for the same
 * reason every module in this codebase does it even when the dependency is
 * real: `backend/README.md` §2 — a module's only public surface is its
 * facade, resolved through DI, never a direct import of another module's
 * files. The shape below is a VERBATIM mirror of `notification.contract.ts`'s
 * `NotificationContract`/`NotificationRequest`/`NotificationResult` —
 * because TypeScript is structural, `NotificationFacade` satisfies this with
 * no adapter and no cast.
 */

export interface DataDeletionNotificationRequest {
  /** e.g. `data_deletion_requested` — see `data-deletion.constants.ts#DATA_DELETION_NOTIFICATION_TEMPLATES`. Resolved against the admin-editable template set. */
  templateCode: string;
  audience: { kind: 'patient' | 'doctor' | 'admin'; id: string };
  /** MUST NOT carry a diagnosis (FR-16.2). This module never passes one. */
  variables?: Record<string, string | number>;
  consultationId?: string;
  deepLinkData?: Record<string, unknown>;
}

export interface DataDeletionNotificationResult {
  queued: boolean;
  notificationId: number | null;
  reason?: string;
}

export interface DataDeletionNotificationPort {
  /** Best-effort. MUST NOT throw into the caller's flow — a failed notification never blocks a status transition this module just wrote. */
  notify(request: DataDeletionNotificationRequest): Promise<DataDeletionNotificationResult>;
}
