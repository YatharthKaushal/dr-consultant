import { ConflictException, NotFoundException } from '@nestjs/common';
import type { Database } from '../../config/db/database.config';
import type { ClarificationCaseRow } from '../../schema/clarification-cases.schema';
import type { AuditService } from '../../shared/audit/audit.service';
import type { ClinicalFacade } from '../clinical/clinical.facade';
import type { DoctorFacade } from '../doctor/doctor.facade';
import { CLARIFICATION_ERROR_CODES } from './clarification.constants';
import type { CreateClarificationCaseDto } from './clarification.dto';
import { ClarificationRepository } from './clarification.repository';
import { ClarificationService } from './clarification.service';

const CASE_ID = '11111111-1111-4111-8111-111111111111';
const TREATING_DOCTOR_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_DOCTOR_ID = '33333333-3333-4333-8333-333333333333';
const EXPERT_DOCTOR_ID = '44444444-4444-4444-8444-444444444444';
const ADMIN_ID = '55555555-5555-4555-8555-555555555555';
const CONSULTATION_ID = '66666666-6666-4666-8666-666666666666';

function row(overrides: Partial<ClarificationCaseRow> = {}): ClarificationCaseRow {
  return {
    id: CASE_ID,
    treatingDoctorId: TREATING_DOCTOR_ID,
    sourceConsultationId: null,
    title: 'Persistent low mood, unclear diagnosis',
    patientAge: 34,
    patientGender: 'female',
    briefHistory: 'Three months of low mood and poor sleep.',
    diagnosis: null,
    currentPlan: 'Sertraline 50mg, weekly review.',
    specificDoubt: 'Would an SSRI switch be reasonable given no response at 6 weeks?',
    urgency: 'routine',
    expertDoctorId: null,
    assignedAt: null,
    messages: [],
    status: 'draft',
    postedAt: null,
    closedAt: null,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
    ...overrides,
  };
}

function createDto(overrides: Partial<CreateClarificationCaseDto> = {}): CreateClarificationCaseDto {
  return {
    title: 'Persistent low mood, unclear diagnosis',
    briefHistory: 'Three months of low mood and poor sleep.',
    specificDoubt: 'Would an SSRI switch be reasonable given no response at 6 weeks?',
    ...overrides,
  };
}

/**
 * Hand-rolled deps, `new ClarificationService(...)` — never
 * `Test.createTestingModule`, `clinical.service.spec.ts`'s convention.
 *
 * The `db.transaction` fake invokes its callback with itself so the code
 * under test runs, but proves no rollback semantics — same honest caveat
 * `clinical.service.spec.ts` states for its own fake. These tests assert
 * WHICH RULES FIRE, never that Postgres rolled anything back.
 */
function createDeps() {
  const db: { transaction: jest.Mock } = {
    transaction: jest.fn(async (callback: (tx: unknown) => unknown) => callback(db)),
  };

  const repo = {
    findById: jest.fn(),
    findByIdForUpdate: jest.fn(),
    listByTreatingDoctor: jest.fn(),
    listByExpertDoctor: jest.fn(),
    listForAdmin: jest.fn(),
    create: jest.fn(),
    updateDraftFields: jest.fn(),
    updateStatusIfIn: jest.fn(),
  };

  const doctors = { isExpertDoctor: jest.fn() };
  const clinical = { getRecordByConsultationId: jest.fn() };
  const audit = { write: jest.fn().mockResolvedValue(undefined) };

  const service = new ClarificationService(
    db as unknown as Database,
    repo as unknown as ClarificationRepository,
    doctors as unknown as DoctorFacade,
    clinical as unknown as ClinicalFacade,
    audit as unknown as AuditService,
  );

  return { service, db, repo, doctors, clinical, audit };
}

