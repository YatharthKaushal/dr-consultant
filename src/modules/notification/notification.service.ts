import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { NotificationRow } from '../../schema/notifications.schema';
import type { AuthContext } from '../../shared/auth/auth.types';
import { collectStrings, screenAllForDiagnosis } from './notification-diagnosis.util';
import { NotificationDeviceRepository } from './notification-device.repository';
import { NotificationRepository } from './notification.repository';
import { NotificationTemplateService } from './notification-template.service';
import { renderTemplate, type RenderedNotification } from './notification-template.util';
import type { PushAppKey, PushFailure, PushProvider } from './notification-push.types';
import {
  FAILURE_REASON_MAX_LENGTH,
  NOTIFICATION_ERROR_CODES,
  NOTIFICATION_LIST_MAX_LIMIT,
  NOTIFICATION_PUSH_PORT,
} from './notification.constants';
import {
  NOTIFICATION_RESULT_REASONS,
  type NotificationAudience,
  type NotificationAudienceKind,
  type NotificationRequest,
  type NotificationResult,
  type NotificationResultReason,
} from './notification.contract';

/** `GET /notifications` query, after the DTO has bounded it. */
export interface ListNotificationsFilter {
  unreadOnly?: boolean;
  limit: number;
  offset: number;
}

/**
 * M-08's rules. Two halves that share one table:
 *
 *   THE WRITE HALF — `notify`, the only way a notification comes into
 *   existence. Reached from other modules through `NotificationFacade` and
 *   from nowhere else.
 *
 *   THE READ HALF — the in-app inbox (`listOwn`, `countUnread`, `markRead`)
 *   and device-token registration, reached by the patient/doctor apps and the
 *   admin panel through `notification.controller.ts`.
 *
 * They are one service because they are one table read two ways, not two
 * concepts: an in-app notification IS a delivery record with `read_at` unset
 * (`notification.repository.ts` sets out why).
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly repo: NotificationRepository,
    private readonly devices: NotificationDeviceRepository,
    private readonly templates: NotificationTemplateService,
    @Inject(NOTIFICATION_PUSH_PORT) private readonly push: PushProvider,
  ) {}

  /* ====================================================================== */
  /* The write half                                                          */
  /* ====================================================================== */

  /**
   * *** THIS METHOD MUST NEVER THROW. ***
   *
   * `NotificationContract.notify` is documented as best-effort, and every
   * caller is in the middle of something more important than a push: M-11 is
   * confirming a booking, M-12 has just captured money, M-13 is fanning an
   * instant request out to doctors while a patient waits. A notification that
   * fails must leave every one of those flows untouched.
   *
   * So the entire pipeline runs inside one try/catch that swallows anything
   * — including a failure of the database write that was supposed to RECORD
   * the failure. `provider_unavailable` is the reason returned for an
   * infrastructure fault, deliberately rather than inventing a fifth reason
   * value: the four in `notification.contract.ts` are frozen, M-13 is built
   * against them, and a value M-13 has never heard of is worse than a
   * slightly broad one it can handle.
   *
   * The failure is LOGGED at error level with the template code and audience
   * kind — never the audience id, never the rendered copy. That log line is
   * the drift signal; the body is not something to put in a log file.
   */
  async notify(request: NotificationRequest): Promise<NotificationResult> {
    try {
      return await this.deliver(request);
    } catch (error: unknown) {
      this.logNotifyFailure(request, error);
      return { queued: false, notificationId: null, reason: NOTIFICATION_RESULT_REASONS.PROVIDER_UNAVAILABLE };
    }
  }

  /**
   * *** THE HANDLER ITSELF MUST NOT THROW. ***
   *
   * It is reached with whatever the caller passed, INCLUDING a null or
   * half-built request — a caller mid-failure is exactly the caller most
   * likely to hand us one. Reading `request.templateCode` directly threw a
   * TypeError on `notify(null)` and turned the one method documented as never
   * throwing into one that did; `?.` fixed that case and left three others.
   *
   * *** INTERPOLATING A VALUE IS ITSELF A THROWING OPERATION. *** `${x}` on a
   * SYMBOL raises "Cannot convert a Symbol value to a string", and `String()`
   * on an object with a null prototype or a throwing `toString` raises
   * "Cannot convert object to primitive value" — all three were reproduced
   * escaping `notify` (`templateCode: Symbol(...)`, a `templateCode` whose
   * `toString` throws, and a dependency rejecting with `Object.create(null)`).
   * `fcm-push.classifier.ts#readMessage` already documents and guards exactly
   * this hazard on the push path; the same guard belongs here, on the path
   * whose invariant is the strictest in the module.
   *
   * So every field is rendered through `describeSafely`, and the whole body is
   * wrapped as well: logging is not allowed to be the thing that breaks the
   * contract logging exists to report on.
   */
  private logNotifyFailure(request: NotificationRequest | undefined, error: unknown): void {
    try {
      const detail = describeSafely(error instanceof Error ? error.message : error, 'unreadable error');
      const templateCode = describeSafely(request?.templateCode, 'unknown');
      const audienceKind = describeSafely(request?.audience?.kind, 'unknown');
      this.logger.error(`notify failed for template ${templateCode} (audience ${audienceKind}): ${detail}`);
    } catch {
      // Deliberately empty. See above.
    }
  }

  private async deliver(request: NotificationRequest): Promise<NotificationResult> {
    /* --- AN AUDIENCE THIS MODULE CANNOT ROUTE IS REFUSED BEFORE ANYTHING
     * IS WRITTEN ---------------------------------------------------------
     * `audience.kind` is three literals in the type system, but `notify` is
     * the module's boundary and is documented as reaching us with whatever a
     * caller passed — and M-13 binds to a LOCAL MIRROR of this contract that
     * this code cannot see. Without this guard a fourth kind fell through
     * every `=== 'patient'` ternary in the module to the DOCTOR side of it:
     * `repo.insert` wrote a row with all three owner columns null (nobody's
     * notification, readable by nobody), `NotificationDeviceRepository` read
     * a token from `doctors`, and `FcmPushAdapter` sent it with the DOCTOR
     * app's Firebase credentials. That is the cross-app delivery the separate
     * store listings exist to prevent, so it stops here. */
    const requestedKind: unknown = request?.audience?.kind;
    if (!isRoutableAudience(request?.audience)) {
      throw new Error(`unroutable audience kind ${describeSafely(requestedKind, 'undefined')}`);
    }

    const template = await this.templates.findTemplate(request.templateCode);
    if (template === null) {
      // Not an error the caller can act on, and not a reason to fail their
      // flow — but it IS a bug: a module raised a code no template answers.
      this.logger.warn(`No template resolves for code "${request.templateCode}" — nothing queued.`);
      return { queued: false, notificationId: null, reason: NOTIFICATION_RESULT_REASONS.TEMPLATE_MISSING };
    }

    const rendered = renderTemplate(template, request.variables);
    this.logRenderIssues(request, rendered);

    /* --- FR-16.2, AT SEND TIME ----------------------------------------- *
     * Screened against the FULLY RENDERED copy — the exact bytes that would
     * be stored in `notifications.body` and pushed to a lock screen — plus
     * the template code and every string reachable in the deep-link payload,
     * both of which travel with the notification and are readable by the app.
     *
     * A hit writes NO ROW. `notifications.body`'s own schema comment says the
     * stored copy "MUST NOT name a diagnosis, FR-16.2", so a row recording
     * the offending body would breach the rule it was written to document —
     * and an in-app inbox reads those rows back, so it would also DISPLAY it.
     * Redacting instead would leave a diagnosis with a hole in it, which is
     * the same call `response-validator.service.ts` makes for model prose.
     *
     * The evidence lives in the log, at error level, naming the template and
     * the construction but NOT the copy. A rising count here is a template an
     * admin needs to fix or a caller passing clinical text in a variable. */
    const screening = screenAllForDiagnosis([
      rendered.title,
      rendered.body,
      // The CODE travels too. It is stored in `notifications.template_code`,
      // handed to the app in the FCM `data` block, and projected straight
      // back to the client by `notification.mapper.ts` — the same three
      // properties that put `deepLinkData` in this list. An admin may create
      // any code matching `TEMPLATE_CODE_PATTERN`, and `you_have_diabetes`
      // matches it; the write path now refuses one, and this catches a code
      // stored before that check existed. Underscores normalise to spaces, so
      // a code screens as the phrase it spells.
      ...(typeof request.templateCode === 'string' ? [request.templateCode] : []),
      ...collectStrings(request.deepLinkData),
    ]);
    if (!screening.clean) {
      this.logger.error(
        `*** FR-16.2 *** Suppressed notification "${request.templateCode}" for a ${request.audience.kind}: the copy, the code or the deep link names a diagnosis ("${screening.construction ?? ''}"). No row written, no push sent.`,
      );
      return { queued: false, notificationId: null, reason: NOTIFICATION_RESULT_REASONS.SUPPRESSED };
    }

    const audience = request.audience;
    const row = await this.repo.insert({
      audience,
      templateCode: request.templateCode,
      title: rendered.title,
      body: rendered.body,
      deepLinkData: request.deepLinkData,
      consultationId: request.consultationId,
    });

    /* --- Admins have no push channel ------------------------------------ *
     * `notifications.admin_id`'s schema comment: "read in the panel — admins
     * have no push token". The panel is a web app with no store listing and
     * no FCM project, so for an admin the ROW IS THE DELIVERY and the status
     * is `sent`, not `failed`. Marking it failed would make every safety
     * alert to a care_coordinator look broken and would poison the
     * `(status, created_at)` index that a delivery-health view reads. */
    if (audience.kind === 'admin') {
      await this.repo.markSent(row.id, new Date());
      return { queued: true, notificationId: row.id };
    }

    return this.deliverPush(audience.kind, audience.id, row, rendered, request);
  }

  /** The push leg. Split out only so `deliver` reads as the decision sequence it is. */
  private async deliverPush(
    app: PushAppKey,
    accountId: string,
    row: NotificationRow,
    rendered: RenderedNotification,
    request: NotificationRequest,
  ): Promise<NotificationResult> {
    /* --- An unconfigured credential DEGRADES ---------------------------- *
     * The brief's rule, and `modules/storage`'s and `modules/ai`'s existing
     * behaviour: a missing credential makes one channel unusable, never the
     * server. The row already exists, so the notification is queued and
     * visible in-app; only the push did not happen, and `failure_reason` says
     * so in words an operator can act on. */
    if (!this.push.isConfigured(app)) {
      return this.fail(
        row.id,
        NOTIFICATION_RESULT_REASONS.PROVIDER_UNAVAILABLE,
        `provider_unavailable: FCM is not configured for the ${app} app`,
      );
    }

    const token = await this.devices.findPushToken(app, accountId);
    if (token === null || token.trim().length === 0) {
      return this.fail(
        row.id,
        NOTIFICATION_RESULT_REASONS.NO_DEVICE_TOKEN,
        'no_device_token: the account has not registered a device for push',
      );
    }

    const result = await this.push.send(app, {
      token,
      title: rendered.title,
      body: rendered.body,
      data: buildDataPayload(row.id, request),
    });

    if (result.delivered) {
      await this.repo.markSent(row.id, new Date());
      return { queued: true, notificationId: row.id };
    }

    return this.handleSendFailure(app, accountId, row.id, result.failure);
  }

  /**
   * Maps a classified push failure onto the frozen four-value `reason`
   * vocabulary, and takes the one side effect a failure can warrant.
   *
   * `unregistered_token` is FCM telling us the token is DEAD — the app was
   * uninstalled, or the token rotated. Google's own guidance is to delete it,
   * and not doing so leaves every future notification to that account failing
   * against a token FCM has already disowned. `invalid_token` is NOT cleared:
   * a token rejected because it belongs to the other app's Firebase project
   * is a misconfiguration to surface, not data to delete.
   *
   * Both report `no_device_token` rather than `provider_unavailable`, because
   * from the caller's point of view that is what has happened: this account
   * has no usable device. Everything else — auth, quota, transport, an
   * unclassified shape — is `provider_unavailable`.
   */
  private async handleSendFailure(
    app: PushAppKey,
    accountId: string,
    notificationId: number,
    failure: PushFailure,
  ): Promise<NotificationResult> {
    if (failure.kind === 'unregistered_token') {
      await this.devices.clearPushToken(app, accountId);
      this.logger.warn(`Cleared an unregistered ${app} push token — FCM reported it dead.`);
    }

    const reason: NotificationResultReason =
      failure.kind === 'unregistered_token' || failure.kind === 'invalid_token'
        ? NOTIFICATION_RESULT_REASONS.NO_DEVICE_TOKEN
        : NOTIFICATION_RESULT_REASONS.PROVIDER_UNAVAILABLE;

    return this.fail(notificationId, reason, `${failure.kind}: ${failure.detail}`);
  }

  /** Records the failed delivery and reports it. The row survives — it is still the in-app notification. */
  private async fail(
    notificationId: number,
    reason: NotificationResultReason,
    failureReason: string,
  ): Promise<NotificationResult> {
    // `notifications.failure_reason` is varchar(200); an over-long reason
    // would turn a recorded failure into an unrecorded one.
    await this.repo.markFailed(notificationId, failureReason.slice(0, FAILURE_REASON_MAX_LENGTH));
    return { queued: true, notificationId, reason };
  }

  /**
   * Logs the two render outcomes worth seeing, WITHOUT logging the copy.
   *
   * `ignored` is the interesting one: it is FR-16.2's layer 2 firing. A
   * caller passed a variable this template does not declare, so the value was
   * dropped rather than substituted — which is exactly what stops
   * `{ diagnosis: '...' }` reaching a body. Only the NAMES are logged; the
   * values are precisely the thing not to write down.
   */
  private logRenderIssues(request: NotificationRequest, rendered: RenderedNotification): void {
    if (rendered.unresolved.length > 0) {
      this.logger.warn(
        `Template "${request.templateCode}" declares ${rendered.unresolved.join(', ')} but the caller supplied no value — rendered without it.`,
      );
    }
    if (rendered.ignored.length > 0) {
      this.logger.warn(
        `Template "${request.templateCode}" does not declare ${rendered.ignored.join(', ')}; those variables were DROPPED, not substituted (FR-16.2).`,
      );
    }
  }

  /* ====================================================================== */
  /* The read half — the in-app inbox                                        */
  /* ====================================================================== */

  /** The caller's OWN notifications, newest first. Identity comes from the token, never from a parameter. */
  async listOwn(auth: AuthContext, filter: ListNotificationsFilter): Promise<NotificationRow[]> {
    return this.repo.listForAudience({
      audience: toAudience(auth),
      unreadOnly: filter.unreadOnly,
      limit: Math.min(filter.limit, NOTIFICATION_LIST_MAX_LIMIT),
      offset: filter.offset,
    });
  }

  /** The unread badge count. `read_at IS NULL` is what unread means — there is no read status value. */
  async countUnread(auth: AuthContext): Promise<{ unread: number }> {
    return { unread: await this.repo.countUnread(toAudience(auth)) };
  }

  /**
   * Marks one notification read. A row that does not exist and a row
   * belonging to someone else are the SAME 404 — telling them apart would
   * turn this endpoint into an existence oracle over other people's
   * notification ids.
   *
   * The `readAt` reported is the one the ROW now holds, not the one this
   * method proposed: re-reading an already-read notification keeps the first
   * read's timestamp (`notification.repository.ts`'s `coalesce`), and
   * answering with `new Date()` would hand the client a time the database
   * never stored.
   */
  async markRead(auth: AuthContext, id: number): Promise<{ id: number; readAt: Date }> {
    const readAt = await this.repo.markRead(toAudience(auth), id, new Date());
    if (readAt === null) {
      throw new NotFoundException({
        code: NOTIFICATION_ERROR_CODES.NOT_FOUND,
        message: 'Notification not found.',
      });
    }
    return { id, readAt };
  }

  async markAllRead(auth: AuthContext): Promise<{ marked: number }> {
    return { marked: await this.repo.markAllRead(toAudience(auth), new Date()) };
  }

  /* ====================================================================== */
  /* Device tokens                                                           */
  /* ====================================================================== */

  /**
   * Stores the FCM registration token the app just obtained.
   *
   * Refused for an admin, and the refusal is the schema's own words:
   * `notifications.admin_id` is "read in the panel — admins have no push
   * token". There is no column to write it to and no Firebase project to send
   * it from, so a 400 naming the reason beats silently accepting a token that
   * can never be used.
   */
  async registerDevice(
    auth: AuthContext,
    values: { pushToken: string; deviceId?: string },
  ): Promise<{ registered: true }> {
    const app = toPushApp(auth);
    const registered = await this.devices.register(app, auth.accountId, values);
    if (!registered) {
      // The token authenticated, so the account exists — unless it was
      // deleted between the two. Reported as a 404 rather than a 500.
      throw new NotFoundException({
        code: NOTIFICATION_ERROR_CODES.NOT_FOUND,
        message: 'Account not found.',
      });
    }
    return { registered: true };
  }

  /** Sign-out, or "stop sending me push". Clears the token AND the device id — see `notification-device.repository.ts`. */
  async unregisterDevice(auth: AuthContext): Promise<void> {
    await this.devices.clearPushToken(toPushApp(auth), auth.accountId);
  }
}

