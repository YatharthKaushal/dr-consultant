import type { ReportRequestRow } from '../../schema/report-requests.schema';
import type { AuditService } from '../../shared/audit/audit.service';
import type { ConsultationLookupPort, ConsultationSummary } from './consultation-lookup.provider';
import { DOCUMENT_ERROR_CODES } from './document.constants';
import type { CreateReportRequestDto } from './document.dto';
import { ReportRequestService } from './report-request.service';
import type { ReportRequestRepository } from './report-request.repository';

const DOCTOR_ID = 'doctor-1';
const OTHER_DOCTOR_ID = 'doctor-2';
const PATIENT_ID = 'patient-1';
const CONSULTATION_ID = 'consultation-1';
const REPORT_REQUEST_ID = 'report-request-1';

function consultation(overrides: Partial<ConsultationSummary> = {}): ConsultationSummary {
  return { id: CONSULTATION_ID, patientId: PATIENT_ID, doctorId: DOCTOR_ID, status: 'in_progress', ...overrides };
}

function reportRequestRow(overrides: Partial<ReportRequestRow> = {}): ReportRequestRow {
  return {
    id: REPORT_REQUEST_ID,
    consultationId: CONSULTATION_ID,
    title: 'Blood test',
    reason: null,
    status: 'open',
    createdAt: new Date('2026-09-01T00:00:00Z'),
    ...overrides,
  };
}

function createDto(overrides: Partial<CreateReportRequestDto> = {}): CreateReportRequestDto {
  return { title: 'Blood test', ...overrides };
}

