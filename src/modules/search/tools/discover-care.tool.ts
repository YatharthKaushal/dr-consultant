import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { ListedDoctorSummary } from '../../doctor/doctor.contract';
import { toDoctorListing, type DoctorListing } from './list-doctors.tool';
import { CATALOGUE_TOOL_PORT, DEFAULT_TOOL_RESULT_LIMIT, DISCOVERY_PORT, DOCTOR_TOOL_PORT, MAX_TOOL_RESULT_LIMIT, TOOL_NAMES } from './search-tool.constants';
import type { AgentTool, CatalogueToolPort, CrisisGuidance, DiscoveryPort, DoctorToolPort } from './search-tool.contract';

const inputSchema = z.object({
  text: z.string().min(1).max(2000).describe("What the patient said about their problem, in their own words. Pass it through as they wrote it — do not summarise, translate, clean up or diagnose it first."),
  locale: z.string().min(2).max(35).optional().describe('Optional BCP-47 locale of the text, e.g. "hi-IN", to help interpretation.'),
  limit: z.number().int().min(1).max(MAX_TOOL_RESULT_LIMIT).optional().describe(`How many doctors to return. Default ${DEFAULT_TOOL_RESULT_LIMIT}, maximum ${MAX_TOOL_RESULT_LIMIT}.`),
});

export type DiscoverCareInput = z.infer<typeof inputSchema>;

export interface DiscoveredConcern {
  id: string;
  code: string;
  name: string;
}

export interface RecommendedSpecialty {
  id: string;
  code: string;
  name: string;
  description: string | null;
  canPrescribe: boolean;
}

/**
 * THE CRISIS BRANCH. `doctors` is typed `readonly []` — the empty tuple — so
 * the type system itself rejects any code that tries to put a doctor in a
 * crisis response. See the class comment for why that is a type-level
 * concern and not merely a runtime one.
 */
export interface DiscoverCareCrisisOutput {
  outcome: 'crisis';
  guidance: CrisisGuidance;
  doctors: readonly [];
}

export interface DiscoverCareRoutedOutput {
  outcome: 'routed';
  concerns: DiscoveredConcern[];
  recommendedSpecialties: RecommendedSpecialty[];
  doctors: DoctorListing[];
  matchReason?: string;
}

export type DiscoverCareOutput = DiscoverCareCrisisOutput | DiscoverCareRoutedOutput;

/**
 * The high-level entry point: free text in, either a crisis response or a
 * routed one out.
 *
 * THE CRISIS RULE (SRS FR-5.6 / §6.3) — non-negotiable
 * ----------------------------------------------------
 * When discovery reports a crisis, this tool returns emergency guidance and
 * ZERO doctor results. Not "doctors de-prioritised", not "doctors plus a
 * warning banner" — nothing else, structurally.
 *
 * The reasoning is about who controls the rendering. Over MCP the consumer is
 * a third-party automation client, and we cannot compel it to display our
 * emergency message, respect an ordering, or honour a flag. Anything we send
 * alongside the guidance is something that client may show INSTEAD of it. So
 * the mitigation is not a stronger instruction, it is an empty payload: when
 * the only thing in the response is the guidance, the only thing there is to
 * render is the guidance.
 *
 * Enforced three ways, deliberately redundant:
 *   1. `DiscoveryResult`'s crisis branch carries no concern or specialty ids
 *      at all, so there is nothing to look doctors up FROM.
 *   2. `execute` returns before any doctor lookup runs — the directory is
 *      never even queried on a crisis path.
 *   3. `DiscoverCareCrisisOutput.doctors` is typed `readonly []`, so a future
 *      edit that tries to populate it fails to compile.
 * `discover-care.tool.spec.ts` asserts (2) and the resulting empty list.
 *
 * NAVIGATION, NOT DIAGNOSIS (SRS §2.4 / §8): the returned concerns are
 * routing labels drawn from a curated taxonomy, not clinical findings, and
 * the doctor list is a deterministic directory query. Nothing here decides
 * what is wrong with anyone.
 */
@Injectable()
export class DiscoverCareTool implements AgentTool<DiscoverCareInput, DiscoverCareOutput> {
  readonly name = TOOL_NAMES.DISCOVER_CARE;