/**
 * `AuthContext` -> audience. `AccountType` and `NotificationAudienceKind` are
 * the same three literals (`enums.schema.ts`), so this is a rename rather
 * than a mapping — written out anyway so that a future account type is a
 * compile error here instead of a query that matches nothing.
 */
function toAudience(auth: AuthContext): NotificationAudience {
  return { kind: auth.accountType, id: auth.accountId };
}

function toPushApp(auth: AuthContext): PushAppKey {
  if (auth.accountType === 'admin') {
    throw new BadRequestException({
      code: NOTIFICATION_ERROR_CODES.DEVICE_TOKEN_NOT_SUPPORTED,
      message: 'Admins have no push token — panel notifications are read in the panel.',
    });
  }
  return auth.accountType;
}

/**
 * FCM's `data` block. Every value must be a string — FCM rejects anything
 * else — so the deep-link payload travels as ONE json-encoded field rather
 * than being flattened into top-level keys.
 *
 * That is not only about types. FCM reserves `from`, `notification`,
 * `message_type` and anything starting with `google` or `gcm`, and a caller's
 * deep-link payload is not something to trust with the key namespace of the
 * push envelope. Nesting it under one key makes a collision impossible.
 */
export function buildDataPayload(notificationId: number, request: NotificationRequest): Record<string, string> {
  const data: Record<string, string> = {
    notificationId: String(notificationId),
    templateCode: request.templateCode,
  };
  if (request.consultationId !== undefined) data.consultationId = request.consultationId;
  if (request.deepLinkData !== undefined) {
    // *** THIS RUNS AFTER THE ROW HAS BEEN WRITTEN. *** `JSON.stringify`
    // throws on a circular structure and on a `BigInt`, and a throw here does
    // not merely lose the deep link: it unwinds into `notify`'s handler,
    // which reports `queued: false, notificationId: null` for a notification
    // that HAS a row — contradicting `notification.contract.ts` ("`queued`
    // means A ROW WAS WRITTEN") and leaving that row stuck at `queued` with
    // no `failure_reason`. A payload we cannot encode is dropped from the
    // push envelope instead; the row still carries it, and the in-app
    // notification is unaffected.
    const encoded = encodeDeepLink(request.deepLinkData);
    if (encoded !== null) data.deepLinkData = encoded;
  }
  return data;
}

