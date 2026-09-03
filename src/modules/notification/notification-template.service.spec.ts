import type { Database } from '../../config/db/database.config';
import type { AppConfigService } from '../../shared/app-config/app-config.service';
import type { AuditService } from '../../shared/audit/audit.service';
import type { NotificationConfigRepository } from './notification-config.repository';
import { NotificationTemplateService } from './notification-template.service';
import { NOTIFICATION_TEMPLATE_DEFAULTS } from './notification.constants';

const ADMIN_ID = 'a0000000-0000-4000-8000-000000000001';
const KEY = 'notifications.templates';

const CUSTOM = { title: 'Booking done', body: 'You are booked with {{doctorName}}.' };

describe('NotificationTemplateService', () => {
  let repo: jest.Mocked<NotificationConfigRepository>;
  let appConfig: jest.Mocked<AppConfigService>;
  let audit: jest.Mocked<AuditService>;
  let db: Database;
  let service: NotificationTemplateService;
  let stored: Map<string, unknown>;

  beforeEach(() => {
    stored = new Map();

    const read = async (keys: readonly string[]) => {
      const result = new Map<string, unknown>();
      for (const key of keys) {
        if (stored.has(key)) result.set(key, stored.get(key));
      }
      return result;
    };

    repo = {
      findByKeys: jest.fn(read),
      findByKeysForUpdate: jest.fn(read),
      upsert: jest.fn(async (key: string, value: unknown) => {
        stored.set(key, value);
      }),
    } as unknown as jest.Mocked<NotificationConfigRepository>;

    appConfig = { invalidate: jest.fn() } as unknown as jest.Mocked<AppConfigService>;
    audit = { write: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<AuditService>;

    // The transaction is the identity function over a fake tx handle: these
    // are unit tests of the RULES, and the only thing the tests need from the
    // transaction is that the repository and the audit write both receive the
    // same executor.
    const tx = { __tx: true };
    db = { transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)) } as unknown as Database;

    service = new NotificationTemplateService(db, repo, appConfig, audit);
  });

  /* ====================================================================== */

  describe('getResolved', () => {
    /**
     * *** THE SEED IS NOT REQUIRED FOR CORRECTNESS. *** A fresh install sends
     * the right copy before `db:seed:notifications` has ever run, and a
     * hand-deleted row degrades to the default rather than silencing a booking
     * confirmation. Same discipline as `PAYMENT_CONFIG_FALLBACKS`.
     */
    it('falls back to the compiled-in copy for all nine codes when nothing is stored', async () => {
      expect(await service.getResolved()).toEqual(NOTIFICATION_TEMPLATE_DEFAULTS);
    });

    /**
     * MERGED, not either-or: a stored map carrying only the two templates an
     * admin has edited must still leave the other seven working.
     */
    it('lays stored copy OVER the defaults per code, leaving the rest intact', async () => {
      stored.set(KEY, { booking_confirmed: CUSTOM });
      const resolved = await service.getResolved();

      expect(resolved.booking_confirmed).toEqual(CUSTOM);
      expect(resolved.consult_reminder).toEqual(NOTIFICATION_TEMPLATE_DEFAULTS.consult_reminder);
      expect(Object.keys(resolved)).toHaveLength(9);
    });

    it('lets an admin add a code the schema does not name, so M-16/M-18 copy needs no release', async () => {
      stored.set(KEY, { followup_overdue: CUSTOM });
      const resolved = await service.getResolved();

      expect(resolved.followup_overdue).toEqual(CUSTOM);
      expect(Object.keys(resolved)).toHaveLength(10);
    });

    /** `app_config.value` is untyped jsonb, so a malformed row is not caught by the database. */
    it.each([['not an object'], [null], [42], [[]], [{ booking_confirmed: { title: 'no body' } }]])(
      'degrades a malformed stored value (%s) to the compiled-in copy',
      async (value) => {
        stored.set(KEY, value);
        expect(await service.getResolved()).toEqual(NOTIFICATION_TEMPLATE_DEFAULTS);
      },
    );

    it('reads the key in ONE query', async () => {
      await service.getResolved();
      expect(repo.findByKeys).toHaveBeenCalledTimes(1);
      expect(repo.findByKeys).toHaveBeenCalledWith([KEY]);
    });
  });

  describe('findTemplate', () => {
    it('resolves a known code', async () => {
      expect(await service.findTemplate('booking_confirmed')).toEqual(
        NOTIFICATION_TEMPLATE_DEFAULTS.booking_confirmed,
      );
    });

    it('returns null for an unknown code, which is the template_missing path', async () => {
      expect(await service.findTemplate('nope')).toBeNull();
    });

    /** Prototype safety — see `lookupTemplate`. Without it this would return a function. */
    it('returns null for an inherited property name', async () => {
      expect(await service.findTemplate('constructor')).toBeNull();
    });
  });

  describe('listForAdmin', () => {
    it('marks an unedited template as default and an edited one as custom, so the panel can offer a revert', async () => {
      stored.set(KEY, { booking_confirmed: CUSTOM });
      const list = await service.listForAdmin();

      expect(list.find((entry) => entry.code === 'booking_confirmed')).toMatchObject({ source: 'custom' });
      expect(list.find((entry) => entry.code === 'consult_reminder')).toMatchObject({ source: 'default' });
    });

    /** Derived from the copy, never stored — a stored list could drift from the copy it describes. */
    it('reports the placeholders each template declares', async () => {
      const list = await service.listForAdmin();
      expect(list.find((entry) => entry.code === 'booking_confirmed')?.variables).toEqual([
        'doctorName',
        'scheduledAt',
      ]);
      expect(list.find((entry) => entry.code === 'doctor_approved')?.variables).toEqual([]);
    });

    it('returns every template in force, sorted, not only the rows that exist', async () => {
      const list = await service.listForAdmin();
      expect(list).toHaveLength(9);
      expect(list.map((entry) => entry.code)).toEqual([...list.map((entry) => entry.code)].sort());
    });
  });

  /* ====================================================================== */

  describe('upsertTemplate', () => {
    it('stores the copy under the one key this module owns', async () => {
      await service.upsertTemplate(ADMIN_ID, 'booking_confirmed', CUSTOM);

      expect(repo.upsert).toHaveBeenCalledTimes(1);
      expect(repo.upsert).toHaveBeenCalledWith(KEY, expect.objectContaining({ booking_confirmed: CUSTOM }), {
        __tx: true,
      });
    });

    it('leaves the other templates alone', async () => {
      stored.set(KEY, { consult_reminder: CUSTOM });
      await service.upsertTemplate(ADMIN_ID, 'booking_confirmed', CUSTOM);

      expect(stored.get(KEY)).toEqual({ consult_reminder: CUSTOM, booking_confirmed: CUSTOM });
    });

    it('accepts a code the schema does not name — FR-16.3 is about copy changing without a release', async () => {
      await expect(service.upsertTemplate(ADMIN_ID, 'followup_overdue', CUSTOM)).resolves.toMatchObject({
        code: 'followup_overdue',
        source: 'custom',
      });
    });

    /**
     * *** WITHOUT THIS THE 30-SECOND MEMO KEEPS SERVING THE OLD COPY. ***
     * An admin correcting a typo would watch nothing happen for half a minute
     * — the exact failure `payment-config.service.ts` warns about for a GST
     * rate.
     */
    it('invalidates the AppConfigService memo for the key it wrote', async () => {
      await service.upsertTemplate(ADMIN_ID, 'booking_confirmed', CUSTOM);
      expect(appConfig.invalidate).toHaveBeenCalledWith(KEY);
      expect(appConfig.invalidate).toHaveBeenCalledTimes(1);
    });

    it('writes an audited BEFORE/AFTER naming which template moved', async () => {
      stored.set(KEY, { booking_confirmed: NOTIFICATION_TEMPLATE_DEFAULTS.booking_confirmed });

      await service.upsertTemplate(ADMIN_ID, 'booking_confirmed', CUSTOM);

      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({
          actorType: 'admin',
          actorId: ADMIN_ID,
          action: 'update',
          entityType: 'notification_config',
          // The KEY is the entity — `app_config` rows are identified by key.
          entityId: KEY,
          metadata: {
            templateCode: 'booking_confirmed',
            before: NOTIFICATION_TEMPLATE_DEFAULTS.booking_confirmed,
            after: CUSTOM,
          },
        }),
        { __tx: true },
      );
    });

    /** Before/after carry THAT ONE template, not the whole nine-entry map — a diff of nine to show a one-word edit is a diff nobody reads. */
    it('records a null before for a template that had no stored copy', async () => {
      await service.upsertTemplate(ADMIN_ID, 'booking_confirmed', CUSTOM);
      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: { templateCode: 'booking_confirmed', before: null, after: CUSTOM } }),
        expect.anything(),
      );
    });

    /** Transactional with the write it audits — a change to what a patient is told must never exist un-audited. */
    it('writes the config and the audit entry in ONE transaction, with the same executor', async () => {
      await service.upsertTemplate(ADMIN_ID, 'booking_confirmed', CUSTOM);

      expect(db.transaction).toHaveBeenCalledTimes(1);
      expect(repo.upsert.mock.calls[0]?.[2]).toBe(audit.write.mock.calls[0]?.[1]);
    });

    /**
     * The whole map lives under one key, so editing one template is a
     * read-modify-write of nine. Two admins editing two DIFFERENT templates
     * would otherwise have the later write silently discard the earlier one.
     */
    it('takes a row lock for the read-modify-write, not a plain read', async () => {
      await service.upsertTemplate(ADMIN_ID, 'booking_confirmed', CUSTOM);
      expect(repo.findByKeysForUpdate).toHaveBeenCalledWith([KEY], { __tx: true });
    });

    it('returns the saved template with its declared variables', async () => {
      await expect(service.upsertTemplate(ADMIN_ID, 'booking_confirmed', CUSTOM)).resolves.toEqual({
        code: 'booking_confirmed',
        ...CUSTOM,
        source: 'custom',
        variables: ['doctorName'],
      });
    });
  });

  /* ====================================================================== */

  /**
   * *** FR-16.2, AT WRITE TIME. ***
   *
   * This is where over-blocking is CHEAP: the admin sees a 409 naming the
   * offending construction and re-words. The send-time half
   * (`notification.service.spec.ts`) is where suppression is silent and
   * costly, which is why both exist.
   */
  describe('FR-16.2 — copy that names a diagnosis is refused', () => {
    it.each([
      ['Your diabetes review is due'],
      ['Your diagnosis is ready'],
      ['You may have something to discuss'],
      ['Your HIV result is available'],
    ])('refuses a body of "%s" with a 409 and the construction named', async (body) => {
      await expect(
        service.upsertTemplate(ADMIN_ID, 'booking_confirmed', { title: 'Update', body }),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: 'NOTIFICATION_TEMPLATE_NAMES_DIAGNOSIS' },
      });
    });

    it('refuses a diagnosis in the TITLE as well as the body', async () => {
      await expect(
        service.upsertTemplate(ADMIN_ID, 'booking_confirmed', { title: 'Your cancer result', body: 'Tap to open.' }),
      ).rejects.toMatchObject({ response: { code: 'NOTIFICATION_TEMPLATE_NAMES_DIAGNOSIS' } });
    });

    /** An admin who cannot see WHICH word was refused will retry the same sentence with a comma moved. */
    it('names the offending construction and the field in the message', async () => {
      await expect(
        service.upsertTemplate(ADMIN_ID, 'booking_confirmed', { title: 'Update', body: 'Your diabetes review' }),
      ).rejects.toMatchObject({
        response: { message: expect.stringContaining('diabet*') as never },
      });
    });

    /** *** NOTHING IS WRITTEN AND NOTHING IS AUDITED. *** A rejected edit leaves the stored map exactly as it was. */
    it('writes nothing, audits nothing and invalidates nothing when it refuses', async () => {
      await expect(
        service.upsertTemplate(ADMIN_ID, 'booking_confirmed', { title: 'Update', body: 'Your diabetes review' }),
      ).rejects.toBeDefined();

      expect(repo.upsert).not.toHaveBeenCalled();
      expect(audit.write).not.toHaveBeenCalled();
      expect(appConfig.invalidate).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('accepts copy that names no diagnosis', async () => {
      await expect(
        service.upsertTemplate(ADMIN_ID, 'prescription_ready', {
          title: 'Your prescription is ready',
          body: 'Tap to open it in the app.',
        }),
      ).resolves.toBeDefined();
    });
  });

  /* ====================================================================== */

  describe('shape validation', () => {
    it.each([
      [{ title: '', body: 'b' }],
      [{ title: '   ', body: 'b' }],
      [{ title: 't', body: '' }],
      [{ title: 'x'.repeat(201), body: 'b' }],
      [{ title: 't', body: 'x'.repeat(2001) }],
      [{ title: 1 as unknown as string, body: 'b' }],
    ])('refuses the malformed template %s', async (template) => {
      await expect(service.upsertTemplate(ADMIN_ID, 'booking_confirmed', template)).rejects.toMatchObject({
        status: 400,
        response: { code: 'NOTIFICATION_TEMPLATE_INVALID' },
      });
      expect(repo.upsert).not.toHaveBeenCalled();
    });

    /** `notifications.title` is `varchar(200)` — one under and one over. */
    it('accepts a title of exactly 200 characters and refuses 201', async () => {
      await expect(
        service.upsertTemplate(ADMIN_ID, 'booking_confirmed', { title: 'x'.repeat(200), body: 'b' }),
      ).resolves.toBeDefined();
      await expect(
        service.upsertTemplate(ADMIN_ID, 'booking_confirmed', { title: 'x'.repeat(201), body: 'b' }),
      ).rejects.toBeDefined();
    });

    it.each([['ab'], ['1abc'], ['Booking_Confirmed'], ['booking-confirmed'], ['__proto__'], ['']])(
      'refuses the illegal template code %s',
      async (code) => {
        await expect(service.upsertTemplate(ADMIN_ID, code, CUSTOM)).rejects.toMatchObject({
          status: 400,
          response: { code: 'NOTIFICATION_TEMPLATE_CODE_INVALID' },
        });
      },
    );
  });

  /* ====================================================================== */

  /**
   * *** THE MIRROR IMAGE OF search-config.service.ts's RULE. ***
   *
   * That file's own comment says an admin holding `SEARCH_MANAGE_MAPPING`
   * "must not be able to reach `payments.gst_pct` through this endpoint
   * because both happen to live in one table." The same must hold here: an
   * admin holding `content.manage_notification_templates` must not be able to
   * reach `search.crisis_keywords` and switch off the safety guardrail.
   */
  describe('the owned-key allow-list', () => {
    it.each([
      ['search.crisis_keywords'],
      ['search.ai_enabled'],
      ['payments.gst_rate'],
      ['otp.request.max_per_number_per_hour'],
      ['notifications.something_else'],
      [''],
    ])('refuses the foreign key %s', (key) => {
      const foreign = service as unknown as { assertOwnedKey(k: string): void };
      expect(() => foreign.assertOwnedKey(key)).toThrow(
        expect.objectContaining({
          status: 400,
          response: expect.objectContaining({ code: 'NOTIFICATION_CONFIG_KEY_NOT_OWNED' }),
        }) as never,
      );
    });

    it('accepts the one key this module owns', () => {
      const foreign = service as unknown as { assertOwnedKey(k: string): void };
      expect(() => foreign.assertOwnedKey(KEY)).not.toThrow();
    });

    it('never writes a foreign key even for a template code that looks like one', async () => {
      await service.upsertTemplate(ADMIN_ID, 'search_crisis_keywords', CUSTOM);
      for (const [key] of repo.upsert.mock.calls) {
        expect(key).toBe(KEY);
      }
    });
  });

  /* ====================================================================== */

  describe('deleteTemplate', () => {
    it('reverts one of the nine schema-named codes to its compiled-in default', async () => {
      stored.set(KEY, { booking_confirmed: CUSTOM });

      await expect(service.deleteTemplate(ADMIN_ID, 'booking_confirmed')).resolves.toEqual({
        code: 'booking_confirmed',
        ...NOTIFICATION_TEMPLATE_DEFAULTS.booking_confirmed,
        source: 'default',
        variables: ['doctorName', 'scheduledAt'],
      });
      expect(stored.get(KEY)).toEqual({});
    });

    it('returns null for an admin-added code, which has no default to fall back to', async () => {
      stored.set(KEY, { followup_overdue: CUSTOM });
      await expect(service.deleteTemplate(ADMIN_ID, 'followup_overdue')).resolves.toBeNull();
    });

    it('audits the copy that was removed and the default that takes over, so a revert is as reversible as an edit', async () => {
      stored.set(KEY, { booking_confirmed: CUSTOM });
      await service.deleteTemplate(ADMIN_ID, 'booking_confirmed');

      expect(audit.write).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'delete',
          entityType: 'notification_config',
          entityId: KEY,
          metadata: {
            templateCode: 'booking_confirmed',
            before: CUSTOM,
            after: NOTIFICATION_TEMPLATE_DEFAULTS.booking_confirmed,
          },
        }),
        expect.anything(),
      );
    });

    it('invalidates the memo', async () => {
      stored.set(KEY, { booking_confirmed: CUSTOM });
      await service.deleteTemplate(ADMIN_ID, 'booking_confirmed');
      expect(appConfig.invalidate).toHaveBeenCalledWith(KEY);
    });

    it('404s when there is no stored copy to remove, rather than silently succeeding', async () => {
      await expect(service.deleteTemplate(ADMIN_ID, 'booking_confirmed')).rejects.toMatchObject({
        status: 404,
        response: { code: 'NOTIFICATION_TEMPLATE_NOT_FOUND' },
      });
      expect(appConfig.invalidate).not.toHaveBeenCalled();
    });

    it('leaves the other stored templates alone', async () => {
      stored.set(KEY, { booking_confirmed: CUSTOM, consult_reminder: CUSTOM });
      await service.deleteTemplate(ADMIN_ID, 'booking_confirmed');
      expect(stored.get(KEY)).toEqual({ consult_reminder: CUSTOM });
    });
  });

  /* ====================================================================== */

  /**
   * *** M-08'S DONE-WHEN: "COPY CHANGES NEED NO APP RELEASE." ***
   *
   * The end-to-end proof, in one test: an admin edits the copy, and the very
   * next resolution — the read `notify` makes — returns the new wording. No
   * restart, no deploy, no client update.
   */
  describe('copy changes need no app release', () => {
    it('an admin edit is visible to the next send', async () => {
      expect((await service.findTemplate('booking_confirmed'))?.body).toBe(
        NOTIFICATION_TEMPLATE_DEFAULTS.booking_confirmed.body,
      );

      await service.upsertTemplate(ADMIN_ID, 'booking_confirmed', {
        title: 'Booking done',
        body: 'See you at {{scheduledAt}}.',
      });

      expect((await service.findTemplate('booking_confirmed'))?.body).toBe('See you at {{scheduledAt}}.');
      // ...and the memo the READ path uses was dropped, so it is not still
      // serving the previous wording for another 30 seconds.
      expect(appConfig.invalidate).toHaveBeenCalledWith(KEY);
    });
  });
});
