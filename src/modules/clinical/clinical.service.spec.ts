import { ConflictException, NotFoundException } from '@nestjs/common';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { Database } from '../../config/db/database.config';
import type { ClinicalRecordRow } from '../../schema/clinical-records.schema';
import type { DoctorClinicalTemplateRow } from '../../schema/doctor-clinical-templates.schema';
import type { AuditService } from '../../shared/audit/audit.service';
import type { CatalogueFacade } from '../catalogue/catalogue.facade';
import type { InstantFacade } from '../instant/instant.facade';
import type { ClinicalBookingPort, ClinicalConsultationView } from './clinical-booking.contract';
import { CLINICAL_ERROR_CODES } from './clinical.constants';
import { CLINICAL_RECORD_FINALISED_EVENT } from './clinical.contract';
import type { SaveClinicalRecordDto } from './clinical.dto';
import type { ClinicalPdfService } from './clinical-pdf.service';
import type { ClinicalRepository } from './clinical.repository';
import { ClinicalService } from './clinical.service';
import type { ClinicalTemplateService } from './clinical-template.service';

const CONSULTATION_ID = '11111111-1111-4111-8111-111111111111';
const DOCTOR_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_DOCTOR_ID = '33333333-3333-4333-8333-333333333333';
const PATIENT_ID = '44444444-4444-4444-8444-444444444444';
const SPECIALTY_ID = '55555555-5555-4555-8555-555555555555';
const RECORD_ID = '66666666-6666-4666-8666-666666666666';
const TEMPLATE_ID = '77777777-7777-4777-8777-777777777777';

const MEDICINE = { name: 'Sertraline', dose: '50mg', frequency: 'Once daily', duration: '14 days' };

const FULL_ADVICE = {
  adviceCovered: 'Reviewed sleep and mood.',
  adviceHomePractice: 'Ten minutes of paced breathing at night.',
  adviceNextFocus: 'Behavioural activation.',
  adviceWarningSigns: 'Thoughts of self-harm, or not sleeping for two nights.',
};

function consultation(overrides: Partial<ClinicalConsultationView> = {}): ClinicalConsultationView {
  return {
    id: CONSULTATION_ID,
    referenceCode: 'DC-2026-000123',
    patientId: PATIENT_ID,
    doctorId: DOCTOR_ID,
    specialtyId: SPECIALTY_ID,
    mode: 'scheduled',
    status: 'in_progress',
    scheduledStartAt: new Date('2026-09-01T10:00:00Z'),
    durationMinutes: 30,
    ...overrides,
  };
}

function record(overrides: Partial<ClinicalRecordRow> = {}): ClinicalRecordRow {
  return {
    id: RECORD_ID,
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
    adviceWarningSigns: null,
    caseSummary: null,
    finalisedAt: null,
    createdAt: new Date('2026-09-01T10:00:00Z'),
    updatedAt: new Date('2026-09-01T10:00:00Z'),
    ...overrides,
  };
}

function template(overrides: Partial<DoctorClinicalTemplateRow> = {}): DoctorClinicalTemplateRow {
  return {
    id: TEMPLATE_ID,
    doctorId: DOCTOR_ID,
    specialtyId: null,
    name: 'Standard anxiety start',
    medicines: [],
    adviceCovered: null,
    adviceHomePractice: null,
    adviceNextFocus: null,
    adviceWarningSigns: null,
    createdAt: new Date('2026-08-01T10:00:00Z'),
    updatedAt: new Date('2026-08-01T10:00:00Z'),
    ...overrides,
  };
}

function saveDto(overrides: Partial<SaveClinicalRecordDto> = {}): SaveClinicalRecordDto {
  return { chiefComplaint: 'Low mood for three months.', riskCategory: 'low', ...overrides };
}

/**
 * Hand-rolled deps, `new ClinicalService(...)` — never `Test.createTestingModule`.
 *
 * *** WHAT THE `db.transaction` FAKE DOES AND DOES NOT PROVE. ***
 * It invokes its callback with itself, so the code under test runs, but it has
 * NO ROLLBACK SEMANTICS — the same honest caveat
 * `patient-file.transaction.integration.spec.ts` opens with. These tests
 * therefore assert WHICH RULES FIRE, never that Postgres rolled anything back.
 * Atomicity and the row lock are the integration spec's job.
 */
function createDeps() {
  const db: { transaction: jest.Mock } = {
    transaction: jest.fn(async (callback: (tx: unknown) => unknown) => callback(db)),
  };

  const repo = {
    findByConsultationId: jest.fn(),
    findByConsultationIdForUpdate: jest.fn(),
    create: jest.fn(),
    updateDraft: jest.fn(),
    finalise: jest.fn(),
    listFinalisedSince: jest.fn(),
    listConsultationAuditTrail: jest.fn(),
  };
  const bookings = {
    getBooking: jest.fn(),
    completeConsultation: jest.fn().mockResolvedValue({ changed: true, status: 'completed' }),
  };
  const catalogue = { getSpecialtyById: jest.fn() };
  const instant = {
    clearCompletionGate: jest.fn().mockResolvedValue({ changed: true, doctorId: DOCTOR_ID, blockedByConsultationId: null }),
    getPresence: jest.fn(),
  };
  const templates = { requireOwnTemplateRow: jest.fn() };
  const pdf = { generateForConsultation: jest.fn().mockResolvedValue({ id: 'file-1' }) };
  const audit = { write: jest.fn().mockResolvedValue(undefined) };
  const events = { emit: jest.fn() };

  const service = new ClinicalService(
    db as unknown as Database,
    repo as unknown as ClinicalRepository,
    bookings as unknown as ClinicalBookingPort,
    catalogue as unknown as CatalogueFacade,
    instant as unknown as InstantFacade,
    templates as unknown as ClinicalTemplateService,
    pdf as unknown as ClinicalPdfService,
    audit as unknown as AuditService,
    events as unknown as EventEmitter2,
  );

  return { service, db, repo, bookings, catalogue, instant, templates, pdf, audit, events };
}

