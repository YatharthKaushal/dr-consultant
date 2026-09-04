import { DocumentFacade } from './document.facade';
import type { PatientFileService } from './patient-file.service';

const PATIENT_ID = '11111111-1111-4111-8111-111111111111';
const CONSULTATION_ID = '22222222-2222-4222-8222-222222222222';

function createFacade() {
  const files = {
    getPatientFileById: jest.fn().mockResolvedValue(null),
    writePrescriptionPdf: jest.fn(),
    countDataRightsRowsForPatient: jest.fn().mockResolvedValue({ patientFiles: 3, reportRequests: 1 }),
  };
  return { facade: new DocumentFacade(files as unknown as PatientFileService), files };
}

describe('DocumentFacade', () => {
  /**
   * *** M-21 CALLS THIS. *** A pure row count for a patient data-deletion
   * preview — see `document.contract.ts#DocumentContract.countDataRightsRowsForPatient`.
   * Nothing here writes.
   */
  it('delegates the M-21 data-rights row count', async () => {
    const { facade, files } = createFacade();
    const input = { patientId: PATIENT_ID, consultationIds: [CONSULTATION_ID] };

    await expect(facade.countDataRightsRowsForPatient(input)).resolves.toEqual({
      patientFiles: 3,
      reportRequests: 1,
    });
    expect(files.countDataRightsRowsForPatient).toHaveBeenCalledWith(input);
  });

  it('passes an empty consultationIds list straight through — the empty-array guard lives in the repository, not here', async () => {
    const { facade, files } = createFacade();
    const input = { patientId: PATIENT_ID, consultationIds: [] as readonly string[] };

    await facade.countDataRightsRowsForPatient(input);

    expect(files.countDataRightsRowsForPatient).toHaveBeenCalledWith(input);
  });
});
