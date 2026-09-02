import { Injectable } from '@nestjs/common';
import type { ListedDoctorSummary } from '../doctor/doctor.contract';

/**
 * *** STAGE 5. DETERMINISTIC RANKING. NO MODEL, EVER. ***
 *
 * PURE FUNCTIONS — candidates, the specialty mapping from stage 4, and each
 * doctor's earliest bookable slot are all fetched by the caller and handed
 * in, so every test here runs without a database or a mock, exactly like
 * `availability-slot.engine.ts`.
 *
 * This is where SRS §7's "curated symptom-to-specialty mapping layer, so
 * behaviour stays explainable and admin-controllable" is actually cashed in.
 * The model never sees a doctor, never orders one, and never learns that
 * doctors exist. It maps free text onto the curated taxonomy; from stage 3
 * onwards every decision is this arithmetic, which means any result can be
 * explained to a patient, replayed by an admin, and changed from the admin
 * panel without a release.
 *
 * ---------------------------------------------------------------------------
 * FILTERS (hard, FR-4.4) are applied BEFORE scoring, so a filtered-out doctor
 * cannot occupy a result slot: languages, `maxFeeInr`, `availableWithinDays`.
 *
 * SIGNALS, each normalised to 0..1 and combined by the weights below:
 *
 *   specialtyFit    the strongest signal, because it is the curated one.
 *                   1.0 for a doctor whose PRIMARY specialty is a matched
 *                   specialty, SECONDARY_SPECIALTY_FIT for a secondary
 *                   match. A doctor practising psychiatry primarily should
 *                   outrank one who lists it second, which is exactly what
 *                   `doctor_specialties.is_primary` is for.
 *   concernFit      how strongly the query matched THAT specialty, relative
 *                   to the best-matching specialty in this result set. Keeps
 *                   `matchWeight` (the admin's own lever on the taxonomy)
 *                   influencing doctor order, not just concern order.
 *   availability    FR-4.2/4.4's "live availability". Linear decay from 1.0
 *                   (bookable now) to 0.0 (at the lookahead horizon); no
 *                   bookable slot at all scores 0 but is NOT excluded unless
 *                   the patient actually filtered on availability.
 *   language        FR-4.4. 1.0 when the doctor speaks a requested language.
 *   fee             FR-4.4. Cheapest in the candidate set scores 1.0, dearest
 *                   0.0, linear between. Relative, not absolute: "cheap" only
 *                   means anything against the other results on the screen.
 *
 * When the patient expressed no preference for a signal, that signal scores
 * 1.0 for EVERY candidate, so it contributes a constant and cannot distort
 * an order it was never asked to influence.
 *
 * TIE-BREAK: equal totals sort by `doctor.id` ascending. Not cosmetic — two
 * identical requests must return identically ordered results, or a patient
 * paging through them sees doctors appear twice and others not at all.
 */

const WEIGHTS = {
  specialtyFit: 0.4,
  concernFit: 0.2,
  availability: 0.2,
  language: 0.1,
  fee: 0.1,
} as const;

/** A secondary specialty is a real match, but not the doctor's own headline practice. */
const SECONDARY_SPECIALTY_FIT = 0.6;

/** One matched specialty from stage 4, with the concerns that mapped onto it. */
export interface SpecialtyMatch {
  specialtyId: string;
  specialtyCode: string;
  specialtyName: string;
  /** Aggregated concern score that mapped onto this specialty. Comparable within one request only. */
  score: number;
  concernIds: string[];
  concernNames: string[];
}

export interface RankingFilters {
  /** FR-4.4. Case-insensitive; a doctor must speak at least one. */
  languages?: readonly string[];
  /** FR-4.4. Inclusive ceiling, decimal string — `consultationFeeInr` is a `numeric` column. */
  maxFeeInr?: string;
  /** FR-4.4. Excludes doctors with no bookable slot inside this many days. */
  availableWithinDays?: number;
}

