import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateClarificationCaseDto } from './clarification.dto';

/**
 * *** THE HONEST DE-IDENTIFICATION CLAIM: STRUCTURAL ABSENCE, NOT REDACTION.
 * ***
 *
 * `clarification.constants.ts#DEIDENTIFICATION_NOTICE` and
 * `clarification.service.ts#postCase`'s header are both explicit that this
 * module does not and cannot redact an identifier a doctor types into free
 * text. What it DOES guarantee is narrower and provable: there is no
 * `patientName`/`patientPhone`/`patientAddress`/`patientEmail` field on the
 * DTO that reaches this module's create route, so nothing needs to strip one
 * at runtime — there is nowhere for it to have been written.
 *
 * This test proves the runtime half of that: the global `ValidationPipe`
 * (`app.bootstrap.ts`) is configured `{ whitelist: true, transform: true }`,
 * which is exactly `plainToInstance` + `validate({ whitelist: true })` below
 * — a payload carrying direct identifiers alongside the legitimate fields
 * comes out the other side with them gone, because `CreateClarificationCaseDto`
 * declares no matching property for `class-validator` to keep.
 */
describe('CreateClarificationCaseDto — structural de-identification', () => {
  it('strips patientName/patientPhone/patientAddress/patientEmail (and treatingDoctorId) sent by a malicious or careless client', async () => {
    const payload = {
      title: 'Persistent low mood',
      briefHistory: 'Three months of low mood.',
      specificDoubt: 'SSRI switch reasonable?',
      // None of these five have a matching @-decorated property below.
      patientName: 'Asha Verma',
      patientPhone: '+919876543210',
      patientAddress: '12 MG Road, Andheri, Mumbai',
      patientEmail: 'asha.verma@example.com',
      treatingDoctorId: 'some-other-doctor-id',
    };

    const instance = plainToInstance(CreateClarificationCaseDto, payload, { excludeExtraneousValues: false });
    const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: false });

    expect(errors).toEqual([]);
    expect(instance).not.toHaveProperty('patientName');
    expect(instance).not.toHaveProperty('patientPhone');
    expect(instance).not.toHaveProperty('patientAddress');
    expect(instance).not.toHaveProperty('patientEmail');
    expect(instance).not.toHaveProperty('treatingDoctorId');
  });

  it('accepts a fully-populated legitimate payload with no validation errors', async () => {
    const instance = plainToInstance(CreateClarificationCaseDto, {
      title: 'Persistent low mood, unclear diagnosis',
      patientAge: 34,
      patientGender: 'female',
      briefHistory: 'Three months of low mood and poor sleep.',
      diagnosis: 'Provisional: Major depressive episode.',
      currentPlan: 'Sertraline 50mg, weekly review.',
      specificDoubt: 'Would an SSRI switch be reasonable given no response at 6 weeks?',
      urgency: 'soon',
      sourceConsultationId: '11111111-1111-4111-8111-111111111111',
    });

    const errors = await validate(instance, { whitelist: true });
    expect(errors).toEqual([]);
  });

  it('rejects a title over the column limit rather than silently truncating it', async () => {
    const instance = plainToInstance(CreateClarificationCaseDto, {
      title: 'x'.repeat(201),
      briefHistory: 'Three months of low mood.',
      specificDoubt: 'SSRI switch reasonable?',
    });

    const errors = await validate(instance, { whitelist: true });
    expect(errors.some((e) => e.property === 'title')).toBe(true);
  });
});
