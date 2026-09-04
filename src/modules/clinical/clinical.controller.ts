import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put } from '@nestjs/common';
import { AccountType, CurrentUser } from '../../shared/auth/auth.decorator';
import type { AuthContext } from '../../shared/auth/auth.types';
import { createUuidValidationPipe } from '../../shared/errors/uuid-param.pipe';
import { ApplyTemplateDto, SaveClinicalRecordDto } from './clinical.dto';
import { ClinicalService } from './clinical.service';

/**
 * The treating doctor's clinical record, under `/consultations/:id/...`.
 *
 * *** `/consultations` IS A SHARED PREFIX, AND THIS ADDS TO IT DELIBERATELY. ***
 * `document-consultation.controller.ts` already owns `:id/report-requests` and
 * `:id/documents` there, and its header warns the next builder that the prefix
 * is shared. Every route below has a literal `clinical-record` third segment,
 * so there is no ambiguity with those, and none with `booking.controller.ts`,
 * which is `@Controller('bookings')` and does not use this prefix at all.
 *
 * Being on the SAME prefix as report requests is the right outcome, not a
 * collision to route around: `docs/MODULES.md` lists "report request for the
 * next session, raised here and held by M-10" under M-15, and this is what that
 * sentence means in practice. *** THIS MODULE DOES NOT REIMPLEMENT REPORT
 * REQUESTS. *** M-10 already owns them end to end, including the rule that the
 * raising doctor must be the treating doctor (`report-request.service.ts`), so
 * a doctor documenting a consultation raises one at
 * `POST /consultations/:id/report-requests` — the route right beside these, on
 * the same screen, in the other module. A second implementation here would be a
 * second place that decides who may ask a patient for a document.
 *
 * Every route derives the doctor from `@CurrentUser()`, never a path or body
 * param, and a consultation that is not this doctor's returns the SAME 404 a
 * stranger gets, so a doctor cannot probe for another doctor's consultations.
 */
@Controller('consultations')
@AccountType('doctor')
export class ClinicalController {
  constructor(private readonly clinical: ClinicalService) {}

  /** The record as it stands. `null` — not a 404 — when the doctor has not started one yet: an empty form is a normal state, not an error. */
  @Get(':id/clinical-record')
  getRecord(@CurrentUser() auth: AuthContext, @Param('id', createUuidValidationPipe('id')) consultationId: string) {
    return this.clinical.getOwnRecord(consultationId, auth.accountId);
  }

  /**
   * FR-9.4/FR-11.1: save the structured notes.
   *
   * `PUT`, and the body is the complete record — the same convention
   * `availability.controller.ts` and `instant-doctor.controller.ts` use for a
   * single-valued resource. There is at most one clinical record per
   * consultation (`consultation_id` is UNIQUE), so "create" and "update" are
   * the same request and the service decides which happened.
   */
  @Put(':id/clinical-record')
  saveRecord(
    @CurrentUser() auth: AuthContext,
    @Param('id', createUuidValidationPipe('id')) consultationId: string,
    @Body() dto: SaveClinicalRecordDto,
  ) {
    return this.clinical.saveDraft(consultationId, auth.accountId, dto);
  }

  /**
   * FR-9.6: copy one of this doctor's own templates into the draft.
   *
   * `@HttpCode(OK)` because applying a template CREATES nothing — it patches a
   * record that already exists. Same reasoning as `booking.controller.ts#cancel`.
   */
  @Post(':id/clinical-record/apply-template')
  @HttpCode(HttpStatus.OK)
  applyTemplate(
    @CurrentUser() auth: AuthContext,
    @Param('id', createUuidValidationPipe('id')) consultationId: string,
    @Body() dto: ApplyTemplateDto,
  ) {
    return this.clinical.applyTemplate(consultationId, auth.accountId, dto.templateId);
  }

  /**
   * *** THE COMPLETION GATE (FR-11.5). *** Marks the consultation clinically
   * complete — and only then.
   *
   * `@HttpCode(OK)`: this transitions a record that already exists rather than
   * creating one.
   *
   * There is deliberately no "unfinalise" route to pair with it. A finalised
   * clinical record is immutable; a correction is a new consultation, not an
   * edit to a closed one, and an endpoint that could reopen one would put the
   * completion gate back in the hands of the person it constrains.
   *
   * The response reports what each of finalising's three consequences actually
   * did (`consultationStatus`, `completionGateCleared`, `prescriptionFileId`)
   * rather than only the record, because two of them are cross-module calls
   * that are allowed to fail — and a doctor's app should be able to tell that
   * their PDF is not ready yet without guessing.
   */
  @Post(':id/clinical-record/finalise')
  @HttpCode(HttpStatus.OK)
  finalise(@CurrentUser() auth: AuthContext, @Param('id', createUuidValidationPipe('id')) consultationId: string) {
    return this.clinical.finalise(consultationId, auth.accountId);
  }

  /**
   * FR-9.5: (re)issue the prescription PDF for a finalised record.
   *
   * The retry for the one consequence of finalising that may fail without
   * failing the finalise itself. An existing prescription is returned rather
   * than a second one minted (`DocumentContract#writePrescriptionPdf`) — but
   * see `clinical-pdf.service.ts`: that idempotence is SEQUENTIAL ONLY, and
   * two concurrent calls to this route really do produce two `patient_files`
   * rows, because nothing in `patient_files` constrains the pair.
   *
   * *** RETRIEVAL IS NOT HERE. *** The file is a `patient_files` row, so the
   * patient reads it at `GET /documents/me?category=prescription_pdf` and
   * downloads it at `GET /documents/:id/download` — M-10's existing
   * access-controlled, short-lived signed-URL path (FR-6.1). A second download
   * route here would be a second place that decides who may read a
   * prescription.
   *
   * *** WHO THAT PATH ADMITS IS WIDER THAN THIS COMMENT ONCE CLAIMED, AND ONE
   * OF THE THREE IS A HOLE IN THIS MODULE'S BOUNDARY. *** The doctor branch is
   * any doctor sharing any consultation with the patient, not the treating
   * doctor of this one; the admin branch is unconditional, with no
   * `@RequirePermission` — so `care_coordinator`, which
   * `clinical-admin.controller.ts` deliberately denies `clinical.read_records`,
   * can download a prescription carrying the diagnosis, risk category and
   * medicines. `clinical-pdf.service.ts` has the full finding and says why the
   * fix is M-10's rather than a second rule here.
   */
  @Post(':id/clinical-record/prescription-pdf')
  @HttpCode(HttpStatus.OK)
  generatePrescriptionPdf(
    @CurrentUser() auth: AuthContext,
    @Param('id', createUuidValidationPipe('id')) consultationId: string,
  ) {
    return this.clinical.generatePrescriptionPdf(consultationId, auth.accountId);
  }
}
