import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { AuditService } from '../../shared/audit/audit.service';
import type { ReportRequestRow } from '../../schema/report-requests.schema';
import { CONSULTATION_LOOKUP_PROVIDER, DOCUMENT_AUDIT_ENTITY_TYPES, DOCUMENT_ERROR_CODES } from './document.constants';
import type { ConsultationLookupPort } from './consultation-lookup.provider';
import type { CreateReportRequestDto } from './document.dto';
import { ReportRequestRepository } from './report-request.repository';

/**
 * `report_requests` workflow: a doctor raises one against a consultation
 * they treat, cancels it while still `open`, and lists what they've raised.
 * FULFIL is deliberately absent from this service — per `report-requests.
 * schema.ts`'s own comment ("No `fulfilled_at` — the arriving `patient_files`
 * row carries that time in its `created_at`"), fulfilment is an IMPLICIT
 * side effect of a matching upload, owned entirely by `patient-file.
 * service.ts#upload`'s transaction, not a state transition this service
 * ever performs.
 *
 * De-identified clarification-attachment support (M-17) is EXPLICITLY OUT OF
 * SCOPE for this pass — `patient_files_deidentified_check` already enforces
 * the structural invariant (`clarification_case_id IS NULL OR patient_id IS
 * NULL`) at the DB layer, M-17 doesn't exist yet, and nothing calls a
 * "create de-identified copy" method. That method would live here (report
 * requests are the thing an expert opinion answers) WHEN M-17 exists and has
 * a real shape to ask for — not built speculatively now.
 */
@Injectable()
export class ReportRequestService {
  constructor(
    private readonly repo: ReportRequestRepository,
    @Inject(CONSULTATION_LOOKUP_PROVIDER) private readonly consultationLookup: ConsultationLookupPort,
    private readonly audit: AuditService,
  ) {}

  /** Rule: the raising doctor must be the TREATING doctor for `consultationId` — `consultations.doctor_id`, not a stored column (see class doc comment on `report-request.repository.ts`). */
  async raise(doctorId: string, consultationId: string, dto: CreateReportRequestDto): Promise<ReportRequestRow> {
    const consultation = await this.consultationLookup.findById(consultationId);
    if (!consultation || consultation.doctorId !== doctorId) {
      throw consultationNotFound();
    }

    const row = await this.repo.create({
      consultationId,
      title: dto.title,
      reason: dto.reason ?? null,
    });

    await this.audit.write({
      actorType: 'doctor',
      actorId: doctorId,
      action: 'create',
      entityType: DOCUMENT_AUDIT_ENTITY_TYPES.REPORT_REQUEST,
      entityId: row.id,
      consultationId,
      metadata: { title: dto.title },
    });

    return row;
  }

  /** Only valid from `status: 'open'` — refused with 409 otherwise. Fulfil is implicit (see class doc comment); this is the ONLY explicit doctor action on a report request. */
  async cancel(doctorId: string, consultationId: string, reportRequestId: string): Promise<ReportRequestRow> {
    const consultation = await this.consultationLookup.findById(consultationId);
    if (!consultation || consultation.doctorId !== doctorId) {
      throw consultationNotFound();
    }

    const existing = await this.repo.findById(reportRequestId);
    if (!existing || existing.consultationId !== consultationId) {
      throw reportRequestNotFound();
    }
    if (existing.status !== 'open') {
      throw reportRequestNotOpen();
    }

    const updated = await this.repo.updateStatusIfOpen(reportRequestId, 'cancelled');
    if (!updated) {
      // Raced with a fulfilling upload (or another cancel) between the read above and this write.
      throw reportRequestNotOpen();
    }

    await this.audit.write({
      actorType: 'doctor',
      actorId: doctorId,
      action: 'update',
      entityType: DOCUMENT_AUDIT_ENTITY_TYPES.REPORT_REQUEST,
      entityId: reportRequestId,
      consultationId,
      metadata: { before: 'open', after: 'cancelled' },
    });

    return updated;
  }

  /** Requests raised in one specific consultation — verifies the caller is the treating doctor for it first. */
  async listForConsultation(doctorId: string, consultationId: string): Promise<ReportRequestRow[]> {
    const consultation = await this.consultationLookup.findById(consultationId);
    if (!consultation || consultation.doctorId !== doctorId) {
      throw consultationNotFound();
    }
    return this.repo.listByConsultation(consultationId);
  }

  /** The patient's own report requests (open and otherwise), derived via their own consultations — there is no `report_requests.patient_id` column. */
  async listOwnAcrossConsultations(patientId: string): Promise<ReportRequestRow[]> {
    const consultationIds = await this.consultationLookup.listConsultationIdsForPatient(patientId);
    return this.repo.listByConsultations(consultationIds);
  }
}

/** Collapses "doesn't exist" and "isn't yours" into one 404 — a caller with no relationship to the consultation cannot distinguish the two. Exported for `patient-file.service.ts` to reuse on its own `consultationId`/`reportRequestId` ownership checks, rather than duplicating the same error shape. */
export function consultationNotFound(): NotFoundException {
  return new NotFoundException({ code: DOCUMENT_ERROR_CODES.CONSULTATION_NOT_FOUND, message: 'Consultation not found.' });
}

export function reportRequestNotFound(): NotFoundException {
  return new NotFoundException({ code: DOCUMENT_ERROR_CODES.REPORT_REQUEST_NOT_FOUND, message: 'Report request not found.' });
}

export function reportRequestNotOpen(): ConflictException {
  return new ConflictException({
    code: DOCUMENT_ERROR_CODES.REPORT_REQUEST_NOT_OPEN,
    message: 'This report request is no longer open.',
  });
}
