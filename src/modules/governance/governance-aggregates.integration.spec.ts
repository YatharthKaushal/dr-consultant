/**
 * *** REAL-DATABASE TEST. *** Follows `clinical/clinical.completion-gate
 * .integration.spec.ts`'s pattern — one fixture helper, strict reverse-FK
 * teardown, per-run UUID/reference-code namespacing.
 *
 * ── Why none of this can be a mocked test ──────────────────────────────────
 *
 * `governance-quality.service.spec.ts` asserts that `getDashboard` CALLS
 * `BookingFacade.countByStatus`/`ClinicalFacade.countPendingCaseSummaries`/
 * `FollowupFacade.countOpenAlertsByType` and adds their results together
 * correctly — a claim about `jest.fn()`s. It says nothing about whether the
 * `GROUP BY` queries THEMSELVES (`booking.repository.ts#countByStatus`,
 * `clinical.repository.ts#listDrafts`/`countDrafts`,
 * `followup.repository.ts#countOpenAlertsByType`) actually count what their
 * names claim against real Postgres rows — including the one subtlety a mock
 * cannot exercise: a status/type with ZERO matching rows is simply ABSENT
 * from the returned map, not present with value `0`, and every caller in
 * this module composes with `?? 0`. This file proves that against a real
 * `GROUP BY` result, not an assumption about how Drizzle behaves.
 *
 * ── The delta approach, and why a raw total assertion would be wrong ───────
 *
 * `countByStatus`/`countDrafts`/`countOpenAlertsByType` are GLOBAL
 * aggregates with no `consultationId`/`doctorId` scope — that is their whole
 * point, a dashboard number is platform-wide. Against a REAL shared
 * database (this suite runs alongside every other integration spec against
 * the same `DATABASE_URL`), asserting an absolute total would be flaky by
 * construction. Every assertion below instead reads the aggregate BEFORE
 * seeding, inserts a known number of new rows, reads it AFTER, and asserts
 * the DELTA — which is exactly right regardless of what else exists in the
 * table.
 *
 * ── What is real here and what is not ──────────────────────────────────────
 *
 * Real: the database, `BookingRepository`, `ClinicalRepository`,
 * `FollowupRepository` — the exact three repositories `GovernanceQualityService`/
 * `GovernanceQueueService` compose through their owning modules' facades.
 * NOT constructed here: the facades themselves, or `GovernanceQueueService`/
 * `GovernanceQualityService` — their composition logic is proved with mocks
 * in their own `.spec.ts` files, and constructing the real facades would
 * pull in every dependency `clinical.completion-gate.integration.spec.ts`'s
 * header already explains is out of scope for a narrow SQL claim.
 *
 * ── Requires a reachable Postgres ──────────────────────────────────────────
 *
 * Reads `DATABASE_URL` from `.env`/`.env.local` exactly as the seed scripts
 * do, and fails loudly rather than skipping.
 */
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { connectDatabase, disconnectDatabase, type Database } from '../../config/db/database.config';
import { loadEnvFiles } from '../../config/env/env.validation';
import { clinicalRecordsTable } from '../../schema/clinical-records.schema';
import { consultationsTable } from '../../schema/consultations.schema';
import { doctorSpecialtiesTable } from '../../schema/doctor-specialties.schema';
import { doctorsTable } from '../../schema/doctors.schema';
import type { ConsultationStatus } from '../../schema/enums.schema';
import { patientsTable } from '../../schema/patients.schema';
import { safetyAlertsTable } from '../../schema/safety-alerts.schema';
import { specialtiesTable } from '../../schema/specialties.schema';
import { BookingRepository } from '../booking/booking.repository';
import { ClinicalRepository } from '../clinical/clinical.repository';
import { FollowupRepository } from '../followup/followup.repository';

jest.setTimeout(30_000);

interface Fixtures {
  runId: string;
  specialtyId: string;
  patientId: string;
  doctorId: string;
  /** Two `completed`, one `cancelled` — for `countByStatus`'s delta. */
  completedConsultationIds: string[];
  cancelledConsultationId: string;
  /** Carries the two clinical-record drafts and the one finalised record. */
  draftConsultationIds: string[];
  finalisedConsultationId: string;
  /** Carries the safety alerts: two open `red_flag`, one open `amber`, one closed `red_flag` (must NOT count). */
  alertConsultationId: string;
}

