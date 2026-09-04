import { ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DATABASE } from '../../config/db/database.module';
import type { Database } from '../../config/db/database.config';
import type { ClinicalRecordRow, NewClinicalRecordRow } from '../../schema/clinical-records.schema';
import type { ConsultationStatus } from '../../schema/enums.schema';
import { AuditService } from '../../shared/audit/audit.service';
import { isUniqueConstraintViolation } from '../../shared/errors/postgres-error.util';
import { CatalogueFacade } from '../catalogue/catalogue.facade';
import { InstantFacade } from '../instant/instant.facade';
import type { ClinicalBookingPort, ClinicalConsultationView } from './clinical-booking.contract';
import {
  CLINICAL_AUDIT_ENTITY_TYPES,
  CLINICAL_BOOKING_PORT,
  CLINICAL_AUDIT_TRAIL_LIMIT,
  CLINICAL_ERROR_CODES,
  CLINICAL_RECORD_WRITABLE_STATUSES,
} from './clinical.constants';
import {
  CLINICAL_RECORD_FINALISED_EVENT,
  type ClinicalAuditEntryView,
  type ClinicalCarePlanView,
  type ClinicalMedicine,
  type ClinicalRecordView,
} from './clinical.contract';
import type { SaveClinicalRecordDto } from './clinical.dto';
import { normaliseText, parseMedicineLines } from './clinical-medicine.util';
import { toClinicalAuditEntryView, toClinicalCarePlanView, toClinicalRecordView } from './clinical.mapper';
import { ClinicalPdfService } from './clinical-pdf.service';
import { ClinicalRepository } from './clinical.repository';
import { ClinicalTemplateService } from './clinical-template.service';

/** What `finalise` reports back — the record plus what actually happened to each of the three things finalising switches on. */
export interface FinaliseResult {
  record: ClinicalRecordView;
  /** The consultation's status after the move, or `null` if it could not be read. */
  consultationStatus: ConsultationStatus | null;
  /** `true` when this call actually un-gated the doctor. `false` is normal — a scheduled consultation never gated anyone, and a retry finds it already clear. */
  completionGateCleared: boolean;
  /** The generated prescription's `patient_files` id, or `null` if generation failed (already logged; the doctor can retry). */
  prescriptionFileId: string | null;
}

/**
 * M-15's rules (`backend/README.md` §2: "services hold the rules").
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * *** THE COMPLETION GATE (FR-11.5). THE REASON THIS MODULE EXISTS. ***
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `clinical-records.schema.ts` states the rule and `docs/erd.sql` repeats it:
 * setting `finalised_at` requires `case_summary`, plus either a medicine line
 * or the advice fields. Until now that was PROSE IN A SCHEMA COMMENT — no CHECK
 * constraint, no code, nothing. FR-11.5 is explicit that the rule is "enforced
 * by the system, not by convention", so it lives here, in
 * `assertCompletionGate`, and it is checked TWICE: once cheaply before the
 * transaction, and once authoritatively against the row read under
 * `SELECT ... FOR UPDATE`.
 *
 * The second check is not belt-and-braces. Without it, two requests — "save a
 * draft that blanks the case summary" and "finalise" — could interleave so that
 * the gate is evaluated against a row that no longer exists by the time
 * `finalised_at` is written.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * *** THE PRESCRIBING GATE. WHICH `canPrescribe` IS THE RIGHT ONE. ***
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `consultations.specialty_id -> specialties.can_prescribe`, read through
 * `CatalogueFacade.getSpecialtyById` — the BOOKING-TIME SNAPSHOT of the
 * specialty the consultation was actually held under.
 *
 * *** NOT `DoctorContract.getPrescribingEligibility`. *** That method's own doc
 * comment forbids this call site in capitals, and it is right to: it derives
 * from the doctor's PRIMARY specialty, which can differ from — or change after
 * — the specialty a given past consultation was booked under. A psychiatrist
 * who later adds counselling as their primary specialty must not retroactively
 * lose the right to have prescribed; a counsellor who later qualifies in
 * psychiatry must not retroactively gain it. `getPrescribingEligibility` IS the
 * right method for a doctor's personal templates, where there is no
 * consultation to snapshot from — see `clinical-template.service.ts`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * *** WHAT FINALISING SWITCHES ON. ***
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Three consequences, in this order, each idempotent, none inside the
 * transaction (`backend/README.md` §2 forbids cross-module transactions):
 *
 *   1. The consultation moves to `completed`, through `CLINICAL_BOOKING_PORT`.
 *      *** THIS ALSO SWITCHES ON REFERRAL REWARDS AND AFFILIATE ACCRUAL. ***
 *      `promotion.referral_qualifying_statuses` defaults to
 *      `['awaiting_documentation','completed']`, and
 *      `promotion.constants.ts` says of that default: "BOTH ARE SET BY M-15.
 *      Until M-15 exists, NOTHING in this codebase moves a consultation into
 *      either — so with the default set, no referral reward and no affiliate
 *      accrual will EVER fire." This line is what changes that. Nothing in
 *      `modules/promotion` needed editing; its sweep was already watching.
 *
 *   2. `InstantFacade.clearCompletionGate` — FR-10.5. That method has existed,
 *      documented "M-15 CALLS THIS", idempotent, since M-13 shipped, and has
 *      never had a caller. This is the caller.
 *
 *   3. The prescription PDF (FR-9.5/FR-14.2), best effort.
 *
 * Steps 1 and 2 are attempted even if the one before them refused, and neither
 * can undo `finalised_at`. That ordering is deliberate: the clinical record is
 * the source of truth, and the other two are consequences OF it. A crash
 * between them leaves a doctor gated by a consultation whose record is already
 * final — precisely the state `clearCompletionGate` is idempotent for, and
 * precisely what `clinical-gate-sweep.service.ts` reconciles.
 */
