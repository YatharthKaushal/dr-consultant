import type { NotificationRow } from '../../schema/notifications.schema';

/**
 * What a patient, doctor or admin sees of their own notification.
 *
 * Three columns are deliberately dropped, following the same discipline as
 * `document.mapper.ts`'s `SafePatientFileRow` and `doctor.mapper.ts`'s
 * `SafeDoctorRow`:
 *
 *   - the two owner ids that are NOT the reader's. A patient's notification
 *     never carries a `doctorId`, but returning the column at all invites a
 *     future join that does. The reader already knows who they are.
 *   - `failureReason`. It is operational text about OUR delivery
 *     infrastructure ("provider_unavailable: FCM is not configured for the
 *     patient app"), written for a log and an operator. A patient reading
 *     their inbox has no use for it and no business seeing it — same rule
 *     `storage-provider.types.ts` states for vendor `detail`.
 *
 * `status` IS kept: a doctor whose alerts are silently failing should be able
 * to see that in the app, and it is the one signal that prompts a
 * re-registration. `read_at` is kept because it is what "read" means — there
 * is no read value in the status enum saying the same thing.
 */
export interface NotificationView {
  id: number;
  templateCode: string;
  title: string;
  body: string;
  deepLinkData: unknown;
  consultationId: string | null;
  status: NotificationRow['status'];
  sentAt: Date | null;
  readAt: Date | null;
  createdAt: Date;
}

export function toNotificationView(row: NotificationRow): NotificationView {
  return {
    id: row.id,
    templateCode: row.templateCode,
    title: row.title,
    body: row.body,
    deepLinkData: row.deepLinkData ?? null,
    consultationId: row.consultationId,
    status: row.status,
    sentAt: row.sentAt,
    readAt: row.readAt,
    createdAt: row.createdAt,
  };
}

export function toNotificationViews(rows: readonly NotificationRow[]): NotificationView[] {
  return rows.map(toNotificationView);
}
