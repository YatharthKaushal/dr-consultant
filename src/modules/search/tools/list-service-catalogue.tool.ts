import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { CATALOGUE_TOOL_PORT, TOOL_NAMES } from './search-tool.constants';
import type { AgentTool, CatalogueToolPort } from './search-tool.contract';

const inputSchema = z.object({}).describe('No arguments.');

export type ListServiceCatalogueInput = z.infer<typeof inputSchema>;

export interface ServiceCatalogueEntry {
  id: string;
  code: string;
  name: string;
  description: string | null;
  /** Whether a professional of this type may issue a prescription. */
  canPrescribe: boolean;
}

export interface ListServiceCatalogueOutput {
  specialties: ServiceCatalogueEntry[];
}

@Injectable()
export class ListServiceCatalogueTool implements AgentTool<ListServiceCatalogueInput, ListServiceCatalogueOutput> {
  readonly name = TOOL_NAMES.LIST_SERVICE_CATALOGUE;

  readonly description =
    'List every type of mental-health professional currently offered on this platform (for example psychiatrist, psychologist, counsellor), with a short description of each and whether that type can prescribe medication. ' +
    'Call this first when the patient asks what kinds of help are available, or when you need a specialty id to pass to get_service_details or list_doctors. ' +
    'Returns the catalogue only — no doctors, no prices, no availability. For the cost and doctor count of one specialty use get_service_details; to pick actual doctors use list_doctors.';

  readonly inputSchema = inputSchema;

  constructor(@Inject(CATALOGUE_TOOL_PORT) private readonly catalogue: CatalogueToolPort) {}

  async execute(_input: ListServiceCatalogueInput): Promise<ListServiceCatalogueOutput> {
    const specialties = await this.catalogue.listActiveSpecialties();

    // Projected field-by-field rather than spread: `PublicSpecialty` also
    // carries `intakeForm`/`firstConsultForm`/`requiredDocuments`, which are
    // booking-flow internals of no use to an agent answering "what help can
    // I get here", and `isActive`, which is always true in this list.
    return {
      specialties: specialties.map((specialty) => ({
        id: specialty.id,
        code: specialty.code,
        name: specialty.name,
        description: specialty.description,
        canPrescribe: specialty.canPrescribe,
      })),
    };
  }
}