export interface RankDoctorsInput {
  candidates: readonly ListedDoctorSummary[];
  /** Stage 4's output. Empty for a plain browse (`GET /search/doctors` with no concern), which makes specialty and concern fit neutral. */
  specialtyMatches: readonly SpecialtyMatch[];
  /** Earliest bookable slot per doctor id; a missing entry is treated the same as `null`. */
  earliestSlotByDoctorId: ReadonlyMap<string, Date | null>;
  filters: RankingFilters;
  now: Date;
  /** Horizon the availability signal decays over. */
  lookaheadDays: number;
  /** `undefined` means no cap. */
  limit?: number;
}

export interface RankedDoctor {
  doctor: ListedDoctorSummary;
  /** 0..1, weighted sum of the signals below. NOT a clinical score and never presented as one. */
  score: number;
  /** Per-signal breakdown, so an admin can see exactly why this doctor placed where it did. */
  signals: {
    specialtyFit: number;
    concernFit: number;
    availability: number;
    language: number;
    fee: number;
  };
  earliestSlotAt: Date | null;
  /** The specialty this doctor matched under, `null` on a plain browse. */
  matchedSpecialty: { id: string; code: string; name: string } | null;
  matchedConcernIds: string[];
  matchedConcernNames: string[];
  /** FR-5.4's "plain-language reason", e.g. "Matched to: sleep, anxiety". Built from curated names only — never model prose. */
  reason: string;
}

function parseFee(fee: string): number {
  const parsed = Number.parseFloat(fee);
  return Number.isFinite(parsed) ? parsed : 0;
}

function speaksAny(doctor: ListedDoctorSummary, wanted: readonly string[]): boolean {
  const spoken = new Set(doctor.languages.map((language) => language.trim().toLowerCase()));
  return wanted.some((language) => spoken.has(language.trim().toLowerCase()));
}

/**
 * FR-5.4. Curated names only: the concerns the query matched, and the
 * specialty they map to. Deliberately not a sentence the model wrote — this
 * string is shown next to a doctor, which is the last place invented text
 * belongs.
 */
export function buildMatchReason(concernNames: readonly string[], specialtyName: string | null): string {
  if (concernNames.length > 0) {
    return `Matched to: ${concernNames.join(', ')}`;
  }
  return specialtyName ? `Practises ${specialtyName}` : 'Available for consultation';
}

