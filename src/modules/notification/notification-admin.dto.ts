import { IsString, Length, Matches } from 'class-validator';
import { BODY_MAX_LENGTH, TEMPLATE_CODE_PATTERN, TITLE_MAX_LENGTH } from './notification-template.util';

/**
 * The `notifications.templates` write surface, FR-16.3.
 *
 * There is deliberately NO free-form `{ key, value }` pair here: an admin
 * holding `content.manage_notification_templates` can only reach the one
 * `app_config` key this module owns, so one shared table never becomes one
 * shared permission. `notification-template.service.ts` re-checks ownership,
 * bounds AND FR-16.2 anyway — services hold the rules, per
 * `backend/README.md`, not just the HTTP layer.
 *
 * *** THE FR-16.2 CHECK IS NOT HERE. *** It could have been a
 * `@Matches` on the body, and it deliberately is not: a rule that decides
 * what a patient may be told belongs in the service where it can be unit
 * tested against the copy AS RENDERED, not in a decorator that only ever sees
 * the template. See `notification-diagnosis.util.ts`.
 */
export class UpsertNotificationTemplateDto {
  /** `notifications.title` is `varchar(200)`; a longer render would be a Postgres error rather than a truncation. */
  @IsString()
  @Length(1, TITLE_MAX_LENGTH)
  title!: string;

  @IsString()
  @Length(1, BODY_MAX_LENGTH)
  body!: string;
}

/**
 * The `:code` path parameter. `notifications.template_code` is `varchar(80)`,
 * and the code is also a JSON object key in `app_config`, so a free-form
 * string is not acceptable in either direction.
 */
export class NotificationTemplateCodeParamDto {
  @IsString()
  @Matches(TEMPLATE_CODE_PATTERN, {
    message:
      'templateCode must be 3-80 characters of lower-case letters, digits and underscores, starting with a letter.',
  })
  code!: string;
}
