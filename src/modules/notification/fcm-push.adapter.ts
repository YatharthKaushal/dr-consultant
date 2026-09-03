import { Injectable, Logger } from '@nestjs/common';
import { cert, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { getEnv } from '../../config/env/env.validation';
import { FcmPushClassifier } from './fcm-push.classifier';
import {
  PUSH_APP_KEYS,
  type PushAppKey,
  type PushErrorClassifier,
  type PushMessage,
  type PushProvider,
  type PushSendResult,
} from './notification-push.types';

/**
 * `firebase-admin@14.3.0` — Firebase Cloud Messaging, and through it APNs.
 *
 * *** ONE SDK COVERS BOTH PLATFORMS. *** FCM delivers to iOS by forwarding to
 * APNs on Google's side, so there is no second APNs integration here.
 * `docs/MODULES.md` M-08 lists "push through Firebase Cloud Messaging and
 * APNs" as one feature, and this is it: an APNs key uploaded to the Firebase
 * console, not a second client in this repo. The one visible consequence is
 * that an APNs credential problem arrives as
 * `messaging/third-party-auth-error` — see `fcm-push.classifier.ts`.
 *
 * ===========================================================================
 * *** NAMED MULTI-APP INITIALISATION. ***
 *
 * `docs/MODULES.md` M-08: "Separate push credentials per app, since the
 * patient and doctor apps are separate store listings." Two store listings
 * means two Firebase projects, two service accounts and two sets of device
 * tokens that are NOT interchangeable — a patient-app token is meaningless to
 * the doctor project and is rejected with `messaging/mismatched-credential`.
 *
 * `firebase-admin` supports this natively: `initializeApp(options, name)`
 * registers a NAMED app alongside the default one, and `getMessaging(app)`
 * takes the instance. So this adapter holds up to two `App`s and resolves
 * which one to use from the audience — `notification.service.ts` maps
 * `audience.kind` to a `PushAppKey`, and nothing above that ever learns there
 * are two credentials at all.
 *
 * The names are prefixed (`notification-patient`, `notification-doctor`)
 * rather than bare, and the DEFAULT app is deliberately never used: any other
 * library in this process that calls `initializeApp()` with no name takes the
 * default slot, and sharing it would make delivery depend on module load
 * order.
 * ===========================================================================
 *
 * *** AN UNCONFIGURED APP IS NOT AN ERROR. *** All six environment variables
 * are optional (`env.validation.ts`), exactly like the S3/Cloudinary pairs
 * and unlike `AI_CREDENTIAL_ENCRYPTION_KEY`. A deployment may legitimately
 * run with only the patient app configured, or with neither — early
 * development, a staging box, or the test suite. Missing credentials make
 * push unavailable for that audience and nothing else: no boot failure, no
 * throw, and a `notifications` row is still written so the in-app
 * notification and the panel are unaffected. That is the "queued but not
 * delivered" degradation, and `notification.service.ts` records it in
 * `failure_reason`.
 */

/** Prefix so these can never collide with a default app another library initialises. */
const APP_NAME_PREFIX = 'notification';

/** Per-app-key environment credentials. All three must be present for that app to be usable. */
interface FcmCredentials {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

/** `null` = tried and failed; `undefined` = not tried yet. Distinguishing them is what keeps a broken key from being retried on every send. */
type AppSlot = App | null;

@Injectable()
export class FcmPushAdapter implements PushProvider {
  private readonly logger = new Logger(FcmPushAdapter.name);

  readonly classifier: PushErrorClassifier = new FcmPushClassifier();

  private readonly apps = new Map<PushAppKey, AppSlot>();

  isConfigured(app: PushAppKey): boolean {
    return this.readCredentials(app) !== null;
  }

  /** The subset of `PUSH_APP_KEYS` this deployment can actually send to. For the health/admin view and for tests. */
  configuredApps(): PushAppKey[] {
    return PUSH_APP_KEYS.filter((key) => this.isConfigured(key));
  }

  /** *** NEVER THROWS. *** See `PushProvider.send`. */
  async send(app: PushAppKey, message: PushMessage): Promise<PushSendResult> {
    const instance = this.resolveApp(app);
    if (instance === null) {
      return {
        delivered: false,
        failure: {
          kind: 'not_configured',
          detail: `FCM is not configured for the ${app} app`,
        },
      };
    }

    try {
      const messageId = await getMessaging(instance).send({
        token: message.token,
        notification: { title: message.title, body: message.body },
        ...(message.data === undefined ? {} : { data: message.data }),
      });
      return { delivered: true, messageId };
    } catch (error: unknown) {
      return { delivered: false, failure: this.classifier.classify(error) };
    }
  }

  /**
   * Lazily initialises (or reuses) the named app, memoizing BOTH outcomes.
   *
   * Lazy rather than in the constructor, because a Nest provider is
   * constructed at boot and `initializeApp` parses the private key: a
   * mistyped key must not be able to take the server down, which is the
   * whole reason `env.validation.ts` does not regex-check it either.
   *
   * A FAILED initialisation is memoized as `null` and logged once. Retrying a
   * malformed service account on every notification would turn one
   * configuration mistake into a log flood, and the outcome cannot change
   * without a restart anyway — the env is read once per process.
   *
   * `getApps()` is consulted first so a hot reload (`nest start --watch`,
   * which re-instantiates providers in the same process) reuses the app it
   * already registered. `initializeApp` throws on a duplicate name, and that
   * throw would otherwise look like a credential failure.
   */
  private resolveApp(app: PushAppKey): AppSlot {
    const memoized = this.apps.get(app);
    if (memoized !== undefined) return memoized;

    const credentials = this.readCredentials(app);
    if (credentials === null) {
      this.logger.warn(
        `FCM is not configured for the ${app} app — notifications for that audience will be recorded but not delivered. Set FCM_${app.toUpperCase()}_PROJECT_ID / _CLIENT_EMAIL / _PRIVATE_KEY to enable push.`,
      );
      this.apps.set(app, null);
      return null;
    }

    const name = `${APP_NAME_PREFIX}-${app}`;
    try {
      const existing = getApps().find((candidate) => candidate.name === name);
      const instance =
        existing ??
        initializeApp(
          {
            credential: cert({
              projectId: credentials.projectId,
              clientEmail: credentials.clientEmail,
              privateKey: credentials.privateKey,
            }),
            projectId: credentials.projectId,
          },
          name,
        );
      this.apps.set(app, instance);
      return instance;
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `FCM initialisation failed for the ${app} app (${detail}). Notifications for that audience will be recorded but not delivered until the credentials are fixed and the server restarted.`,
      );
      this.apps.set(app, null);
      return null;
    }
  }

  /**
   * The three environment values for one app, or `null` if any is absent.
   *
   * *** THE `\n` PROBLEM. *** A Google service-account private key is a
   * multi-line PEM. A `.env` file cannot hold a raw newline in an unquoted
   * value, so every deployment guide (and every secret manager) ships the key
   * with LITERAL backslash-n sequences. Unescaping here rather than in
   * `env.validation.ts` keeps that schema a plain declaration of shape, the
   * same way the S3 and Cloudinary secrets are stored raw — and it is the
   * single most common FCM misconfiguration, so it is handled once, in the
   * one place that consumes the value.
   *
   * Surrounding quotes are stripped for the same reason: a key pasted as
   * `FCM_PATIENT_PRIVATE_KEY="-----BEGIN..."` keeps its quotes through some
   * dotenv/secret-manager paths, and a quoted PEM is not a PEM.
   */
  private readCredentials(app: PushAppKey): FcmCredentials | null {
    const env = getEnv();
    const raw =
      app === 'patient'
        ? {
            projectId: env.FCM_PATIENT_PROJECT_ID,
            clientEmail: env.FCM_PATIENT_CLIENT_EMAIL,
            privateKey: env.FCM_PATIENT_PRIVATE_KEY,
          }
        : {
            projectId: env.FCM_DOCTOR_PROJECT_ID,
            clientEmail: env.FCM_DOCTOR_CLIENT_EMAIL,
            privateKey: env.FCM_DOCTOR_PRIVATE_KEY,
          };

    if (!raw.projectId || !raw.clientEmail || !raw.privateKey) return null;

    return {
      projectId: raw.projectId,
      clientEmail: raw.clientEmail,
      privateKey: normalizePrivateKey(raw.privateKey),
    };
  }
}

/** Exported for its own test — see the `\n` note on `readCredentials`. */
export function normalizePrivateKey(value: string): string {
  const unquoted = value.replace(/^["']/, '').replace(/["']$/, '');
  return unquoted.replace(/\\n/g, '\n');
}
