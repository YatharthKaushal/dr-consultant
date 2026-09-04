import type { ClarificationCaseRow } from '../../schema/clarification-cases.schema';
import { toClarificationCaseExpertView, toClarificationCaseSummaryView, toClarificationCaseView } from './clarification.mapper';

const CASE_ID = '11111111-1111-4111-8111-111111111111';
const TREATING_DOCTOR_ID = '22222222-2222-4222-8222-222222222222';
const CONSULTATION_ID = '33333333-3333-4333-8333-333333333333';

function row(overrides: Partial<ClarificationCaseRow> = {}): ClarificationCaseRow {
  return {
    id: CASE_ID,
    treatingDoctorId: TREATING_DOCTOR_ID,
    sourceConsultationId: CONSULTATION_ID,
    title: 'Persistent low mood',
    patientAge: 34,
    patientGender: 'female',
    briefHistory: 'Three months of low mood.',
    diagnosis: null,
    currentPlan: null,
    specificDoubt: 'SSRI switch reasonable?',
    urgency: 'routine',
    expertDoctorId: null,
    assignedAt: null,
    messages: [],
    status: 'posted',
    postedAt: new Date('2026-09-01T00:00:00Z'),
    closedAt: null,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-01T00:00:00Z'),
    ...overrides,
  };
}

describe('toClarificationCaseView', () => {
  it('carries sourceConsultationId — this is the treating-doctor/admin view', () => {
    const view = toClarificationCaseView(row());
    expect(view.sourceConsultationId).toBe(CONSULTATION_ID);
  });

  it('carries the de-identification notice only while status is draft', () => {
    expect(toClarificationCaseView(row({ status: 'draft' })).deidentificationNotice).toEqual(expect.any(String));
    expect(toClarificationCaseView(row({ status: 'posted' })).deidentificationNotice).toBeUndefined();
    expect('deidentificationNotice' in toClarificationCaseView(row({ status: 'posted' }))).toBe(false);
  });
});

describe('toClarificationCaseExpertView — CHECK #2: what the expert may see', () => {
  it('*** NEVER carries sourceConsultationId, structurally — the key is genuinely absent, not undefined ***', () => {
    const view = toClarificationCaseExpertView(row({ sourceConsultationId: CONSULTATION_ID }));

    expect(Object.keys(view)).not.toContain('sourceConsultationId');
    expect('sourceConsultationId' in view).toBe(false);
  });

  it('never carries the de-identification notice — that warning is for the treating doctor, before posting', () => {
    const view = toClarificationCaseExpertView(row());
    expect('deidentificationNotice' in view).toBe(false);
  });

  it('still carries treatingDoctorId — a colleague identity, not a patient identifier', () => {
    const view = toClarificationCaseExpertView(row());
    expect(view.treatingDoctorId).toBe(TREATING_DOCTOR_ID);
  });

  it('carries every clinical field the schema defines', () => {
    const source = row({
      title: 'A title',
      patientAge: 40,
      patientGender: 'male',
      briefHistory: 'History text',
      diagnosis: 'Provisional diagnosis',
      currentPlan: 'Current plan text',
      specificDoubt: 'The doubt',
      urgency: 'urgent',
    });
    const view = toClarificationCaseExpertView(source);

    expect(view).toMatchObject({
      title: 'A title',
      patientAge: 40,
      patientGender: 'male',
      briefHistory: 'History text',
      diagnosis: 'Provisional diagnosis',
      currentPlan: 'Current plan text',
      specificDoubt: 'The doubt',
      urgency: 'urgent',
    });
  });
});

describe('toClarificationCaseSummaryView', () => {
  it('carries no case content and no sourceConsultationId — the narrowest cross-module read', () => {
    const view = toClarificationCaseSummaryView(row({ sourceConsultationId: CONSULTATION_ID, briefHistory: 'secret' }));

    expect(view).not.toHaveProperty('sourceConsultationId');
    expect(view).not.toHaveProperty('briefHistory');
    expect(view).not.toHaveProperty('diagnosis');
    expect(view).not.toHaveProperty('specificDoubt');
  });
});