@Injectable()
export class ClinicalService {
  private readonly logger = new Logger(ClinicalService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly repo: ClinicalRepository,
    @Inject(CLINICAL_BOOKING_PORT) private readonly bookings: ClinicalBookingPort,
    private readonly catalogue: CatalogueFacade,
    private readonly instant: InstantFacade,
    private readonly templates: ClinicalTemplateService,
    private readonly pdf: ClinicalPdfService,
    private readonly audit: AuditService,
    private readonly events: EventEmitter2,
  ) {}

  /* ══════════════════════════════════════════════════════════════════════ */
  /* The treating doctor's record                                           */
  /* ══════════════════════════════════════════════════════════════════════ */

  /** The doctor's own view of the record they are writing. 404 — with the same code a stranger gets — when the consultation is not theirs. */
  async getOwnRecord(consultationId: string, doctorId: string): Promise<ClinicalRecordView | null> {
    await this.requireOwnConsultation(consultationId, doctorId);
    const row = await this.repo.findByConsultationId(consultationId);
    return row ? toClinicalRecordView(row) : null;
  }

  /**
   * Creates or replaces the DRAFT (FR-9.4, FR-11.1).
   *
   * `PUT` semantics: the body is the complete state of the record, so a field
   * left out is CLEARED, not preserved. That is what a notes form submits, and
   * a merge-on-absent alternative would make "I deleted that paragraph"
   * indistinguishable from "I did not send that field".
   */
  async saveDraft(consultationId: string, doctorId: string, dto: SaveClinicalRecordDto): Promise<ClinicalRecordView> {
    const consultation = await this.requireOwnConsultation(consultationId, doctorId);
    this.requireWritableStatus(consultation);

    const medicines = parseMedicineLines(dto.medicines, 'request');
    await this.assertMedicinesPermittedForConsultation(consultation, medicines);

    const patch = this.toRowPatch(dto, medicines);
    const saved = await this.writeDraft(consultationId, doctorId, patch, { source: 'form' });
    return toClinicalRecordView(saved);
  }