  readonly description =
    'Turn what a patient said about their problem, in their own words, into the right next step: the concerns it maps to, which type of professional handles them, and doctors available for that type. This is the main entry point when someone describes how they are feeling rather than asking for a specific service. ' +
    'Pass the patient\'s wording through unchanged — do not summarise it or decide the specialty yourself; this tool makes that decision. ' +
    'IMPORTANT: if the result has outcome "crisis" it will contain emergency guidance and an EMPTY doctor list. You must show that guidance to the patient as written, and you must not offer doctors, appointments or alternatives in that turn. ' +
    'Otherwise the result has outcome "routed" with concerns, recommended professional types and a doctor list. These are navigation results, not a diagnosis — never tell the patient what condition they have.';

  readonly inputSchema = inputSchema;

  constructor(
    @Inject(DISCOVERY_PORT) private readonly discovery: DiscoveryPort,
    @Inject(CATALOGUE_TOOL_PORT) private readonly catalogue: CatalogueToolPort,
    @Inject(DOCTOR_TOOL_PORT) private readonly doctors: DoctorToolPort,
  ) {}

  async execute(input: DiscoverCareInput): Promise<DiscoverCareOutput> {
    const result = await this.discovery.discover({
      text: input.text,
      source: 'mcp',
      ...(input.locale === undefined ? {} : { locale: input.locale }),
    });

    // Crisis: return here, before anything touches the catalogue or the
    // doctor directory. See the class comment.
    if (result.outcome === 'crisis') {
      return { outcome: 'crisis', guidance: result.guidance, doctors: [] };
    }

    const limit = input.limit ?? DEFAULT_TOOL_RESULT_LIMIT;
    const [concerns, specialties] = await Promise.all([
      this.resolveConcerns(result.interpretedConcernIds),
      this.resolveSpecialties(result.recommendedSpecialtyIds),
    ]);

    return {
      outcome: 'routed',
      concerns,
      recommendedSpecialties: specialties,
      doctors: await this.listDoctorsFor(specialties, limit),
      ...(result.matchReason === undefined ? {} : { matchReason: result.matchReason }),
    };
  }

  private async resolveConcerns(ids: string[]): Promise<DiscoveredConcern[]> {
    const concerns = await this.catalogue.getConcernsByIds(ids);
    // Reordered to the pipeline's own id order — `getConcernsByIds` is a
    // set lookup and gives no ordering guarantee, but the pipeline's order
    // is meaningful (strongest match first, FR-5.4).
    const byId = new Map(concerns.map((concern) => [concern.id, concern]));
    return ids
      .map((id) => byId.get(id))
      .filter((concern): concern is NonNullable<typeof concern> => concern !== undefined)
      .map((concern) => ({ id: concern.id, code: concern.code, name: concern.name }));
  }

  private async resolveSpecialties(ids: string[]): Promise<RecommendedSpecialty[]> {
    const active = await this.catalogue.listActiveSpecialties();
    const byId = new Map(active.map((specialty) => [specialty.id, specialty]));
    // Same ordering discipline, and a specialty deactivated since the
    // pipeline ran simply drops out rather than being recommended.
    return ids
      .map((id) => byId.get(id))
      .filter((specialty): specialty is NonNullable<typeof specialty> => specialty !== undefined)
      .map((specialty) => ({
        id: specialty.id,
        code: specialty.code,
        name: specialty.name,
        description: specialty.description,
        canPrescribe: specialty.canPrescribe,
      }));
  }

  /**
   * Deterministic and NEVER model-ranked: one directory query per recommended
   * specialty, in the pipeline's recommendation order, concatenated and
   * deduplicated by doctor id. A doctor holding two recommended specialties
   * appears once, at the position of the higher-recommended one.
   */
  private async listDoctorsFor(specialties: RecommendedSpecialty[], limit: number): Promise<DoctorListing[]> {
    const collected: ListedDoctorSummary[] = [];
    const seen = new Set<string>();

    for (const specialty of specialties) {
      if (collected.length >= limit) {
        break;
      }
      const batch = await this.doctors.listListedDoctors({ specialtyId: specialty.id, limit });
      for (const doctor of batch) {
        if (!seen.has(doctor.id)) {
          seen.add(doctor.id);
          collected.push(doctor);
        }
      }
    }

    return collected.slice(0, limit).map(toDoctorListing);
  }
}
