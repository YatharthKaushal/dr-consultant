/**
 * PURE template handling — parsing the untyped `app_config` jsonb into a
 * template set, and rendering one template with a caller's variables. No I/O,
 * no config, no DI, which is why the FR-16.2 tests that matter most need no
 * mocking at all.
 *
 * Mirrors the split `modules/search` uses (`screenTextForCrisis` /
 * `validateProse` pure, a thin `@Injectable()` wrapper around each): the rule
 * is a function, the service is the thing that knows where the data came
 * from.
 */

/**
 * One piece of admin-editable copy. FR-16.3 — "notification copy is editable
 * from the admin panel" — is exactly these two strings, and nothing more is
 * stored: no audience, no channel, no schedule.
 *
 * Audience is NOT stored here on purpose. It is the CALLER's, passed per
 * request (`NotificationRequest.audience`), because the same code can be
 * legitimately raised at more than one audience — `red_flag_alert` goes to
 * the doctor AND, per `admins`' own schema comment, to the care_coordinator
 * who "receives safety and follow-up alerts, read in-panel". Pinning an
 * audience into the template would make that impossible without a second
 * template code and duplicated copy.
 */
export interface NotificationTemplate {
  title: string;
  body: string;
}

/** `template_code` -> copy. The whole value of the `notifications.templates` `app_config` key. */
export type NotificationTemplateSet = Readonly<Record<string, NotificationTemplate>>;

/**
 * `{{name}}`. Names are `[a-zA-Z][a-zA-Z0-9_]{0,39}` — camelCase, matching
 * how the rest of the codebase spells a JSON field, and bounded so a
 * pathological template cannot make the scan expensive.
 */
const PLACEHOLDER_SOURCE = '\\{\\{([a-zA-Z][a-zA-Z0-9_]{0,39})\\}\\}';

/** `notifications.template_code` is `varchar(80)`; the shape is the same lower_snake_case the schema comment's own examples use. */
export const TEMPLATE_CODE_PATTERN = /^[a-z][a-z0-9_]{2,79}$/;

/** `notifications.title` is `varchar(200)`. A longer render would be a Postgres error, not a truncation — so it is bounded here instead. */
export const TITLE_MAX_LENGTH = 200;

/** `notifications.body` is unbounded `text`; this is a sanity ceiling on a push payload, not a column limit. FCM's own message cap is 4KB. */
export const BODY_MAX_LENGTH = 2000;

/** A fresh regex per call: a module-level literal with `g` carries `lastIndex` between calls. */
function placeholderPattern(): RegExp {
  return new RegExp(PLACEHOLDER_SOURCE, 'g');
}

/** Every distinct placeholder name in `text`, in order of first appearance. */
export function extractPlaceholders(text: string): string[] {
  const found: string[] = [];
  const pattern = placeholderPattern();
  let match = pattern.exec(text);
  while (match !== null) {
    const name = match[1] as string;
    if (!found.includes(name)) found.push(name);
    match = pattern.exec(text);
  }
  return found;
}

/** What a template DECLARES: the union of the placeholders in its title and its body. Derived, never stored — a stored list could drift from the copy it describes. */
export function declaredVariables(template: NotificationTemplate): string[] {
  const fromTitle = extractPlaceholders(template.title);
  const fromBody = extractPlaceholders(template.body);
  return [...fromTitle, ...fromBody.filter((name) => !fromTitle.includes(name))];
}

export interface RenderedNotification {
  title: string;
  body: string;
  /** Placeholders the copy declares for which the caller supplied nothing. Removed from the output, and worth a log line — see `renderTemplate`. */
  unresolved: string[];
  /** Variables the caller supplied that this template does not declare. DROPPED, never substituted. See `notification-diagnosis.util.ts`, layer 2. */
  ignored: string[];
}

