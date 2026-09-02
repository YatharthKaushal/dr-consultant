import { Injectable } from '@nestjs/common';
import type { CatalogueContract, PublicConcern, PublicSpecialty } from './catalogue.contract';
import { ConcernService } from './concern.service';
import { SpecialtyService } from './specialty.service';

@Injectable()
export class CatalogueFacade implements CatalogueContract {
  constructor(
    private readonly specialtyService: SpecialtyService,
    private readonly concernService: ConcernService,
  ) {}

  async getSpecialtyById(id: string): Promise<PublicSpecialty | null> {
    return this.specialtyService.getPublicById(id);
  }

  async listActiveSpecialties(): Promise<PublicSpecialty[]> {
    return this.specialtyService.listActive();
  }

  async getConcernById(id: string): Promise<PublicConcern | null> {
    return this.concernService.getPublicById(id);
  }
}
