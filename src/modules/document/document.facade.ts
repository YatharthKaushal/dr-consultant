import { Injectable } from '@nestjs/common';
import type { DocumentContract, PatientFileView, WritePrescriptionPdfInput } from './document.contract';
import { PatientFileService } from './patient-file.service';

@Injectable()
export class DocumentFacade implements DocumentContract {
  constructor(private readonly files: PatientFileService) {}

  async getPatientFileById(fileId: string): Promise<PatientFileView | null> {
    return this.files.getPatientFileById(fileId);
  }

  /** *** M-15 CALLS THIS. *** See `DocumentContract#writePrescriptionPdf` — the only door a `prescription_pdf` row can come through. */
  async writePrescriptionPdf(input: WritePrescriptionPdfInput): Promise<PatientFileView> {
    return this.files.writePrescriptionPdf(input);
  }

  /** *** M-21 CALLS THIS. *** See `DocumentContract#countDataRightsRowsForPatient` — a pure, read-only count, nothing here is anonymized or deleted. */
  async countDataRightsRowsForPatient(input: {
    patientId: string;
    consultationIds: readonly string[];
  }): Promise<{ patientFiles: number; reportRequests: number }> {
    return this.files.countDataRightsRowsForPatient(input);
  }
}