  /**
   * FR-9.6: copies one of the doctor's own templates into the draft.
   *
   * *** A COPY, NOT A LINK. *** `doctor-clinical-templates.schema.ts` is
   * explicit that applying a template is "a field-for-field copy into a new
   * `clinical_records` row with no mapping layer" — which is also why a later
   * edit to the template cannot reach back and alter a record that was already
   * written from it, the same reasoning `specialties.prescriptionTemplate` and
   * `consultations.intake_answers` both rely on.
   *
   * *** THE PRESCRIBING GATE APPLIES HERE TOO, AND THAT IS THE POINT. *** A
   * template is the obvious way to smuggle a medicine line past a check that
   * only guards the form: a psychiatrist's template, applied to a counselling
   * consultation. It is refused, loudly, rather than silently stripped —
   * silently dropping medicines a doctor believes they just applied is worse
   * than an error, because the doctor would not know.
   *
   * Only `medicines` and the four `advice_*` fields are copied. There is
   * nothing else to copy: the template table deliberately has no `diagnosis`
   * and no `chief_complaint`, because "a pre-fillable diagnosis is a
   * clinical-safety hazard, not a convenience".
   */
  async applyTemplate(consultationId: string, doctorId: string, templateId: string): Promise<ClinicalRecordView> {
    const consultation = await this.requireOwnConsultation(consultationId, doctorId);
    this.requireWritableStatus(consultation);

    const template = await this.templates.requireOwnTemplateRow(templateId, doctorId);
    const medicines = parseMedicineLines(template.medicines, 'template');
    await this.assertMedicinesPermittedForConsultation(consultation, medicines);

    const existing = await this.repo.findByConsultationId(consultationId);
    if (!existing) {
      // `chief_complaint` and `risk_category` are NOT NULL and a template
      // carries neither, so there is no row to create from one. The doctor
      // saves the notes first and applies the template into them.
      throw recordNotFound();
    }

    const saved = await this.writeDraft(
      consultationId,
      doctorId,
      {
        medicines,
        adviceCovered: template.adviceCovered,
        adviceHomePractice: template.adviceHomePractice,
        adviceNextFocus: template.adviceNextFocus,
        adviceWarningSigns: template.adviceWarningSigns,
      },
      { source: 'template', templateId },
    );
    return toClinicalRecordView(saved);
  }

  /* ══════════════════════════════════════════════════════════════════════ */
  /* *** FINALISATION. THE COMPLETION GATE. *** */
  /* ══════════════════════════════════════════════════════════════════════ */

  /**
   * FR-11.5. See this class's header for the whole argument; the short version
   * is that this method is the only thing in the system that may set
   * `finalised_at`, and it refuses unless the record is genuinely complete.
   */
  async finalise(consultationId: string, doctorId: string): Promise<FinaliseResult> {
    const consultation = await this.requireOwnConsultation(consultationId, doctorId);
    this.requireWritableStatus(consultation);

    const draft = await this.repo.findByConsultationId(consultationId);
    if (!draft) throw recordNotFound();
    if (draft.finalisedAt) throw alreadyFinalised();

    // The specialty read is a FACADE CALL, so it happens before the
    // transaction opens and never inside one — `backend/README.md` §2 forbids
    // cross-module transactions, and holding a pooled connection open across a
    // call into another module is how that rule gets broken by accident.
    const canPrescribe = await this.consultationCanPrescribe(consultation);

    // Cheap pre-flight, so an incomplete record is refused without taking a
    // row lock. The authoritative check is the identical call inside the
    // transaction below, against the row read FOR UPDATE.
    this.assertCompletionGate(draft, canPrescribe);

    const finalisedAt = new Date();
    const finalised = await this.db.transaction(async (tx) => {
      const locked = await this.repo.findByConsultationIdForUpdate(consultationId, tx);
      if (!locked) throw recordNotFound();
      if (locked.finalisedAt) throw alreadyFinalised();

      // *** THE AUTHORITATIVE CHECK. *** Re-evaluated against the locked row,
      // so a concurrent draft save that blanked the case summary cannot slip
      // an incomplete record past a check made a moment earlier.
      this.assertCompletionGate(locked, canPrescribe);

      const row = await this.repo.finalise(consultationId, finalisedAt, tx);
      if (!row) {
        // The guarded UPDATE found `finalised_at` already set — another
        // request won the race between the lock and this write.
        throw alreadyFinalised();
      }

      await this.audit.write(
        {
          actorType: 'doctor',
          actorId: doctorId,
          action: 'update',
          entityType: CLINICAL_AUDIT_ENTITY_TYPES.CLINICAL_RECORD,
          entityId: row.id,
          consultationId,
          metadata: {
            event: 'finalised',
            finalisedAt: finalisedAt.toISOString(),
            medicineCount: parseMedicineLines(row.medicines, 'template').length,
            canPrescribe,
            riskCategory: row.riskCategory,
            referralAdvised: row.referralNote !== null,
          },
        },
        tx,
      );

      return row;
    });

    /* ── The three consequences. None may undo `finalised_at`. ─────────── */

    const consultationStatus = await this.moveConsultationToCompleted(consultationId);
    const completionGateCleared = await this.clearCompletionGate(consultationId);
    const prescription = await this.pdf.generateForConsultation(finalised, consultation);

    // *** STEP 4. *** Fire-and-forget, deliberately: see
    // `CLINICAL_RECORD_FINALISED_EVENT`'s own header for why this has no
    // reconciling sweep behind it yet. `emit` never throws on a listener
    // error (nestjs/event-emitter's `suppressErrors` defaults to true), so
    // this cannot fail `finalise` itself.
    this.events.emit(CLINICAL_RECORD_FINALISED_EVENT, { consultationId });

    return {
      record: toClinicalRecordView(finalised),
      consultationStatus,
      completionGateCleared,
      prescriptionFileId: prescription?.id ?? null,
    };
  }

