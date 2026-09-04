import type { NotificationService } from './notification.service';
import { NotificationFacade } from './notification.facade';

/* ==========================================================================
 * *** M-13'S MIRROR, COPIED VERBATIM. ***
 *
 * M-13 (presence and instant consult) is being built in a parallel worktree
 * against its own local declaration of this port, bound to its own
 * `NOTIFICATION_PORT` token with a null object. It cannot see this module's
 * code, so the only thing keeping the two in step is that `NotificationFacade`
 * satisfies the shape STRUCTURALLY — no adapter, no cast.
 *
 * The block below is that declaration, pasted as M-13 wrote it and
 * deliberately NOT imported from `notification.contract.ts`. Importing would
 * make this test tautological: it would assert the facade matches its own
 * contract, which `implements` already does, rather than that it matches the
 * INDEPENDENT copy M-13 holds. A field renamed or an argument added on either
 * side fails here, at `tsc`, instead of at runtime after both merge.
 * ======================================================================== */

interface MirroredNotificationRequest {
  /** e.g. 'instant_request'. Resolved against the admin-editable template set. */
  templateCode: string;
  audience: { kind: 'patient' | 'doctor' | 'admin'; id: string };
  /** Substituted into the template. MUST NOT carry a diagnosis (FR-16.2). */
  variables?: Record<string, string | number>;
  consultationId?: string;
  deepLinkData?: Record<string, unknown>;
}

interface MirroredNotificationResult {
  queued: boolean;
  /** `notifications.id` is bigserial. Null when nothing was queued. */
  notificationId: number | null;
  /** Why not: 'no_device_token' | 'template_missing' | 'provider_unavailable' | 'suppressed'. */
  reason?: string;
}

interface MirroredNotificationContract {
  /** Best-effort. MUST NOT throw into the caller's flow — a failed notification never fails a consult. */
  notify(request: MirroredNotificationRequest): Promise<MirroredNotificationResult>;
}

/* ========================================================================= */

describe('NotificationFacade', () => {
  let notifications: jest.Mocked<NotificationService>;
  let facade: NotificationFacade;

  beforeEach(() => {
    notifications = {
      notify: jest.fn().mockResolvedValue({ queued: true, notificationId: 41 }),
      countNotificationsForPatient: jest.fn().mockResolvedValue(0),
    } as unknown as jest.Mocked<NotificationService>;

    facade = new NotificationFacade(notifications);
  });

  describe('the frozen port M-13 mirrors blind', () => {
    /**
     * *** THE ASSIGNMENT IS THE TEST. ***
     *
     * This is what M-13's `{ provide: NOTIFICATION_PORT, useExisting:
     * NotificationFacade }` does at its own DI layer. If the two shapes ever
     * diverge, this line stops compiling and `npx tsc --noEmit` fails — which
     * is exactly the failure mode we want, because M-13's own build would
     * otherwise be the first place anyone found out.
     */
    it('satisfies M-13-s independently declared contract structurally, with no adapter and no cast', () => {
      const port: MirroredNotificationContract = facade;
      expect(typeof port.notify).toBe('function');
    });

    /** And in the other direction: a request built to M-13's declaration is accepted by ours. */
    it('accepts a request built against M-13-s declaration', async () => {
      const request: MirroredNotificationRequest = {
        templateCode: 'instant_request',
        audience: { kind: 'doctor', id: 'd0000000-0000-4000-8000-000000000001' },
        variables: { expiresInSeconds: 45 },
        consultationId: 'c0000000-0000-4000-8000-000000000001',
        deepLinkData: { screen: 'instant-request' },
      };

      const result: MirroredNotificationResult = await (facade as MirroredNotificationContract).notify(request);
      expect(result).toEqual({ queued: true, notificationId: 41 });
    });

    /** `notificationId` is a NUMBER, because `notifications.id` is bigserial — not a uuid string like every other id on the platform. */
    it('returns a numeric notificationId, matching the bigserial column', async () => {
      const result = await facade.notify({
        templateCode: 'booking_confirmed',
        audience: { kind: 'patient', id: 'p0000000-0000-4000-8000-000000000001' },
      });
      expect(typeof result.notificationId).toBe('number');
    });

    it('returns a null notificationId when nothing was queued', async () => {
      notifications.notify.mockResolvedValue({ queued: false, notificationId: null, reason: 'template_missing' });
      await expect(
        facade.notify({ templateCode: 'nope', audience: { kind: 'patient', id: 'p1' } }),
      ).resolves.toEqual({ queued: false, notificationId: null, reason: 'template_missing' });
    });
  });

  describe('delegation', () => {
    /** Thin by design — every rule lives in `NotificationService`, so the facade must not add one. */
    it('passes the request through untouched', async () => {
      const request = {
        templateCode: 'booking_confirmed',
        audience: { kind: 'patient' as const, id: 'p1' },
        variables: { doctorName: 'Dr Rao' },
      };

      await facade.notify(request);
      expect(notifications.notify).toHaveBeenCalledTimes(1);
      expect(notifications.notify).toHaveBeenCalledWith(request);
    });

    it('returns the service-s result untouched', async () => {
      notifications.notify.mockResolvedValue({ queued: true, notificationId: 7, reason: 'no_device_token' });
      await expect(facade.notify({ templateCode: 'x', audience: { kind: 'doctor', id: 'd1' } })).resolves.toEqual({
        queued: true,
        notificationId: 7,
        reason: 'no_device_token',
      });
    });
  });

  /**
   * *** M-21 CALLS THIS. *** A pure row count for a patient data-deletion
   * preview — see `notification.contract.ts#NotificationContract.countNotificationsForPatient`.
   * Nothing here writes, and it does not touch the three frozen M-13 interfaces.
   */
  describe('the M-21 data-rights row count', () => {
    it('delegates to the service', async () => {
      notifications.countNotificationsForPatient.mockResolvedValue(6);

      await expect(facade.countNotificationsForPatient('p1')).resolves.toBe(6);
      expect(notifications.countNotificationsForPatient).toHaveBeenCalledWith('p1');
    });
  });

  /**
   * The facade exposes `notify` and the M-21 row count, and nothing else.
   * The in-app inbox and device registration are HTTP surfaces for the apps
   * themselves, not something another MODULE calls — a module that could
   * reach them could read another account's notifications, and M-08's
   * done-when is a structural property of this surface rather than a
   * convention.
   */
  it('exposes notify, the M-21 count, and nothing else', () => {
    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(facade) as object).filter(
      (name) => name !== 'constructor',
    );
    expect(surface.sort()).toEqual(['countNotificationsForPatient', 'notify']);
  });
});
