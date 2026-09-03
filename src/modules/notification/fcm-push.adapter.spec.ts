/**
 * *** NO NETWORK CALL IS MADE ANYWHERE IN THIS FILE. ***
 *
 * `firebase-admin/app` and `firebase-admin/messaging` are both replaced with
 * hand-rolled `jest.fn()`s, following `identity-otp.service.spec.ts`'s
 * treatment of `@synquic/slide` — mock only the constructor/entry points that
 * would talk to a vendor, and keep everything else real.
 *
 * `getEnv` is mocked for the same reason that file gives: the adapter reads it
 * per call, and the real boot-time validation would `process.exit(1)` and kill
 * the jest worker when the FCM variables are absent — which is precisely the
 * state most of these tests want to put it in.
 *
 * *** WHAT THIS FILE CANNOT PROVE. *** That a message actually arrives on a
 * phone. There are no real FCM credentials in this repo and no Firebase
 * project to point at, so every assertion below is about what the adapter
 * ASKS the SDK to do — which app it initialises, under which name, with which
 * credential, and what it does when the SDK refuses. Real delivery is
 * untested and stated as such in the module's report.
 */

const initializeApp = jest.fn();
const getApps = jest.fn();
const cert = jest.fn();
const send = jest.fn();
const getMessaging = jest.fn();

jest.mock('firebase-admin/app', () => ({
  initializeApp: (...args: unknown[]) => initializeApp(...args),
  getApps: () => getApps(),
  cert: (...args: unknown[]) => cert(...args),
}));

jest.mock('firebase-admin/messaging', () => ({
  getMessaging: (...args: unknown[]) => getMessaging(...args),
}));

const env: Record<string, string | undefined> = {};

jest.mock('../../config/env/env.validation', () => ({
  ...jest.requireActual('../../config/env/env.validation'),
  getEnv: () => env,
}));

// Imported after the mocks, so the adapter binds to them.
import { REQUIRED_ENV_KEYS } from '../../config/env/env.validation';
import { FcmPushAdapter, normalizePrivateKey } from './fcm-push.adapter';

const PATIENT_ENV = {
  FCM_PATIENT_PROJECT_ID: 'patient-project',
  FCM_PATIENT_CLIENT_EMAIL: 'patient@example.iam.gserviceaccount.com',
  FCM_PATIENT_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nAAAA\\n-----END PRIVATE KEY-----\\n',
};

const DOCTOR_ENV = {
  FCM_DOCTOR_PROJECT_ID: 'doctor-project',
  FCM_DOCTOR_CLIENT_EMAIL: 'doctor@example.iam.gserviceaccount.com',
  FCM_DOCTOR_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nBBBB\\n-----END PRIVATE KEY-----\\n',
};

function setEnv(values: Record<string, string | undefined>): void {
  for (const key of Object.keys(env)) delete env[key];
  Object.assign(env, values);
}

const MESSAGE = { token: 'tok_1', title: 'Appointment confirmed', body: 'Tap to see the details.' };