/** The happy path every gate test then breaks in exactly one place. */
function arrangeFinalisable(deps: ReturnType<typeof createDeps>, row: ClinicalRecordRow, canPrescribe = false) {
  deps.bookings.getBooking.mockResolvedValue(consultation());
  deps.catalogue.getSpecialtyById.mockResolvedValue({ id: SPECIALTY_ID, canPrescribe });
  deps.repo.findByConsultationId.mockResolvedValue(row);
  deps.repo.findByConsultationIdForUpdate.mockResolvedValue(row);
  deps.repo.finalise.mockImplementation(async (_id: string, finalisedAt: Date) => ({ ...row, finalisedAt }));
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ response: { code } });
}

describe('ClinicalService', () => {
  /* ═══════════════════════════════════════════════════════════════════════ */
  /* DONE-WHEN 1: "a consultation cannot be marked complete with a missing    */
  /* prescription or advice and summary" (docs/MODULES.md M-15, FR-11.5).    */
  /* ═══════════════════════════════════════════════════════════════════════ */

  describe('the completion gate (FR-11.5)', () => {
    it('refuses to finalise with NO case summary, even when the advice plan is complete', async () => {
      const deps = createDeps();
      arrangeFinalisable(deps, record({ ...FULL_ADVICE, caseSummary: null }));

      await expectCode(deps.service.finalise(CONSULTATION_ID, DOCTOR_ID), CLINICAL_ERROR_CODES.CASE_SUMMARY_REQUIRED);
      expect(deps.repo.finalise).not.toHaveBeenCalled();
    });

    it('refuses a case summary that is only whitespace — a space is not a summary', async () => {
      const deps = createDeps();
      arrangeFinalisable(deps, record({ ...FULL_ADVICE, caseSummary: '    \n  ' }));

      await expectCode(deps.service.finalise(CONSULTATION_ID, DOCTOR_ID), CLINICAL_ERROR_CODES.CASE_SUMMARY_REQUIRED);
    });

    it('refuses to finalise with a case summary but NEITHER a medicine NOR advice', async () => {
      const deps = createDeps();
      arrangeFinalisable(deps, record({ caseSummary: 'Stable. Continue plan.' }), true);

      await expectCode(
        deps.service.finalise(CONSULTATION_ID, DOCTOR_ID),
        CLINICAL_ERROR_CODES.PRESCRIPTION_OR_ADVICE_REQUIRED,
      );
      expect(deps.repo.finalise).not.toHaveBeenCalled();
    });

    it('refuses THREE of the four advice fields — a partial care plan is not a care plan', async () => {
      const deps = createDeps();
      arrangeFinalisable(
        deps,
        record({ ...FULL_ADVICE, adviceWarningSigns: null, caseSummary: 'Stable. Continue plan.' }),
      );

      await expectCode(
        deps.service.finalise(CONSULTATION_ID, DOCTOR_ID),
        CLINICAL_ERROR_CODES.PRESCRIPTION_OR_ADVICE_REQUIRED,
      );
    });

    it('refuses advice fields that are only whitespace', async () => {
      const deps = createDeps();
      arrangeFinalisable(deps, record({ ...FULL_ADVICE, adviceNextFocus: '   ', caseSummary: 'Stable.' }));

      await expectCode(
        deps.service.finalise(CONSULTATION_ID, DOCTOR_ID),
        CLINICAL_ERROR_CODES.PRESCRIPTION_OR_ADVICE_REQUIRED,
      );
    });

    it('POSITIVE CONTROL: a non-prescribing consultation finalises on case summary + the complete advice plan', async () => {
      const deps = createDeps();
      arrangeFinalisable(deps, record({ ...FULL_ADVICE, caseSummary: 'Stable. Continue plan.' }));

      const result = await deps.service.finalise(CONSULTATION_ID, DOCTOR_ID);

      expect(deps.repo.finalise).toHaveBeenCalledTimes(1);
      expect(result.record.finalisedAt).toBeInstanceOf(Date);
    });

    it('POSITIVE CONTROL: a prescribing consultation finalises on case summary + one medicine, with no advice at all', async () => {
      const deps = createDeps();
      arrangeFinalisable(deps, record({ medicines: [MEDICINE], caseSummary: 'Started sertraline.' }), true);

      const result = await deps.service.finalise(CONSULTATION_ID, DOCTOR_ID);

      expect(deps.repo.finalise).toHaveBeenCalledTimes(1);
      expect(result.record.medicines).toHaveLength(1);
    });

    it('emits CLINICAL_RECORD_FINALISED_EVENT with the consultation id — the M-16 seam `followup-clinical.listener.ts` listens for', async () => {
      const deps = createDeps();
      arrangeFinalisable(deps, record({ ...FULL_ADVICE, caseSummary: 'Stable. Continue plan.' }));

      await deps.service.finalise(CONSULTATION_ID, DOCTOR_ID);

      expect(deps.events.emit).toHaveBeenCalledWith(CLINICAL_RECORD_FINALISED_EVENT, { consultationId: CONSULTATION_ID });
    });

    it('*** ROUTING AROUND IT: *** re-checks the gate against the LOCKED row, so a draft save that blanks the summary mid-flight cannot slip through', async () => {
      const deps = createDeps();
      // The pre-flight read sees a complete record...
      const complete = record({ ...FULL_ADVICE, caseSummary: 'Stable. Continue plan.' });
      arrangeFinalisable(deps, complete);
      // ...and the row read under `SELECT ... FOR UPDATE` — the authoritative
      // one — has had its summary cleared by a concurrent draft save.
      deps.repo.findByConsultationIdForUpdate.mockResolvedValue({ ...complete, caseSummary: null });

      await expectCode(deps.service.finalise(CONSULTATION_ID, DOCTOR_ID), CLINICAL_ERROR_CODES.CASE_SUMMARY_REQUIRED);
      expect(deps.repo.finalise).not.toHaveBeenCalled();
    });

    it('refuses a second finalise: the record is already final', async () => {
      const deps = createDeps();
      arrangeFinalisable(
        deps,
        record({ ...FULL_ADVICE, caseSummary: 'Stable.', finalisedAt: new Date('2026-09-01T11:00:00Z') }),
      );

      await expectCode(deps.service.finalise(CONSULTATION_ID, DOCTOR_ID), CLINICAL_ERROR_CODES.RECORD_ALREADY_FINALISED);
    });

    it('refuses when the guarded UPDATE loses the race — `finalise` returning null is a conflict, not a silent success', async () => {
      const deps = createDeps();
      arrangeFinalisable(deps, record({ ...FULL_ADVICE, caseSummary: 'Stable.' }));
      deps.repo.finalise.mockResolvedValue(null);

      await expectCode(deps.service.finalise(CONSULTATION_ID, DOCTOR_ID), CLINICAL_ERROR_CODES.RECORD_ALREADY_FINALISED);
    });

    it('refuses to finalise a consultation with no clinical record at all', async () => {
      const deps = createDeps();
      deps.bookings.getBooking.mockResolvedValue(consultation());
      deps.repo.findByConsultationId.mockResolvedValue(null);

      await expectCode(deps.service.finalise(CONSULTATION_ID, DOCTOR_ID), CLINICAL_ERROR_CODES.RECORD_NOT_FOUND);
    });

    it('refuses to finalise a consultation that is already completed', async () => {
      const deps = createDeps();
      deps.bookings.getBooking.mockResolvedValue(consultation({ status: 'completed' }));

      await expectCode(
        deps.service.finalise(CONSULTATION_ID, DOCTOR_ID),
        CLINICAL_ERROR_CODES.CONSULTATION_NOT_WRITABLE,
      );
    });

    it("404s — with the code a stranger gets — when the consultation is another doctor's", async () => {
      const deps = createDeps();
      deps.bookings.getBooking.mockResolvedValue(consultation({ doctorId: OTHER_DOCTOR_ID }));

      await expectCode(
        deps.service.finalise(CONSULTATION_ID, DOCTOR_ID),
        CLINICAL_ERROR_CODES.CONSULTATION_NOT_FOUND,
      );
      await expect(deps.service.finalise(CONSULTATION_ID, DOCTOR_ID)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════ */
  /* *** WHAT FINALISING ACTUALLY FIRES. THE POINT OF THIS MODULE. ***       */
  /* ═══════════════════════════════════════════════════════════════════════ */

  describe('finalising switches on the machinery that was already shipped', () => {
    function arrangeHappyFinalise() {
      const deps = createDeps();
      arrangeFinalisable(deps, record({ ...FULL_ADVICE, caseSummary: 'Stable. Continue plan.' }));
      return deps;
    }

    it('*** CALLS `InstantFacade.clearCompletionGate` — the first caller that method has ever had (FR-10.5) ***', async () => {
      const deps = arrangeHappyFinalise();

      const result = await deps.service.finalise(CONSULTATION_ID, DOCTOR_ID);

      expect(deps.instant.clearCompletionGate).toHaveBeenCalledTimes(1);
      expect(deps.instant.clearCompletionGate).toHaveBeenCalledWith(CONSULTATION_ID);
      expect(result.completionGateCleared).toBe(true);
    });

    it('*** MOVES THE CONSULTATION TO `completed` — which is what makes referral rewards and affiliate accrual qualify ***', async () => {
      const deps = arrangeHappyFinalise();

      const result = await deps.service.finalise(CONSULTATION_ID, DOCTOR_ID);

      expect(deps.bookings.completeConsultation).toHaveBeenCalledWith({
        consultationId: CONSULTATION_ID,
        from: ['in_progress', 'awaiting_documentation'],
        reason: 'clinical_record_finalised',
      });
      expect(result.consultationStatus).toBe('completed');
    });

    it('generates the prescription PDF and reports its file id', async () => {
      const deps = arrangeHappyFinalise();

      const result = await deps.service.finalise(CONSULTATION_ID, DOCTOR_ID);

      expect(deps.pdf.generateForConsultation).toHaveBeenCalledTimes(1);
      expect(result.prescriptionFileId).toBe('file-1');
    });

    it('does the three consequences in order: the record is final BEFORE anything cross-module is attempted', async () => {
      const deps = arrangeHappyFinalise();
      const order: string[] = [];
      deps.repo.finalise.mockImplementation(async (_id: string, finalisedAt: Date) => {
        order.push('finalise');
        return { ...record({ ...FULL_ADVICE, caseSummary: 'Stable.' }), finalisedAt };
      });
      deps.bookings.completeConsultation.mockImplementation(async () => {
        order.push('complete');
        return { changed: true, status: 'completed' };
      });
      deps.instant.clearCompletionGate.mockImplementation(async () => {
        order.push('clearGate');
        return { changed: true, doctorId: DOCTOR_ID, blockedByConsultationId: null };
      });
      deps.pdf.generateForConsultation.mockImplementation(async () => {
        order.push('pdf');
        return { id: 'file-1' };
      });

      await deps.service.finalise(CONSULTATION_ID, DOCTOR_ID);

      expect(order).toEqual(['finalise', 'complete', 'clearGate', 'pdf']);
    });

    it('still clears the gate when the status move was refused — the two consequences are independent', async () => {
      const deps = arrangeHappyFinalise();
      deps.bookings.completeConsultation.mockResolvedValue({
        changed: false,
        status: 'in_progress',
        refusal: 'illegal_transition',
      });

      const result = await deps.service.finalise(CONSULTATION_ID, DOCTOR_ID);

      expect(deps.instant.clearCompletionGate).toHaveBeenCalledTimes(1);
      expect(result.record.finalisedAt).toBeInstanceOf(Date);
    });

    it('*** A THROWING `clearCompletionGate` DOES NOT UN-FINALISE THE RECORD *** — the sweep is the backstop, not a rollback', async () => {
      const deps = arrangeHappyFinalise();
      deps.instant.clearCompletionGate.mockRejectedValue(new Error('instant module unreachable'));

      const result = await deps.service.finalise(CONSULTATION_ID, DOCTOR_ID);

      expect(result.record.finalisedAt).toBeInstanceOf(Date);
      expect(result.completionGateCleared).toBe(false);
      // And the PDF after it is still attempted: one failed consequence must
      // not abandon the next.
      expect(deps.pdf.generateForConsultation).toHaveBeenCalledTimes(1);
    });

    it('a failed PDF leaves a final record with a null file id, never a failed request', async () => {
      const deps = arrangeHappyFinalise();
      deps.pdf.generateForConsultation.mockResolvedValue(null);

      const result = await deps.service.finalise(CONSULTATION_ID, DOCTOR_ID);

      expect(result.prescriptionFileId).toBeNull();
      expect(result.record.finalisedAt).toBeInstanceOf(Date);
    });

    it('writes the finalisation audit row transactionally, carrying the consultation id', async () => {
      const deps = arrangeHappyFinalise();

      await deps.service.finalise(CONSULTATION_ID, DOCTOR_ID);

      const [entry, tx] = deps.audit.write.mock.calls.at(-1) ?? [];
      expect(entry).toMatchObject({
        actorType: 'doctor',
        actorId: DOCTOR_ID,
        entityType: 'clinical_record',
        consultationId: CONSULTATION_ID,
        metadata: expect.objectContaining({ event: 'finalised' }),
      });
      // The second argument is the transaction handle — a finalisation must
      // never exist un-audited.
      expect(tx).toBeDefined();
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════ */
  /* DONE-WHEN 2: "a non-prescribing professional cannot save a medicine".   */
  /* ═══════════════════════════════════════════════════════════════════════ */

  describe('the prescribing gate — every angle', () => {
    it('ANGLE 1 (the form): refuses medicines on a consultation booked under a non-prescribing specialty', async () => {
      const deps = createDeps();
      deps.bookings.getBooking.mockResolvedValue(consultation());
      deps.catalogue.getSpecialtyById.mockResolvedValue({ id: SPECIALTY_ID, canPrescribe: false });

      await expectCode(
        deps.service.saveDraft(CONSULTATION_ID, DOCTOR_ID, saveDto({ medicines: [MEDICINE] })),
        CLINICAL_ERROR_CODES.MEDICINES_NOT_PERMITTED,
      );
      expect(deps.repo.create).not.toHaveBeenCalled();
      expect(deps.repo.updateDraft).not.toHaveBeenCalled();
    });

    it('ANGLE 2 (a template): refuses a template carrying medicines applied to a non-prescribing consultation', async () => {
      const deps = createDeps();
      deps.bookings.getBooking.mockResolvedValue(consultation());
      deps.catalogue.getSpecialtyById.mockResolvedValue({ id: SPECIALTY_ID, canPrescribe: false });
      // A psychiatrist's own template, entirely legitimate where it was authored.
      deps.templates.requireOwnTemplateRow.mockResolvedValue(template({ medicines: [MEDICINE] }));
      deps.repo.findByConsultationId.mockResolvedValue(record());

      await expectCode(
        deps.service.applyTemplate(CONSULTATION_ID, DOCTOR_ID, TEMPLATE_ID),
        CLINICAL_ERROR_CODES.MEDICINES_NOT_PERMITTED,
      );
      expect(deps.repo.updateDraft).not.toHaveBeenCalled();
    });

    it('ANGLE 2b: the refusal is LOUD — medicines are never silently stripped from an applied template', async () => {
      const deps = createDeps();
      deps.bookings.getBooking.mockResolvedValue(consultation());
      deps.catalogue.getSpecialtyById.mockResolvedValue({ id: SPECIALTY_ID, canPrescribe: false });
      deps.templates.requireOwnTemplateRow.mockResolvedValue(template({ medicines: [MEDICINE], ...FULL_ADVICE }));
      deps.repo.findByConsultationId.mockResolvedValue(record());

      await expect(deps.service.applyTemplate(CONSULTATION_ID, DOCTOR_ID, TEMPLATE_ID)).rejects.toBeInstanceOf(
        ConflictException,
      );
      // Not "applied without the medicines" — nothing was written at all.
      expect(deps.db.transaction).not.toHaveBeenCalled();
    });

    it('ANGLE 3 (an unreadable specialty): treats a specialty it cannot read as NON-prescribing', async () => {
      const deps = createDeps();
      deps.bookings.getBooking.mockResolvedValue(consultation());
      deps.catalogue.getSpecialtyById.mockResolvedValue(null);

      await expectCode(
        deps.service.saveDraft(CONSULTATION_ID, DOCTOR_ID, saveDto({ medicines: [MEDICINE] })),
        CLINICAL_ERROR_CODES.MEDICINES_NOT_PERMITTED,
      );
    });

    it('*** READS THE CONSULTATION\'S BOOKING-TIME SPECIALTY, NOT THE DOCTOR *** — `DoctorContract.getPrescribingEligibility` is never consulted here', async () => {
      const deps = createDeps();
      deps.bookings.getBooking.mockResolvedValue(consultation());
      deps.catalogue.getSpecialtyById.mockResolvedValue({ id: SPECIALTY_ID, canPrescribe: true });
      deps.repo.findByConsultationId.mockResolvedValue(null);
      deps.repo.findByConsultationIdForUpdate.mockResolvedValue(null);
      deps.repo.create.mockResolvedValue(record({ medicines: [MEDICINE] }));

      await deps.service.saveDraft(CONSULTATION_ID, DOCTOR_ID, saveDto({ medicines: [MEDICINE] }));

      // The gate resolved from `consultations.specialty_id`, exactly as
      // `doctor.contract.ts` demands of this call site.
      expect(deps.catalogue.getSpecialtyById).toHaveBeenCalledWith(SPECIALTY_ID);
    });

    it('POSITIVE CONTROL: a prescribing specialty saves the medicine line, trimmed and normalised', async () => {
      const deps = createDeps();
      deps.bookings.getBooking.mockResolvedValue(consultation());
      deps.catalogue.getSpecialtyById.mockResolvedValue({ id: SPECIALTY_ID, canPrescribe: true });
      deps.repo.findByConsultationId.mockResolvedValue(null);
      deps.repo.findByConsultationIdForUpdate.mockResolvedValue(null);
      deps.repo.create.mockResolvedValue(record({ medicines: [MEDICINE] }));

      await deps.service.saveDraft(
        CONSULTATION_ID,
        DOCTOR_ID,
        saveDto({ medicines: [{ ...MEDICINE, name: '  Sertraline  ', instructions: '   ' }] }),
      );

      expect(deps.repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ medicines: [{ name: 'Sertraline', dose: '50mg', frequency: 'Once daily', duration: '14 days' }] }),
        expect.anything(),
      );
    });

    it('allows a non-prescribing specialty to save a record with NO medicines', async () => {
      const deps = createDeps();
      deps.bookings.getBooking.mockResolvedValue(consultation());
      deps.catalogue.getSpecialtyById.mockResolvedValue({ id: SPECIALTY_ID, canPrescribe: false });
      deps.repo.findByConsultationId.mockResolvedValue(null);
      deps.repo.findByConsultationIdForUpdate.mockResolvedValue(null);
      deps.repo.create.mockResolvedValue(record());

      await expect(
        deps.service.saveDraft(CONSULTATION_ID, DOCTOR_ID, saveDto({ ...FULL_ADVICE })),
      ).resolves.toMatchObject({ consultationId: CONSULTATION_ID });
      // No specialty lookup is even needed when there are no medicines to gate.
      expect(deps.catalogue.getSpecialtyById).not.toHaveBeenCalled();
    });

    /* ═════════════════════════════════════════════════════════════════════ */
    /* ANGLE 4: THE SPECIALTY CHANGED BETWEEN THE DRAFT AND THE FINALISE.    */
    /*                                                                       */
    /* `specialties.can_prescribe` is an ADMIN-EDITABLE COLUMN               */
    /* (`specialty.service.ts#adminUpdate`), and this gate reads it LIVE on  */
    /* every call rather than from a snapshot. So the sequence               */
    /*                                                                       */
    /*   1. doctor saves a draft with medicines — gate passes, `true`        */
    /*   2. an admin flips the specialty to `can_prescribe: false`           */
    /*   3. doctor finalises                                                 */
    /*                                                                       */
    /* reaches `finalise` with medicines already in the row and              */
    /* `canPrescribe === false`. `finalise` re-reads the gate — and before   */
    /* this block existed it used the answer ONLY to pick an error message.  */
    /* Nothing refused, so the medicines were sealed into an immutable       */
    /* record and printed onto the patient's prescription PDF.               */
    /* ═════════════════════════════════════════════════════════════════════ */

    it('ANGLE 4: refuses to FINALISE medicines the consultation may no longer carry', async () => {
      const deps = createDeps();
      // Medicines already in the row from when the specialty still allowed
      // them; `canPrescribe` is now false.
      arrangeFinalisable(deps, record({ medicines: [MEDICINE], caseSummary: 'Stable. Continue plan.' }), false);

      await expectCode(
        deps.service.finalise(CONSULTATION_ID, DOCTOR_ID),
        CLINICAL_ERROR_CODES.MEDICINES_NOT_PERMITTED,
      );
      expect(deps.repo.finalise).not.toHaveBeenCalled();
      expect(deps.instant.clearCompletionGate).not.toHaveBeenCalled();
      expect(deps.pdf.generateForConsultation).not.toHaveBeenCalled();
    });

    it('ANGLE 4b: those medicines do not satisfy the completion gate either — the advice plan is still owed', async () => {
      const deps = createDeps();
      arrangeFinalisable(deps, record({ medicines: [MEDICINE], caseSummary: 'Stable. Continue plan.' }), false);

      // The record has NO advice at all. `docs/MODULES.md` says the advice and
      // therapy plan IS a non-prescribing professional's closing record, and
      // the gate's own doc comment leans on "a medicine line cannot exist" for
      // such a consultation. It can, so the gate must not accept one.
      await expect(deps.service.finalise(CONSULTATION_ID, DOCTOR_ID)).rejects.toBeInstanceOf(ConflictException);
      expect(deps.repo.finalise).not.toHaveBeenCalled();
    });

    it('ANGLE 4c: the refusal survives the row lock — it is re-checked against the LOCKED row, not only the pre-flight one', async () => {
      const deps = createDeps();
      // Clean pre-flight row (no medicines, full advice) passes the cheap
      // check; the row read FOR UPDATE is the one carrying the medicines.
      arrangeFinalisable(deps, record({ ...FULL_ADVICE, caseSummary: 'Stable.' }), false);
      deps.repo.findByConsultationIdForUpdate.mockResolvedValue(
        record({ ...FULL_ADVICE, caseSummary: 'Stable.', medicines: [MEDICINE] }),
      );

      await expectCode(
        deps.service.finalise(CONSULTATION_ID, DOCTOR_ID),
        CLINICAL_ERROR_CODES.MEDICINES_NOT_PERMITTED,
      );
      expect(deps.repo.finalise).not.toHaveBeenCalled();
    });

    it('POSITIVE CONTROL: a prescribing consultation still finalises on its medicines alone', async () => {
      const deps = createDeps();
      arrangeFinalisable(deps, record({ medicines: [MEDICINE], caseSummary: 'Stable. Continue plan.' }), true);

      await expect(deps.service.finalise(CONSULTATION_ID, DOCTOR_ID)).resolves.toMatchObject({
        record: { finalisedAt: expect.any(Date) },
      });
    });

    it('POSITIVE CONTROL: a non-prescribing consultation with no medicines is untouched by ANGLE 4', async () => {
      const deps = createDeps();
      arrangeFinalisable(deps, record({ ...FULL_ADVICE, caseSummary: 'Stable. Continue plan.' }), false);

      await expect(deps.service.finalise(CONSULTATION_ID, DOCTOR_ID)).resolves.toMatchObject({
        record: { finalisedAt: expect.any(Date) },
      });
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════ */
  /* Drafts                                                                  */
  /* ═══════════════════════════════════════════════════════════════════════ */

  /* ═══════════════════════════════════════════════════════════════════════ */
  /* THE M-21 READ-AUDIT GAP: `getOwnRecord` (the treating doctor's own view) */
  /* now leaves a trace, the same way `getRecordForAdmin`'s already does.    */
  /* ═══════════════════════════════════════════════════════════════════════ */

  describe("the treating doctor's own read (getOwnRecord)", () => {
    it('audits a read of an existing record as the treating doctor', async () => {
      const deps = createDeps();
      deps.bookings.getBooking.mockResolvedValue(consultation());
      deps.repo.findByConsultationId.mockResolvedValue(record());

      await deps.service.getOwnRecord(CONSULTATION_ID, DOCTOR_ID);

      expect(deps.audit.write).toHaveBeenCalledWith(
        expect.objectContaining({
          actorType: 'doctor',
          actorId: DOCTOR_ID,
          action: 'read',
          entityType: 'clinical_record',
          entityId: RECORD_ID,
          consultationId: CONSULTATION_ID,
        }),
      );
    });

    it('writes no audit entry when there is no record yet to have read', async () => {
      const deps = createDeps();
      deps.bookings.getBooking.mockResolvedValue(consultation());
      deps.repo.findByConsultationId.mockResolvedValue(null);

      const result = await deps.service.getOwnRecord(CONSULTATION_ID, DOCTOR_ID);

      expect(result).toBeNull();
      expect(deps.audit.write).not.toHaveBeenCalled();
    });

    it('404s before reading or auditing anything when the consultation is not this doctor’s', async () => {
      const deps = createDeps();
      deps.bookings.getBooking.mockResolvedValue(consultation({ doctorId: OTHER_DOCTOR_ID }));

      await expectCode(deps.service.getOwnRecord(CONSULTATION_ID, DOCTOR_ID), CLINICAL_ERROR_CODES.CONSULTATION_NOT_FOUND);
      expect(deps.repo.findByConsultationId).not.toHaveBeenCalled();
      expect(deps.audit.write).not.toHaveBeenCalled();
    });
  });

  describe('saving a draft', () => {
    it('refuses to edit a record that is already finalised', async () => {
      const deps = createDeps();
      deps.bookings.getBooking.mockResolvedValue(consultation());
      deps.repo.findByConsultationIdForUpdate.mockResolvedValue(record({ finalisedAt: new Date() }));

      await expectCode(
        deps.service.saveDraft(CONSULTATION_ID, DOCTOR_ID, saveDto()),
        CLINICAL_ERROR_CODES.RECORD_ALREADY_FINALISED,
      );
    });

    it('refuses to write notes against a consultation that has not happened', async () => {
      const deps = createDeps();
      deps.bookings.getBooking.mockResolvedValue(consultation({ status: 'scheduled' }));

      await expectCode(
        deps.service.saveDraft(CONSULTATION_ID, DOCTOR_ID, saveDto()),
        CLINICAL_ERROR_CODES.CONSULTATION_NOT_WRITABLE,
      );
    });

    it('stores blank free text as NULL, which is what makes the completion gate honest', async () => {
      const deps = createDeps();
      deps.bookings.getBooking.mockResolvedValue(consultation());
      deps.repo.findByConsultationIdForUpdate.mockResolvedValue(null);
      deps.repo.create.mockResolvedValue(record());

      await deps.service.saveDraft(CONSULTATION_ID, DOCTOR_ID, saveDto({ caseSummary: '   ', diagnosis: '' }));

      expect(deps.repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ caseSummary: null, diagnosis: null }),
        expect.anything(),
      );
    });

    it('updates an existing draft rather than inserting a second record', async () => {
      const deps = createDeps();
      deps.bookings.getBooking.mockResolvedValue(consultation());
      deps.repo.findByConsultationIdForUpdate.mockResolvedValue(record());
      deps.repo.updateDraft.mockResolvedValue(record({ caseSummary: 'Stable.' }));

      await deps.service.saveDraft(CONSULTATION_ID, DOCTOR_ID, saveDto({ caseSummary: 'Stable.' }));

      expect(deps.repo.updateDraft).toHaveBeenCalledTimes(1);
      expect(deps.repo.create).not.toHaveBeenCalled();
    });

    it('applies a template as a COPY of medicines and the four advice fields, and of nothing else', async () => {
      const deps = createDeps();
      deps.bookings.getBooking.mockResolvedValue(consultation());
      deps.templates.requireOwnTemplateRow.mockResolvedValue(template({ ...FULL_ADVICE }));
      deps.repo.findByConsultationId.mockResolvedValue(record());
      deps.repo.findByConsultationIdForUpdate.mockResolvedValue(record());
      deps.repo.updateDraft.mockResolvedValue(record({ ...FULL_ADVICE }));

      await deps.service.applyTemplate(CONSULTATION_ID, DOCTOR_ID, TEMPLATE_ID);

      const [, patch] = deps.repo.updateDraft.mock.calls[0] ?? [];
      // Exactly five keys: medicines plus the four advice fields. A template
      // carries no diagnosis and no chief complaint, and applying one must not
      // invent either.
      expect(Object.keys(patch as object).sort()).toEqual([
        'adviceCovered',
        'adviceHomePractice',
        'adviceNextFocus',
        'adviceWarningSigns',
        'medicines',
      ]);
    });

    it('refuses to apply a template when no record exists yet — a template carries no chief complaint or risk category', async () => {
      const deps = createDeps();
      deps.bookings.getBooking.mockResolvedValue(consultation());
      deps.templates.requireOwnTemplateRow.mockResolvedValue(template());
      deps.repo.findByConsultationId.mockResolvedValue(null);

      await expectCode(
        deps.service.applyTemplate(CONSULTATION_ID, DOCTOR_ID, TEMPLATE_ID),
        CLINICAL_ERROR_CODES.RECORD_NOT_FOUND,
      );
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════ */
  /* DONE-WHEN 3: "the full record rebuilds from the consultation ID".       */
  /* ═══════════════════════════════════════════════════════════════════════ */

  describe('rebuilding the record from the consultation id', () => {
    const complete = record({
      clinicalHistory: 'Two prior episodes, both resolved.',
      diagnosis: 'Recurrent depressive disorder',
      isDiagnosisProvisional: false,
      riskCategory: 'moderate',
      referralNote: 'In-person review if agitation worsens.',
      medicines: [{ ...MEDICINE, instructions: 'After food.' }],
      ...FULL_ADVICE,
      caseSummary: 'Three lines of summary.',
      finalisedAt: new Date('2026-09-01T11:00:00Z'),
    });

    it('returns EVERY field of the record from the consultation id alone', async () => {
      const deps = createDeps();
      deps.repo.findByConsultationId.mockResolvedValue(complete);

      const view = await deps.service.getRecordByConsultationId(CONSULTATION_ID);

      expect(deps.repo.findByConsultationId).toHaveBeenCalledWith(CONSULTATION_ID);
      expect(view).toEqual({
        id: RECORD_ID,
        consultationId: CONSULTATION_ID,
        chiefComplaint: 'Low mood for three months.',
        clinicalHistory: 'Two prior episodes, both resolved.',
        diagnosis: 'Recurrent depressive disorder',
        isDiagnosisProvisional: false,
        riskCategory: 'moderate',
        referralNote: 'In-person review if agitation worsens.',
        medicines: [{ ...MEDICINE, instructions: 'After food.' }],
        advice: {
          covered: FULL_ADVICE.adviceCovered,
          homePractice: FULL_ADVICE.adviceHomePractice,
          nextFocus: FULL_ADVICE.adviceNextFocus,
          warningSigns: FULL_ADVICE.adviceWarningSigns,
        },
        caseSummary: 'Three lines of summary.',
        finalisedAt: new Date('2026-09-01T11:00:00Z'),
        createdAt: complete.createdAt,
        updatedAt: complete.updatedAt,
      });
    });

    it('gives M-16 the Care Plan projection — prescription and warning signs, and no diagnosis', async () => {
      const deps = createDeps();
      deps.repo.findByConsultationId.mockResolvedValue(complete);

      const plan = await deps.service.getCarePlanInputs(CONSULTATION_ID);

      expect(plan).toMatchObject({
        consultationId: CONSULTATION_ID,
        medicines: [expect.objectContaining({ name: 'Sertraline' })],
        advice: expect.objectContaining({ warningSigns: FULL_ADVICE.adviceWarningSigns }),
      });
      expect(plan).not.toHaveProperty('diagnosis');
      expect(plan).not.toHaveProperty('caseSummary');
    });

    it('gives M-16 nothing for a DRAFT — half-written warning signs are worse than none', async () => {
      const deps = createDeps();
      deps.repo.findByConsultationId.mockResolvedValue(record({ ...FULL_ADVICE, finalisedAt: null }));

      await expect(deps.service.getCarePlanInputs(CONSULTATION_ID)).resolves.toBeNull();
    });

    it('the admin read is itself audited — the most sensitive read in the panel leaves a trace of who looked', async () => {
      const deps = createDeps();
      deps.repo.findByConsultationId.mockResolvedValue(complete);

      await deps.service.getRecordForAdmin(CONSULTATION_ID, 'admin-1');

      expect(deps.audit.write).toHaveBeenCalledWith(
        expect.objectContaining({
          actorType: 'admin',
          actorId: 'admin-1',
          action: 'read',
          entityType: 'clinical_record',
          consultationId: CONSULTATION_ID,
        }),
      );
    });

    it('returns the FR-11.6 cross-module trail for one consultation, and audits reading it', async () => {
      const deps = createDeps();
      deps.repo.listConsultationAuditTrail.mockResolvedValue([
        {
          id: 1,
          actorType: 'patient',
          actorId: PATIENT_ID,
          action: 'create',
          entityType: 'consultation',
          entityId: CONSULTATION_ID,
          metadata: null,
          createdAt: new Date('2026-09-01T09:00:00Z'),
        },
      ]);

      const trail = await deps.service.getConsultationTrailForAdmin(CONSULTATION_ID, 'admin-1');

      expect(deps.repo.listConsultationAuditTrail).toHaveBeenCalledWith(CONSULTATION_ID, 500);
      expect(trail).toHaveLength(1);
      // `ipAddress` never leaves this module — SRS §6.2 minimum-necessary.
      expect(trail[0]).not.toHaveProperty('ipAddress');
      expect(deps.audit.write).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'read', metadata: expect.objectContaining({ event: 'audit_trail_read' }) }),
      );
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════ */
  /* The prescription retry                                                  */
  /* ═══════════════════════════════════════════════════════════════════════ */

  describe('generatePrescriptionPdf', () => {
    it('refuses to issue a prescription for a record that is not finalised', async () => {
      const deps = createDeps();
      deps.bookings.getBooking.mockResolvedValue(consultation());
      deps.repo.findByConsultationId.mockResolvedValue(record());

      await expectCode(
        deps.service.generatePrescriptionPdf(CONSULTATION_ID, DOCTOR_ID),
        CLINICAL_ERROR_CODES.PRESCRIPTION_OR_ADVICE_REQUIRED,
      );
      expect(deps.pdf.generateForConsultation).not.toHaveBeenCalled();
    });

    it('regenerates for a finalised record — the doctor-facing retry for the one consequence allowed to fail', async () => {
      const deps = createDeps();
      deps.bookings.getBooking.mockResolvedValue(consultation({ status: 'completed' }));
      deps.repo.findByConsultationId.mockResolvedValue(record({ finalisedAt: new Date() }));

      await expect(deps.service.generatePrescriptionPdf(CONSULTATION_ID, DOCTOR_ID)).resolves.toEqual({
        fileId: 'file-1',
      });
    });

    it("404s on another doctor's consultation", async () => {
      const deps = createDeps();
      deps.bookings.getBooking.mockResolvedValue(consultation({ doctorId: OTHER_DOCTOR_ID }));

      await expectCode(
        deps.service.generatePrescriptionPdf(CONSULTATION_ID, DOCTOR_ID),
        CLINICAL_ERROR_CODES.CONSULTATION_NOT_FOUND,
      );
    });
  });
});