  /**
   * *** STEP 1. *** Moves the consultation to `completed` — and, as a
   * consequence nobody has to remember to arrange, makes the referral reward
   * and the affiliate commission on this booking qualify on the promotion
   * module's next sweep. See the class header.
   *
   * Non-throwing: a refusal is logged and reported, never raised. The record is
   * already final, and failing the doctor's request at this point would tell
   * them their notes did not save when they did.
   */
  private async moveConsultationToCompleted(consultationId: string): Promise<ConsultationStatus | null> {
    try {
      const result = await this.bookings.completeConsultation({
        consultationId,
        from: CLINICAL_RECORD_WRITABLE_STATUSES,
        reason: 'clinical_record_finalised',
      });
      if (result.refusal) {
        this.logger.warn(
          `Consultation ${consultationId} was not moved to completed after finalisation (${result.refusal}); the sweep will retry.`,
        );
      }
      return result.status;
    } catch (error) {
      this.logger.error(
        `Moving consultation ${consultationId} to completed failed: ${describeError(error)}. The sweep will retry.`,
      );
      return null;
    }
  }

  /**
   * *** STEP 2. THE FIRST CALLER `InstantFacade.clearCompletionGate` HAS EVER
   * HAD. *** FR-10.5: the notes are done, so the doctor stops being blocked
   * from new instant requests and goes back into the routing pool.
   *
   * Idempotent by that method's own contract, and non-throwing here for the
   * same reason as step 1. `changed: false` with no refusal is the NORMAL case
   * for a scheduled consultation — nothing gated anyone — and is not a failure.
   */
  private async clearCompletionGate(consultationId: string): Promise<boolean> {
    try {
      const gate = await this.instant.clearCompletionGate(consultationId);
      if (gate.refusal) {
        this.logger.warn(`Clearing the completion gate for consultation ${consultationId} was refused (${gate.refusal}).`);
      }
      return gate.changed;
    } catch (error) {
      this.logger.error(
        `Clearing the completion gate for consultation ${consultationId} failed: ${describeError(error)}. The sweep will retry.`,
      );
      return false;
    }
  }

  /**
   * FR-9.5/FR-14.2: (re)generates the prescription PDF for a finalised record.
   *
   * The doctor-facing retry for the one consequence of finalising that is
   * allowed to fail — a storage outage during finalisation leaves a final
   * record with no PDF, and this is how it gets one without anything about the
   * record changing. Idempotent through `DocumentFacade.writePrescriptionPdf`:
   * calling it when a prescription already exists returns that one.
   */
  async generatePrescriptionPdf(consultationId: string, doctorId: string): Promise<{ fileId: string | null }> {
    await this.requireOwnConsultation(consultationId, doctorId);

    const record = await this.repo.findByConsultationId(consultationId);
    if (!record) throw recordNotFound();
    if (!record.finalisedAt) {
      throw new ConflictException({
        code: CLINICAL_ERROR_CODES.PRESCRIPTION_OR_ADVICE_REQUIRED,
        message: 'The clinical record must be finalised before a prescription can be issued.',
      });
    }

    const file = await this.pdf.generateForConsultation(record);
    return { fileId: file?.id ?? null };
  }

  /* ══════════════════════════════════════════════════════════════════════ */
  /* Reads for other modules and for governance                             */
  /* ══════════════════════════════════════════════════════════════════════ */

  /** `ClinicalContract#getRecordByConsultationId`. No ownership check — the caller authorizes. */
  async getRecordByConsultationId(consultationId: string): Promise<ClinicalRecordView | null> {
    const row = await this.repo.findByConsultationId(consultationId);
    return row ? toClinicalRecordView(row) : null;
  }

