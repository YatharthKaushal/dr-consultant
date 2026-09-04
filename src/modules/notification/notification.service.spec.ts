import { Logger } from '@nestjs/common';
import type { NotificationRow } from '../../schema/notifications.schema';
import type { AuthContext } from '../../shared/auth/auth.types';
import type { NotificationDeviceRepository } from './notification-device.repository';
import type { NotificationRepository } from './notification.repository';
import type { NotificationTemplateService } from './notification-template.service';
import type { PushProvider, PushSendResult } from './notification-push.types';
import { NotificationService, buildDataPayload } from './notification.service';
import { NOTIFICATION_TEMPLATE_DEFAULTS } from './notification.constants';
import { screenForDiagnosis } from './notification-diagnosis.util';

const PATIENT_ID = 'p0000000-0000-4000-8000-000000000001';
const DOCTOR_ID = 'd0000000-0000-4000-8000-000000000001';
const ADMIN_ID = 'a0000000-0000-4000-8000-000000000001';
const CONSULTATION_ID = 'c0000000-0000-4000-8000-000000000001';

const patient = (): AuthContext => ({ accountType: 'patient', accountId: PATIENT_ID });
const doctor = (): AuthContext => ({ accountType: 'doctor', accountId: DOCTOR_ID });
const admin = (): AuthContext => ({ accountType: 'admin', accountId: ADMIN_ID });

function row(overrides: Partial<NotificationRow> = {}): NotificationRow {
  return {
    id: 41,
    patientId: PATIENT_ID,
    doctorId: null,
    adminId: null,
    templateCode: 'booking_confirmed',
    title: 'Appointment confirmed',
    body: 'Your consultation with Dr Rao is confirmed for 10:30 am. Tap to see the details.',
    deepLinkData: null,
    consultationId: null,
    status: 'queued',
    sentAt: null,
    readAt: null,
    failureReason: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  } as NotificationRow;
}

