import { BadRequestException } from '@nestjs/common';
import type { CheckinStatus } from '../../schema/enums.schema';
import { FOLLOWUP_ERROR_CODES } from './followup.constants';
import {
  impliedOptionValues,
  type FollowupAnswers,
  type FollowupQuestion,
  type RedFlagRule,
} from './followup-question.types';

/**
 * Pure validation + scoring — no I/O, no Nest DI, so `followup-scoring.util
 * .spec.ts` drives it directly with hand-built fixtures, the same discipline
 * `clinical-medicine.util.ts` and `promotion-discount.util.ts` apply.
 *
 * *** THIS FILE IS FR-13.1 THROUGH FR-13.5, IN CODE. *** Everything else in
 * this module is plumbing around what happens here.
 */

const MAX_QUESTIONS = 30;
const MAX_RULES = 60;

function invalidQuestionSet(message: string): BadRequestException {
  return new BadRequestException({ code: FOLLOWUP_ERROR_CODES.INVALID_QUESTION_SET, message });
}

function invalidRedFlagRules(message: string): BadRequestException {
  return new BadRequestException({ code: FOLLOWUP_ERROR_CODES.INVALID_RED_FLAG_RULES, message });
}

function invalidAnswers(message: string): BadRequestException {
  return new BadRequestException({ code: FOLLOWUP_ERROR_CODES.INVALID_ANSWERS, message });
}

/**
 * *** WHAT `RedFlagRule.reason`'s DOC COMMENT PROMISES, MADE REAL. ***
 * `followup-question.types.ts#RedFlagRule.reason` has claimed, since this
 * module was written, "Enforced on write — see `assertReasonNamesNoDiagnosis`"
 * — a function that did not exist anywhere in this codebase until this one
 * was added. Nothing before this stopped an admin-authored rule from naming
 * a diagnosis in the very string `safety_alerts.reason`'s own schema comment
 * says must "NEVER name a diagnosis": that string reaches the admin alert
 * queue (`GET /admin/safety-alerts`) and the doctor/admin push notification's
 * log line verbatim.
 *
 * A small, explicit blocklist — not fuzzy NLP — is the right proportion HERE
 * specifically, unlike M-17's doctor-authored free text
 * (`clarification.constants.ts#DEIDENTIFICATION_NOTICE`'s header explains why
 * THAT field cannot be machine-checked): `reason` is short (<=255 chars),
 * fixed-purpose (describes which answer/risk fired, not clinical narrative),
 * and authored only by `clinical_governance` admins through
 * `POST /admin/followup-pathways` — a small, trusted, low-volume surface a
 * blocklist can realistically cover without false positives crowding out
 * genuine reasons. FR-13.5's seven red-flag categories (self-harm thoughts,
 * severe worsening, confusion or agitation, violence risk, severe
 * withdrawal, medication side effects, feeling unsafe) are all
 * behaviours/symptoms, not diagnoses, so none of them collide with this list.
 */
const DIAGNOSIS_TERMS: readonly string[] = [
  'depression',
  'depressive disorder',
  'major depressive disorder',
  'anxiety disorder',
  'generalized anxiety disorder',
  'panic disorder',
  'bipolar',
  'psychosis',
  'psychotic disorder',
  'schizophrenia',
  'schizoaffective',
  'substance use disorder',
  'substance abuse disorder',
  'alcohol use disorder',
  'addiction',
  'post-traumatic stress disorder',
  'ptsd',
  'obsessive-compulsive disorder',
  'borderline personality disorder',
  'insomnia disorder',
];

function assertReasonNamesNoDiagnosis(reason: string, ruleId: string): void {
  const lower = reason.toLowerCase();
  const match = DIAGNOSIS_TERMS.find((term) => lower.includes(term));
  if (match) {
    throw invalidRedFlagRules(
      `Rule "${ruleId}"'s reason must not name a diagnosis (found "${match}") — safety_alerts.reason describes the answer or risk that fired, never a diagnostic label.`,
    );
  }
}

/**
 * Validates an admin-authored question array on WRITE (pathway version
 * create). Deliberately strict — a malformed question set must never reach a
 * patient's check-in screen, and this is the only gate it passes through
 * (`jsonb` carries no schema of its own).
 */
