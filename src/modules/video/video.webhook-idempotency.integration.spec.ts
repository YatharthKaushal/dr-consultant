/**
 * *** REAL-DATABASE TEST. Follows `instant/instant.routing-race.integration
 * .spec.ts`, which follows `booking/booking.slot-race.integration.spec.ts` and
 * `document/patient-file.transaction.integration.spec.ts` — one fixture
 * helper, strict reverse-FK teardown, per-run UUID namespacing, and a positive
 * control on every claim. ***
 *
 * ── M-14's OTHER DONE-WHEN, AND WHY IT CANNOT BE MOCKED ────────────────────
 *
 * `docs/MODULES.md` M-14: "session metadata is complete after the call". This
 * module's whole claim to that is a claim about DATABASE OBJECTS, not about
 * service code, and a `jest.fn()` cannot answer any of it:
 *
 *   1. `docs/erd.sql` on `consultation_participants.livekit_participant_sid`:
 *      "this being the key is what makes webhook redelivery idempotent". A
 *      unit test can assert that a repository RETURNING `false` is treated as a
 *      replay — `video-webhook.service.spec.ts` does. Only Postgres can say
 *      that a second `INSERT ... ON CONFLICT DO NOTHING` on the same sid really
 *      writes nothing.
 *
 *   2. `closeConnection` is an UPSERT with `ON CONFLICT DO UPDATE ... WHERE
 *      left_at IS NULL`. That `setWhere` is the entire guarantee that a
 *      redelivered `participant_left` cannot move the recorded leave time, and
 *      it is a clause in generated SQL — the one thing a mocked Drizzle proves
 *      nothing about.
 *
 *   3. "A reconnect ADDS a row, never overwrites one" is a claim about a
 *      primary key admitting a second sid for the same consultation and party.
 *
 *   4. The table's hand-added CHECK (`party in ('patient','doctor')`) is a
 *      database object no TypeScript type reaches.
 *
 * ── Requires a reachable Postgres ─────────────────────────────────────────
 *
 * Reads `DATABASE_URL` from `.env`/`.env.local` exactly as the seed scripts do,
 * and fails loudly rather than skipping if the database is unreachable: a
 * silently-skipped idempotency test is worse than no test.
 *
 * ── There is no LiveKit server, and this test does not pretend otherwise ───
 *
 * Every delivery below is a `LivekitWebhookDelivery` constructed by hand and
 * handed to `VideoWebhookService#handle` — i.e. the code path that runs AFTER
 * signature verification. Verification itself is the SDK's `WebhookReceiver`,
 * exercised in `video.secret-leak.spec.ts` against a real `LivekitClient`.
 * *** NO ROOM WAS EVER JOINED, HERE OR ANYWHERE ELSE IN THIS TEST SUITE. ***
 */
import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { connectDatabase, disconnectDatabase, type Database } from '../../config/db/database.config';
import { loadEnvFiles } from '../../config/env/env.validation';
import { consultationParticipantsTable } from '../../schema/consultation-participants.schema';
import { consultationsTable } from '../../schema/consultations.schema';
import { doctorSpecialtiesTable } from '../../schema/doctor-specialties.schema';
import { doctorsTable } from '../../schema/doctors.schema';
import { patientsTable } from '../../schema/patients.schema';
import { specialtiesTable } from '../../schema/specialties.schema';
import { AuditService } from '../../shared/audit/audit.service';
import type { BookingView } from '../booking/booking.contract';
import type { LivekitWebhookDelivery } from './livekit.client';
import { deriveSession } from './video-session.util';
import { VideoRepository } from './video.repository';
import { VideoWebhookService } from './video-webhook.service';

jest.setTimeout(30_000);

interface Fixtures {
  runId: string;
  specialtyId: string;
  patientId: string;
  doctorId: string;
  /** A `scheduled` consultation with both parties assigned — the ordinary video call. */
  consultationId: string;
  /** A second consultation, used to prove a row cannot be written against a stranger's id. */
  otherPatientId: string;
}

