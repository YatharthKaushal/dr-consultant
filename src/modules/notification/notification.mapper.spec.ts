import type { NotificationRow } from '../../schema/notifications.schema';
import { toNotificationView, toNotificationViews } from './notification.mapper';

function row(overrides: Partial<NotificationRow> = {}): NotificationRow {
  return {
    id: 41,
    patientId: 'p0000000-0000-4000-8000-000000000001',
    doctorId: null,
    adminId: null,
    templateCode: 'booking_confirmed',
    title: 'Appointment confirmed',
    body: 'Your consultation with Dr Rao is confirmed for 10:30 am.',
    deepLinkData: { screen: 'consultation' },
    consultationId: 'c0000000-0000-4000-8000-000000000001',
    status: 'sent',
    sentAt: new Date('2026-01-01T00:00:01Z'),
    readAt: null,
    failureReason: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  } as NotificationRow;
}

describe('toNotificationView', () => {
  /**
   * *** THE PROJECTION IS THE PRIVACY BOUNDARY. ***
   *
   * Same discipline as `document.mapper.ts`'s `SafePatientFileRow` and
   * `doctor.mapper.ts`'s `SafeDoctorRow`: what is dropped is dropped on
   * purpose, and an exact-shape assertion is what stops a future column
   * arriving in a client payload just because it was added to the table.
   */
  it('returns exactly the ten fields a client is meant to see', () => {
    expect(Object.keys(toNotificationView(row())).sort()).toEqual([
      'body',
      'consultationId',
      'createdAt',
      'deepLinkData',
      'id',
      'readAt',
      'sentAt',
      'status',
      'templateCode',
      'title',
    ]);
  });

  /**
   * `failure_reason` is operational text about OUR delivery infrastructure
   * ("provider_unavailable: FCM is not configured for the patient app"),
   * written for a log and an operator. A patient reading their inbox has no
   * use for it and no business seeing it — the same rule
   * `storage-provider.types.ts` states for vendor `detail`.
   */
  it('never leaks failureReason, whatever it says', () => {
    const view = toNotificationView(
      row({ status: 'failed', failureReason: 'provider_unavailable: FCM is not configured for the patient app' }),
    );

    expect(view).not.toHaveProperty('failureReason');
    expect(JSON.stringify(view)).not.toContain('FCM');
  });

  /**
   * The reader already knows who they are. Returning the other two owner
   * columns at all invites a future join that populates them.
   */
  it.each([['patientId'], ['doctorId'], ['adminId']])('never returns the owner column %s', (column) => {
    expect(toNotificationView(row())).not.toHaveProperty(column);
  });

  /**
   * `status` IS kept: a doctor whose alerts are silently failing should be
   * able to see that in the app, and it is the one signal that prompts a
   * re-registration.
   */
  it('keeps status, which is the only signal that prompts a re-registration', () => {
    expect(toNotificationView(row({ status: 'failed' })).status).toBe('failed');
  });

  /** `read_at` set = read. There is no read value in the status enum saying the same thing. */
  it('keeps readAt, because that is what "read" means', () => {
    const readAt = new Date('2026-01-02T00:00:00Z');
    expect(toNotificationView(row({ readAt })).readAt).toBe(readAt);
    expect(toNotificationView(row({ readAt: null })).readAt).toBeNull();
  });

  it('normalises an absent deep-link payload to null rather than undefined, so the JSON shape is stable', () => {
    expect(toNotificationView(row({ deepLinkData: null })).deepLinkData).toBeNull();
  });

  it('passes the copy AS SENT through untouched', () => {
    const view = toNotificationView(row());
    expect(view.title).toBe('Appointment confirmed');
    expect(view.body).toBe('Your consultation with Dr Rao is confirmed for 10:30 am.');
  });
});

describe('toNotificationViews', () => {
  it('maps a list, preserving order', () => {
    const views = toNotificationViews([row({ id: 3 }), row({ id: 2 }), row({ id: 1 })]);
    expect(views.map((view) => view.id)).toEqual([3, 2, 1]);
  });

  it('returns an empty list for an empty inbox', () => {
    expect(toNotificationViews([])).toEqual([]);
  });

  it('drops failureReason from every row, not just the first', () => {
    const views = toNotificationViews([row({ failureReason: 'a' }), row({ failureReason: 'b' })]);
    for (const view of views) expect(view).not.toHaveProperty('failureReason');
  });
});
