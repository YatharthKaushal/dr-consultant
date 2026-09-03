/**
 * *** THE M-13 -> M-08 (NOTIFICATIONS) SEAM. READ BEFORE TOUCHING. ***
 *
 * `modules/notification` is being built in a PARALLEL WORKTREE and does not
 * exist in this one, so a direct `import from '../notification/notification
 * .contract'` would not compile. This file declares the interface LOCALLY and
 * binds it to the `NOTIFICATION_PORT` DI token (`instant.constants.ts`) —
 * precisely the pattern `booking/booking-payment.contract.ts` uses for
 * `BookingPaymentPort`/`BOOKING_PAYMENT_PORT`, `search/search-ai.contract.ts`
 * uses for `SearchAiPort`/`SEARCH_AI_PORT`, and `document/document-storage
 * .contract.ts` uses for `DocumentStoragePort`/`DOCUMENT_STORAGE_PORT`.
 *
 * The types below are a VERBATIM mirror of `modules/notification`'s own FIXED
 * signature — the other worktree is implementing this exact shape, blind.
 * *** DO NOT RENAME A FIELD OR ADD A REQUIRED ARGUMENT. *** Because TypeScript
 * is structural, `NotificationFacade` will satisfy `NotificationPort` with no
 * adapter, no cast and no change on either side.
 *
 * *** POST-MERGE, THE COORDINATOR REBINDS `NOTIFICATION_PORT` FROM
 * `UnavailableNotificationProvider` TO `NotificationFacade` IN
 * `instant.module.ts`. *** That is the whole handover: one line in the
 * `providers` array. If the notification module's signature ever changes,
 * change it HERE too — a structural mismatch will surface as a `tsc` error at
 * that binding, which is the point.
 *
 * Do NOT "fix" this into a cross-module import of `modules/notification`:
 * `backend/README.md` §2 says a module's only public surface is its facade,
 * resolved through DI, and the token is exactly that.
 *
 * ── WHY THIS PORT IS DIFFERENT FROM THE PAYMENT ONE ────────────────────────
 *
 * `UnavailableBookingPaymentProvider` THROWS, because a booking with no
 * payment is not a booking. The null object here does NOT throw, and neither
 * does the real implementation: *** M-13 IS FULLY FUNCTIONAL WITHOUT M-08. ***
 * SSE is the primary channel for a doctor with the app open, which is the
 * whole population Available Now describes; push is the fallback for a
 * backgrounded app. A notification that cannot be sent must therefore degrade
 * to "the doctor sees it when they look at the app", never to "the consult
 * fails". That is why `notify` is documented as best-effort and why every
 * call site here ignores its result.
 */

/** What M-08 is being asked to send. */
export interface NotificationRequest {
  /** e.g. 'instant_request'. Resolved against the admin-editable template set. */
  templateCode: string;
  audience: { kind: 'patient' | 'doctor' | 'admin'; id: string };
  /** Substituted into the template. MUST NOT carry a diagnosis (FR-16.2). */
  variables?: Record<string, string | number>;
  consultationId?: string;
  deepLinkData?: Record<string, unknown>;
}

/** What M-08 hands back. A `queued: false` is information, never a failure the caller has to handle. */
export interface NotificationResult {
  queued: boolean;
  /** `notifications.id` is bigserial. Null when nothing was queued. */
  notificationId: number | null;
  /** Why not: 'no_device_token' | 'template_missing' | 'provider_unavailable' | 'suppressed'. */
  reason?: string;
}

export interface NotificationPort {
  /** Best-effort. MUST NOT throw into the caller's flow — a failed notification never fails a consult. */
  notify(request: NotificationRequest): Promise<NotificationResult>;
}