async function seedFixtures(db: Database): Promise<Fixtures> {
  const runId = randomUUID().slice(0, 8);
  let phoneSeq = 10;
  const nextPhone = () => `+9198${runId.slice(0, 6)}${String(phoneSeq++).padStart(2, '0')}`;

  const [specialty] = await db
    .insert(specialtiesTable)
    .values({ code: `vid_${runId}`, name: `Video Specialty ${runId}` })
    .returning({ id: specialtiesTable.id });

  const [patient] = await db
    .insert(patientsTable)
    .values({ mobileNumber: nextPhone(), status: 'active' })
    .returning({ id: patientsTable.id });

  const [otherPatient] = await db
    .insert(patientsTable)
    .values({ mobileNumber: nextPhone(), status: 'active' })
    .returning({ id: patientsTable.id });

  const [doctor] = await db
    .insert(doctorsTable)
    .values({
      mobileNumber: nextPhone(),
      fullName: `Video Doctor ${runId}`,
      verificationStatus: 'verified',
      isListed: true,
    })
    .returning({ id: doctorsTable.id });
  await db.insert(doctorSpecialtiesTable).values({ doctorId: doctor.id, specialtyId: specialty.id });

  const [consultation] = await db
    .insert(consultationsTable)
    .values({
      referenceCode: `VID-${randomUUID().slice(0, 16)}`,
      patientId: patient.id,
      doctorId: doctor.id,
      specialtyId: specialty.id,
      mode: 'scheduled',
      status: 'scheduled',
      scheduledStartAt: new Date('2026-09-04T10:00:00.000Z'),
      durationMinutes: 30,
    })
    .returning({ id: consultationsTable.id });

  return {
    runId,
    specialtyId: specialty.id,
    patientId: patient.id,
    otherPatientId: otherPatient.id,
    doctorId: doctor.id,
    consultationId: consultation.id,
  };
}

/** Strict reverse FK order. Children before parents, every time. */
async function teardown(db: Database, fixtures: Fixtures): Promise<void> {
  await db
    .delete(consultationParticipantsTable)
    .where(eq(consultationParticipantsTable.consultationId, fixtures.consultationId));
  await db.execute(sql`delete from audit_log where consultation_id = ${fixtures.consultationId}`);
  await db.delete(consultationsTable).where(eq(consultationsTable.id, fixtures.consultationId));
  await db.delete(doctorSpecialtiesTable).where(eq(doctorSpecialtiesTable.doctorId, fixtures.doctorId));
  await db.delete(doctorsTable).where(eq(doctorsTable.id, fixtures.doctorId));
  await db
    .delete(patientsTable)
    .where(inArray(patientsTable.id, [fixtures.patientId, fixtures.otherPatientId]));
  await db.delete(specialtiesTable).where(eq(specialtiesTable.id, fixtures.specialtyId));
}

/** Unwraps Drizzle's `DrizzleQueryError` to the underlying `pg` `DatabaseError`, where `code`/`constraint` actually live. */
function causeOf(error: unknown): Record<string, unknown> {
  const wrapped = error as { cause?: unknown };
  return (wrapped?.cause ?? error) as Record<string, unknown>;
}