  /** `ClinicalContract#getCarePlanInputs`. `null` for a draft — see the contract. */
  async getCarePlanInputs(consultationId: string): Promise<ClinicalCarePlanView | null> {
    const row = await this.repo.findByConsultationId(consultationId);
    return row ? toClinicalCarePlanView(row) : null;
  }

  /** ADDITIVE (M-20/governance and quality) — see `clinical.repository.ts#listDrafts`. */
  async listPendingCaseSummaries(limit: number, offset: number): Promise<ClinicalRecordView[]> {
    const rows = await this.repo.listDrafts(limit, offset);
    return rows.map(toClinicalRecordView);
  }

  /** ADDITIVE (M-20/governance and quality) — see `clinical.repository.ts#countDrafts`. */
  async countPendingCaseSummaries(): Promise<number> {
    return this.repo.countDrafts();
  }

  /** ADDITIVE (M-21/data rights execution) — see `clinical.repository.ts#countRecordsForConsultations`. */
  async countRecordsForConsultations(consultationIds: readonly string[]): Promise<number> {
    return this.repo.countRecordsForConsultations(consultationIds);
  }

  /**
   * *** THE `clinical.read_records` READ (SRS §6.2). ***
   *
   * The permission has existed since M-01, bundled to `super_admin` and
   * `clinical_governance`, with NO controller using it. This is what it gates.
   * `care_coordinator` deliberately does not hold it — a coordinator acts on an
   * alert without reading the notes behind it — and nothing here widens that.
   *
   * *** THE READ ITSELF IS AUDITED. *** `audit_log.action` carries a `read`
   * value for exactly this: the most sensitive read in the admin panel must
   * leave a trace of who looked, and it is written best-effort (no `tx`) so a
   * logging failure cannot deny an operator a record they are entitled to see.
   */
  async getRecordForAdmin(consultationId: string, adminId: string): Promise<ClinicalRecordView> {
    const row = await this.repo.findByConsultationId(consultationId);
    if (!row) throw recordNotFound();

    await this.audit.write({
      actorType: 'admin',
      actorId: adminId,
      action: 'read',
      entityType: CLINICAL_AUDIT_ENTITY_TYPES.CLINICAL_RECORD,
      entityId: row.id,
      consultationId,
      metadata: { finalised: row.finalisedAt !== null },
    });

    return toClinicalRecordView(row);
  }

  /**
   * *** FR-11.6, LITERALLY. *** "Each consultation has a consultation ID that
   * ties together booking, video session metadata, prescription and case
   * summary for audit."
   *
   * That trail is not this module's to own — every module writes it, through
   * `shared/audit` — but this module is the only one whose requirement is
   * ABOUT it, and `audit_log.consultation_id` carries an index for exactly this
   * lookup. So the read lives here, narrowed to one consultation, behind the
   * same `clinical.read_records` permission as the record itself.
   *
   * What comes back is genuinely cross-module: M-11's booking transitions,
   * M-12's payment events, M-10's file writes (including the prescription PDF),
   * M-14's session metadata once it exists, and this module's own draft,
   * finalise and read entries. Reading it IS `docs/MODULES.md`'s "the full
   * record rebuilds from the consultation ID" bar approached from the other
   * side: the record says what was decided, the trail says how it got there.
   *
   * The read is itself audited, for the same reason `getRecordForAdmin`'s is.
   */
  async getConsultationTrailForAdmin(consultationId: string, adminId: string): Promise<ClinicalAuditEntryView[]> {
    const rows = await this.repo.listConsultationAuditTrail(consultationId, CLINICAL_AUDIT_TRAIL_LIMIT);

    await this.audit.write({
      actorType: 'admin',
      actorId: adminId,
      action: 'read',
      entityType: CLINICAL_AUDIT_ENTITY_TYPES.CLINICAL_RECORD,
      entityId: consultationId,
      consultationId,
      metadata: { event: 'audit_trail_read', entries: rows.length },
    });

    return rows.map(toClinicalAuditEntryView);
  }

  /* ══════════════════════════════════════════════════════════════════════ */
  /* The gates                                                              */
  /* ══════════════════════════════════════════════════════════════════════ */