function encodeDeepLink(value: unknown): string | null {
  try {
    return JSON.stringify(value) ?? null;
  } catch {
    return null;
  }
}

/**
 * `String()` that cannot itself raise — see `logNotifyFailure`. A symbol, an
 * object with a null prototype and an object whose `toString` throws all reach
 * this from a caller's request or from a rejected dependency.
 */
function describeSafely(value: unknown, fallback: string): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return fallback;
  try {
    return String(value);
  } catch {
    return fallback;
  }
}

/**
 * The three audience kinds this module can actually route, as a runtime set.
 *
 * `satisfies Record<NotificationAudienceKind, true>` is the point: adding a
 * fourth kind to `notification.contract.ts` without adding it here is a `tsc`
 * error, which is the same discipline `toAudience` is written out longhand
 * for.
 */
const ROUTABLE_AUDIENCE_KINDS = {
  patient: true,
  doctor: true,
  admin: true,
} as const satisfies Record<NotificationAudienceKind, true>;

function isRoutableAudience(audience: NotificationAudience | undefined | null): audience is NotificationAudience {
  if (audience === null || audience === undefined) return false;
  const kind: unknown = audience.kind;
  return typeof kind === 'string' && Object.prototype.hasOwnProperty.call(ROUTABLE_AUDIENCE_KINDS, kind);
}