describe('ClarificationService.createDraft', () => {
  it('always uses the treatingDoctorId parameter, never a client-supplied one — a doctor cannot post a case as someone else', async () => {
    const { service, repo } = createDeps();
    repo.create.mockImplementation(async (data) => row({ ...data }));

    // Even if a caller somehow smuggled a `treatingDoctorId` onto the DTO
    // (the type does not allow it, but `whitelist: true` on the global
    // ValidationPipe would strip it anyway — see `clarification.dto.spec.ts`),
    // the service only ever uses its own `treatingDoctorId` PARAMETER.
    const maliciousDto = { ...createDto(), treatingDoctorId: OTHER_DOCTOR_ID } as CreateClarificationCaseDto;

    await service.createDraft(TREATING_DOCTOR_ID, maliciousDto);

    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ treatingDoctorId: TREATING_DOCTOR_ID }));
  });

  it('stores only the structured fields the schema defines — no name/phone/address/email field exists to store', async () => {
    const { service, repo } = createDeps();
    repo.create.mockImplementation(async (data) => row({ ...data }));

    await service.createDraft(TREATING_DOCTOR_ID, createDto());

    const inserted = repo.create.mock.calls[0][0];
    const keys = Object.keys(inserted);
    expect(keys).not.toContain('patientName');
    expect(keys).not.toContain('patientPhone');
    expect(keys).not.toContain('patientAddress');
    expect(keys).not.toContain('patientEmail');
  });

  it('checks sourceConsultationId against ClinicalFacade when supplied, and refuses an id with no matching clinical record', async () => {
    const { service, clinical } = createDeps();
    clinical.getRecordByConsultationId.mockResolvedValue(null);

    await expect(
      service.createDraft(TREATING_DOCTOR_ID, createDto({ sourceConsultationId: CONSULTATION_ID })),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(clinical.getRecordByConsultationId).toHaveBeenCalledWith(CONSULTATION_ID);
  });

  it('records a matching sourceConsultationId on the row', async () => {
    const { service, repo, clinical } = createDeps();
    clinical.getRecordByConsultationId.mockResolvedValue({ id: 'record-1', consultationId: CONSULTATION_ID });
    repo.create.mockImplementation(async (data) => row({ ...data }));

    await service.createDraft(TREATING_DOCTOR_ID, createDto({ sourceConsultationId: CONSULTATION_ID }));

    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ sourceConsultationId: CONSULTATION_ID }));
  });

  it('writes an audit entry', async () => {
    const { service, repo, audit } = createDeps();
    repo.create.mockImplementation(async (data) => row({ ...data }));

    await service.createDraft(TREATING_DOCTOR_ID, createDto());

    expect(audit.write).toHaveBeenCalledWith(
      expect.objectContaining({ actorType: 'doctor', actorId: TREATING_DOCTOR_ID, action: 'create' }),
    );
  });
});