describe('FcmPushAdapter', () => {
  let adapter: FcmPushAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    setEnv({});
    getApps.mockReturnValue([]);
    initializeApp.mockImplementation((_options: unknown, name: string) => ({ name }));
    cert.mockImplementation((options: unknown) => ({ cert: options }));
    getMessaging.mockReturnValue({ send });
    send.mockResolvedValue('projects/p/messages/1');
    adapter = new FcmPushAdapter();
  });

  /* ====================================================================== */

  describe('an unconfigured deployment', () => {
    /**
     * *** THE PROPERTY THE BRIEF ASKS FOR, AT THE ENV LAYER. ***
     *
     * `validateEnv` exits the process on a REQUIRED variable that is missing,
     * so the only way a missing FCM credential can be guaranteed not to crash
     * boot is for none of the six to be required. Asserted here rather than in
     * `env.validation.spec.ts` so the guarantee lives beside the code that
     * depends on it.
     */
    it.each([
      ['FCM_PATIENT_PROJECT_ID'],
      ['FCM_PATIENT_CLIENT_EMAIL'],
      ['FCM_PATIENT_PRIVATE_KEY'],
      ['FCM_DOCTOR_PROJECT_ID'],
      ['FCM_DOCTOR_CLIENT_EMAIL'],
      ['FCM_DOCTOR_PRIVATE_KEY'],
    ])('%s is NOT a required environment variable, so its absence cannot stop the server booting', (key) => {
      expect(REQUIRED_ENV_KEYS).not.toContain(key);
    });

    it('reports both apps unconfigured when no credentials are set', () => {
      expect(adapter.isConfigured('patient')).toBe(false);
      expect(adapter.isConfigured('doctor')).toBe(false);
      expect(adapter.configuredApps()).toEqual([]);
    });

    /** A capability check, not a live probe: `isConfigured` must not initialise anything. */
    it('does not touch the SDK to answer isConfigured', () => {
      adapter.isConfigured('patient');
      expect(initializeApp).not.toHaveBeenCalled();
      expect(getApps).not.toHaveBeenCalled();
    });

    /**
     * *** "QUEUED BUT NOT DELIVERED", AT THE ADAPTER LAYER. ***
     * `send` RETURNS a failure rather than throwing, so the service can record
     * a row and a `failure_reason` instead of losing the notification.
     */
    it('returns a not_configured failure instead of throwing', async () => {
      const result = await adapter.send('patient', MESSAGE);

      expect(result).toEqual({
        delivered: false,
        failure: { kind: 'not_configured', detail: 'FCM is not configured for the patient app' },
      });
      expect(send).not.toHaveBeenCalled();
    });

    it('does not attempt to initialise an app it has no credentials for', async () => {
      await adapter.send('patient', MESSAGE);
      expect(initializeApp).not.toHaveBeenCalled();
    });

    it.each([
      ['project id', { ...PATIENT_ENV, FCM_PATIENT_PROJECT_ID: undefined }],
      ['client email', { ...PATIENT_ENV, FCM_PATIENT_CLIENT_EMAIL: undefined }],
      ['private key', { ...PATIENT_ENV, FCM_PATIENT_PRIVATE_KEY: undefined }],
    ])('treats a partial credential (missing %s) as unconfigured rather than half-initialising', (_label, partial) => {
      setEnv(partial);
      expect(adapter.isConfigured('patient')).toBe(false);
    });

    it('treats an empty-string credential as absent', () => {
      setEnv({ ...PATIENT_ENV, FCM_PATIENT_PRIVATE_KEY: '' });
      expect(adapter.isConfigured('patient')).toBe(false);
    });
  });

  /* ====================================================================== */

  describe('one app configured and the other not', () => {
    /**
     * `docs/MODULES.md` M-08 puts the patient and doctor apps on separate
     * credentials, and this is the consequence worth testing: a deployment
     * that has only shipped the patient app must be able to send to patients
     * while doctors degrade. Same posture as the optional S3/Cloudinary pairs.
     */
    beforeEach(() => setEnv({ ...PATIENT_ENV }));

    it('reports only the configured app', () => {
      expect(adapter.configuredApps()).toEqual(['patient']);
    });

    it('delivers to the configured app', async () => {
      await expect(adapter.send('patient', MESSAGE)).resolves.toEqual({
        delivered: true,
        messageId: 'projects/p/messages/1',
      });
    });

    it('degrades the unconfigured one without affecting the other', async () => {
      await expect(adapter.send('doctor', MESSAGE)).resolves.toMatchObject({
        delivered: false,
        failure: { kind: 'not_configured' },
      });
      await expect(adapter.send('patient', MESSAGE)).resolves.toMatchObject({ delivered: true });
    });
  });

  /* ====================================================================== */

  describe('named multi-app initialisation', () => {
    beforeEach(() => setEnv({ ...PATIENT_ENV, ...DOCTOR_ENV }));

    /**
     * *** TWO STORE LISTINGS, TWO FIREBASE PROJECTS, TWO NAMED APPS. ***
     * `firebase-admin`'s `initializeApp(options, name)` is what makes that
     * possible in one process.
     */
    it('initialises a separate named app per audience, each with its own credential', async () => {
      await adapter.send('patient', MESSAGE);
      await adapter.send('doctor', MESSAGE);

      expect(initializeApp).toHaveBeenCalledTimes(2);
      expect(initializeApp).toHaveBeenNthCalledWith(1, expect.anything(), 'notification-patient');
      expect(initializeApp).toHaveBeenNthCalledWith(2, expect.anything(), 'notification-doctor');

      expect(cert).toHaveBeenNthCalledWith(1, expect.objectContaining({ projectId: 'patient-project' }));
      expect(cert).toHaveBeenNthCalledWith(2, expect.objectContaining({ projectId: 'doctor-project' }));
    });

    /**
     * The DEFAULT app is never used. Any other library in this process that
     * calls `initializeApp()` with no name takes that slot, and sharing it
     * would make delivery depend on module load order.
     */
    it('never initialises the default (unnamed) app', async () => {
      await adapter.send('patient', MESSAGE);
      for (const call of initializeApp.mock.calls) {
        expect(call[1]).toMatch(/^notification-/);
      }
    });

    it('sends through the app that matches the audience, not a shared one', async () => {
      await adapter.send('doctor', MESSAGE);
      expect(getMessaging).toHaveBeenCalledWith({ name: 'notification-doctor' });
    });

    /** Lazy and memoized: initialising is not free, and `initializeApp` throws on a duplicate name. */
    it('initialises once and reuses the app on later sends', async () => {
      await adapter.send('patient', MESSAGE);
      await adapter.send('patient', MESSAGE);
      await adapter.send('patient', MESSAGE);

      expect(initializeApp).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledTimes(3);
    });

    it('is lazy — constructing the adapter initialises nothing', () => {
      new FcmPushAdapter();
      expect(initializeApp).not.toHaveBeenCalled();
    });

    /**
     * `nest start --watch` re-instantiates providers in the same process, so
     * the app this adapter registered last time is still there.
     * `initializeApp` throws on a duplicate name, and that throw would
     * otherwise be misread as a credential failure.
     */
    it('reuses an app the process already registered under that name, rather than initialising a duplicate', async () => {
      const existing = { name: 'notification-patient' };
      getApps.mockReturnValue([{ name: '[DEFAULT]' }, existing]);

      await adapter.send('patient', MESSAGE);

      expect(initializeApp).not.toHaveBeenCalled();
      expect(getMessaging).toHaveBeenCalledWith(existing);
    });
  });

  /* ====================================================================== */

  describe('sending', () => {
    beforeEach(() => setEnv({ ...PATIENT_ENV }));

    it('passes the copy as an FCM notification block and the payload as data', async () => {
      await adapter.send('patient', { ...MESSAGE, data: { notificationId: '41', templateCode: 'booking_confirmed' } });

      expect(send).toHaveBeenCalledWith({
        token: 'tok_1',
        notification: { title: 'Appointment confirmed', body: 'Tap to see the details.' },
        data: { notificationId: '41', templateCode: 'booking_confirmed' },
      });
    });

    it('omits the data block entirely when there is none, rather than sending an empty one', async () => {
      await adapter.send('patient', MESSAGE);
      expect(send).toHaveBeenCalledWith(expect.not.objectContaining({ data: expect.anything() }));
    });

    /** *** NEVER THROWS. *** Every vendor failure comes back classified. */
    it('classifies a rejected send instead of throwing', async () => {
      send.mockRejectedValue(
        Object.assign(new Error('Requested entity was not found.'), {
          code: 'messaging/registration-token-not-registered',
        }),
      );

      await expect(adapter.send('patient', MESSAGE)).resolves.toEqual({
        delivered: false,
        failure: { kind: 'unregistered_token', detail: 'Requested entity was not found.' },
      });
    });

    it('classifies an unrecognised rejection as unknown rather than letting it escape', async () => {
      send.mockRejectedValue('a bare string');
      await expect(adapter.send('patient', MESSAGE)).resolves.toMatchObject({
        delivered: false,
        failure: { kind: 'unknown' },
      });
    });
  });

  /* ====================================================================== */

  describe('a malformed credential', () => {
    beforeEach(() => {
      setEnv({ ...PATIENT_ENV, FCM_PATIENT_PRIVATE_KEY: 'not a pem' });
      cert.mockImplementation(() => {
        throw new Error('Failed to parse private key: Error: Invalid PEM formatted message.');
      });
    });

    /**
     * *** THIS IS WHY `env.validation.ts` DOES NOT REGEX-CHECK THE KEY. ***
     * `validateEnv` exits the process on a value that is present but invalid,
     * so a PEM check there would turn one mistyped key into a server that will
     * not start. Notifications are the least critical thing this server does
     * and must not be able to take down consultations, payments or sign-in —
     * so the failure lands here instead, as one degraded audience.
     */
    it('degrades to not_configured instead of throwing', async () => {
      await expect(adapter.send('patient', MESSAGE)).resolves.toMatchObject({
        delivered: false,
        failure: { kind: 'not_configured' },
      });
    });

    /** Retrying a malformed service account on every notification turns one mistake into a log flood, and the outcome cannot change without a restart. */
    it('memoizes the failure and does not retry the initialisation on every send', async () => {
      await adapter.send('patient', MESSAGE);
      await adapter.send('patient', MESSAGE);
      await adapter.send('patient', MESSAGE);

      expect(cert).toHaveBeenCalledTimes(1);
    });
  });

  /* ====================================================================== */

  describe('normalizePrivateKey', () => {
    /**
     * *** THE COMMONEST FCM MISCONFIGURATION. *** A service-account private
     * key is a multi-line PEM, and a `.env` file cannot hold a raw newline in
     * an unquoted value, so every deployment guide ships it with literal
     * backslash-n.
     */
    it('unescapes literal backslash-n into real newlines', () => {
      expect(normalizePrivateKey('-----BEGIN-----\\nAAAA\\n-----END-----')).toBe(
        '-----BEGIN-----\nAAAA\n-----END-----',
      );
    });

    it('leaves a key that already has real newlines alone', () => {
      const real = '-----BEGIN-----\nAAAA\n-----END-----';
      expect(normalizePrivateKey(real)).toBe(real);
    });

    /** A quoted PEM is not a PEM; some dotenv/secret-manager paths keep the quotes. */
    it.each([['"'], ["'"]])('strips surrounding %s quotes', (quote) => {
      expect(normalizePrivateKey(`${quote}-----BEGIN-----\\nAAAA${quote}`)).toBe('-----BEGIN-----\nAAAA');
    });

    it('does not strip a quote that appears only on one side', () => {
      expect(normalizePrivateKey('"abc')).toBe('abc');
      expect(normalizePrivateKey('abc"')).toBe('abc');
    });

    it('passes the unescaped key to cert(), not the raw environment string', async () => {
      setEnv({ ...PATIENT_ENV });
      const adapterUnderTest = new FcmPushAdapter();
      await adapterUnderTest.send('patient', MESSAGE);

      expect(cert).toHaveBeenCalledWith(
        expect.objectContaining({ privateKey: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n' }),
      );
    });
  });
});
