import { and, eq, gt, inArray, sql, type SQL } from 'drizzle-orm';
import { doctorsTable } from '../../schema/doctors.schema';
import type { DoctorVerificationStatus } from '../../schema/enums.schema';

/**
 * Where a doctor has got to in admin onboarding, and therefore whose move it
 * is next.
 *
 * This is a DERIVED value — no column holds it. It is a total function of
 * three columns the doctors table already owns (`verificationStatus`,
 * `consultationFeeInr`, `isListed`), and it exists because those three
 * columns individually answer "what is true" while an ops team needs "what
 * is blocking".
 *
 * Why it matters operationally: the four lifecycle actions sit behind four
 * separate permissions, and no single non-super-admin role holds all of
 * them. Operations creates and lists, Clinical Governance verifies, Finance
 * prices. `stage` is what tells each of them which doctors are theirs.
 */
export const DOCTOR_ONBOARDING_STAGES = [
  'awaiting_verification',
  'needs_fee',
  'ready_to_list',
  'live',
  'blocked',
] as const;
export type DoctorOnboardingStage = (typeof DOCTOR_ONBOARDING_STAGES)[number];

/**
 * One stage's rule, as data.
 *
 * The rule is declared ONCE, here, and both consumers are generated from it:
 * `deriveDoctorStage` evaluates it in TypeScript for a row already in
 * memory, and `doctorStageCondition` compiles it to SQL for the `stage` list
 * filter. That is the whole point of the indirection — a rule written out
 * twice (once in TS, once in SQL) is a rule that eventually disagrees with
 * itself, and the disagreement shows up as a filter whose results don't
 * match the badges beside them.
 *
 * An omitted field means "don't care".
 */
interface StageRule {
  statusIn: readonly DoctorVerificationStatus[];
  fee?: 'zero' | 'set';
  isListed?: boolean;
}

/**
 * Ordered, mutually exclusive, and exhaustive over
 * (verificationStatus × fee × isListed). `doctor-stage.spec.ts` proves all
 * three properties over the full matrix, so the ordering below is a
 * readability aid rather than something correctness leans on.
 *
 * The one ranking that IS a judgement call: `needs_fee` sits above `live`,
 * so a verified doctor priced at ₹0 reads as needing a fee even if somebody
 * already listed them. A listed doctor on a zero fee is bookable for free —
 * the more urgent problem, not a finished state.
 */
const STAGE_RULES: readonly (readonly [DoctorOnboardingStage, StageRule])[] = [
  ['blocked', { statusIn: ['rejected', 'suspended'] }],
  ['awaiting_verification', { statusIn: ['pending', 'under_review'] }],
  ['needs_fee', { statusIn: ['verified'], fee: 'zero' }],
  ['ready_to_list', { statusIn: ['verified'], fee: 'set', isListed: false }],
  ['live', { statusIn: ['verified'], fee: 'set', isListed: true }],
];

/**
 * True when a `numeric(10,2)` money string is zero — "0", "0.00", "0.0" all
 * count.
 *
 * Deliberately string math. Money in this codebase is a decimal string end
 * to end and never round-trips through `Number()`; that rule does not get an
 * exception just because the comparison happens to be against zero.
 */
export function isZeroFee(consultationFeeInr: string): boolean {
  return /^-?0+(?:\.0+)?$/.test(consultationFeeInr.trim());
}

/** The subset of a doctor row the rule reads — so this is callable from a mapper, a test or a fixture without building a whole `DoctorRow`. */
export interface DoctorStageInput {
  verificationStatus: string;
  consultationFeeInr: string;
  isListed: boolean;
}

function matches(rule: StageRule, row: DoctorStageInput): boolean {
  if (!(rule.statusIn as readonly string[]).includes(row.verificationStatus)) return false;
  if (rule.fee === 'zero' && !isZeroFee(row.consultationFeeInr)) return false;
  if (rule.fee === 'set' && isZeroFee(row.consultationFeeInr)) return false;
  if (rule.isListed !== undefined && rule.isListed !== row.isListed) return false;
  return true;
}

/** Evaluates `STAGE_RULES` against a row in memory. Used by the mapper for every admin doctor read. */
export function deriveDoctorStage(row: DoctorStageInput): DoctorOnboardingStage {
  for (const [stage, rule] of STAGE_RULES) {
    if (matches(rule, row)) return stage;
  }
  // Unreachable: STAGE_RULES is exhaustive over the enum (proven in the
  // spec). Falling back to `blocked` rather than throwing keeps a listing
  // read from 500-ing if a new verification status is ever added to the
  // enum without a rule — it degrades to "needs attention", which is true.
  return 'blocked';
}

/**
 * Compiles the same rule to a WHERE predicate for the `stage` list filter.
 *
 * A predicate rather than a selected CASE column, so the composite index on
 * (`verification_status`, `is_listed`) can still drive the scan — filtering
 * on a computed output column would force a sequential scan.
 *
 * Because the rules are mutually exclusive, each stage's predicate is just
 * its own conjunction; no branch has to restate its predecessors' negation.
 */
export function doctorStageCondition(stage: DoctorOnboardingStage): SQL {
  const entry = STAGE_RULES.find(([name]) => name === stage);
  if (!entry) return sql`false`;
  const [, rule] = entry;

  const conditions: SQL[] = [
    inArray(doctorsTable.verificationStatus, [...rule.statusIn]),
  ];
  if (rule.fee === 'zero') conditions.push(eq(doctorsTable.consultationFeeInr, '0'));
  if (rule.fee === 'set') conditions.push(gt(doctorsTable.consultationFeeInr, '0'));
  if (rule.isListed !== undefined) conditions.push(eq(doctorsTable.isListed, rule.isListed));

  return and(...conditions) as SQL;
}

/** Exposed for the spec, so the exhaustiveness/exclusivity proof runs against the real table rather than a copy of it. */
export const __STAGE_RULES_FOR_TEST = STAGE_RULES;