describe('ClarificationService ownership — the treating doctor', () => {
  it('getOwnCase 404s (not 403) when the case does not exist', async () => {
    const { service, repo } = createDeps();
    repo.findById.mockResolvedValue(null);

    await expect(service.getOwnCase(CASE_ID, TREATING_DOCTOR_ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('getOwnCase 404s with the IDENTICAL code when the case belongs to another doctor — no existence leak', async () => {
    const { service, repo } = createDeps();
    repo.findById.mockResolvedValue(row({ treatingDoctorId: OTHER_DOCTOR_ID }));

    await expect(service.getOwnCase(CASE_ID, TREATING_DOCTOR_ID)).rejects.toMatchObject({
      response: { code: CLARIFICATION_ERROR_CODES.CASE_NOT_FOUND },
    });
  });

  it('getOwnCase returns the full view, including sourceConsultationId, for the true owner', async () => {
    const { service, repo } = createDeps();
    repo.findById.mockResolvedValue(row({ sourceConsultationId: CONSULTATION_ID }));

    const result = await service.getOwnCase(CASE_ID, TREATING_DOCTOR_ID);

    expect(result.sourceConsultationId).toBe(CONSULTATION_ID);
  });

  it('draft views carry the de-identification notice; posted ones do not', async () => {
    const { service, repo } = createDeps();
    repo.findById.mockResolvedValueOnce(row({ status: 'draft' }));
    const draftView = await service.getOwnCase(CASE_ID, TREATING_DOCTOR_ID);
    expect(draftView.deidentificationNotice).toEqual(expect.any(String));

    repo.findById.mockResolvedValueOnce(row({ status: 'posted', postedAt: new Date() }));
    const postedView = await service.getOwnCase(CASE_ID, TREATING_DOCTOR_ID);
    expect(postedView.deidentificationNotice).toBeUndefined();
  });
});

describe('ClarificationService.updateDraft', () => {
  it('refuses to edit a case that has already been posted', async () => {
    const { service, repo } = createDeps();
    repo.findById.mockResolvedValue(row({ status: 'posted' }));

    await expect(service.updateDraft(CASE_ID, TREATING_DOCTOR_ID, { title: 'New title' })).rejects.toMatchObject({
      response: { code: CLARIFICATION_ERROR_CODES.NOT_A_DRAFT },
    });
  });

  it('refuses when it is not this doctor\'s case', async () => {
    const { service, repo } = createDeps();
    repo.findById.mockResolvedValue(row({ treatingDoctorId: OTHER_DOCTOR_ID }));

    await expect(service.updateDraft(CASE_ID, TREATING_DOCTOR_ID, { title: 'x' })).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('ClarificationService.postCase — draft -> posted', () => {
  it('posts a draft belonging to the caller', async () => {
    const { service, repo } = createDeps();
    repo.findByIdForUpdate.mockResolvedValue(row({ status: 'draft' }));
    repo.updateStatusIfIn.mockResolvedValue(row({ status: 'posted', postedAt: new Date() }));

    const result = await service.postCase(CASE_ID, TREATING_DOCTOR_ID);

    expect(result.status).toBe('posted');
    expect(repo.updateStatusIfIn).toHaveBeenCalledWith(CASE_ID, ['draft'], expect.objectContaining({ status: 'posted' }), expect.anything());
  });

  it('refuses to post a case that is not a draft (illegal transition, not silently allowed)', async () => {
    const { service, repo } = createDeps();
    repo.findByIdForUpdate.mockResolvedValue(row({ status: 'posted' }));

    await expect(service.postCase(CASE_ID, TREATING_DOCTOR_ID)).rejects.toMatchObject({
      response: { code: CLARIFICATION_ERROR_CODES.ILLEGAL_TRANSITION },
    });
    expect(repo.updateStatusIfIn).not.toHaveBeenCalled();
  });

  it('404s (not 403) when posting a case that is not the caller\'s', async () => {
    const { service, repo } = createDeps();
    repo.findByIdForUpdate.mockResolvedValue(row({ status: 'draft', treatingDoctorId: OTHER_DOCTOR_ID }));

    await expect(service.postCase(CASE_ID, TREATING_DOCTOR_ID)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('ClarificationService.assignExpert — CHECK #1: who may be asked', () => {
  it('refuses a doctor who is not a verified expert', async () => {
    const { service, doctors, repo } = createDeps();
    doctors.isExpertDoctor.mockResolvedValue(false);

    await expect(service.assignExpert(CASE_ID, OTHER_DOCTOR_ID, ADMIN_ID)).rejects.toMatchObject({
      response: { code: CLARIFICATION_ERROR_CODES.NOT_AN_EXPERT },
    });
    expect(repo.findByIdForUpdate).not.toHaveBeenCalled();
  });

  it('assigns a verified expert to a posted case', async () => {
    const { service, doctors, repo, audit } = createDeps();
    doctors.isExpertDoctor.mockResolvedValue(true);
    repo.findByIdForUpdate.mockResolvedValue(row({ status: 'posted' }));
    repo.updateStatusIfIn.mockResolvedValue(
      row({ status: 'awaiting_response', expertDoctorId: EXPERT_DOCTOR_ID, assignedAt: new Date() }),
    );

    const result = await service.assignExpert(CASE_ID, EXPERT_DOCTOR_ID, ADMIN_ID);

    expect(result.expertDoctorId).toBe(EXPERT_DOCTOR_ID);
    expect(result.status).toBe('awaiting_response');
    expect(repo.updateStatusIfIn).toHaveBeenCalledWith(
      CASE_ID,
      ['posted'],
      expect.objectContaining({ status: 'awaiting_response', expertDoctorId: EXPERT_DOCTOR_ID }),
      expect.anything(),
    );
    expect(audit.write).toHaveBeenCalledWith(
      expect.objectContaining({ actorType: 'admin', actorId: ADMIN_ID }),
      expect.anything(),
    );
  });

  it('refuses to assign a case that is not in draft-posted state (e.g. still draft, or already assigned)', async () => {
    const { service, doctors, repo } = createDeps();
    doctors.isExpertDoctor.mockResolvedValue(true);
    repo.findByIdForUpdate.mockResolvedValue(row({ status: 'draft' }));

    await expect(service.assignExpert(CASE_ID, EXPERT_DOCTOR_ID, ADMIN_ID)).rejects.toMatchObject({
      response: { code: CLARIFICATION_ERROR_CODES.ILLEGAL_TRANSITION },
    });
  });

  it('404s when the case does not exist', async () => {
    const { service, doctors, repo } = createDeps();
    doctors.isExpertDoctor.mockResolvedValue(true);
    repo.findByIdForUpdate.mockResolvedValue(null);

    await expect(service.assignExpert(CASE_ID, EXPERT_DOCTOR_ID, ADMIN_ID)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('ClarificationService — the expert queue, CHECK #2: what they may see', () => {
  it('listAssignedCases passes expertDoctorId straight into the repository filter — never a general query', async () => {
    const { service, repo } = createDeps();
    repo.listByExpertDoctor.mockResolvedValue([]);

    await service.listAssignedCases(EXPERT_DOCTOR_ID, {});

    expect(repo.listByExpertDoctor).toHaveBeenCalledWith(
      EXPERT_DOCTOR_ID,
      expect.objectContaining({ limit: expect.any(Number), offset: expect.any(Number) }),
    );
  });

  it('an expert with zero assigned cases gets an empty list, even though the repository (standing in for "other cases exist in the table") is only ever asked for THIS expert\'s id', async () => {
    const { service, repo } = createDeps();
    // The repository is the seam that enforces "never a general query" — see
    // `clarification.repository.ts#listByExpertDoctor`'s own header. Standing
    // in for "other cases exist" here: were this method ever called WITHOUT
    // `expertDoctorId`, or with the wrong one, this mock would not know to
    // return [] for this specific expert while a real backlog of OTHER
    // experts' cases sits in the table.
    repo.listByExpertDoctor.mockImplementation(async (expertDoctorId: string) =>
      expertDoctorId === EXPERT_DOCTOR_ID ? [] : [row({ expertDoctorId: OTHER_DOCTOR_ID })],
    );

    const result = await service.listAssignedCases(EXPERT_DOCTOR_ID, {});

    expect(result).toEqual([]);
  });

  it('getAssignedCase 404s (not 403) when the case is not assigned to this expert', async () => {
    const { service, repo } = createDeps();
    repo.findById.mockResolvedValue(row({ status: 'awaiting_response', expertDoctorId: OTHER_DOCTOR_ID }));

    await expect(service.getAssignedCase(CASE_ID, EXPERT_DOCTOR_ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('getAssignedCase 404s with the SAME code whether the case does not exist or merely is not assigned to this expert', async () => {
    const { service, repo } = createDeps();

    repo.findById.mockResolvedValueOnce(null);
    const missing = await service.getAssignedCase(CASE_ID, EXPERT_DOCTOR_ID).catch((e) => e);

    repo.findById.mockResolvedValueOnce(row({ expertDoctorId: OTHER_DOCTOR_ID }));
    const notAssigned = await service.getAssignedCase(CASE_ID, EXPERT_DOCTOR_ID).catch((e) => e);

    expect(missing.response.code).toBe(notAssigned.response.code);
    expect(missing.status).toBe(notAssigned.status);
  });

  it('*** THE DE-IDENTIFICATION CONTRACT: an expert view never carries sourceConsultationId ***, even when the underlying row has one', async () => {
    const { service, repo } = createDeps();
    repo.findById.mockResolvedValue(
      row({ expertDoctorId: EXPERT_DOCTOR_ID, status: 'awaiting_response', sourceConsultationId: CONSULTATION_ID }),
    );

    const result = await service.getAssignedCase(CASE_ID, EXPERT_DOCTOR_ID);

    expect(result).not.toHaveProperty('sourceConsultationId');
    expect(Object.keys(result)).not.toContain('sourceConsultationId');
  });
});

describe('ClarificationService.respondAsExpert', () => {
  it('moves awaiting_response -> response_received for an ordinary reply', async () => {
    const { service, repo } = createDeps();
    repo.findByIdForUpdate.mockResolvedValue(row({ expertDoctorId: EXPERT_DOCTOR_ID, status: 'awaiting_response' }));
    repo.updateStatusIfIn.mockImplementation(async (_id, _from, patch) =>
      row({ expertDoctorId: EXPERT_DOCTOR_ID, status: patch.status, messages: patch.messages }),
    );

    const result = await service.respondAsExpert(CASE_ID, EXPERT_DOCTOR_ID, {
      messageType: 'comment',
      body: 'Consider a dose increase before switching.',
    });

    expect(result.status).toBe('response_received');
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({ authorId: EXPERT_DOCTOR_ID, authorType: 'doctor', messageType: 'comment' });
  });

  it('moves awaiting_response -> clarification_asked when the expert requests clarification', async () => {
    const { service, repo } = createDeps();
    repo.findByIdForUpdate.mockResolvedValue(row({ expertDoctorId: EXPERT_DOCTOR_ID, status: 'awaiting_response' }));
    repo.updateStatusIfIn.mockImplementation(async (_id, _from, patch) =>
      row({ expertDoctorId: EXPERT_DOCTOR_ID, status: patch.status, messages: patch.messages }),
    );

    const result = await service.respondAsExpert(CASE_ID, EXPERT_DOCTOR_ID, {
      messageType: 'clarification_request',
      body: 'What was the baseline PHQ-9 score?',
    });

    expect(result.status).toBe('clarification_asked');
  });

  it('refuses when it is not this expert\'s turn (status is not awaiting_response)', async () => {
    const { service, repo } = createDeps();
    repo.findByIdForUpdate.mockResolvedValue(row({ expertDoctorId: EXPERT_DOCTOR_ID, status: 'response_received' }));

    await expect(
      service.respondAsExpert(CASE_ID, EXPERT_DOCTOR_ID, { messageType: 'comment', body: 'x' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(repo.updateStatusIfIn).not.toHaveBeenCalled();
  });

  it('404s (not 403) when the case is not assigned to this expert', async () => {
    const { service, repo } = createDeps();
    repo.findByIdForUpdate.mockResolvedValue(row({ expertDoctorId: OTHER_DOCTOR_ID, status: 'awaiting_response' }));

    await expect(
      service.respondAsExpert(CASE_ID, EXPERT_DOCTOR_ID, { messageType: 'comment', body: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('ClarificationService.replyToClarification', () => {
  it('moves clarification_asked -> awaiting_response and appends the doctor\'s reply', async () => {
    const { service, repo } = createDeps();
    repo.findByIdForUpdate.mockResolvedValue(row({ status: 'clarification_asked' }));
    repo.updateStatusIfIn.mockImplementation(async (_id, _from, patch) => row({ status: patch.status, messages: patch.messages }));

    const result = await service.replyToClarification(CASE_ID, TREATING_DOCTOR_ID, {
      messageType: 'comment',
      body: 'Baseline PHQ-9 was 18.',
    });

    expect(result.status).toBe('awaiting_response');
    expect(result.messages[0]).toMatchObject({ authorId: TREATING_DOCTOR_ID, authorType: 'doctor' });
  });

  it('refuses when the case is not currently awaiting the treating doctor\'s reply', async () => {
    const { service, repo } = createDeps();
    repo.findByIdForUpdate.mockResolvedValue(row({ status: 'awaiting_response' }));

    await expect(
      service.replyToClarification(CASE_ID, TREATING_DOCTOR_ID, { messageType: 'comment', body: 'x' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('ClarificationService.markReviewed / closeCase', () => {
  it('markReviewed moves response_received -> reviewed', async () => {
    const { service, repo } = createDeps();
    repo.findByIdForUpdate.mockResolvedValue(row({ status: 'response_received' }));
    repo.updateStatusIfIn.mockResolvedValue(row({ status: 'reviewed' }));

    const result = await service.markReviewed(CASE_ID, TREATING_DOCTOR_ID);

    expect(result.status).toBe('reviewed');
  });

  it('markReviewed refuses from any other status', async () => {
    const { service, repo } = createDeps();
    repo.findByIdForUpdate.mockResolvedValue(row({ status: 'awaiting_response' }));

    await expect(service.markReviewed(CASE_ID, TREATING_DOCTOR_ID)).rejects.toBeInstanceOf(ConflictException);
  });

  it.each(['posted', 'awaiting_response', 'response_received', 'clarification_asked', 'reviewed'] as const)(
    'closeCase closes from %s',
    async (status) => {
      const { service, repo } = createDeps();
      repo.findByIdForUpdate.mockResolvedValue(row({ status }));
      repo.updateStatusIfIn.mockResolvedValue(row({ status: 'closed', closedAt: new Date() }));

      const result = await service.closeCase(CASE_ID, TREATING_DOCTOR_ID);

      expect(result.status).toBe('closed');
    },
  );

  it('closeCase refuses from draft — a case must be posted before it can be closed', async () => {
    const { service, repo } = createDeps();
    repo.findByIdForUpdate.mockResolvedValue(row({ status: 'draft' }));

    await expect(service.closeCase(CASE_ID, TREATING_DOCTOR_ID)).rejects.toBeInstanceOf(ConflictException);
  });

  it('closeCase refuses a case already closed', async () => {
    const { service, repo } = createDeps();
    repo.findByIdForUpdate.mockResolvedValue(row({ status: 'closed', closedAt: new Date() }));

    await expect(service.closeCase(CASE_ID, TREATING_DOCTOR_ID)).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('ClarificationService admin surface', () => {
  it('getForAdmin returns the FULL view, including sourceConsultationId — an admin is not the expert', async () => {
    const { service, repo } = createDeps();
    repo.findById.mockResolvedValue(row({ sourceConsultationId: CONSULTATION_ID }));

    const result = await service.getForAdmin(CASE_ID);

    expect(result.sourceConsultationId).toBe(CONSULTATION_ID);
  });

  it('getForAdmin 404s when the case does not exist', async () => {
    const { service, repo } = createDeps();
    repo.findById.mockResolvedValue(null);

    await expect(service.getForAdmin(CASE_ID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('getCaseSummary never carries case content or sourceConsultationId', async () => {
    const { service, repo } = createDeps();
    repo.findById.mockResolvedValue(row({ sourceConsultationId: CONSULTATION_ID, briefHistory: 'secret text' }));

    const result = await service.getCaseSummary(CASE_ID);

    expect(result).not.toHaveProperty('sourceConsultationId');
    expect(result).not.toHaveProperty('briefHistory');
  });

  it('getCaseSummary returns null for an unknown id', async () => {
    const { service, repo } = createDeps();
    repo.findById.mockResolvedValue(null);

    await expect(service.getCaseSummary(CASE_ID)).resolves.toBeNull();
  });
});