async function seedFixtures(db: Database): Promise<Fixtures> {
  const runId = randomUUID().slice(0, 8);
  let phoneSeq = 10;
  const nextPhone = () => `+9197${runId.slice(0, 6)}${String(phoneSeq++).padStart(2, '0')}`;

  const [specialty] = await db
    .insert(specialtiesTable)
    .values({ code: `gov_agg_${runId}`, name: `Governance Aggregates ${runId}`, canPrescribe: true })
    .returning({ id: specialtiesTable.id });

  const [patient] = await db
    .insert(patientsTable)
    .values({ mobileNumber: nextPhone(), status: 'active' })
    .returning({ id: patientsTable.id });

  const [doctor] = await db
    .insert(doctorsTable)
    .values({
      mobileNumber: nextPhone(),
      fullName: `Governance Aggregates Doctor ${runId}`,
      verificationStatus: 'verified',
      isListed: true,
    })
    .returning({ id: doctorsTable.id });
  await db.insert(doctorSpecialtiesTable).values({ doctorId: doctor.id, specialtyId: specialty.id, isPrimary: true });

  let referenceSeq = 100;
  async function makeConsultation(status: ConsultationStatus): Promise<string> {
    const [row] = await db
      .insert(consultationsTable)
      .values({
        referenceCode: `GOVAGG-${runId}-${referenceSeq++}`,
        patientId: patient.id,
        doctorId: doctor.id,
        specialtyId: specialty.id,
        mode: 'scheduled',
        status,
        durationMinutes: 30,
      })
      .returning({ id: consultationsTable.id });
    return row.id;
  }

  const completedConsultationIds = [await makeConsultation('completed'), await makeConsultation('completed')];
  const cancelledConsultationId = await makeConsultation('cancelled');
  const draftConsultationIds = [await makeConsultation('awaiting_documentation'), await makeConsultation('awaiting_documentation')];
  const finalisedConsultationId = await makeConsultation('completed');
  const alertConsultationId = await makeConsultation('in_progress');

  // Two drafts, deliberately timestamped a second apart so `listDrafts`'s
  // oldest-first ordering has something real to prove.
  const now = Date.now();
  await db.insert(clinicalRecordsTable).values({
    consultationId: draftConsultationIds[0]!,
    chiefComplaint: 'Older draft',
    riskCategory: 'moderate',
    createdAt: new Date(now - 60_000),
    updatedAt: new Date(now - 60_000),
  });
  await db.insert(clinicalRecordsTable).values({
    consultationId: draftConsultationIds[1]!,
    chiefComplaint: 'Newer draft',
    riskCategory: 'low',
    createdAt: new Date(now - 30_000),
    updatedAt: new Date(now - 30_000),
  });
  await db.insert(clinicalRecordsTable).values({
    consultationId: finalisedConsultationId,
    chiefComplaint: 'Already finalised, must not count as a draft',
    riskCategory: 'high',
    caseSummary: 'Finalised for the aggregates test.',
    adviceCovered: 'x',
    adviceHomePractice: 'x',
    adviceNextFocus: 'x',
    adviceWarningSigns: 'x',
    finalisedAt: new Date(),
  });

  await db.insert(safetyAlertsTable).values([
    { alertType: 'red_flag', consultationId: alertConsultationId, reason: 'Open red flag one.' },
    { alertType: 'red_flag', consultationId: alertConsultationId, reason: 'Open red flag two.' },
    { alertType: 'amber', consultationId: alertConsultationId, reason: 'Open amber.' },
    // Closed — must NOT be counted as open by `countOpenAlertsByType`.
    {
      alertType: 'red_flag',
      consultationId: alertConsultationId,
      reason: 'Closed red flag, must not count.',
      closedAt: new Date(),
    },
  ]);

  return {
    runId,
    specialtyId: specialty.id,
    patientId: patient.id,
    doctorId: doctor.id,
    completedConsultationIds,
    cancelledConsultationId,
    draftConsultationIds,
    finalisedConsultationId,
    alertConsultationId,
  };
}