function createService() {
  const repo = {
    create: jest.fn(),
    findById: jest.fn(),
    listByConsultation: jest.fn().mockResolvedValue([]),
    listByConsultations: jest.fn().mockResolvedValue([]),
    updateStatusIfOpen: jest.fn(),
  } as unknown as jest.Mocked<ReportRequestRepository>;

  const consultationLookup = {
    findById: jest.fn(),
    listConsultationIdsBetween: jest.fn().mockResolvedValue([]),
    listConsultationIdsForPatient: jest.fn().mockResolvedValue([]),
  } as unknown as jest.Mocked<ConsultationLookupPort>;

  const audit = { write: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<AuditService>;

  const service = new ReportRequestService(repo, consultationLookup, audit);
  return { service, repo, consultationLookup, audit };
}

describe('ReportRequestService.raise', () => {
  it('creates a request when the caller is the treating doctor for the consultation', async () => {
    const { service, repo, consultationLookup, audit } = createService();
    consultationLookup.findById.mockResolvedValue(consultation());
    repo.create.mockResolvedValue(reportRequestRow());

    const result = await service.raise(DOCTOR_ID, CONSULTATION_ID, createDto());

    expect(repo.create).toHaveBeenCalledWith({ consultationId: CONSULTATION_ID, title: 'Blood test', reason: null });
    expect(result.status).toBe('open');
    expect(audit.write).toHaveBeenCalledWith(
      expect.objectContaining({ actorType: 'doctor', actorId: DOCTOR_ID, action: 'create', consultationId: CONSULTATION_ID }),
    );
  });

  it('passes reason through when given', async () => {
    const { service, repo, consultationLookup } = createService();
    consultationLookup.findById.mockResolvedValue(consultation());
    repo.create.mockResolvedValue(reportRequestRow({ reason: 'Rule out infection' }));

    await service.raise(DOCTOR_ID, CONSULTATION_ID, createDto({ reason: 'Rule out infection' }));

    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ reason: 'Rule out infection' }));
  });

  it('rejects when the caller is NOT the treating doctor for the consultation (404, not 403)', async () => {
    const { service, repo, consultationLookup } = createService();
    consultationLookup.findById.mockResolvedValue(consultation({ doctorId: OTHER_DOCTOR_ID }));

    await expect(service.raise(DOCTOR_ID, CONSULTATION_ID, createDto())).rejects.toMatchObject({
      status: 404,
      response: { code: DOCUMENT_ERROR_CODES.CONSULTATION_NOT_FOUND },
    });
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('rejects when the consultation does not exist at all', async () => {
    const { service, repo, consultationLookup } = createService();
    consultationLookup.findById.mockResolvedValue(null);

    await expect(service.raise(DOCTOR_ID, CONSULTATION_ID, createDto())).rejects.toMatchObject({ status: 404 });
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('rejects when the consultation has no doctor assigned yet (instant-request routing in progress)', async () => {
    const { service, repo, consultationLookup } = createService();
    consultationLookup.findById.mockResolvedValue(consultation({ doctorId: null }));

    await expect(service.raise(DOCTOR_ID, CONSULTATION_ID, createDto())).rejects.toMatchObject({ status: 404 });
    expect(repo.create).not.toHaveBeenCalled();
  });
});

describe('ReportRequestService.cancel', () => {
  it('cancels a request that is currently open', async () => {
    const { service, repo, consultationLookup, audit } = createService();
    consultationLookup.findById.mockResolvedValue(consultation());
    repo.findById.mockResolvedValue(reportRequestRow({ status: 'open' }));
    repo.updateStatusIfOpen.mockResolvedValue(reportRequestRow({ status: 'cancelled' }));

    const result = await service.cancel(DOCTOR_ID, CONSULTATION_ID, REPORT_REQUEST_ID);

    expect(result.status).toBe('cancelled');
    expect(repo.updateStatusIfOpen).toHaveBeenCalledWith(REPORT_REQUEST_ID, 'cancelled');
    expect(audit.write).toHaveBeenCalledWith(expect.objectContaining({ action: 'update' }));
  });

  it.each(['fulfilled', 'cancelled'] as const)('rejects cancelling a request that is already %s (409)', async (status) => {
    const { service, repo, consultationLookup } = createService();
    consultationLookup.findById.mockResolvedValue(consultation());
    repo.findById.mockResolvedValue(reportRequestRow({ status }));

    await expect(service.cancel(DOCTOR_ID, CONSULTATION_ID, REPORT_REQUEST_ID)).rejects.toMatchObject({
      status: 409,
      response: { code: DOCUMENT_ERROR_CODES.REPORT_REQUEST_NOT_OPEN },
    });
    expect(repo.updateStatusIfOpen).not.toHaveBeenCalled();
  });

  it('rejects (409) when a race flips the request between the read and the write', async () => {
    const { service, repo, consultationLookup } = createService();
    consultationLookup.findById.mockResolvedValue(consultation());
    repo.findById.mockResolvedValue(reportRequestRow({ status: 'open' }));
    repo.updateStatusIfOpen.mockResolvedValue(null);

    await expect(service.cancel(DOCTOR_ID, CONSULTATION_ID, REPORT_REQUEST_ID)).rejects.toMatchObject({
      status: 409,
      response: { code: DOCUMENT_ERROR_CODES.REPORT_REQUEST_NOT_OPEN },
    });
  });

  it('rejects when the caller is not the treating doctor for the consultation', async () => {
    const { service, repo, consultationLookup } = createService();
    consultationLookup.findById.mockResolvedValue(consultation({ doctorId: OTHER_DOCTOR_ID }));

    await expect(service.cancel(DOCTOR_ID, CONSULTATION_ID, REPORT_REQUEST_ID)).rejects.toMatchObject({ status: 404 });
    expect(repo.findById).not.toHaveBeenCalled();
  });

  it('rejects when the report request does not belong to the given consultation', async () => {
    const { service, repo, consultationLookup } = createService();
    consultationLookup.findById.mockResolvedValue(consultation());
    repo.findById.mockResolvedValue(reportRequestRow({ consultationId: 'a-different-consultation' }));

    await expect(service.cancel(DOCTOR_ID, CONSULTATION_ID, REPORT_REQUEST_ID)).rejects.toMatchObject({
      status: 404,
      response: { code: DOCUMENT_ERROR_CODES.REPORT_REQUEST_NOT_FOUND },
    });
  });

  it('rejects when the report request does not exist', async () => {
    const { service, repo, consultationLookup } = createService();
    consultationLookup.findById.mockResolvedValue(consultation());
    repo.findById.mockResolvedValue(null);

    await expect(service.cancel(DOCTOR_ID, CONSULTATION_ID, REPORT_REQUEST_ID)).rejects.toMatchObject({
      status: 404,
      response: { code: DOCUMENT_ERROR_CODES.REPORT_REQUEST_NOT_FOUND },
    });
  });
});

describe('ReportRequestService.listForConsultation', () => {
  it('lists requests for a consultation the caller treats', async () => {
    const { service, repo, consultationLookup } = createService();
    consultationLookup.findById.mockResolvedValue(consultation());
    repo.listByConsultation.mockResolvedValue([reportRequestRow()]);

    const result = await service.listForConsultation(DOCTOR_ID, CONSULTATION_ID);

    expect(result).toHaveLength(1);
    expect(repo.listByConsultation).toHaveBeenCalledWith(CONSULTATION_ID);
  });

  it('rejects when the caller is not the treating doctor', async () => {
    const { service, repo, consultationLookup } = createService();
    consultationLookup.findById.mockResolvedValue(consultation({ doctorId: OTHER_DOCTOR_ID }));

    await expect(service.listForConsultation(DOCTOR_ID, CONSULTATION_ID)).rejects.toMatchObject({ status: 404 });
    expect(repo.listByConsultation).not.toHaveBeenCalled();
  });
});

describe('ReportRequestService.listOwnAcrossConsultations', () => {
  it('derives the request list from every one of the patient\'s own consultations', async () => {
    const { service, repo, consultationLookup } = createService();
    consultationLookup.listConsultationIdsForPatient.mockResolvedValue([CONSULTATION_ID, 'consultation-2']);
    repo.listByConsultations.mockResolvedValue([reportRequestRow()]);

    const result = await service.listOwnAcrossConsultations(PATIENT_ID);

    expect(consultationLookup.listConsultationIdsForPatient).toHaveBeenCalledWith(PATIENT_ID);
    expect(repo.listByConsultations).toHaveBeenCalledWith([CONSULTATION_ID, 'consultation-2']);
    expect(result).toHaveLength(1);
  });

  it('returns an empty list for a patient with no consultations yet, with no query issued', async () => {
    const { service, repo, consultationLookup } = createService();
    consultationLookup.listConsultationIdsForPatient.mockResolvedValue([]);

    const result = await service.listOwnAcrossConsultations(PATIENT_ID);

    expect(result).toEqual([]);
    expect(repo.listByConsultations).toHaveBeenCalledWith([]);
  });
});