describe('Video webhooks — the primary key, the left_at guard and the CHECK (integration)', () => {
  let db: Database;
  let fixtures: Fixtures;
  let repo: VideoRepository;
  let webhooks: VideoWebhookService;

  /** Records what `VideoService` was asked to do, without a booking module behind it. */
  let statusMoves: Array<{ to: string; consultationId: string }>;

  beforeAll(async () => {
    loadEnvFiles();
    db = await connectDatabase();
    fixtures = await seedFixtures(db);
    repo = new VideoRepository(db);
  });

  beforeEach(async () => {
    await db
      .delete(consultationParticipantsTable)
      .where(eq(consultationParticipantsTable.consultationId, fixtures.consultationId));

    statusMoves = [];

    const booking: BookingView = {
      id: fixtures.consultationId,
      referenceCode: 'VID-TEST',
      patientId: fixtures.patientId,
      doctorId: fixtures.doctorId,
      specialtyId: fixtures.specialtyId,
      concernId: null,
      mode: 'scheduled',
      status: 'scheduled',
      scheduledStartAt: new Date('2026-09-04T10:00:00.000Z'),
      durationMinutes: 30,
      intakeAnswers: null,
      rescheduledFromConsultationId: null,
      cancelledAt: null,
      cancelledByParty: null,
      cancellationReason: null,
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
    };

    // *** THE DATABASE IS REAL; THE OTHER MODULES ARE NOT. *** This spec is
    // about `consultation_participants` and the SQL that writes it. M-11's
    // status machine has its own tests and its own transaction; standing one up
    // here would test that instead.
    const video = {
      markCallStarted: jest.fn(async (consultationId: string) => {
        statusMoves.push({ to: 'in_progress', consultationId });
      }),
      endSession: jest.fn(async (consultationId: string) => {
        statusMoves.push({ to: 'awaiting_documentation', consultationId });
        return { consultationId, changed: true, status: 'awaiting_documentation' as const };
      }),
    };
    const bookings = { getBooking: jest.fn().mockResolvedValue(booking) };

    webhooks = new VideoWebhookService(
      { verifyWebhook: jest.fn() } as never,
      repo,
      video as never,
      bookings as never,
      // A REAL audit writer against the real database — an audit row that
      // cannot be inserted would otherwise pass unnoticed here.
      new AuditService(db),
    );
  });

  afterAll(async () => {
    try {
      if (db && fixtures) await teardown(db, fixtures);
    } finally {
      await disconnectDatabase();
    }
  });

  /* ---------------------------------------------------------------------- */

  function joined(sid: string, party: 'patient' | 'doctor', joinedAt: Date): LivekitWebhookDelivery {
    return {
      event: 'participant_joined',
      id: randomUUID(),
      roomName: `consult-${fixtures.consultationId}`,
      participant: {
        sid,
        identity: `${party}:${party === 'patient' ? fixtures.patientId : fixtures.doctorId}`,
        joinedAt,
        disconnectReason: null,
      },
    };
  }

  function left(
    sid: string,
    party: 'patient' | 'doctor',
    joinedAt: Date,
    reason: string | null,
  ): LivekitWebhookDelivery {
    return { ...joined(sid, party, joinedAt), event: 'participant_left', participant: { ...joined(sid, party, joinedAt).participant!, disconnectReason: reason } };
  }

  async function rows() {
    return db
      .select()
      .from(consultationParticipantsTable)
      .where(eq(consultationParticipantsTable.consultationId, fixtures.consultationId))
      .orderBy(consultationParticipantsTable.joinedAt);
  }

  /* ---------------------------------------------------------------------- */

  describe('*** WEBHOOK REDELIVERY IS IDEMPOTENT ***', () => {
    it('a redelivered participant_joined writes NO second row', async () => {
      const at = new Date('2026-09-04T10:00:05.000Z');

      const first = await webhooks.handle(joined('PA_dup1', 'patient', at));
      const second = await webhooks.handle(joined('PA_dup1', 'patient', at));
      const third = await webhooks.handle(joined('PA_dup1', 'patient', at));

      expect(first.outcome).toBe('processed');
      expect(second.outcome).toBe('duplicate');
      expect(third.outcome).toBe('duplicate');

      // *** THE CLAIM, STRAIGHT FROM POSTGRES. ***
      expect(await repo.countConnections(fixtures.consultationId)).toBe(1);
      // And the status was moved exactly once, not three times.
      expect(statusMoves).toHaveLength(1);
    });

    it('a redelivered participant_left cannot MOVE the recorded leave time', async () => {
      const joinedAt = new Date('2026-09-04T10:00:05.000Z');
      await webhooks.handle(joined('PA_dup2', 'patient', joinedAt));

      const firstLeave = new Date('2026-09-04T10:20:00.000Z');
      const laterRedelivery = new Date('2026-09-04T10:45:00.000Z');

      const first = await webhooks.handle(left('PA_dup2', 'patient', joinedAt, 'CLIENT_INITIATED'), firstLeave);
      const second = await webhooks.handle(left('PA_dup2', 'patient', joinedAt, 'ROOM_DELETED'), laterRedelivery);

      expect(first.outcome).toBe('processed');
      expect(second.outcome).toBe('duplicate');

      const [row] = await rows();
      // *** THE `left_at IS NULL` GUARD IN THE `DO UPDATE`, PROVED. *** Without
      // it the redelivery would have rewritten both columns and added
      // twenty-five minutes to the call.
      expect(row.leftAt).toEqual(firstLeave);
      expect(row.disconnectReason).toBe('CLIENT_INITIATED');
    });

    it('a redelivered room_finished ends the consultation once', async () => {
      const finished: LivekitWebhookDelivery = {
        event: 'room_finished',
        id: randomUUID(),
        roomName: `consult-${fixtures.consultationId}`,
        participant: null,
      };

      await webhooks.handle(finished);
      await webhooks.handle(finished);

      // `endSession` is itself idempotent through `transitionConsultationStatus`
      // (see `video.service.spec.ts`); here the point is that the WEBHOOK does
      // not multiply the request.
      expect(statusMoves.filter((move) => move.to === 'awaiting_documentation')).toHaveLength(2);
      expect(await repo.countConnections(fixtures.consultationId)).toBe(0);
    });

    it('*** A LEAVE THAT OVERTAKES ITS OWN JOIN IS NOT LOST *** — and the late join is then a no-op', async () => {
      // LiveKit makes no ordering guarantee across deliveries. If this were a
      // bare UPDATE the leave would match no row, be dropped, and the
      // connection would stay open in the data forever.
      const joinedAt = new Date('2026-09-04T10:00:05.000Z');
      const leftAt = new Date('2026-09-04T10:20:00.000Z');

      const leaveFirst = await webhooks.handle(left('PA_ooo', 'doctor', joinedAt, 'SIGNAL_CLOSE'), leftAt);
      const joinLate = await webhooks.handle(joined('PA_ooo', 'doctor', joinedAt));

      expect(leaveFirst.outcome).toBe('processed');
      expect(joinLate.outcome).toBe('duplicate');

      const [row] = await rows();
      expect(row.joinedAt).toEqual(joinedAt);
      expect(row.leftAt).toEqual(leftAt);
      expect(row.disconnectReason).toBe('SIGNAL_CLOSE');
      expect(await repo.countConnections(fixtures.consultationId)).toBe(1);
    });
  });

  describe('*** SESSION METADATA IS COMPLETE AFTER A CALL ***', () => {
    it('records both sides, a reconnect, and every derived figure', async () => {
      const t = (minute: number, second = 0) => new Date(Date.UTC(2026, 8, 4, 10, minute, second));

      // The doctor joins at 10:00 and stays to 10:30.
      await webhooks.handle(joined('PA_doc', 'doctor', t(0)));
      // The patient joins at 10:02, drops at 10:10, and comes back at 10:12 on
      // a NEW connection with a NEW sid.
      await webhooks.handle(joined('PA_pat_a', 'patient', t(2)));
      await webhooks.handle(left('PA_pat_a', 'patient', t(2), 'SIGNAL_CLOSE'), t(10));
      await webhooks.handle(joined('PA_pat_b', 'patient', t(12)));
      await webhooks.handle(left('PA_pat_b', 'patient', t(12), 'CLIENT_INITIATED'), t(30));
      await webhooks.handle(left('PA_doc', 'doctor', t(0), 'CLIENT_INITIATED'), t(30));

      const stored = await rows();
      // *** A RECONNECT ADDED A ROW; IT DID NOT OVERWRITE ONE. ***
      expect(stored).toHaveLength(3);
      expect(await repo.countConnections(fixtures.consultationId, 'patient')).toBe(2);
      expect(await repo.countConnections(fixtures.consultationId, 'doctor')).toBe(1);

      const session = deriveSession(fixtures.consultationId, stored, t(60));

      expect(session.firstJoinedAt).toEqual(t(0));
      expect(session.lastLeftAt).toEqual(t(30));
      expect(session.live).toBe(false);
      expect(session.noShowParties).toEqual([]);
      expect(session.patient.connectionCount).toBe(2);
      // 10:02-10:10 plus 10:12-10:30.
      expect(session.patient.connectedSeconds).toBe((8 + 18) * 60);
      expect(session.doctor.connectedSeconds).toBe(30 * 60);
      // Both present: 10:02-10:10 and 10:12-10:30. The two minutes the patient
      // was away are not consultation time.
      expect(session.durationSeconds).toBe((8 + 18) * 60);
      // The reason is stored verbatim, which is what makes a `technical_issue`
      // complaint adjudicable at all.
      expect(stored.map((row) => row.disconnectReason).sort()).toEqual([
        'CLIENT_INITIATED',
        'CLIENT_INITIATED',
        'SIGNAL_CLOSE',
      ]);
    });

    it('a one-sided call leaves the absent party with NO row, which IS the no-show', async () => {
      const t = (minute: number) => new Date(Date.UTC(2026, 8, 4, 10, minute));

      await webhooks.handle(joined('PA_solo', 'patient', t(0)));
      await webhooks.handle(left('PA_solo', 'patient', t(0), 'CLIENT_INITIATED'), t(9));

      const session = deriveSession(fixtures.consultationId, await rows(), t(60));

      expect(session.noShowParties).toEqual(['doctor']);
      expect(session.durationSeconds).toBe(0);
      expect(session.patient.connectedSeconds).toBe(9 * 60);
    });

    it('writes an audit row per connection event, carrying the consultation id', async () => {
      const t = new Date('2026-09-04T10:00:00.000Z');
      await webhooks.handle(joined('PA_audit', 'patient', t));
      await webhooks.handle(left('PA_audit', 'patient', t, 'CLIENT_INITIATED'), new Date('2026-09-04T10:10:00.000Z'));
      // The replay must NOT add a third.
      await webhooks.handle(joined('PA_audit', 'patient', t));

      // Scoped to THIS sid: `audit_log` is append-only and is not cleared
      // between the tests in this file, so a count over the whole consultation
      // would grow with every case above it.
      const audited = await db.execute<{ count: string }>(
        sql`select count(*)::int as count from audit_log
            where consultation_id = ${fixtures.consultationId}
              and entity_type = 'video_session'
              and entity_id = 'PA_audit'`,
      );
      expect(Number(audited.rows[0].count)).toBe(2);
    });
  });

  describe('*** ONLY THE TWO ASSIGNED PARTICIPANTS ARE EVER RECORDED ***', () => {
    it('writes no row for an identity naming somebody who is not on the consultation', async () => {
      const stranger: LivekitWebhookDelivery = {
        event: 'participant_joined',
        id: randomUUID(),
        roomName: `consult-${fixtures.consultationId}`,
        participant: {
          sid: 'PA_stranger',
          identity: `patient:${fixtures.otherPatientId}`,
          joinedAt: new Date('2026-09-04T10:00:00.000Z'),
          disconnectReason: null,
        },
      };

      const result = await webhooks.handle(stranger);

      expect(result.outcome).toBe('ignored');
      expect(await repo.countConnections(fixtures.consultationId)).toBe(0);
      expect(statusMoves).toHaveLength(0);
    });

    it('writes no row for a room that is not this platform\'s', async () => {
      const result = await webhooks.handle({
        event: 'participant_joined',
        id: randomUUID(),
        roomName: 'standup-2026-09-04',
        participant: {
          sid: 'PA_other_app',
          identity: `patient:${fixtures.patientId}`,
          joinedAt: new Date(),
          disconnectReason: null,
        },
      });

      expect(result.outcome).toBe('ignored');
      expect(await repo.countConnections(fixtures.consultationId)).toBe(0);
    });
  });

  describe('the database objects the schema depends on', () => {
    it('*** THE CHECK CONSTRAINT REFUSES A PARTY THAT IS NOT patient OR doctor ***', async () => {
      // Unreachable through the write path — `parseParticipantIdentity` refuses
      // `admin`/`system` first — so this goes straight at the table. The CHECK
      // is added by hand per `docs/erd.sql`, and it is the last line of defence
      // behind the derivation that says "the party with NO row here is the one
      // that did not show".
      const insert = db.insert(consultationParticipantsTable).values({
        livekitParticipantSid: 'PA_check',
        consultationId: fixtures.consultationId,
        party: 'admin',
        joinedAt: new Date(),
      });

      await expect(insert).rejects.toBeDefined();
      const failure: Record<string, unknown> = await insert.then(
        () => ({}),
        (error: unknown) => causeOf(error),
      );
      expect(failure).toMatchObject({ code: '23514' });
      expect(String(failure.constraint)).toContain('party');
    });

    it('the foreign key refuses a connection for a consultation that does not exist', async () => {
      // What stops a stray room name from writing an orphan row that no
      // consultation would ever surface.
      const insert = db.insert(consultationParticipantsTable).values({
        livekitParticipantSid: 'PA_orphan',
        consultationId: randomUUID(),
        party: 'patient',
        joinedAt: new Date(),
      });

      await expect(insert).rejects.toBeDefined();
      const failure: Record<string, unknown> = await insert.then(
        () => ({}),
        (error: unknown) => causeOf(error),
      );
      expect(failure).toMatchObject({ code: '23503' });
    });

    it('positive control: a well-formed row inserts, so the two refusals above are about the constraints', async () => {
      await expect(
        db.insert(consultationParticipantsTable).values({
          livekitParticipantSid: 'PA_control',
          consultationId: fixtures.consultationId,
          party: 'doctor',
          joinedAt: new Date(),
        }),
      ).resolves.toBeDefined();

      expect(await repo.countConnections(fixtures.consultationId, 'doctor')).toBe(1);
    });
  });
});
