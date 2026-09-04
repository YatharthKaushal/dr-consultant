import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ClinicalRecordRow } from '../../schema/clinical-records.schema';
import { CatalogueFacade } from '../catalogue/catalogue.facade';
import { DoctorFacade } from '../doctor/doctor.facade';
import { DocumentFacade } from '../document/document.facade';
import type { PatientFileView } from '../document/document.contract';
import { PatientFacade } from '../patient/patient.facade';
import type { ClinicalBookingPort, ClinicalConsultationView } from './clinical-booking.contract';
import { CLINICAL_BOOKING_PORT, CLINICAL_PDF_FILE_NAME_PREFIX } from './clinical.constants';
import { parseMedicineLines } from './clinical-medicine.util';
import { toClinicalAdvice } from './clinical.mapper';
import { findUnicodeFont, renderPrescriptionPdf, type PrescriptionDocumentData } from './clinical-pdf.renderer';

/**
 * FR-9.5's "structured form that generates the patient PDF" and FR-14.2's
 * "view and download the prescription PDF, with warning signs and the doctor's
 * follow-up plan".
 *
 * ── THE DIVISION OF LABOUR ─────────────────────────────────────────────────
 *
 * This class GATHERS (four facades, no SQL of its own) and STORES (one facade
 * call). `clinical-pdf.renderer.ts` DRAWS, as a pure function of the gathered
 * data. Splitting them is what lets the layout be tested without a database and
 * the gathering be tested without parsing a PDF.
 *
 * ── WRITING GOES THROUGH `DocumentFacade`, AND ONLY THROUGH IT ─────────────
 *
 * `patient_files` is M-10's table. `document.constants.ts` rejects
 * `prescription_pdf` on the patient upload path BY NAME, and
 * `DocumentContract.writePrescriptionPdf` is the counterpart door — the only
 * way such a row is ever created. This module never touches `patient_files`,
 * never mints a storage key, and never learns one: retrieval is the existing
 * access-controlled signed-URL path (`GET /documents/:id/download`, FR-6.1),
 * which already admits the owning patient, the treating doctor and an admin,
 * and admits nobody else.
 *
 * ── EVERY FAILURE HERE IS SURVIVABLE, ON PURPOSE ───────────────────────────
 *
 * `generateForConsultation` returns `null` rather than throwing when it cannot
 * produce a file. A storage outage, a missing font, a facade that is briefly
 * unreachable — none of those may un-finalise a clinical record or block a
 * doctor's completion gate from clearing. The record is the source of truth and
 * the PDF is derived from it, so the PDF can always be produced again:
 * `POST /consultations/:id/clinical-record/prescription-pdf` re-runs exactly
 * this path, and `writePrescriptionPdf` is idempotent, so a retry cannot fork
 * one consultation into two prescriptions.
 */
@Injectable()
export class ClinicalPdfService {
  private readonly logger = new Logger(ClinicalPdfService.name);
  /** Emitted once per process, not once per prescription — a broken deploy should be loud, not a log flood. */
  private warnedAboutMissingFont = false;

  constructor(
    @Inject(CLINICAL_BOOKING_PORT) private readonly bookings: ClinicalBookingPort,
    private readonly patients: PatientFacade,
    private readonly doctors: DoctorFacade,
    private readonly catalogue: CatalogueFacade,
    private readonly documents: DocumentFacade,
  ) {}

  /**
   * Renders and stores the prescription for a FINALISED record, or returns
   * `null` if anything went wrong (already logged).
   *
   * The consultation is passed in when the caller already holds it — the
   * finalise path does — so a freshly-read row is not fetched twice.
   */
  async generateForConsultation(
    record: ClinicalRecordRow,
    consultation?: ClinicalConsultationView | null,
  ): Promise<PatientFileView | null> {
    try {
      const booking = consultation ?? (await this.bookings.getBooking(record.consultationId));
      if (!booking) {
        this.logger.warn(`Cannot generate a prescription for consultation ${record.consultationId}: it no longer exists.`);
        return null;
      }
      if (!record.finalisedAt) {
        // Defensive: nothing in this module calls this for a draft. A
        // prescription is a statement that the clinical work is complete, and
        // rendering one from a half-written record would make that statement
        // falsely.
        this.logger.warn(`Refusing to generate a prescription for consultation ${record.consultationId}: the record is not finalised.`);
        return null;
      }

      const data = await this.gather(record, booking, record.finalisedAt);
      const fontPath = findUnicodeFont();
      if (!fontPath && !this.warnedAboutMissingFont) {
        this.warnedAboutMissingFont = true;
        this.logger.error(
          'assets/fonts/Lohit-Devanagari.ttf is missing. Prescription PDFs are falling back to Helvetica, which is Latin-1 — ' +
            'any Devanagari patient or doctor name WILL render incorrectly. See assets/fonts/README.md.',
        );
      }

      const pdf = await renderPrescriptionPdf(data, fontPath);

      return await this.documents.writePrescriptionPdf({
        consultationId: booking.id,
        patientId: booking.patientId,
        doctorId: booking.doctorId,
        fileName: `${CLINICAL_PDF_FILE_NAME_PREFIX}-${booking.referenceCode}.pdf`,
        pdf,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(`Prescription PDF generation failed for consultation ${record.consultationId}: ${detail}`);
      return null;
    }
  }

  /**
   * Four facade reads, in parallel — none depends on another's result, and a
   * doctor waiting on their own "finalise" button should not pay for them
   * serially.
   *
   * Every one of them degrades to `null` rather than failing the document. A
   * prescription whose header says "Not recorded" where a specialty name should
   * be is still a valid clinical record of what was prescribed; a prescription
   * that does not exist because M-06 was briefly slow is not.
   */
  private async gather(
    record: ClinicalRecordRow,
    booking: ClinicalConsultationView,
    finalisedAt: Date,
  ): Promise<PrescriptionDocumentData> {
    const [patient, doctor, specialty] = await Promise.all([
      this.patients.getProfileSummary(booking.patientId).catch(() => null),
      booking.doctorId ? this.doctors.getPublicProfile(booking.doctorId).catch(() => null) : Promise.resolve(null),
      this.catalogue.getSpecialtyById(booking.specialtyId).catch(() => null),
    ]);

    return {
      referenceCode: booking.referenceCode,
      // The date the consultation was HELD where there is one, falling back to
      // when it was documented. An instant consult has no `scheduledStartAt`.
      consultedOn: booking.scheduledStartAt ?? finalisedAt,
      patientName: patient?.fullName ?? null,
      doctorName: doctor?.fullName ?? null,
      doctorQualification: doctor?.qualification ?? null,
      doctorRegistrationNumber: doctor?.registrationNumber ?? null,
      specialtyName: specialty?.name ?? null,
      chiefComplaint: record.chiefComplaint,
      diagnosis: record.diagnosis,
      isDiagnosisProvisional: record.isDiagnosisProvisional,
      riskCategory: record.riskCategory,
      referralNote: record.referralNote,
      medicines: parseMedicineLines(record.medicines, 'template'),
      advice: toClinicalAdvice(record),
      finalisedAt,
    };
  }
}