  /**
   * *** THE COMPLETION GATE (FR-11.5), IN ONE PLACE. ***
   *
   * `case_summary` (FR-11.3), PLUS either a medicine line or the advice and
   * therapy plan (FR-11.2: "prescription or advice is mandatory where
   * applicable").
   *
   * Read the second condition carefully, because the asymmetry is the rule:
   *
   *   NON-PRESCRIBING specialty — a medicine line MUST NOT be there, so the
   *     advice fields are the ONLY way through. `docs/MODULES.md`: "the advice
   *     and therapy plan is their closing record".
   *
   *   PRESCRIBING specialty — either satisfies it. A psychiatrist who
   *     prescribed nothing this session and wrote a full therapy plan has
   *     documented the consultation; forcing a medicine line to close the case
   *     would be a system demanding a prescription, which is the opposite of a
   *     safety rule.
   *
   * "The advice fields" means ALL FOUR. `docs/MODULES.md` enumerates them as
   * one artefact — "what was covered, home practice for the patient, focus for
   * the next session, and warning signs" — and FR-14.2 puts the warning signs
   * and the follow-up plan on the patient's own PDF. Three of four is a
   * half-written care plan, and the patient cannot tell which quarter is
   * missing.
   *
   * Blank strings do not count: `normaliseText` has already stored `"   "` as
   * NULL, which is what makes a whitespace submission fail this check instead
   * of passing it.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * *** AND IT RE-ASSERTS THE PRESCRIBING GATE, BECAUSE SAVE TIME IS NOT
   *     SEAL TIME. ***
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * "A medicine line cannot exist on a non-prescribing consultation, because
   * the prescribing gate refused it at save time" WAS AN INVARIANT THAT HELD
   * ONLY BY COINCIDENCE. `specialties.can_prescribe` is an admin-editable
   * column (`specialty.service.ts#adminUpdate`), and BOTH gates read it LIVE.
   * So:
   *
   *   1. the doctor saves a draft with medicines — the gate reads `true`
   *   2. an admin flips that specialty to `can_prescribe: false`
   *   3. the doctor finalises
   *
   * arrives here with medicines in the row and `canPrescribe === false`. Before
   * this check, `canPrescribe` was consulted ONLY to choose the wording of the
   * message below — so the medicines were sealed into an immutable record and
   * printed onto the patient's prescription PDF by a professional the platform
   * had just decided may not prescribe, AND they satisfied the second condition
   * on their own, so the advice and therapy plan that is the whole closing
   * record for such a consultation was never written.
   *
   * Refused, not stripped, for the same reason `applyTemplate` refuses rather
   * than silently dropping a template's medicines: a doctor who is not told is
   * a doctor who believes the prescription went out. The draft is still a
   * draft, so the remedy is theirs — save the record without the medicine
   * lines, and write the advice plan.
   */
  private assertCompletionGate(record: ClinicalRecordRow, canPrescribe: boolean): void {
    if (!normaliseText(record.caseSummary)) {
      throw new ConflictException({
        code: CLINICAL_ERROR_CODES.CASE_SUMMARY_REQUIRED,
        message: 'A case summary is required before this consultation can be marked complete.',
      });
    }

    const hasMedicine = parseMedicineLines(record.medicines, 'template').length > 0;

    // *** THE PRESCRIBING GATE, AT THE MOMENT OF SEALING. *** See above. Runs
    // before the advice test, so a medicine line a non-prescribing consultation
    // may not carry can never be what satisfies it.
    if (hasMedicine && !canPrescribe) {
      throw new ConflictException({
        code: CLINICAL_ERROR_CODES.MEDICINES_NOT_PERMITTED,
        message:
          'This consultation was booked under a specialty that does not allow prescribing, so its record cannot be closed with a medicine line. Remove the medicines and record the advice and therapy plan instead.',
      });
    }

    const hasAdvice =
      normaliseText(record.adviceCovered) !== null &&
      normaliseText(record.adviceHomePractice) !== null &&
      normaliseText(record.adviceNextFocus) !== null &&
      normaliseText(record.adviceWarningSigns) !== null;

    if (hasMedicine || hasAdvice) return;

    throw new ConflictException({
      code: CLINICAL_ERROR_CODES.PRESCRIPTION_OR_ADVICE_REQUIRED,
      message: canPrescribe
        ? 'Add at least one medicine, or complete the advice and therapy plan, before marking this consultation complete.'
        : 'Complete the advice and therapy plan — what was covered, home practice, focus for the next session and warning signs — before marking this consultation complete.',
    });
  }

