import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DATABASE } from '../../config/db/database.module';
import type { Database } from '../../config/db/database.config';
import { AppConfigService } from '../../shared/app-config/app-config.service';
import { AuditService } from '../../shared/audit/audit.service';
import { screenForDiagnosis } from './notification-diagnosis.util';
import { NotificationConfigRepository } from './notification-config.repository';
import {
  NOTIFICATION_AUDIT_ENTITY_TYPES,
  NOTIFICATION_CONFIG_KEYS,
  NOTIFICATION_CONFIG_KEY_LIST,
  NOTIFICATION_ERROR_CODES,
  NOTIFICATION_TEMPLATE_DEFAULTS,
} from './notification.constants';
import {
  BODY_MAX_LENGTH,
  TEMPLATE_CODE_PATTERN,
  TITLE_MAX_LENGTH,
  declaredVariables,
  lookupTemplate,
  parseTemplate,
  parseTemplateSet,
  type NotificationTemplate,
  type NotificationTemplateSet,
} from './notification-template.util';

/** One template as the admin panel sees it: the copy, where it came from, and which placeholders it declares. */
export interface AdminNotificationTemplate extends NotificationTemplate {
  code: string;
  /** `default` = compiled-in, no `app_config` entry yet. `custom` = an admin has edited it. Lets the panel offer "revert". */
  source: 'default' | 'custom';
  /** Derived from the copy, never stored. The panel renders these as the placeholders an editor may use. */
  variables: string[];
}

/**
 * The READ AND WRITE path for M-08's own `app_config` key — FR-16.3's
 * "notification copy is editable from the admin panel", FR-18.7's content
 * management ("...and notification copy"), and M-08's done-when: "copy
 * changes need no app release."
 *
 * Modelled line-for-line on `payment-config.service.ts` and
 * `search-config.service.ts`, which carry the same three responsibilities a
 * bare config write does not:
 *
 *   1. KEY OWNERSHIP. Writes are restricted to `NOTIFICATION_CONFIG_KEY_LIST`.
 *      `search-config.service.ts`'s own comment states the rule in the other
 *      direction: an admin holding one module's config permission "must not
 *      be able to reach `payments.gst_pct` through this endpoint because both
 *      happen to live in one table." Here that means an admin holding
 *      `content.manage_notification_templates` must not be able to reach
 *      `search.crisis_keywords` and switch off the safety guardrail.
 *   2. SHAPE VALIDATION. `app_config.value` is untyped jsonb, so a bad write
 *      is not caught by the database. A title longer than `notifications.
 *      title`'s `varchar(200)` would not fail here — it would fail at the
 *      next send, on a row nobody is watching.
 *   3. AUDIT + INVALIDATION. Every change writes an `audit_log` row carrying
 *      actor and BEFORE/AFTER, then calls `AppConfigService.invalidate(key)`.
 *      *** Without that last call the 30-second memo keeps serving the old
 *      copy *** and an admin correcting a typo would watch nothing happen for
 *      half a minute — the exact failure `payment-config.service.ts` warns
 *      about for a GST rate.
 *
 * And one this module has that neither of those does:
 *
 *   4. *** FR-16.2. *** Copy that names a diagnosis is REFUSED, with the
 *      offending construction named so the admin can re-word rather than
 *      guess. This is the write-time half of the rule; the send-time half is
 *      in `notification.service.ts`, and the reasoning for having both is in
 *      `notification-diagnosis.util.ts`. Enforced in the service, not in the
 *      DTO — `backend/README.md`: services hold the rules.
 *
 * *** THE PERMISSION IS THE EXISTING `content.manage_notification_templates`.
 * *** It is already in `permission.catalog.ts`, already described as "Edit
 * notification copy", and already bundled to the `content` role. M-08 adds no
 * permission of its own.
 */