describe('NotificationService', () => {
  let repo: jest.Mocked<NotificationRepository>;
  let devices: jest.Mocked<NotificationDeviceRepository>;
  let templates: jest.Mocked<NotificationTemplateService>;
  let push: jest.Mocked<PushProvider>;
  let service: NotificationService;

  beforeEach(() => {
    // The service logs a warning on every degraded path by design; silence it
    // so a green run is readable, and assert on behaviour instead.
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    repo = {
      insert: jest.fn(async () => row()),
      markSent: jest.fn(async () => undefined),
      markFailed: jest.fn(async () => undefined),
      listForAudience: jest.fn(async () => []),
      countUnread: jest.fn(async () => 0),
      markRead: jest.fn(async () => new Date('2026-02-02T09:00:00Z')),
      markAllRead: jest.fn(async () => 0),
    } as unknown as jest.Mocked<NotificationRepository>;

    devices = {
      findPushToken: jest.fn(async () => 'tok_1'),
      register: jest.fn(async () => true),
      clearPushToken: jest.fn(async () => undefined),
    } as unknown as jest.Mocked<NotificationDeviceRepository>;

    templates = {
      findTemplate: jest.fn(async (code: string) => {
        const entry = NOTIFICATION_TEMPLATE_DEFAULTS[code as keyof typeof NOTIFICATION_TEMPLATE_DEFAULTS];
        return entry ?? null;
      }),
    } as unknown as jest.Mocked<NotificationTemplateService>;

    push = {
      isConfigured: jest.fn(() => true),
      send: jest.fn(async (): Promise<PushSendResult> => ({ delivered: true, messageId: 'msg_1' })),
    } as unknown as jest.Mocked<PushProvider>;

    service = new NotificationService(repo, devices, templates, push);
  });

  afterEach(() => jest.restoreAllMocks());

  const bookingRequest = () => ({
    templateCode: 'booking_confirmed',
    audience: { kind: 'patient' as const, id: PATIENT_ID },
    variables: { doctorName: 'Dr Rao', scheduledAt: '10:30 am' },
  });

  /* ====================================================================== */

  describe('the happy path', () => {
    it('renders the template, records the row and pushes', async () => {
      const result = await service.notify(bookingRequest());

      expect(result).toEqual({ queued: true, notificationId: 41 });
      expect(repo.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          audience: { kind: 'patient', id: PATIENT_ID },
          templateCode: 'booking_confirmed',
          title: 'Appointment confirmed',
          body: 'Your consultation with Dr Rao is confirmed for 10:30 am. Tap to see the details.',
        }),
      );
      expect(push.send).toHaveBeenCalledWith(
        'patient',
        expect.objectContaining({ token: 'tok_1', title: 'Appointment confirmed' }),
      );
      expect(repo.markSent).toHaveBeenCalledWith(41, expect.any(Date));
    });

    /**
     * *** THE COPY STORED IS THE COPY SENT. *** `notifications.body`'s own
     * schema comment: "the copy AS SENT. Kept because the template may change
     * later." A row that recorded the template rather than the render would
     * be useless the first time an admin edits the wording.
     */
    it('stores exactly the bytes it pushes', async () => {
      await service.notify(bookingRequest());

      const stored = repo.insert.mock.calls[0]?.[0];
      const pushed = push.send.mock.calls[0]?.[1];
      expect(pushed?.title).toBe(stored?.title);
      expect(pushed?.body).toBe(stored?.body);
    });

    it('routes a doctor notification through the doctor app, not a shared one', async () => {
      await service.notify({
        templateCode: 'instant_request',
        audience: { kind: 'doctor', id: DOCTOR_ID },
        variables: { expiresInSeconds: 45 },
      });

      expect(devices.findPushToken).toHaveBeenCalledWith('doctor', DOCTOR_ID);
      expect(push.send).toHaveBeenCalledWith('doctor', expect.anything());
    });

    it('carries the consultation id and deep-link payload onto the row', async () => {
      await service.notify({
        ...bookingRequest(),
        consultationId: CONSULTATION_ID,
        deepLinkData: { screen: 'consultation' },
      });

      expect(repo.insert).toHaveBeenCalledWith(
        expect.objectContaining({ consultationId: CONSULTATION_ID, deepLinkData: { screen: 'consultation' } }),
      );
    });
  });

  /* ====================================================================== */

  /**
   * *** THE DONE-WHEN: "OTHER MODULES RAISE NOTIFICATIONS WITHOUT KNOWING THE
   * DELIVERY CHANNEL." ***
   *
   * The proof is what a caller has to pass and what it gets back. Nothing in
   * `NotificationRequest` names a channel, a Firebase project, a device token
   * or a piece of copy, and the SAME request produces the same caller-visible
   * shape whether it is delivered, degraded or suppressed.
   */
  describe('the caller never learns the delivery channel', () => {
    it('takes no channel, token or copy from the caller — only a template code and an audience', async () => {
      const request = bookingRequest();
      await service.notify(request);

      // The request the caller wrote carries no delivery concept at all.
      expect(Object.keys(request).sort()).toEqual(['audience', 'templateCode', 'variables']);
      // ...and the copy came from the template, not the caller.
      expect(templates.findTemplate).toHaveBeenCalledWith('booking_confirmed');
      expect(repo.insert.mock.calls[0]?.[0].body).toContain('Tap to see the details');
    });

    it.each([
      ['delivered', () => undefined],
      ['no token', () => devices.findPushToken.mockResolvedValue(null)],
      ['FCM unconfigured', () => push.isConfigured.mockReturnValue(false)],
      ['FCM rejecting', () => push.send.mockResolvedValue({ delivered: false, failure: { kind: 'unavailable', detail: 'x' } })],
    ])('answers the same result SHAPE when %s, so no caller branches on the channel', async (_label, arrange) => {
      arrange();
      const result = await service.notify(bookingRequest());

      expect(result.queued).toBe(true);
      expect(result.notificationId).toBe(41);
      expect(Object.keys(result).every((key) => ['queued', 'notificationId', 'reason'].includes(key))).toBe(true);
    });
  });

  /* ====================================================================== */

  /**
   * *** notify MUST NEVER THROW. ***
   *
   * Every caller is in the middle of something more important than a push:
   * M-11 is confirming a booking, M-12 has just captured money, M-13 is
   * fanning an instant request out while a patient waits. A failed
   * notification must leave every one of those flows untouched.
   */
  describe('notify never throws into the caller-s flow', () => {
    it.each([
      ['the template lookup throws', () => templates.findTemplate.mockRejectedValue(new Error('config down'))],
      ['the row insert throws', () => repo.insert.mockRejectedValue(new Error('deadlock detected'))],
      ['the token read throws', () => devices.findPushToken.mockRejectedValue(new Error('connection reset'))],
      ['the push adapter throws', () => push.send.mockRejectedValue(new Error('unexpected'))],
      ['isConfigured throws', () => push.isConfigured.mockImplementation(() => { throw new Error('env gone'); })],
      ['markSent throws', () => repo.markSent.mockRejectedValue(new Error('write failed'))],
      // Even the write that was supposed to RECORD the failure.
      ['markFailed throws', () => {
        devices.findPushToken.mockResolvedValue(null);
        repo.markFailed.mockRejectedValue(new Error('write failed'));
      }],
    ])('returns a result rather than throwing when %s', async (_label, arrange) => {
      arrange();
      await expect(service.notify(bookingRequest())).resolves.toEqual({
        queued: false,
        notificationId: null,
        reason: 'provider_unavailable',
      });
    });

    /** A malformed request from a caller is still a caller's flow to protect. */
    it.each([
      [{ templateCode: 'booking_confirmed' } as never],
      [{ audience: { kind: 'patient', id: PATIENT_ID } } as never],
      [{} as never],
      [null as never],
    ])('survives the malformed request %s', async (request) => {
      await expect(service.notify(request)).resolves.toMatchObject({ queued: false, notificationId: null });
    });

    /**
     * The four `reason` values are FROZEN — M-13 is built against a blind
     * mirror of them. An infrastructure fault is reported as
     * `provider_unavailable` rather than a fifth value M-13 has never heard
     * of.
     */
    it('never invents a reason outside the four M-13 knows about', async () => {
      const arrangements = [
        () => repo.insert.mockRejectedValue(new Error('x')),
        () => templates.findTemplate.mockResolvedValue(null),
        () => devices.findPushToken.mockResolvedValue(null),
        () => push.isConfigured.mockReturnValue(false),
      ];

      for (const arrange of arrangements) {
        jest.clearAllMocks();
        arrange();
        const { reason } = await service.notify(bookingRequest());
        if (reason !== undefined) {
          expect(['no_device_token', 'template_missing', 'provider_unavailable', 'suppressed']).toContain(reason);
        }
      }
    });
  });

  /* ====================================================================== */

  describe('template_missing', () => {
    it('queues nothing when the code resolves to no template', async () => {
      templates.findTemplate.mockResolvedValue(null);

      await expect(service.notify({ ...bookingRequest(), templateCode: 'never_defined' })).resolves.toEqual({
        queued: false,
        notificationId: null,
        reason: 'template_missing',
      });
      expect(repo.insert).not.toHaveBeenCalled();
      expect(push.send).not.toHaveBeenCalled();
    });
  });

  /* ====================================================================== */

  /**
   * *** FR-16.2, AT SEND TIME. ***
   *
   * Screened against the FULLY RENDERED copy — the exact bytes that would be
   * stored in `notifications.body` and pushed to a lock screen.
   *
   * A hit writes NO ROW. `notifications.body`'s schema comment says the
   * stored copy "MUST NOT name a diagnosis", so a row recording the offending
   * body would breach the rule it was written to document — and the in-app
   * inbox reads those rows back, so it would also DISPLAY it.
   */
  describe('FR-16.2 — no notification body can name a diagnosis', () => {
    it('suppresses entirely when the TEMPLATE copy names a diagnosis', async () => {
      templates.findTemplate.mockResolvedValue({ title: 'Update', body: 'Your diabetes review is due.' });

      await expect(service.notify(bookingRequest())).resolves.toEqual({
        queued: false,
        notificationId: null,
        reason: 'suppressed',
      });
    });

    /** *** NO ROW, NO PUSH, NOTHING. *** Not a redacted row: a redacted diagnosis is a diagnosis with a hole in it. */
    it('writes no row and sends no push when it suppresses', async () => {
      templates.findTemplate.mockResolvedValue({ title: 'Update', body: 'Your diabetes review is due.' });
      await service.notify(bookingRequest());

      expect(repo.insert).not.toHaveBeenCalled();
      expect(repo.markFailed).not.toHaveBeenCalled();
      expect(push.send).not.toHaveBeenCalled();
    });

    /**
     * THE CASE WRITE-TIME SCREENING CANNOT CATCH. `document_rejected`'s
     * `{{reason}}` is genuinely free-form text an admin reviewer types, and it
     * is substituted into a template that passed every write-time check. This
     * is the whole reason send-time screening exists.
     */
    it('suppresses when a DECLARED variable smuggles a diagnosis into clean template copy', async () => {
      const result = await service.notify({
        templateCode: 'document_rejected',
        audience: { kind: 'doctor', id: DOCTOR_ID },
        variables: { documentType: 'registration certificate', reason: 'it names a diabetes clinic' },
      });

      expect(result.reason).toBe('suppressed');
      expect(repo.insert).not.toHaveBeenCalled();
      // ...and the template itself was perfectly clean.
      expect(screenForDiagnosis(NOTIFICATION_TEMPLATE_DEFAULTS.document_rejected.body).clean).toBe(true);
    });

    /** The deep-link payload travels with the notification and is readable by the app before anything is unlocked. */
    it('suppresses when the DEEP-LINK payload names a diagnosis, even though the copy is clean', async () => {
      const result = await service.notify({
        ...bookingRequest(),
        deepLinkData: { screen: 'consultation', tag: 'diabetes follow-up' },
      });

      expect(result.reason).toBe('suppressed');
      expect(repo.insert).not.toHaveBeenCalled();
    });

    it('suppresses on a deep-link object KEY as well as a value', async () => {
      const result = await service.notify({ ...bookingRequest(), deepLinkData: { diabetes: true } });
      expect(result.reason).toBe('suppressed');
    });

    /**
     * *** NESTING WAS A ONE-LINE WAY AROUND THIS SCREEN. *** The deep-link
     * walk gave up below six levels and returned nothing, so this payload
     * screened clean and the phrase reached `deep_link_data`, the client (via
     * `notification.mapper.ts`) and the FCM `data` block.
     */
    it('suppresses a diagnosis buried deeper than the old deep-link depth cap', async () => {
      const result = await service.notify({
        ...bookingRequest(),
        deepLinkData: { a: { b: { c: { d: { e: { f: { g: 'you have diabetes' } } } } } } },
      });

      expect(result).toEqual({ queued: false, notificationId: null, reason: 'suppressed' });
      expect(repo.insert).not.toHaveBeenCalled();
      expect(push.send).not.toHaveBeenCalled();
    });

    /**
     * *** LAYER 2 — THE STRUCTURAL GUARANTEE, NOT THE DENY-LIST. ***
     *
     * An UNDECLARED variable is dropped before anything screens it, so a
     * caller passing a diagnosis under a name the template does not use
     * cannot put those words in a body — and the notification is still
     * delivered, because nothing went wrong. This is what makes FR-16.2 hold
     * for the tens of thousands of conditions the deny-list does NOT name.
     */
    it('a diagnosis in an UNDECLARED variable never reaches the body, and does not suppress the notification', async () => {
      const result = await service.notify({
        ...bookingRequest(),
        variables: { doctorName: 'Dr Rao', scheduledAt: '10:30 am', diagnosis: 'type 2 diabetes' },
      });

      expect(result).toEqual({ queued: true, notificationId: 41 });
      const stored = repo.insert.mock.calls[0]?.[0];
      expect(stored?.body).not.toContain('diabetes');
      expect(stored?.title).not.toContain('diabetes');
      expect(screenForDiagnosis(String(stored?.body)).clean).toBe(true);
    });

    /** The same holds for a condition the deny-list has never heard of — because it is never substituted, not because it is screened. */
    it('drops an undeclared variable naming an UNLISTED condition too', async () => {
      await service.notify({
        ...bookingRequest(),
        variables: { doctorName: 'Dr Rao', scheduledAt: '10:30 am', notes: 'sarcoidosis, stage II' },
      });

      expect(repo.insert.mock.calls[0]?.[0].body).not.toContain('sarcoidosis');
    });

    /** Every stored body is screened, whatever the audience. */
    it.each([
      ['patient', PATIENT_ID],
      ['doctor', DOCTOR_ID],
      ['admin', ADMIN_ID],
    ])('screens a %s notification the same way', async (kind, id) => {
      templates.findTemplate.mockResolvedValue({ title: 'Update', body: 'Your cancer result is ready.' });

      const result = await service.notify({
        templateCode: 'booking_confirmed',
        audience: { kind: kind as 'patient' | 'doctor' | 'admin', id },
      });

      expect(result.reason).toBe('suppressed');
      expect(repo.insert).not.toHaveBeenCalled();
    });
  });

  /* ====================================================================== */

  /**
   * `notifications.admin_id`'s schema comment: "read in the panel — admins
   * have no push token". The panel is a web app with no store listing and no
   * FCM project, so for an admin the ROW IS THE DELIVERY.
   */
  describe('an admin audience', () => {
    const alert = () => ({
      templateCode: 'red_flag_alert',
      audience: { kind: 'admin' as const, id: ADMIN_ID },
    });

    it('records the row as SENT, not failed — the panel is the delivery channel', async () => {
      repo.insert.mockResolvedValue(row({ adminId: ADMIN_ID, patientId: null }));

      await expect(service.notify(alert())).resolves.toEqual({ queued: true, notificationId: 41 });
      expect(repo.markSent).toHaveBeenCalledWith(41, expect.any(Date));
      expect(repo.markFailed).not.toHaveBeenCalled();
    });

    /** Marking it failed would make every safety alert to a care_coordinator look broken and poison the (status, created_at) index. */
    it('returns no reason — nothing went wrong', async () => {
      const result = await service.notify(alert());
      expect(result.reason).toBeUndefined();
    });

    it('never looks for a push token and never touches the push provider', async () => {
      await service.notify(alert());
      expect(devices.findPushToken).not.toHaveBeenCalled();
      expect(push.isConfigured).not.toHaveBeenCalled();
      expect(push.send).not.toHaveBeenCalled();
    });
  });

  /* ====================================================================== */

  /**
   * *** "QUEUED BUT NOT DELIVERED". ***
   *
   * The row still exists, so the in-app notification and the panel are
   * unaffected; only the push did not happen, and `failure_reason` says so in
   * words an operator can act on.
   */
  describe('an unconfigured FCM credential degrades', () => {
    beforeEach(() => push.isConfigured.mockReturnValue(false));

    it('still queues the row, and reports provider_unavailable', async () => {
      await expect(service.notify(bookingRequest())).resolves.toEqual({
        queued: true,
        notificationId: 41,
        reason: 'provider_unavailable',
      });
      expect(repo.insert).toHaveBeenCalled();
    });

    it('records a failure_reason that names the app an operator has to fix', async () => {
      await service.notify(bookingRequest());
      expect(repo.markFailed).toHaveBeenCalledWith(
        41,
        'provider_unavailable: FCM is not configured for the patient app',
      );
    });

    it('does not attempt a send, and does not read a token it cannot use', async () => {
      await service.notify(bookingRequest());
      expect(push.send).not.toHaveBeenCalled();
      expect(devices.findPushToken).not.toHaveBeenCalled();
    });
  });

  describe('no device token', () => {
    it.each([[null], ['']])('records no_device_token when the stored token is %s', async (token) => {
      devices.findPushToken.mockResolvedValue(token);

      await expect(service.notify(bookingRequest())).resolves.toEqual({
        queued: true,
        notificationId: 41,
        reason: 'no_device_token',
      });
      expect(repo.markFailed).toHaveBeenCalledWith(
        41,
        'no_device_token: the account has not registered a device for push',
      );
      expect(push.send).not.toHaveBeenCalled();
    });
  });

  describe('a rejected send', () => {
    /**
     * *** THE ONE FAILURE WITH A SIDE EFFECT. *** FCM is saying the token is
     * dead. Not clearing it leaves every future notification to that account
     * failing forever against a token FCM has already disowned.
     */
    it('clears the stored token when FCM reports it unregistered', async () => {
      push.send.mockResolvedValue({
        delivered: false,
        failure: { kind: 'unregistered_token', detail: 'Requested entity was not found.' },
      });

      const result = await service.notify(bookingRequest());

      expect(devices.clearPushToken).toHaveBeenCalledWith('patient', PATIENT_ID);
      expect(result.reason).toBe('no_device_token');
      expect(repo.markFailed).toHaveBeenCalledWith(41, expect.stringContaining('unregistered_token'));
    });

    /** A token rejected because it belongs to the OTHER app's project is a misconfiguration to surface, not data to delete. */
    it('does NOT clear the token for an invalid_token, but still reports no_device_token', async () => {
      push.send.mockResolvedValue({
        delivered: false,
        failure: { kind: 'invalid_token', detail: 'mismatched credential' },
      });

      const result = await service.notify(bookingRequest());

      expect(devices.clearPushToken).not.toHaveBeenCalled();
      expect(result.reason).toBe('no_device_token');
    });

    it.each([['invalid_credentials'], ['rate_limited'], ['unavailable'], ['unknown'], ['not_configured']] as const)(
      'reports provider_unavailable for a %s failure, and keeps the row',
      async (kind) => {
        push.send.mockResolvedValue({ delivered: false, failure: { kind, detail: 'vendor text' } });

        await expect(service.notify(bookingRequest())).resolves.toEqual({
          queued: true,
          notificationId: 41,
          reason: 'provider_unavailable',
        });
        expect(repo.markFailed).toHaveBeenCalledWith(41, `${kind}: vendor text`);
      },
    );

    /** `notifications.failure_reason` is `varchar(200)`; an over-long reason would turn a recorded failure into an unrecorded one. */
    it('truncates the failure reason to the 200 characters the column holds', async () => {
      push.send.mockResolvedValue({ delivered: false, failure: { kind: 'unknown', detail: 'x'.repeat(500) } });
      await service.notify(bookingRequest());

      const [, reason] = repo.markFailed.mock.calls[0] ?? [];
      expect(String(reason)).toHaveLength(200);
    });
  });

  /* ====================================================================== */

  describe('buildDataPayload', () => {
    /**
     * FCM rejects a non-string `data` value, and reserves `from`,
     * `notification`, `message_type` and anything starting with `google`/
     * `gcm`. Nesting the caller's payload under ONE key makes a collision
     * with those impossible.
     */
    it('json-encodes the deep-link payload under one key rather than flattening it', () => {
      const data = buildDataPayload(41, {
        templateCode: 'booking_confirmed',
        audience: { kind: 'patient', id: PATIENT_ID },
        deepLinkData: { screen: 'consultation', from: 'attacker' },
      });

      expect(data).toEqual({
        notificationId: '41',
        templateCode: 'booking_confirmed',
        deepLinkData: '{"screen":"consultation","from":"attacker"}',
      });
      expect(data.from).toBeUndefined();
    });

    it('makes every value a string, which is all FCM accepts', () => {
      const data = buildDataPayload(41, {
        templateCode: 'booking_confirmed',
        audience: { kind: 'patient', id: PATIENT_ID },
        consultationId: CONSULTATION_ID,
      });

      for (const value of Object.values(data)) expect(typeof value).toBe('string');
    });

    it('omits the optional keys when the caller passed none', () => {
      expect(
        buildDataPayload(41, { templateCode: 'checkin_due', audience: { kind: 'patient', id: PATIENT_ID } }),
      ).toEqual({ notificationId: '41', templateCode: 'checkin_due' });
    });
  });

  /* ====================================================================== */
  /* The read half — the in-app inbox                                        */
  /* ====================================================================== */

  describe('the in-app inbox', () => {
    /** Identity comes from the token, never from a parameter — FR-1.4. */
    it.each([
      ['patient', patient(), PATIENT_ID],
      ['doctor', doctor(), DOCTOR_ID],
      ['admin', admin(), ADMIN_ID],
    ])('scopes a %s list to their own audience', async (kind, auth, id) => {
      await service.listOwn(auth, { limit: 20, offset: 0 });
      expect(repo.listForAudience).toHaveBeenCalledWith(expect.objectContaining({ audience: { kind, id } }));
    });

    it('passes the unread filter through', async () => {
      await service.listOwn(patient(), { unreadOnly: true, limit: 20, offset: 0 });
      expect(repo.listForAudience).toHaveBeenCalledWith(expect.objectContaining({ unreadOnly: true }));
    });

    /** A client asking for more than the ceiling gets the ceiling, not an error and not the whole table. */
    it('caps the page size at the module maximum however large a limit reaches it', async () => {
      await service.listOwn(patient(), { limit: 100_000, offset: 0 });
      expect(repo.listForAudience).toHaveBeenCalledWith(expect.objectContaining({ limit: 100 }));
    });

    it('reports the unread count', async () => {
      repo.countUnread.mockResolvedValue(7);
      await expect(service.countUnread(patient())).resolves.toEqual({ unread: 7 });
    });

    it('marks one notification read and reports when it happened', async () => {
      const result = await service.markRead(patient(), 41);

      expect(repo.markRead).toHaveBeenCalledWith({ kind: 'patient', id: PATIENT_ID }, 41, expect.any(Date));
      expect(result).toMatchObject({ id: 41 });
      expect(result.readAt).toBeInstanceOf(Date);
    });

    /**
     * A row that does not exist and a row belonging to someone else are the
     * SAME 404 — telling them apart would turn this endpoint into an
     * existence oracle over other people's notification ids.
     */
    it('404s identically for a missing row and for someone else-s row', async () => {
      repo.markRead.mockResolvedValue(null);

      await expect(service.markRead(patient(), 41)).rejects.toMatchObject({
        status: 404,
        response: { code: 'NOTIFICATION_NOT_FOUND' },
      });
    });

    it('marks all read and reports how many moved', async () => {
      repo.markAllRead.mockResolvedValue(3);
      await expect(service.markAllRead(doctor())).resolves.toEqual({ marked: 3 });
      expect(repo.markAllRead).toHaveBeenCalledWith({ kind: 'doctor', id: DOCTOR_ID }, expect.any(Date));
    });
  });

  /* ====================================================================== */

  describe('device tokens', () => {
    it('registers a patient token against the patient app', async () => {
      await expect(service.registerDevice(patient(), { pushToken: 'tok_9', deviceId: 'dev_1' })).resolves.toEqual({
        registered: true,
      });
      expect(devices.register).toHaveBeenCalledWith('patient', PATIENT_ID, { pushToken: 'tok_9', deviceId: 'dev_1' });
    });

    it('registers a doctor token against the doctor app', async () => {
      await service.registerDevice(doctor(), { pushToken: 'tok_9' });
      expect(devices.register).toHaveBeenCalledWith('doctor', DOCTOR_ID, { pushToken: 'tok_9', deviceId: undefined });
    });

    /**
     * `notifications.admin_id`: "admins have no push token". There is no
     * column to write it to and no Firebase project to send it from, so a 400
     * naming the reason beats silently accepting a token that can never be
     * used. Enforced in the SERVICE, not only by the controller's
     * `@AccountType`.
     */
    it('refuses an admin, because there is no admin push channel to register for', async () => {
      await expect(service.registerDevice(admin(), { pushToken: 'tok_9' })).rejects.toMatchObject({
        status: 400,
        response: { code: 'NOTIFICATION_DEVICE_TOKEN_NOT_SUPPORTED' },
      });
      expect(devices.register).not.toHaveBeenCalled();
    });

    it('404s when the account no longer exists', async () => {
      devices.register.mockResolvedValue(false);
      await expect(service.registerDevice(patient(), { pushToken: 'tok_9' })).rejects.toMatchObject({
        status: 404,
        response: { code: 'NOTIFICATION_NOT_FOUND' },
      });
    });

    it('clears the token on sign-out', async () => {
      await service.unregisterDevice(doctor());
      expect(devices.clearPushToken).toHaveBeenCalledWith('doctor', DOCTOR_ID);
    });

    it('refuses an admin unregister for the same reason it refuses the register', async () => {
      await expect(service.unregisterDevice(admin())).rejects.toMatchObject({
        response: { code: 'NOTIFICATION_DEVICE_TOKEN_NOT_SUPPORTED' },
      });
    });
  });

  /* ====================================================================== */

  /**
   * *** THE HANDLER THAT CATCHES EVERYTHING USED TO THROW. ***
   *
   * `notify`'s catch block builds its log line out of the caller's own
   * request, and INTERPOLATION IS ITSELF A THROWING OPERATION: `${x}` on a
   * symbol raises "Cannot convert a Symbol value to a string", and `String()`
   * on a null-prototype object or one with a throwing `toString` raises
   * "Cannot convert object to primitive value". Each of the three below was
   * observed escaping `notify` and reaching the caller — the exact failure
   * the method's own doc comment says must not happen.
   */
  describe('the failure handler is itself a place that can throw', () => {
    it('survives a templateCode that is a symbol', async () => {
      await expect(
        service.notify({ templateCode: Symbol('evil'), audience: { kind: 'patient', id: PATIENT_ID } } as never),
      ).resolves.toEqual({ queued: false, notificationId: null, reason: 'provider_unavailable' });
    });

    it('survives a templateCode whose toString throws', async () => {
      const hostile = {
        toString() {
          throw new Error('boom');
        },
      };
      await expect(
        service.notify({ templateCode: hostile, audience: { kind: 'patient', id: PATIENT_ID } } as never),
      ).resolves.toEqual({ queued: false, notificationId: null, reason: 'provider_unavailable' });
    });

    /** A dependency is free to reject with something that is not an `Error` — `fcm-push.classifier.ts` already guards this exact shape. */
    it('survives a dependency rejecting with a null-prototype object', async () => {
      templates.findTemplate.mockRejectedValue(Object.create(null));
      await expect(service.notify(bookingRequest())).resolves.toEqual({
        queued: false,
        notificationId: null,
        reason: 'provider_unavailable',
      });
    });

    /** Nothing about a failed log line may reach the caller. */
    it('survives a logger that throws', async () => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => {
        throw new Error('log sink down');
      });
      repo.insert.mockRejectedValue(new Error('deadlock detected'));

      await expect(service.notify(bookingRequest())).resolves.toEqual({
        queued: false,
        notificationId: null,
        reason: 'provider_unavailable',
      });
    });
  });

  /* ====================================================================== */

  /**
   * `variables: null` is not the same thing as no variables, and the
   * difference used to be an entire lost notification: `Object.keys(null)`
   * threw inside `renderTemplate` and `notify` reported
   * `provider_unavailable` with no row written.
   */
  describe('a caller who passes null variables', () => {
    it('still queues the notification, with the placeholders unresolved', async () => {
      const result = await service.notify({
        templateCode: 'booking_confirmed',
        audience: { kind: 'patient', id: PATIENT_ID },
        variables: null,
      } as never);

      expect(result).toEqual({ queued: true, notificationId: 41 });
      expect(repo.insert).toHaveBeenCalledWith(
        expect.objectContaining({ body: 'Your consultation with is confirmed for. Tap to see the details.' }),
      );
    });
  });

  /* ====================================================================== */

  /**
   * *** AN AUDIENCE KIND THIS MODULE CANNOT ROUTE MUST NOT BECOME A DOCTOR. ***
   *
   * `audience.kind` is three literals in the type system and nothing else
   * enforced it, so a fourth value fell through every `=== 'patient'` ternary
   * to the doctor side: a row with all three owner columns null, a token read
   * from `doctors`, and a push sent with the DOCTOR app's Firebase
   * credentials. M-13 binds to a MIRROR of this contract that this code
   * cannot see, which is exactly the seam a fourth value arrives through.
   */
  describe('an audience kind that is not one of the three', () => {
    const unroutable = () =>
      ({ templateCode: 'booking_confirmed', audience: { kind: 'nurse', id: 'n1' } }) as never;

    it('writes no row, reads no token and sends no push', async () => {
      const result = await service.notify(unroutable());

      expect(result).toEqual({ queued: false, notificationId: null, reason: 'provider_unavailable' });
      expect(repo.insert).not.toHaveBeenCalled();
      expect(devices.findPushToken).not.toHaveBeenCalled();
      expect(push.send).not.toHaveBeenCalled();
    });

    /**
     * `FcmPushAdapter.readCredentials` and `NotificationDeviceRepository`
     * both branch on `=== 'patient'`, so anything else that reaches them is
     * treated as a DOCTOR. The provider must never be asked about a key that
     * is not one of its two.
     */
    it('never hands an unroutable kind on to the push provider as an app key', async () => {
      await service.notify(unroutable());
      expect(push.isConfigured).not.toHaveBeenCalled();
      expect(push.send).not.toHaveBeenCalled();
    });

    it.each([[null], [undefined], [{}], [{ id: PATIENT_ID }]])(
      'refuses the malformed audience %s the same way',
      async (audience) => {
        const result = await service.notify({ templateCode: 'booking_confirmed', audience } as never);
        expect(result).toEqual({ queued: false, notificationId: null, reason: 'provider_unavailable' });
        expect(repo.insert).not.toHaveBeenCalled();
      },
    );
  });

  /* ====================================================================== */

  /**
   * FR-16.2 reaches the CODE as well as the copy. `template_code` is stored
   * on the row, put in the FCM `data` block and projected straight back to
   * the app by `notification.mapper.ts` — the same three properties that put
   * `deepLinkData` under the screen. `TEMPLATE_CODE_PATTERN` happily accepts
   * `you_have_diabetes`, and underscores normalise to spaces.
   */
  describe('FR-16.2 — the template code is part of the notification', () => {
    it('suppresses a notification whose CODE names a diagnosis, even with clean copy', async () => {
      templates.findTemplate.mockResolvedValue({ title: 'An update', body: 'Tap to open the app.' });

      const result = await service.notify({
        templateCode: 'you_have_diabetes',
        audience: { kind: 'patient', id: PATIENT_ID },
      });

      expect(result).toEqual({ queued: false, notificationId: null, reason: 'suppressed' });
      expect(repo.insert).not.toHaveBeenCalled();
      expect(push.send).not.toHaveBeenCalled();
    });

    it('leaves the nine shipped codes alone', async () => {
      for (const code of Object.keys(NOTIFICATION_TEMPLATE_DEFAULTS)) {
        expect(screenForDiagnosis(code)).toEqual({ clean: true, construction: null });
      }
    });
  });

  /* ====================================================================== */

  /**
   * *** A ROW THAT EXISTS MUST NOT BE REPORTED AS NEVER WRITTEN. ***
   *
   * `buildDataPayload` runs AFTER the insert, and `JSON.stringify` throws on
   * a circular structure and on a `BigInt`. That throw unwound into `notify`'s
   * handler, which answered `queued: false, notificationId: null` for a
   * notification that has a row — contradicting the contract's "`queued`
   * means A ROW WAS WRITTEN" and leaving that row stuck at `queued` with no
   * `failure_reason`.
   */
  describe('a deep-link payload that cannot be json-encoded', () => {
    const circular = () => {
      const payload: Record<string, unknown> = { screen: 'consultation' };
      payload.self = payload;
      return payload;
    };

    it('still reports the row it wrote', async () => {
      const result = await service.notify({ ...bookingRequest(), deepLinkData: circular() });
      expect(result).toEqual({ queued: true, notificationId: 41 });
    });

    it('drops the payload from the push envelope rather than losing the notification', async () => {
      await service.notify({ ...bookingRequest(), deepLinkData: circular() });

      expect(push.send).toHaveBeenCalledWith('patient', expect.objectContaining({ token: 'tok_1' }));
      expect(push.send.mock.calls[0]?.[1].data).not.toHaveProperty('deepLinkData');
      expect(repo.markSent).toHaveBeenCalledWith(41, expect.any(Date));
    });

    it('does the same for a BigInt, which JSON.stringify also refuses', async () => {
      const result = await service.notify({
        ...bookingRequest(),
        deepLinkData: { attempt: BigInt(1) },
      } as never);
      expect(result).toEqual({ queued: true, notificationId: 41 });
    });
  });

  /* ====================================================================== */

  /**
   * Re-reading an already-read notification KEEPS the first read's timestamp
   * (`notification.repository.ts`'s `coalesce`), so answering with this
   * method's own `new Date()` told the client the row said something it did
   * not.
   */
  describe('markRead reports the timestamp the row holds', () => {
    it('returns the stored readAt, not the one it proposed', async () => {
      const stored = new Date('2026-01-05T08:00:00Z');
      repo.markRead.mockResolvedValue(stored);

      const result = await service.markRead(patient(), 41);

      expect(result).toEqual({ id: 41, readAt: stored });
      expect(repo.markRead).toHaveBeenCalledWith(
        { kind: 'patient', id: PATIENT_ID },
        41,
        expect.any(Date),
      );
    });
  });
});