/** PURE. Filters, scores and orders the candidate set. */
export function rankDoctors(input: RankDoctorsInput): RankedDoctor[] {
  const { candidates, specialtyMatches, earliestSlotByDoctorId, filters, now, lookaheadDays } = input;

  const matchBySpecialtyId = new Map(specialtyMatches.map((match) => [match.specialtyId, match]));
  const bestMatchScore = specialtyMatches.reduce((max, match) => Math.max(max, match.score), 0);
  const horizonMs = Math.max(1, lookaheadDays) * 24 * 60 * 60 * 1000;

  // --- Hard filters (FR-4.4), applied before any scoring. ---
  const maxFee = filters.maxFeeInr === undefined ? null : parseFee(filters.maxFeeInr);
  const availabilityCutoff =
    filters.availableWithinDays === undefined ? null : new Date(now.getTime() + filters.availableWithinDays * 24 * 60 * 60 * 1000);

  const eligible = candidates.filter((doctor) => {
    if (filters.languages && filters.languages.length > 0 && !speaksAny(doctor, filters.languages)) return false;
    if (maxFee !== null && parseFee(doctor.consultationFeeInr) > maxFee) return false;
    if (availabilityCutoff !== null) {
      const earliest = earliestSlotByDoctorId.get(doctor.id) ?? null;
      if (earliest === null || earliest.getTime() > availabilityCutoff.getTime()) return false;
    }
    return true;
  });

  if (eligible.length === 0) return [];

  // Fee is scored RELATIVE to the surviving candidates, so it is computed
  // after filtering — a doctor excluded by `maxFeeInr` must not stretch the
  // scale the remaining ones are measured on.
  const fees = eligible.map((doctor) => parseFee(doctor.consultationFeeInr));
  const minFee = Math.min(...fees);
  const maxFeeInSet = Math.max(...fees);
  const feeSpread = maxFeeInSet - minFee;

  const ranked: RankedDoctor[] = eligible.map((doctor) => {
    // Best matching specialty for this doctor. PRIMACY DOMINATES SCORE: a
    // doctor listing psychiatry primarily and counselling secondarily, when
    // both matched, is ranked and explained on the primary one — that is
    // their headline practice, and it is what `doctor_specialties.is_primary`
    // is for. Only among specialties of EQUAL primacy does the stronger
    // query match win. (Writing this as a single `||` chain gets it wrong:
    // a later, higher-scoring secondary silently overrides an earlier
    // primary.)
    let matched: { match: SpecialtyMatch; isPrimary: boolean } | null = null;
    for (const specialty of doctor.specialties) {
      const match = matchBySpecialtyId.get(specialty.id);
      if (!match) continue;
      const candidate = { match, isPrimary: specialty.isPrimary };
      if (matched === null || isBetterSpecialtyMatch(candidate, matched)) {
        matched = candidate;
      }
    }

    // No mapping at all (a plain browse) makes both curated signals neutral,
    // so they contribute a constant and leave ordering to the others.
    const specialtyFit =
      specialtyMatches.length === 0 ? 1 : matched === null ? 0 : matched.isPrimary ? 1 : SECONDARY_SPECIALTY_FIT;
    const concernFit =
      specialtyMatches.length === 0 || bestMatchScore <= 0 ? 1 : matched === null ? 0 : matched.match.score / bestMatchScore;

    const earliestSlotAt = earliestSlotByDoctorId.get(doctor.id) ?? null;
    const availability =
      earliestSlotAt === null ? 0 : clamp01(1 - Math.max(0, earliestSlotAt.getTime() - now.getTime()) / horizonMs);

    const language = !filters.languages || filters.languages.length === 0 ? 1 : speaksAny(doctor, filters.languages) ? 1 : 0;
    const fee = feeSpread === 0 ? 1 : clamp01(1 - (parseFee(doctor.consultationFeeInr) - minFee) / feeSpread);

    const signals = { specialtyFit, concernFit, availability, language, fee };
    const score =
      signals.specialtyFit * WEIGHTS.specialtyFit +
      signals.concernFit * WEIGHTS.concernFit +
      signals.availability * WEIGHTS.availability +
      signals.language * WEIGHTS.language +
      signals.fee * WEIGHTS.fee;

    const matchedSpecialty = matched
      ? { id: matched.match.specialtyId, code: matched.match.specialtyCode, name: matched.match.specialtyName }
      : null;

    return {
      doctor,
      score,
      signals,
      earliestSlotAt,
      matchedSpecialty,
      matchedConcernIds: matched ? [...matched.match.concernIds] : [],
      matchedConcernNames: matched ? [...matched.match.concernNames] : [],
      reason: buildMatchReason(matched?.match.concernNames ?? [], matchedSpecialty?.name ?? null),
    };
  });

  ranked.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.doctor.id.localeCompare(b.doctor.id)));
  return input.limit === undefined ? ranked : ranked.slice(0, input.limit);
}

/** Primacy first, then score, then specialty code — total and stable, so a doctor's displayed match never depends on the order their specialties came back in. */
function isBetterSpecialtyMatch(
  candidate: { match: SpecialtyMatch; isPrimary: boolean },
  incumbent: { match: SpecialtyMatch; isPrimary: boolean },
): boolean {
  if (candidate.isPrimary !== incumbent.isPrimary) return candidate.isPrimary;
  if (candidate.match.score !== incumbent.match.score) return candidate.match.score > incumbent.match.score;
  return candidate.match.specialtyCode.localeCompare(incumbent.match.specialtyCode) < 0;
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Injectable wrapper — holds no state and does no I/O, same role as `ConcernMatcherService`. */
@Injectable()
export class DoctorRankerService {
  rank(input: RankDoctorsInput): RankedDoctor[] {
    return rankDoctors(input);
  }
}
