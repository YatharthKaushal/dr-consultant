import { NotFoundException } from '@nestjs/common';
import type { DoctorClinicalTemplateRow } from '../../schema/doctor-clinical-templates.schema';
import type { AuditService } from '../../shared/audit/audit.service';
import type { DoctorFacade } from '../doctor/doctor.facade';
import { CLINICAL_ERROR_CODES } from './clinical.constants';
import type { SaveClinicalTemplateDto } from './clinical.dto';
import { ClinicalTemplateService } from './clinical-template.service';
import type { ClinicalTemplateRepository } from './clinical-template.repository';

const DOCTOR_ID = '22222222-2222-4222-8222-222222222222';
const TEMPLATE_ID = '77777777-7777-4777-8777-777777777777';
const SPECIALTY_ID = '55555555-5555-4555-8555-555555555555';
const OTHER_SPECIALTY_ID = '88888888-8888-4888-8888-888888888888';

const MEDICINE = { name: 'Sertraline', dose: '50mg', frequency: 'Once daily', duration: '14 days' };

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

function dto(overrides: Partial<SaveClinicalTemplateDto> = {}): SaveClinicalTemplateDto {
  return { name: 'Standard anxiety start', ...overrides };
}

/** Hand-rolled deps, `new ClinicalTemplateService(...)` — never `Test.createTestingModule`. */
function createDeps() {
  const repo = {
    findByIdForDoctor: jest.fn(),
    listForDoctor: jest.fn(),
    create: jest.fn(),
    updateForDoctor: jest.fn(),
    deleteForDoctor: jest.fn(),
  };
  const doctors = {
    getPrescribingEligibility: jest.fn().mockResolvedValue(false),
    getPublicProfile: jest.fn(),
  };
  const audit = { write: jest.fn().mockResolvedValue(undefined) };

  const service = new ClinicalTemplateService(
    repo as unknown as ClinicalTemplateRepository,
    doctors as unknown as DoctorFacade,
    audit as unknown as AuditService,
  );

  return { service, repo, doctors, audit };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ response: { code } });
}

/** Drizzle 0.45 wraps the driver error and hangs the real one off `.cause` — see `postgres-error.util.ts`. */
function wrappedPgError(code: string): Error {
  const driverError = Object.assign(new Error('driver'), { code });
  return Object.assign(new Error('DrizzleQueryError'), { cause: driverError });
}