  /**
   * *** THE PRESCRIBING GATE. *** See the class header for why this reads the
   * consultation's booking-time specialty snapshot and never the doctor's
   * primary specialty.
   *
   * A specialty that cannot be read AT ALL is treated as non-prescribing. That
   * is the safe direction: the failure mode of guessing "yes" is a medicine
   * entered by somebody with no right to prescribe it.
   */
  private async assertMedicinesPermittedForConsultation(
    consultation: ClinicalConsultationView,
    medicines: readonly ClinicalMedicine[],
  ): Promise<void> {
    if (medicines.length === 0) return;

    if (!(await this.consultationCanPrescribe(consultation))) {
      throw new ConflictException({
        code: CLINICAL_ERROR_CODES.MEDICINES_NOT_PERMITTED,
        message:
          'This consultation was booked under a specialty that does not allow prescribing. Record the advice and therapy plan instead.',
      });
    }
  }

  private async consultationCanPrescribe(consultation: ClinicalConsultationView): Promise<boolean> {
    const specialty = await this.catalogue.getSpecialtyById(consultation.specialtyId);
    return specialty?.canPrescribe === true;
  }

  /* ══════════════════════════════════════════════════════════════════════ */
  /* Shared plumbing                                                        */
  /* ══════════════════════════════════════════════════════════════════════ */

  /**
   * Ownership. A consultation that does not exist and one belonging to another
   * doctor produce the IDENTICAL 404 — without that, any doctor could probe for
   * the existence of any consultation by id.
   */
  private async requireOwnConsultation(consultationId: string, doctorId: string): Promise<ClinicalConsultationView> {
    const consultation = await this.bookings.getBooking(consultationId);
    if (!consultation || consultation.doctorId !== doctorId) {
      throw consultationNotFound();
    }
    return consultation;
  }

  /** A clinical record belongs to a consultation that happened or is happening — see `CLINICAL_RECORD_WRITABLE_STATUSES`. */
  private requireWritableStatus(consultation: ClinicalConsultationView): void {
    if (!(CLINICAL_RECORD_WRITABLE_STATUSES as readonly ConsultationStatus[]).includes(consultation.status)) {
      throw new ConflictException({
        code: CLINICAL_ERROR_CODES.CONSULTATION_NOT_WRITABLE,
        message:
          consultation.status === 'completed'
            ? 'This consultation is already complete; its clinical record can no longer be changed.'
            : 'Clinical notes can only be written while the consultation is in progress or awaiting documentation.',
      });
    }
  }