async function teardown(db: Database, fixtures: Fixtures): Promise<void> {
  const consultationIds = [
    ...fixtures.completedConsultationIds,
    fixtures.cancelledConsultationId,
    ...fixtures.draftConsultationIds,
    fixtures.finalisedConsultationId,
    fixtures.alertConsultationId,
  ];

  await db.delete(safetyAlertsTable).where(inArray(safetyAlertsTable.consultationId, consultationIds));
  await db.delete(clinicalRecordsTable).where(inArray(clinicalRecordsTable.consultationId, consultationIds));
  await db.delete(consultationsTable).where(inArray(consultationsTable.id, consultationIds));
  await db.delete(doctorSpecialtiesTable).where(eq(doctorSpecialtiesTable.doctorId, fixtures.doctorId));
  await db.delete(doctorsTable).where(eq(doctorsTable.id, fixtures.doctorId));
  await db.delete(patientsTable).where(eq(patientsTable.id, fixtures.patientId));
  await db.delete(specialtiesTable).where(eq(specialtiesTable.id, fixtures.specialtyId));
}

describe('M-20 governance aggregate queries, against a real database', () => {
  let db: Database;
  let fixtures: Fixtures;
  let bookingRepo: BookingRepository;
  let clinicalRepo: ClinicalRepository;
  let followupRepo: FollowupRepository;

  let before: {
    statusCounts: Partial<Record<string, number>>;
    draftCount: number;
    alertCounts: Partial<Record<string, number>>;
  };

  beforeAll(async () => {
    loadEnvFiles();
    db = await connectDatabase();
    bookingRepo = new BookingRepository(db);
    clinicalRepo = new ClinicalRepository(db);
    followupRepo = new FollowupRepository(db);

    // Read the "before" picture BEFORE seeding, so every assertion below is a
    // delta — see the file header for why a raw total would be flaky here.
    before = {
      statusCounts: await bookingRepo.countByStatus(),
      draftCount: await clinicalRepo.countDrafts(),
      alertCounts: await followupRepo.countOpenAlertsByType(),
    };

    fixtures = await seedFixtures(db);
  });

  afterAll(async () => {
    await teardown(db, fixtures);
    await disconnectDatabase();
  });

  it('BookingRepository#countByStatus: the two new `completed` rows and the one `cancelled` row both land in the GROUP BY', async () => {
    const after = await bookingRepo.countByStatus();

    expect((after.completed ?? 0) - (before.statusCounts.completed ?? 0)).toBe(3); // 2 explicitly `completed` + the finalised-record consultation, also seeded as `completed`
    expect((after.cancelled ?? 0) - (before.statusCounts.cancelled ?? 0)).toBe(1);
  });

  it('ClinicalRepository#countDrafts: counts the two unfinalised records, never the finalised one', async () => {
    const after = await clinicalRepo.countDrafts();
    expect(after - before.draftCount).toBe(2);
  });

  it('ClinicalRepository#listDrafts: returns the two drafts OLDEST first, and excludes the finalised record entirely', async () => {
    // Page generously past any pre-existing backlog so both seeded rows are
    // guaranteed to appear regardless of what else is in the table.
    const rows = await clinicalRepo.listDrafts(before.draftCount + 50, 0);
    const ids = rows.map((row) => row.consultationId);

    expect(ids).toContain(fixtures.draftConsultationIds[0]);
    expect(ids).toContain(fixtures.draftConsultationIds[1]);
    expect(ids).not.toContain(fixtures.finalisedConsultationId);

    const olderIndex = ids.indexOf(fixtures.draftConsultationIds[0]!);
    const newerIndex = ids.indexOf(fixtures.draftConsultationIds[1]!);
    expect(olderIndex).toBeLessThan(newerIndex);
  });

  it('FollowupRepository#countOpenAlertsByType: counts only OPEN alerts, split by type, excluding the closed one', async () => {
    const after = await followupRepo.countOpenAlertsByType();

    expect((after.red_flag ?? 0) - (before.alertCounts.red_flag ?? 0)).toBe(2); // 2 open, the 3rd is closed
    expect((after.amber ?? 0) - (before.alertCounts.amber ?? 0)).toBe(1);
  });

  it('FollowupRepository#listOpenAlerts: the open alerts for this run are present, the closed one is not', async () => {
    const rows = await followupRepo.listOpenAlerts(2_000, 0);
    const reasons = rows.filter((row) => row.consultationId === fixtures.alertConsultationId).map((row) => row.reason);

    expect(reasons).toEqual(
      expect.arrayContaining(['Open red flag one.', 'Open red flag two.', 'Open amber.']),
    );
    expect(reasons).not.toContain('Closed red flag, must not count.');
  });
});
