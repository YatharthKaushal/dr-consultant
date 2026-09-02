import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { ListedDoctorSummary } from '../../doctor/doctor.contract';
import { DEFAULT_TOOL_RESULT_LIMIT, DOCTOR_TOOL_PORT, MAX_TOOL_RESULT_LIMIT, TOOL_NAMES } from './search-tool.constants';
import type { AgentTool, DoctorToolPort } from './search-tool.contract';

const inputSchema = z.object({
  specialtyId: z.string().uuid().optional().describe('Only doctors offering this specialty. Get the id from list_service_catalogue.'),
  language: z.string().min(1).max(60).optional().describe('Only doctors who speak this language, e.g. "Hindi". Exact match.'),
  maxFeeInr: z.number().int().positive().optional().describe('Only doctors whose consultation fee is at most this many rupees.'),
  limit: z.number().int().min(1).max(MAX_TOOL_RESULT_LIMIT).optional().describe(`How many doctors to return. Default ${DEFAULT_TOOL_RESULT_LIMIT}, maximum ${MAX_TOOL_RESULT_LIMIT}.`),
});

export type ListDoctorsInput = z.infer<typeof inputSchema>;

export interface DoctorListing {
  id: string;
  fullName: string;
  languages: string[];
  qualification: string | null;
  yearsOfExperience: number | null;
  consultationFeeInr: string;
  consultationDurationMinutes: number;
  specialties: Array<{ id: string; code: string; name: string; isPrimary: boolean }>;
}

export interface ListDoctorsOutput {
  doctors: DoctorListing[];
}

/**
 * Deterministic doctor listing: filter, then return, in the order the doctor
 * module produced. There is NO ranking step here and there must never be one
 * driven by a model — which doctor a patient is shown is a platform decision
 * (SRS §7), not something an LLM gets to reorder. The tool takes exactly the
 * filters a patient can express (type of professional, language, budget) and
 * nothing that could act as a relevance knob.
 *
 * `registrationNumber` is dropped on the way out: it is a regulator-facing
 * credential identifier, and an external automation client has no use for it
 * that browsing a doctor's card requires. `bio` is absent for a different
 * reason — the facade's listing projection (`ListedDoctorSummary`) excludes
 * it by design, since unbounded profile prose belongs to FR-4.3's profile
 * screen, not to an FR-4.2 listing row.
 */
@Injectable()
export class ListDoctorsTool implements AgentTool<ListDoctorsInput, ListDoctorsOutput> {
  readonly name = TOOL_NAMES.LIST_DOCTORS;

  readonly description =
    'List doctors currently accepting patients, filtered by professional type, language spoken, and maximum consultation fee. Results are a plain filtered directory listing in the platform\'s own order — they are not ranked or personalised, so present them as options rather than as a recommendation. ' +
    'Use this once you already know which type of professional the patient needs. If you do not yet know, call discover_care with what the patient told you, which decides the professional type and returns doctors for it. ' +
    'Returns an empty list when nothing matches the filters; that means no match, not an error.';

  readonly inputSchema = inputSchema;

  constructor(@Inject(DOCTOR_TOOL_PORT) private readonly doctors: DoctorToolPort) {}

  async execute(input: ListDoctorsInput): Promise<ListDoctorsOutput> {
    const listed = await this.doctors.listListedDoctors({
      specialtyId: input.specialtyId,
      language: input.language,
      maxFeeInr: input.maxFeeInr,
      limit: input.limit ?? DEFAULT_TOOL_RESULT_LIMIT,
    });

    return { doctors: listed.map(toDoctorListing) };
  }
}

/** Shared with `discover-care.tool.ts` so both tools describe a doctor identically. */
export function toDoctorListing(doctor: ListedDoctorSummary): DoctorListing {
  return {
    id: doctor.id,
    fullName: doctor.fullName,
    languages: doctor.languages,
    qualification: doctor.qualification,
    yearsOfExperience: doctor.yearsOfExperience,
    consultationFeeInr: doctor.consultationFeeInr,
    consultationDurationMinutes: doctor.consultationDurationMinutes,
    specialties: doctor.specialties.map((specialty) => ({
      id: specialty.id,
      code: specialty.code,
      name: specialty.name,
      isPrimary: specialty.isPrimary,
    })),
  };
}