export function validateQuestions(value: unknown): FollowupQuestion[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalidQuestionSet('questions must be a non-empty array.');
  }
  if (value.length > MAX_QUESTIONS) {
    throw invalidQuestionSet(`questions must not exceed ${MAX_QUESTIONS} entries.`);
  }

  const seenIds = new Set<string>();
  const questions: FollowupQuestion[] = [];

  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) throw invalidQuestionSet('Each question must be an object.');
    const q = raw as Record<string, unknown>;

    if (typeof q.id !== 'string' || q.id.trim().length === 0) {
      throw invalidQuestionSet('Each question needs a non-empty string id.');
    }
    if (seenIds.has(q.id)) throw invalidQuestionSet(`Duplicate question id "${q.id}".`);
    seenIds.add(q.id);

    if (typeof q.text !== 'string' || q.text.trim().length === 0) {
      throw invalidQuestionSet(`Question "${q.id}" needs non-empty text.`);
    }
    if (q.type !== 'scale_1_5' && q.type !== 'yes_no' && q.type !== 'choice') {
      throw invalidQuestionSet(`Question "${q.id}" has an unknown type "${String(q.type)}".`);
    }
    if (typeof q.required !== 'boolean') {
      throw invalidQuestionSet(`Question "${q.id}" needs a boolean "required".`);
    }

    let options: FollowupQuestion['options'];
    if (q.type === 'choice') {
      if (!Array.isArray(q.options) || q.options.length < 2) {
        throw invalidQuestionSet(`Choice question "${q.id}" needs at least two options.`);
      }
      const seenValues = new Set<string>();
      options = q.options.map((rawOption) => {
        if (typeof rawOption !== 'object' || rawOption === null) {
          throw invalidQuestionSet(`Question "${q.id}" has a malformed option.`);
        }
        const option = rawOption as Record<string, unknown>;
        if (typeof option.value !== 'string' || option.value.trim().length === 0) {
          throw invalidQuestionSet(`Question "${q.id}" has an option with no value.`);
        }
        if (typeof option.label !== 'string' || option.label.trim().length === 0) {
          throw invalidQuestionSet(`Question "${q.id}" has an option with no label.`);
        }
        if (seenValues.has(option.value)) {
          throw invalidQuestionSet(`Question "${q.id}" has a duplicate option value "${option.value}".`);
        }
        seenValues.add(option.value);
        return { value: option.value, label: option.label };
      });
    }

    questions.push({
      id: q.id,
      text: q.text,
      type: q.type,
      required: q.required,
      ...(options ? { options } : {}),
    });
  }

  return questions;
}

/**
 * Validates an admin-authored red-flag rule array against the question set it
 * pairs with — every `questionId` must exist, and every `matchValues` entry
 * must be a value that question can actually produce. This is what stops an
 * admin from authoring a rule that can never fire (a typo'd question id) or
 * always fires vacuously (an option that does not exist).
 */