  /**
   * The one place a draft is written, so the row lock, the immutability guard
   * and the audit row cannot be forgotten by one of the two callers.
   *
   * Creating and updating are the same operation from the caller's point of
   * view because `clinical_records.consultation_id` is UNIQUE — there is at
   * most one record per consultation, and which of the two happened is an
   * implementation detail the doctor never sees.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * *** THE ROW LOCK DOES NOT COVER THE FIRST SAVE, AND CANNOT. ***
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * `SELECT ... FOR UPDATE` that matches ZERO ROWS LOCKS NOTHING — there is no
   * row yet to lock. So two requests that both arrive before either has
   * committed both read `null` and both take the INSERT branch, and the second
   * one meets the UNIQUE constraint on `consultation_id` instead. That is not
   * an exotic interleaving: it is a doctor double-tapping "save" on a notes
   * form they have not saved before, and measured against a real database a
   * three-way race produced 48 driver errors in 75 attempts.
   *
   * Without the retry below the loser got a raw `23505` through
   * `HttpExceptionFilter`'s generic-500 branch — "your notes did not save",
   * about notes that in fact saved, for a request that was entirely legal.
   * Every other check-then-insert in this codebase already carries this net
   * (`consent.service.ts`, `legal-document.service.ts`,
   * `clinical-template.service.ts`, `booking.service.ts`); this one did not.
   *
   * ONE retry is enough, and is not a loop dressed up as a constant: the
   * conflict PROVES the row now exists, nothing in this module (or any other)
   * deletes a `clinical_records` row, and the second attempt's
   * `FOR UPDATE` therefore finds it and takes the UPDATE branch — blocking on
   * the real row lock if a third writer is still mid-flight. The retry is a
   * fresh transaction because the first one is already aborted: Postgres
   * refuses every further statement on a transaction that has raised an error.
   */
  private async writeDraft(
    consultationId: string,
    doctorId: string,
    patch: Partial<NewClinicalRecordRow>,
    context: { source: 'form' | 'template'; templateId?: string },
  ): Promise<ClinicalRecordRow> {
    try {
      return await this.writeDraftOnce(consultationId, doctorId, patch, context);
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) throw error;
      return this.writeDraftOnce(consultationId, doctorId, patch, context);
    }
  }

  /** One attempt at `writeDraft`. See there for why there are two. */
  private async writeDraftOnce(
    consultationId: string,
    doctorId: string,
    patch: Partial<NewClinicalRecordRow>,
    context: { source: 'form' | 'template'; templateId?: string },
  ): Promise<ClinicalRecordRow> {
    return this.db.transaction(async (tx) => {
      const existing = await this.repo.findByConsultationIdForUpdate(consultationId, tx);
      if (existing?.finalisedAt) throw alreadyFinalised();

      let row: ClinicalRecordRow;
      if (existing) {
        const updated = await this.repo.updateDraft(consultationId, patch, tx);
        // The UPDATE carries `finalised_at IS NULL` in its own WHERE clause, so
        // a null here means the record was finalised between the lock and the
        // write. Under the lock that should be unreachable; it is checked
        // anyway, because "should be unreachable" is not "is".
        if (!updated) throw alreadyFinalised();
        row = updated;
      } else {
        row = await this.repo.create({ consultationId, ...patch } as NewClinicalRecordRow, tx);
      }

      await this.audit.write(
        {
          actorType: 'doctor',
          actorId: doctorId,
          action: existing ? 'update' : 'create',
          entityType: CLINICAL_AUDIT_ENTITY_TYPES.CLINICAL_RECORD,
          entityId: row.id,
          consultationId,
          metadata: {
            event: existing ? 'draft_updated' : 'draft_created',
            source: context.source,
            ...(context.templateId ? { templateId: context.templateId } : {}),
            medicineCount: parseMedicineLines(row.medicines, 'template').length,
            hasCaseSummary: normaliseText(row.caseSummary) !== null,
          },
        },
        tx,
      );

      return row;
    });
  }

  /**
   * DTO -> row columns.
   *
   * Every free-text field goes through `normaliseText`, which is what makes the
   * completion gate honest: `"   "` is stored as NULL, so a whitespace-only
   * case summary fails FR-11.3 rather than satisfying it.
   */
  private toRowPatch(dto: SaveClinicalRecordDto, medicines: ClinicalMedicine[]): Partial<NewClinicalRecordRow> {
    return {
      chiefComplaint: dto.chiefComplaint.trim(),
      clinicalHistory: normaliseText(dto.clinicalHistory),
      diagnosis: normaliseText(dto.diagnosis),
      isDiagnosisProvisional: dto.isDiagnosisProvisional ?? true,
      riskCategory: dto.riskCategory,
      referralNote: normaliseText(dto.referralNote),
      medicines,
      adviceCovered: normaliseText(dto.adviceCovered),
      adviceHomePractice: normaliseText(dto.adviceHomePractice),
      adviceNextFocus: normaliseText(dto.adviceNextFocus),
      adviceWarningSigns: normaliseText(dto.adviceWarningSigns),
      caseSummary: normaliseText(dto.caseSummary),
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

/** One code for "does not exist" and "is not yours" — a doctor with no relationship to the consultation cannot tell them apart. */
export function consultationNotFound(): NotFoundException {
  return new NotFoundException({
    code: CLINICAL_ERROR_CODES.CONSULTATION_NOT_FOUND,
    message: 'Consultation not found.',
  });
}

export function recordNotFound(): NotFoundException {
  return new NotFoundException({
    code: CLINICAL_ERROR_CODES.RECORD_NOT_FOUND,
    message: 'No clinical record has been started for this consultation.',
  });
}

/** A finalised record is immutable and there is no unfinalise — a correction is a new consultation, not an edit to a closed one. */
export function alreadyFinalised(): ConflictException {
  return new ConflictException({
    code: CLINICAL_ERROR_CODES.RECORD_ALREADY_FINALISED,
    message: 'This clinical record has already been finalised and can no longer be changed.',
  });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
