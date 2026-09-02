import { Injectable } from '@nestjs/common';
import type { DocumentContract, PatientFileView } from './document.contract';
import { PatientFileService } from './patient-file.service';

@Injectable()
export class DocumentFacade implements DocumentContract {
  constructor(private readonly files: PatientFileService) {}

  async getPatientFileById(fileId: string): Promise<PatientFileView | null> {
    return this.files.getPatientFileById(fileId);
  }
}
