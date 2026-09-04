import type { ClinicalRecordRow } from '../../schema/clinical-records.schema';
import type { CatalogueFacade } from '../catalogue/catalogue.facade';
import type { DoctorFacade } from '../doctor/doctor.facade';
import type { DocumentFacade } from '../document/document.facade';
import type { PatientFacade } from '../patient/patient.facade';
import type { ClinicalBookingPort, ClinicalConsultationView } from './clinical-booking.contract';
import { ClinicalPdfService } from './clinical-pdf.service';

const CONSULTATION_ID = '11111111-1111-4111-8111-111111111111';
const DOCTOR_ID = '22222222-2222-4222-8222-222222222222';
const PATIENT_ID = '44444444-4444-4444-8444-444444444444';
const SPECIALTY_ID = '55555555-5555-4555-8555-555555555555';

function consultation(overrides: Partial<ClinicalConsultationView> = {}): ClinicalConsultationView {
  return {
    id: CONSULTATION_ID,
    referenceCode: 'DC-2026-000123',
    patientId: PATIENT_ID,
    doctorId: DOCTOR_ID,
    specialtyId: SPECIALTY_ID,
    mode: 'scheduled',
    status: 'completed',
    scheduledStartAt: new Date('2026-09-01T10:00:00Z'),
    durationMinutes: 30,
    ...overrides,
  };
}

function record(overrides: Partial<ClinicalRecordRow> = {}): ClinicalRecordRow {
  return {
    id: 'record-1',
    consultationId: CONSULTATION_ID,
    chiefComplaint: 'Low mood for three months.',
    clinicalHistory: null,
    diagnosis: null,
    isDiagnosisProvisional: true,
    riskCategory: 'low',
    referralNote: null,
    medicines: [],
    adviceCovered: null,
    adviceHomePractice: null,
    adviceNextFocus: null,
    adviceWarningSigns: 'Thoughts of self-harm.',
    caseSummary: 'Stable.',
    finalisedAt: new Date('2026-09-01T11:00:00Z'),
    createdAt: new Date('2026-09-01T10:00:00Z'),
    updatedAt: new Date('2026-09-01T11:00:00Z'),
    ...overrides,
  };
}

/** Hand-rolled deps, `new ClinicalPdfService(...)` — never `Test.createTestingModule`. */
function createDeps() {
  const bookings = { getBooking: jest.fn().mockResolvedValue(consultation()), completeConsultation: jest.fn() };
  const patients = { getProfileSummary: jest.fn().mockResolvedValue({ id: PATIENT_ID, fullName: 'Arti Sharma' }) };
  const doctors = {
    getPublicProfile: jest
      .fn()
      .mockResolvedValue({ id: DOCTOR_ID, fullName: 'Dr Rajesh Kumar', qualification: 'MD', registrationNumber: 'MCI-1' }),
  };
  const catalogue = { getSpecialtyById: jest.fn().mockResolvedValue({ id: SPECIALTY_ID, name: 'Psychiatry' }) };
  const documents = { writePrescriptionPdf: jest.fn().mockResolvedValue({ id: 'file-1' }) };

  const service = new ClinicalPdfService(
    bookings as unknown as ClinicalBookingPort,
    patients as unknown as PatientFacade,
    doctors as unknown as DoctorFacade,
    catalogue as unknown as CatalogueFacade,
    documents as unknown as DocumentFacade,
  );

  return { service, bookings, patients, doctors, catalogue, documents };
}

describe('ClinicalPdfService', () => {
  it('*** WRITES THROUGH `DocumentFacade` — the only door a prescription_pdf row has ***', async () => {
    const deps = createDeps();

    const file = await deps.service.generateForConsultation(record(), consultation());

    expect(deps.documents.writePrescriptionPdf).toHaveBeenCalledTimes(1);
    const [input] = deps.documents.writePrescriptionPdf.mock.calls[0] ?? [];
    expect(input).toMatchObject({
      consultationId: CONSULTATION_ID,
      patientId: PATIENT_ID,
      doctorId: DOCTOR_ID,
      fileName: 'prescription-DC-2026-000123.pdf',
    });
    expect((input as { pdf: Buffer }).pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(file).toEqual({ id: 'file-1' });
  });

  it('gathers the patient, doctor and specialty in parallel through their own facades', async () => {
    const deps = createDeps();

    await deps.service.generateForConsultation(record(), consultation());

    expect(deps.patients.getProfileSummary).toHaveBeenCalledWith(PATIENT_ID);
    expect(deps.doctors.getPublicProfile).toHaveBeenCalledWith(DOCTOR_ID);
    expect(deps.catalogue.getSpecialtyById).toHaveBeenCalledWith(SPECIALTY_ID);
  });

  it('re-reads the consultation only when the caller did not already hold it', async () => {
    const deps = createDeps();

    await deps.service.generateForConsultation(record(), consultation());
    expect(deps.bookings.getBooking).not.toHaveBeenCalled();

    await deps.service.generateForConsultation(record());
    expect(deps.bookings.getBooking).toHaveBeenCalledWith(CONSULTATION_ID);
  });

  /* ═══════════════════════════════════════════════════════════════════════ */
  /* Every failure is survivable — a PDF must never un-finalise a record.    */
  /* ═══════════════════════════════════════════════════════════════════════ */

  describe('degradation', () => {
    it('*** RETURNS NULL RATHER THAN THROWING WHEN STORAGE IS DOWN *** — finalisation must not be undone by an outage', async () => {
      const deps = createDeps();
      deps.documents.writePrescriptionPdf.mockRejectedValue(new Error('storage unavailable'));

      await expect(deps.service.generateForConsultation(record(), consultation())).resolves.toBeNull();
    });

    it('still produces a document when the patient, doctor and specialty reads all fail', async () => {
      const deps = createDeps();
      deps.patients.getProfileSummary.mockRejectedValue(new Error('patient module down'));
      deps.doctors.getPublicProfile.mockRejectedValue(new Error('doctor module down'));
      deps.catalogue.getSpecialtyById.mockRejectedValue(new Error('catalogue down'));

      const file = await deps.service.generateForConsultation(record(), consultation());

      expect(file).toEqual({ id: 'file-1' });
      // A prescription that says "Not recorded" where a name should be is
      // still a valid record of what was prescribed; a missing prescription
      // is not.
      expect(deps.documents.writePrescriptionPdf).toHaveBeenCalledTimes(1);
    });

    it('refuses to render a prescription for a record that is NOT finalised', async () => {
      const deps = createDeps();

      await expect(
        deps.service.generateForConsultation(record({ finalisedAt: null }), consultation()),
      ).resolves.toBeNull();
      expect(deps.documents.writePrescriptionPdf).not.toHaveBeenCalled();
    });

    it('returns null when the consultation no longer exists', async () => {
      const deps = createDeps();
      deps.bookings.getBooking.mockResolvedValue(null);

      await expect(deps.service.generateForConsultation(record())).resolves.toBeNull();
    });

    it('handles a consultation with no doctor attached without asking M-05 about `null`', async () => {
      const deps = createDeps();

      const file = await deps.service.generateForConsultation(record(), consultation({ doctorId: null }));

      expect(deps.doctors.getPublicProfile).not.toHaveBeenCalled();
      expect(file).toEqual({ id: 'file-1' });
    });
  });
});
