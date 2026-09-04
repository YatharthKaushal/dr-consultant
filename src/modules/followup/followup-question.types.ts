/**
 * The runtime shape of `followup_pathways.questions` and `.red_flag_rules` —
 * both `jsonb('...').$type<unknown>()` at the schema layer (see that file's
 * header: "so extraction is a `pg_dump`... and a stray cross-module join is
 * obvious in review" — the looseness is deliberate, this module is what gives
 * it meaning).
 *
 * Admin-editable with no app release (FR-13.7): an admin authors a whole new
 * ARRAY of each per pathway version, validated on write
 * (`followup-pathway.service.ts`) so a malformed rule set can never reach a
 * patient's check-in.
 */

export type FollowupQuestionType = 'scale_1_5' | 'yes_no' | 'choice';

export interface FollowupQuestionOption {
  value: string;
  label: string;
}

/**
 * One question. `id` is the stable key every answer and every red-flag rule
 * addresses — NOT the array index, so re-ordering questions in a later
 * version never silently repoints an existing rule.
 */
export interface FollowupQuestion {
  id: string;
  text: string;
  type: FollowupQuestionType;
  /** Required for `type: 'choice'`. Ignored (and not required) for `yes_no`/`scale_1_5`, whose option sets are implicit — see `optionsForQuestion`. */
  options?: FollowupQuestionOption[];
  required: boolean;
}

/** `questionId -> the option value the patient selected` (the scale number, as a string, for `scale_1_5`). One flat, jsonb-safe object — no nesting. */
export type FollowupAnswers = Record<string, string>;

export type RedFlagSeverity = 'amber' | 'red';

/**
 * One red-flag rule: "if `questionId`'s answer is one of `matchValues`, this
 * severity fires." FR-13.5's seven categories (self-harm thoughts, severe
 * worsening, confusion or agitation, violence risk, severe withdrawal,
 * medication side effects, feeling unsafe) are each authored as a rule over a
 * `yes_no` or `choice` question — nothing about the category is hard-coded
 * here, because the client authors the actual wording (`docs/MODULES.md` §7:
 * "modules provide the tools, not the wording").
 */
export interface RedFlagRule {
  id: string;
  questionId: string;
  matchValues: string[];
  severity: RedFlagSeverity;
  /** Plain words. `safety_alerts.reason`'s own schema comment: "NEVER names a diagnosis." Enforced on write — see `assertReasonNamesNoDiagnosis`. */
  reason: string;
}

/** The implicit option set for a question whose type does not carry its own `options` array. */
export function impliedOptionValues(question: FollowupQuestion): string[] {
  if (question.type === 'yes_no') return ['yes', 'no'];
  if (question.type === 'scale_1_5') return ['1', '2', '3', '4', '5'];
  return (question.options ?? []).map((option) => option.value);
}