export function validateRedFlagRules(value: unknown, questions: readonly FollowupQuestion[]): RedFlagRule[] {
  if (!Array.isArray(value)) throw invalidRedFlagRules('redFlagRules must be an array.');
  if (value.length > MAX_RULES) throw invalidRedFlagRules(`redFlagRules must not exceed ${MAX_RULES} entries.`);

  const questionsById = new Map(questions.map((q) => [q.id, q]));
  const seenIds = new Set<string>();
  const rules: RedFlagRule[] = [];

  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) throw invalidRedFlagRules('Each rule must be an object.');
    const r = raw as Record<string, unknown>;

    if (typeof r.id !== 'string' || r.id.trim().length === 0) {
      throw invalidRedFlagRules('Each rule needs a non-empty string id.');
    }
    if (seenIds.has(r.id)) throw invalidRedFlagRules(`Duplicate rule id "${r.id}".`);
    seenIds.add(r.id);

    if (typeof r.questionId !== 'string') throw invalidRedFlagRules(`Rule "${r.id}" needs a questionId.`);
    const question = questionsById.get(r.questionId);
    if (!question) throw invalidRedFlagRules(`Rule "${r.id}" references unknown question "${r.questionId}".`);

    if (!Array.isArray(r.matchValues) || r.matchValues.length === 0) {
      throw invalidRedFlagRules(`Rule "${r.id}" needs a non-empty matchValues array.`);
    }
    const allowed = new Set(impliedOptionValues(question));
    for (const mv of r.matchValues) {
      if (typeof mv !== 'string' || !allowed.has(mv)) {
        throw invalidRedFlagRules(`Rule "${r.id}" has matchValue "${String(mv)}" not offered by question "${question.id}".`);
      }
    }

    if (r.severity !== 'amber' && r.severity !== 'red') {
      throw invalidRedFlagRules(`Rule "${r.id}" has an unknown severity "${String(r.severity)}".`);
    }
    if (typeof r.reason !== 'string' || r.reason.trim().length === 0) {
      throw invalidRedFlagRules(`Rule "${r.id}" needs a non-empty reason.`);
    }
    if (r.reason.length > 255) {
      // Matches `safety_alerts.reason`'s `varchar(255)` — caught here rather
      // than as a 500 from the insert two layers down.
      throw invalidRedFlagRules(`Rule "${r.id}"'s reason must be at most 255 characters.`);
    }
    assertReasonNamesNoDiagnosis(r.reason, r.id);

    rules.push({
      id: r.id,
      questionId: r.questionId,
      matchValues: r.matchValues as string[],
      severity: r.severity,
      reason: r.reason,
    });
  }

  return rules;
}

/**
 * Validates a PATIENT's submitted answers against the PINNED pathway
 * version's question set. Every required question must be answered, and
 * every answer must be a value that question actually offers — the same
 * "cannot vacuously match" discipline `validateRedFlagRules` applies on the
 * admin side, now applied to patient input.
 */
export function validateAnswers(value: unknown, questions: readonly FollowupQuestion[]): FollowupAnswers {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidAnswers('answers must be an object of questionId -> value.');
  }
  const raw = value as Record<string, unknown>;
  const answers: FollowupAnswers = {};

  for (const question of questions) {
    const answer = raw[question.id];
    if (answer === undefined || answer === null) {
      if (question.required) throw invalidAnswers(`Question "${question.id}" is required.`);
      continue;
    }
    if (typeof answer !== 'string') throw invalidAnswers(`Question "${question.id}"'s answer must be a string.`);
    const allowed = new Set(impliedOptionValues(question));
    if (!allowed.has(answer)) {
      throw invalidAnswers(`Question "${question.id}" was answered "${answer}", which is not one of its options.`);
    }
    answers[question.id] = answer;
  }

  return answers;
}

export interface CheckinScoreResult {
  status: CheckinStatus;
  /**
   * Every rule that fired, worst-first. NOT persisted — `checkin-responses
   * .schema.ts`'s own header: "answers plus the pinned pathway version
   * reproduce exactly which rules fired." Returned here so the caller (which
   * DOES persist a `safety_alerts.reason`) has the reason text without a
   * second pass over the same data.
   */
  firedRules: RedFlagRule[];
}

const SEVERITY_RANK: Record<CheckinStatus, number> = { green: 0, amber: 1, red: 2 };

/**
 * FR-13.2 through FR-13.5, applied. `red` always wins over `amber` over
 * `green` regardless of rule order — the worst finding a check-in produces is
 * the one the patient and the system act on, never an earlier, milder one.
 */
export function scoreCheckin(
  questions: readonly FollowupQuestion[],
  redFlagRules: readonly RedFlagRule[],
  answers: FollowupAnswers,
): CheckinScoreResult {
  const fired = redFlagRules.filter((rule) => {
    const answer = answers[rule.questionId];
    return answer !== undefined && rule.matchValues.includes(answer);
  });

  let status: CheckinStatus = 'green';
  for (const rule of fired) {
    if (SEVERITY_RANK[rule.severity] > SEVERITY_RANK[status]) status = rule.severity;
  }

  // Worst-first, so a caller building a single `reason` string can just take
  // `firedRules[0]`.
  fired.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);

  // `void questions` — kept as a parameter for symmetry with `validateAnswers`
  // and because a future rule type (e.g. "two amber questions together") would
  // need the full question set, not just the fired rules. Unused today.
  void questions;

  return { status, firedRules: fired };
}