@Injectable()
export class NotificationTemplateService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly repo: NotificationConfigRepository,
    private readonly appConfig: AppConfigService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The template set actually in force: stored copy laid OVER the compiled-in
   * defaults, per code.
   *
   * Merged rather than either-or, so a stored map that only carries the two
   * templates an admin has edited still leaves the other seven working. A
   * missing or malformed row therefore degrades to shipping the default copy,
   * never to sending nothing — the same call `search-config.service.ts` makes
   * for crisis guidance.
   */
  async getResolved(): Promise<NotificationTemplateSet> {
    const stored = await this.repo.findByKeys(NOTIFICATION_CONFIG_KEY_LIST);
    return this.mergeWithDefaults(stored.get(NOTIFICATION_CONFIG_KEYS.TEMPLATES));
  }

  /** One resolved template, or `null` if the code is neither stored nor compiled in. The read `notify` makes. */
  async findTemplate(code: string): Promise<NotificationTemplate | null> {
    return lookupTemplate(await this.getResolved(), code);
  }

  /** The whole set as the admin panel wants it — sorted, with provenance and the placeholders each template declares. */
  async listForAdmin(): Promise<AdminNotificationTemplate[]> {
    const stored = parseTemplateSet(
      (await this.repo.findByKeys(NOTIFICATION_CONFIG_KEY_LIST)).get(NOTIFICATION_CONFIG_KEYS.TEMPLATES),
    );
    const resolved = this.mergeWithDefaults(stored);

    return Object.keys(resolved)
      .sort()
      .flatMap((code) => {
        const template = lookupTemplate(resolved, code);
        if (template === null) return [];
        return [
          {
            code,
            title: template.title,
            body: template.body,
            source: lookupTemplate(stored, code) === null ? ('default' as const) : ('custom' as const),
            variables: declaredVariables(template),
          },
        ];
      });
  }

  /**
   * Upserts the copy for ONE template code.
   *
   * The whole map lives under one `app_config` key, so this is a
   * read-modify-write; `findByKeysForUpdate` takes the row lock that stops
   * two admins editing two different templates from discarding each other's
   * work. Validation and the FR-16.2 screen run BEFORE anything is written,
   * so a rejected edit leaves the stored map exactly as it was.
   */
  async upsertTemplate(
    actingAdminId: string,
    code: string,
    template: NotificationTemplate,
  ): Promise<AdminNotificationTemplate> {
    this.assertOwnedKey(NOTIFICATION_CONFIG_KEYS.TEMPLATES);
    this.assertValidCode(code);
    const validated = this.assertValidTemplate(template);
    this.assertNamesNoDiagnosis(validated);

    await this.db.transaction(async (tx) => {
      const stored = parseTemplateSet(
        (await this.repo.findByKeysForUpdate(NOTIFICATION_CONFIG_KEY_LIST, tx)).get(
          NOTIFICATION_CONFIG_KEYS.TEMPLATES,
        ),
      );
      const before = lookupTemplate(stored, code);
      const next: Record<string, NotificationTemplate> = { ...stored, [code]: validated };

      await this.repo.upsert(NOTIFICATION_CONFIG_KEYS.TEMPLATES, next, tx);

      // Transactional with the write it audits, which is the mode
      // `audit.service.ts` documents for a change that must never exist
      // un-audited. `docs/MODULES.md` §7 puts notification copy under FR-18.7
      // content management, and an edit to what a patient is told is exactly
      // the kind of change an auditor asks "who, and from what" about.
      await this.audit.write(
        {
          actorType: 'admin',
          actorId: actingAdminId,
          action: 'update',
          entityType: NOTIFICATION_AUDIT_ENTITY_TYPES.CONFIG,
          // The KEY is the entity — `app_config` rows are identified by key.
          // Which template moved is `metadata.templateCode`, and before/after
          // carry THAT template rather than the whole nine-entry map.
          entityId: NOTIFICATION_CONFIG_KEYS.TEMPLATES,
          metadata: { templateCode: code, before, after: validated },
        },
        tx,
      );
    });

    // *** Without this the 30-second memo keeps serving the old copy. ***
    this.appConfig.invalidate(NOTIFICATION_CONFIG_KEYS.TEMPLATES);

    return { code, ...validated, source: 'custom', variables: declaredVariables(validated) };
  }

  /**
   * Drops the stored override for one code.
   *
   * For one of the nine codes the schema names, this is a REVERT: the
   * compiled-in default takes over again and the endpoint returns it. For a
   * code an admin added, it is a delete. Either way the audit records the
   * copy that was removed, so a revert is as reversible as an edit.
   */
  async deleteTemplate(actingAdminId: string, code: string): Promise<AdminNotificationTemplate | null> {
    this.assertValidCode(code);

    const removed = await this.db.transaction(async (tx) => {
      const stored = parseTemplateSet(
        (await this.repo.findByKeysForUpdate(NOTIFICATION_CONFIG_KEY_LIST, tx)).get(
          NOTIFICATION_CONFIG_KEYS.TEMPLATES,
        ),
      );
      const before = lookupTemplate(stored, code);
      if (before === null) return false;

      const next: Record<string, NotificationTemplate> = { ...stored };
      delete next[code];

      await this.repo.upsert(NOTIFICATION_CONFIG_KEYS.TEMPLATES, next, tx);
      await this.audit.write(
        {
          actorType: 'admin',
          actorId: actingAdminId,
          action: 'delete',
          entityType: NOTIFICATION_AUDIT_ENTITY_TYPES.CONFIG,
          entityId: NOTIFICATION_CONFIG_KEYS.TEMPLATES,
          metadata: { templateCode: code, before, after: this.compiledInDefault(code) },
        },
        tx,
      );
      return true;
    });

    if (!removed) {
      throw new NotFoundException({
        code: NOTIFICATION_ERROR_CODES.TEMPLATE_NOT_FOUND,
        message: `No admin-edited copy is stored for template ${code}.`,
      });
    }

    this.appConfig.invalidate(NOTIFICATION_CONFIG_KEYS.TEMPLATES);

    const fallback = this.compiledInDefault(code);
    return fallback === null
      ? null
      : { code, ...fallback, source: 'default', variables: declaredVariables(fallback) };
  }

  /** The shipped copy for one of the nine schema-named codes, or `null` for a code an admin added. */
  private compiledInDefault(code: string): NotificationTemplate | null {
    return lookupTemplate(NOTIFICATION_TEMPLATE_DEFAULTS, code);
  }

  /* ---------------------------------------------------------------------- */
  /* Rules                                                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * Structurally unreachable from the controller (the DTO has no free-form
   * key), and enforced anyway — this is the guard that keeps one shared
   * `app_config` table from becoming one shared permission.
   */
  private assertOwnedKey(key: string): void {
    if (!(NOTIFICATION_CONFIG_KEY_LIST as readonly string[]).includes(key)) {
      throw new BadRequestException({
        code: NOTIFICATION_ERROR_CODES.CONFIG_KEY_NOT_OWNED,
        message: `${key} is not a notifications configuration key.`,
      });
    }
  }

  /** `notifications.template_code` is `varchar(80)`, and a code is also a JSON object key, so a free-form string would let an admin write `__proto__`. */
  private assertValidCode(code: string): void {
    if (typeof code !== 'string' || !TEMPLATE_CODE_PATTERN.test(code)) {
      throw new BadRequestException({
        code: NOTIFICATION_ERROR_CODES.TEMPLATE_CODE_INVALID,
        message: 'templateCode must be 3-80 characters of lower-case letters, digits and underscores, starting with a letter.',
      });
    }
  }

  /** Defensive re-check of the DTO's own bounds — services hold the rules, per `backend/README.md`, not just the HTTP layer. */
  private assertValidTemplate(template: NotificationTemplate): NotificationTemplate {
    const parsed = parseTemplate(template);
    if (parsed === null) {
      throw new BadRequestException({
        code: NOTIFICATION_ERROR_CODES.TEMPLATE_INVALID,
        message: `title and body must be non-empty strings of at most ${TITLE_MAX_LENGTH} and ${BODY_MAX_LENGTH} characters.`,
      });
    }
    return parsed;
  }

  /**
   * *** FR-16.2, AT WRITE TIME. ***
   *
   * `ConflictException`, not a validation error: the body is well-formed, and
   * what is being refused is the platform's rule about what a notification
   * may say. The offending construction is in the message because an admin
   * who cannot see WHICH word was refused will retry the same sentence with a
   * comma moved.
   *
   * Title and body are screened separately — see `screenAllForDiagnosis`'s
   * note on why joining them would let a phrase span a boundary that no
   * reader ever sees as one sentence.
   */
  private assertNamesNoDiagnosis(template: NotificationTemplate): void {
    for (const [field, text] of [
      ['title', template.title],
      ['body', template.body],
    ] as const) {
      const screening = screenForDiagnosis(text);
      if (!screening.clean) {
        throw new ConflictException({
          code: NOTIFICATION_ERROR_CODES.TEMPLATE_NAMES_DIAGNOSIS,
          message: `Notification copy must not name a diagnosis (FR-16.2). The ${field} contains "${screening.construction ?? ''}".`,
        });
      }
    }
  }

  /** Stored copy over compiled-in defaults, per code. Tolerant of a malformed row — see `parseTemplateSet`. */
  private mergeWithDefaults(stored: unknown): NotificationTemplateSet {
    return { ...NOTIFICATION_TEMPLATE_DEFAULTS, ...parseTemplateSet(stored) };
  }
}
