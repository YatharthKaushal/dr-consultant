import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import type { PublicDoctorProfile } from '../../doctor/doctor.contract';
import { DoctorToolAdapter } from './doctor-tool.adapter';
import { CATALOGUE_TOOL_PORT, TOOL_ERROR_CODES, TOOL_NAMES } from './search-tool.constants';
import type { AgentTool, CatalogueToolPort } from './search-tool.contract';

const inputSchema = z.object({
  specialtyId: z.string().uuid().optional().describe('The specialty id from list_service_catalogue. Provide this or specialtyCode.'),
  specialtyCode: z.string().min(1).max(60).optional().describe('The specialty code, e.g. "psychiatry". Provide this or specialtyId.'),
});

export type GetServiceDetailsInput = z.infer<typeof inputSchema>;

export interface FeeRangeInr {
  /** Lowest fee among currently listed doctors, as a decimal string in INR. */
  min: string;
  max: string;
}

export interface ServiceDirectory {
  /** How many verified, listed doctors currently offer this specialty. */
  doctorCount: number;
  /** `null` when `doctorCount` is 0 — there is no range to report, which is NOT the same as a range of zero. */
  feeRangeInr: FeeRangeInr | null;
  /** Every language spoken by at least one of those doctors, deduplicated and sorted. */
  languages: string[];
}

export interface GetServiceDetailsOutput {
  specialty: {
    id: string;
    code: string;
    name: string;
    description: string | null;
    canPrescribe: boolean;
  };
  /**
   * `null` ONLY when the doctor directory cannot be read in this deployment
   * (see `DoctorToolAdapter`). It is never null merely because a specialty
   * has no doctors — that case is `doctorCount: 0`.
   */
  directory: ServiceDirectory | null;
}

/**
 * Computes the min/max fee across doctors. Fees arrive as decimal STRINGS
 * (`doctors.consultation_fee_inr` is `numeric`, which the node-postgres
 * driver reads as a string to avoid float rounding). Comparison is numeric,
 * but the values returned are the original strings, so "1500.00" is reported
 * exactly as stored rather than re-formatted into "1500".
 *
 * Exported for its own direct unit tests (zero / one / many doctors).
 */
export function computeFeeRange(doctors: ReadonlyArray<Pick<PublicDoctorProfile, 'consultationFeeInr'>>): FeeRangeInr | null {
  let min: { raw: string; value: number } | null = null;
  let max: { raw: string; value: number } | null = null;

  for (const doctor of doctors) {
    const value = Number(doctor.consultationFeeInr);
    if (!Number.isFinite(value)) {
      // A malformed numeric string cannot be ordered; skipping it is safer
      // than letting NaN silently win every comparison and erase the range.
      continue;
    }
    if (min === null || value < min.value) {
      min = { raw: doctor.consultationFeeInr, value };
    }
    if (max === null || value > max.value) {
      max = { raw: doctor.consultationFeeInr, value };
    }
  }

  return min !== null && max !== null ? { min: min.raw, max: max.raw } : null;
}

/** Union of every doctor's languages, deduplicated and sorted for a stable response. */
export function collectLanguages(doctors: ReadonlyArray<Pick<PublicDoctorProfile, 'languages'>>): string[] {
  const seen = new Set<string>();
  for (const doctor of doctors) {
    for (const language of doctor.languages) {
      seen.add(language);
    }
  }
  return [...seen].sort();
}

@Injectable()
export class GetServiceDetailsTool implements AgentTool<GetServiceDetailsInput, GetServiceDetailsOutput> {
  readonly name = TOOL_NAMES.GET_SERVICE_DETAILS;

  readonly description =
    'Get the full picture of one professional type: what it is, whether it can prescribe, how many doctors currently offer it, the consultation fee range in INR, and which languages those doctors speak. ' +
    'This is the tool for questions like "what does psychiatry cost?" or "is anyone available who speaks Hindi?". Identify the specialty by id or by code from list_service_catalogue. ' +
    'The "directory" field is null only if the doctor directory cannot be read right now — if it is null, say you cannot look up fees at the moment; never guess or quote a price. A directory with doctorCount 0 means nobody currently offers this specialty, and feeRangeInr will be null.';

  readonly inputSchema = inputSchema;

  constructor(
    @Inject(CATALOGUE_TOOL_PORT) private readonly catalogue: CatalogueToolPort,
    private readonly doctors: DoctorToolAdapter,
  ) {}

  async execute(input: GetServiceDetailsInput): Promise<GetServiceDetailsOutput> {
    const specialties = await this.catalogue.listActiveSpecialties();
    const specialty = specialties.find(
      (candidate) => (input.specialtyId !== undefined && candidate.id === input.specialtyId) || (input.specialtyCode !== undefined && candidate.code === input.specialtyCode),
    );

    if (!specialty) {
      throw new NotFoundException({
        code: TOOL_ERROR_CODES.SPECIALTY_NOT_FOUND,
        message: 'No active specialty matches that id or code. Call list_service_catalogue for the current list.',
      });
    }

    const summary = {
      id: specialty.id,
      code: specialty.code,
      name: specialty.name,
      description: specialty.description,
      canPrescribe: specialty.canPrescribe,
    };

    // Answer with the specialty facts we can actually prove even when the
    // doctor directory is unreadable, rather than failing the whole call —
    // the description, and whether this type can prescribe, are genuinely
    // useful on their own. `directory: null` says "cannot look up", which the
    // tool description tells the agent not to paper over with a guess.
    if (!this.doctors.isAvailable()) {
      return { specialty: summary, directory: null };
    }

    const listed = await this.doctors.listListedDoctors({ specialtyId: specialty.id });

    return {
      specialty: summary,
      directory: {
        doctorCount: listed.length,
        feeRangeInr: computeFeeRange(listed),
        languages: collectLanguages(listed),
      },
    };
  }
}