/**
 * Substitutes `variables` into a template's copy.
 *
 * *** THE SUBSTITUTION IS AN ALLOW-LIST, NOT A MERGE. *** A value is used
 * only where its name already appears as a `{{placeholder}}` in this
 * template's own copy. Anything else the caller passed is reported in
 * `ignored` and goes nowhere. That is FR-16.2's layer 2: passing
 * `{ diagnosis: 'type 2 diabetes' }` to `booking_confirmed` cannot put those
 * words in a body, because `booking_confirmed` has no `{{diagnosis}}` — the
 * value is never screened, because it is never used.
 *
 * *** SUBSTITUTION IS SINGLE-PASS. *** One `String.replace` with a callback,
 * so a variable whose VALUE contains `{{something}}` is inserted literally
 * and never re-scanned. A second pass would let a caller-supplied value name
 * a placeholder and pull in another variable, which is template injection.
 *
 * An UNRESOLVED placeholder is replaced with the empty string and the
 * surrounding whitespace collapsed, rather than left as `{{doctorName}}` or
 * treated as a failure. The trade is deliberate: `notify` is best-effort and
 * must never fail a caller's flow, so the choice is between a slightly
 * awkward sentence and no booking confirmation at all. The caller's bug is
 * still visible — `unresolved` is returned and the service logs it, which is
 * the drift signal.
 */
export function renderTemplate(
  template: NotificationTemplate,
  variables: Record<string, string | number> = {},
): RenderedNotification {
  const declared = declaredVariables(template);
  const supplied = Object.keys(variables);
  const unresolved: string[] = [];

  const substitute = (text: string): string =>
    text.replace(placeholderPattern(), (_match, name: string) => {
      const value = variables[name];
      if (value === undefined || value === null) {
        if (!unresolved.includes(name)) unresolved.push(name);
        return '';
      }
      return String(value);
    });

  return {
    title: tidy(substitute(template.title)).slice(0, TITLE_MAX_LENGTH),
    body: tidy(substitute(template.body)).slice(0, BODY_MAX_LENGTH),
    unresolved,
    ignored: supplied.filter((name) => !declared.includes(name)),
  };
}

/** Collapses the whitespace an emptied placeholder leaves behind, and tidies the space that ends up in front of a full stop or comma. */
function tidy(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim();
}

/**
 * Tolerant reader for `app_config.value`, which is untyped jsonb and so is
 * not protected by the database from a hand-edited row.
 *
 * Anything that is not `{ title: string, body: string }` under a valid
 * template code is DROPPED, not repaired and not thrown on — a single
 * malformed entry must not take down every other template, and a template
 * that half-parses is worse than one that is absent (an absent one falls
 * back to the compiled-in default). Same discipline as
 * `search-config.service.ts`'s readers.
 */
export function parseTemplateSet(value: unknown): NotificationTemplateSet {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};

  const parsed: Record<string, NotificationTemplate> = {};
  for (const [code, entry] of Object.entries(value as Record<string, unknown>)) {
    const template = parseTemplate(entry);
    if (template !== null && TEMPLATE_CODE_PATTERN.test(code)) {
      parsed[code] = template;
    }
  }
  return parsed;
}

/**
 * Looks a code up in a template set WITHOUT falling through to
 * `Object.prototype`.
 *
 * `TEMPLATE_CODE_PATTERN` already refuses `__proto__` (a code must start with
 * a letter), but `constructor`, `toString` and `valueOf` all match it — and a
 * bare `set['constructor']` on an object literal returns a FUNCTION rather
 * than `undefined`. Every read of a template goes through this, so a caller
 * asking for `templateCode: 'constructor'` gets `null` and the
 * `template_missing` path, not a rendered `[object Object]`.
 */
export function lookupTemplate(set: NotificationTemplateSet, code: string): NotificationTemplate | null {
  if (!Object.prototype.hasOwnProperty.call(set, code)) return null;
  return parseTemplate(set[code]);
}

/** One entry of the set, or `null` if it is not usable copy. */
export function parseTemplate(value: unknown): NotificationTemplate | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const candidate = value as { title?: unknown; body?: unknown };
  if (typeof candidate.title !== 'string' || candidate.title.trim().length === 0) return null;
  if (typeof candidate.body !== 'string' || candidate.body.trim().length === 0) return null;
  if (candidate.title.length > TITLE_MAX_LENGTH || candidate.body.length > BODY_MAX_LENGTH) return null;
  return { title: candidate.title, body: candidate.body };
}