describe('ClinicalTemplateService', () => {
  /* ═══════════════════════════════════════════════════════════════════════ */
  /* DONE-WHEN 2, VIA A TEMPLATE: "a non-prescribing professional cannot     */
  /* save a medicine."                                                       */
  /* ═══════════════════════════════════════════════════════════════════════ */

  describe('the prescribing gate on a personal template (FR-9.6)', () => {
    it('*** ANGLE 4: *** refuses to CREATE a template containing medicines for a non-prescribing doctor', async () => {
      const deps = createDeps();
      deps.doctors.getPrescribingEligibility.mockResolvedValue(false);

      await expectCode(
        deps.service.create(DOCTOR_ID, dto({ medicines: [MEDICINE] })),
        CLINICAL_ERROR_CODES.MEDICINES_NOT_PERMITTED,
      );
      expect(deps.repo.create).not.toHaveBeenCalled();
    });

    it('*** ANGLE 5: *** refuses to UPDATE an advice-only template into one containing medicines', async () => {
      const deps = createDeps();
      deps.repo.findByIdForDoctor.mockResolvedValue(template());
      deps.doctors.getPrescribingEligibility.mockResolvedValue(false);

      await expectCode(
        deps.service.update(TEMPLATE_ID, DOCTOR_ID, dto({ medicines: [MEDICINE] })),
        CLINICAL_ERROR_CODES.MEDICINES_NOT_PERMITTED,
      );
      expect(deps.repo.updateForDoctor).not.toHaveBeenCalled();
    });

    it('*** USES `DoctorContract.getPrescribingEligibility` HERE *** — the method whose own doc comment names this exact use case', async () => {
      const deps = createDeps();
      deps.doctors.getPrescribingEligibility.mockResolvedValue(true);
      deps.repo.create.mockResolvedValue(template({ medicines: [MEDICINE] }));

      await deps.service.create(DOCTOR_ID, dto({ medicines: [MEDICINE] }));

      // There is no consultation here to snapshot a specialty from, which is
      // precisely why the doctor-level method is right and the
      // consultation-level one is not available.
      expect(deps.doctors.getPrescribingEligibility).toHaveBeenCalledWith(DOCTOR_ID);
    });

    it('lets a non-prescribing doctor save an ADVICE-ONLY template — one table, not a medicine/advice pair', async () => {
      const deps = createDeps();
      deps.doctors.getPrescribingEligibility.mockResolvedValue(false);
      deps.repo.create.mockResolvedValue(template({ adviceCovered: 'Grounding practice.' }));

      await expect(
        deps.service.create(DOCTOR_ID, dto({ adviceCovered: 'Grounding practice.' })),
      ).resolves.toMatchObject({ name: 'Standard anxiety start' });
      // Nothing to gate, so the eligibility read is never even made.
      expect(deps.doctors.getPrescribingEligibility).not.toHaveBeenCalled();
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════ */
  /* The two constraints the table carries                                   */
  /* ═══════════════════════════════════════════════════════════════════════ */

  describe('constraints', () => {
    it('turns a unique violation on (doctor_id, name) into TEMPLATE_NAME_TAKEN, not a 500', async () => {
      const deps = createDeps();
      deps.repo.create.mockRejectedValue(wrappedPgError('23505'));

      await expectCode(deps.service.create(DOCTOR_ID, dto()), CLINICAL_ERROR_CODES.TEMPLATE_NAME_TAKEN);
    });

    it('turns the composite doctor/specialty FK violation into TEMPLATE_SPECIALTY_NOT_PRACTISED, not a 500', async () => {
      const deps = createDeps();
      // The pre-check passes (the doctor did practise it a moment ago) and the
      // write still loses the race with an admin removing the specialty.
      deps.doctors.getPublicProfile.mockResolvedValue({
        specialties: [{ id: SPECIALTY_ID, code: 'psychiatry', name: 'Psychiatry', isPrimary: true }],
      });
      deps.repo.create.mockRejectedValue(wrappedPgError('23503'));

      await expectCode(
        deps.service.create(DOCTOR_ID, dto({ specialtyId: SPECIALTY_ID })),
        CLINICAL_ERROR_CODES.TEMPLATE_SPECIALTY_NOT_PRACTISED,
      );
    });

    it('refuses a specialty tag the doctor does not practise, before the database has to', async () => {
      const deps = createDeps();
      deps.doctors.getPublicProfile.mockResolvedValue({
        specialties: [{ id: OTHER_SPECIALTY_ID, code: 'therapy', name: 'Therapy', isPrimary: true }],
      });

      await expectCode(
        deps.service.create(DOCTOR_ID, dto({ specialtyId: SPECIALTY_ID })),
        CLINICAL_ERROR_CODES.TEMPLATE_SPECIALTY_NOT_PRACTISED,
      );
      expect(deps.repo.create).not.toHaveBeenCalled();
    });

    it('lets an untagged (general-purpose) template through without touching the doctor profile at all', async () => {
      const deps = createDeps();
      deps.repo.create.mockResolvedValue(template());

      await deps.service.create(DOCTOR_ID, dto());

      expect(deps.doctors.getPublicProfile).not.toHaveBeenCalled();
      expect(deps.repo.create).toHaveBeenCalledWith(expect.objectContaining({ specialtyId: null }));
    });

    it('rethrows an unrelated database error rather than mislabelling it as a conflict', async () => {
      const deps = createDeps();
      deps.repo.create.mockRejectedValue(new Error('connection terminated'));

      await expect(deps.service.create(DOCTOR_ID, dto())).rejects.toThrow('connection terminated');
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════ */
  /* Ownership                                                               */
  /* ═══════════════════════════════════════════════════════════════════════ */

  describe('ownership', () => {
    it("404s on another doctor's template with the same code an unknown id gets", async () => {
      const deps = createDeps();
      deps.repo.findByIdForDoctor.mockResolvedValue(null);

      await expectCode(deps.service.getOwn(TEMPLATE_ID, DOCTOR_ID), CLINICAL_ERROR_CODES.TEMPLATE_NOT_FOUND);
      await expect(deps.service.getOwn(TEMPLATE_ID, DOCTOR_ID)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('scopes every read to the calling doctor in SQL — there is no unscoped find to check afterwards', async () => {
      const deps = createDeps();
      deps.repo.findByIdForDoctor.mockResolvedValue(template());

      await deps.service.getOwn(TEMPLATE_ID, DOCTOR_ID);

      expect(deps.repo.findByIdForDoctor).toHaveBeenCalledWith(TEMPLATE_ID, DOCTOR_ID);
    });

    it('deletes hard, and audits it', async () => {
      const deps = createDeps();
      deps.repo.findByIdForDoctor.mockResolvedValue(template());
      deps.repo.deleteForDoctor.mockResolvedValue(true);

      await deps.service.remove(TEMPLATE_ID, DOCTOR_ID);

      expect(deps.repo.deleteForDoctor).toHaveBeenCalledWith(TEMPLATE_ID, DOCTOR_ID);
      expect(deps.audit.write).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'delete', entityType: 'doctor_clinical_template' }),
      );
    });

    it('reports a lost delete race as not-found rather than a silent success', async () => {
      const deps = createDeps();
      deps.repo.findByIdForDoctor.mockResolvedValue(template());
      deps.repo.deleteForDoctor.mockResolvedValue(false);

      await expectCode(deps.service.remove(TEMPLATE_ID, DOCTOR_ID), CLINICAL_ERROR_CODES.TEMPLATE_NOT_FOUND);
    });
  });

  /* ═══════════════════════════════════════════════════════════════════════ */
  /* Auditing                                                                */
  /* ═══════════════════════════════════════════════════════════════════════ */

  it('writes a template audit row with NO consultation id — a template belongs to a doctor, not to a consultation', async () => {
    const deps = createDeps();
    deps.repo.create.mockResolvedValue(template());

    await deps.service.create(DOCTOR_ID, dto());

    const [entry] = deps.audit.write.mock.calls[0] ?? [];
    expect(entry).toMatchObject({ actorType: 'doctor', actorId: DOCTOR_ID, action: 'create' });
    expect(entry).not.toHaveProperty('consultationId');
  });
});
