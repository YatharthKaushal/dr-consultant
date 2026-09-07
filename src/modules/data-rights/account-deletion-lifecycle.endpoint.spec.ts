/**
 * *** THE FULL ACCOUNT-DELETION LIFECYCLE, END TO END, AGAINST REAL
 * POSTGRES AND REAL HTTP. ***
 *
 * Everything else (`data-rights.integration.spec.ts`, `data-deletion.
 * service.spec.ts`, `patient.service.spec.ts`) proves one layer at a time.
 * This file proves the ACTUAL PRODUCT PROMISE end to end, through the real
 * routes a real client would call: raise -> cancel -> raise again ->
 * admin-approve -> admin-execute -> admin-restore. Plus the two claims that
 * only make sense proven this way: "sign up again" really creates a NEW
 * account on the vacated number, and restoring after the number was
 * reassigned to someone newer is refused loudly, not silently.
 *
 * Uses `createConfiguredApp()` + `app.inject()`, real JWTs via
 * `IdentityTokenService.mintTokenPair` — the sanctioned pattern
 * `app.e2e.integration.spec.ts` documents. Requires a reachable Postgres —
 * reads `DATABASE_URL` from `.env.local`, fails loudly rather than skipping.
 */
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createConfiguredApp } from '../../app.bootstrap';
import { getDb, type Database } from '../../config/db/database.config';
import { loadEnvFiles } from '../../config/env/env.validation';
import { adminPermissionGrantsTable } from '../../schema/admin-permission-grants.schema';
import { adminsTable } from '../../schema/admins.schema';
import { dataDeletionRequestsTable } from '../../schema/data-deletion-requests.schema';
import { deletedAccountsTable } from '../../schema/deleted-accounts.schema';
import { doctorsTable } from '../../schema/doctors.schema';
import { patientsTable } from '../../schema/patients.schema';
import { permissionsTable } from '../../schema/permissions.schema';
import { IdentityRepository } from '../identity/identity.repository';
import { IdentityTokenService } from '../identity/identity-token.service';

jest.setTimeout(60_000);

function payload<T>(response: { json: () => unknown }): T {
  const body = response.json() as { success?: boolean; data?: unknown; error?: unknown };
  if (body && body.success === true) return body.data as T;
  if (body && body.success === false) return body.error as T;
  return body as unknown as T;
}

describe('Account deletion lifecycle — HTTP endpoints, real app.inject(), real Postgres', () => {
  let app: NestFastifyApplication;
  let db: Database;
  let runId: string;
  let adminId: string;
  let adminToken: string;
  const createdPatientIds: string[] = [];
  const createdDoctorIds: string[] = [];
  const createdRequestIds: string[] = [];

  function auth(token: string) {
    return { authorization: `Bearer ${token}` };
  }

  async function seedPatient(tag: string, overrides: Partial<typeof patientsTable.$inferInsert> = {}): Promise<{ id: string; mobileNumber: string; token: string }> {
    // varchar(16) total, "+91" included — keep well under: "+9199" (5) + 3-digit runId + 1-char tag + 2-digit random = 11.
    const mobileNumber = `+9199${runId.slice(0, 3)}${tag}${String(Math.floor(Math.random() * 90) + 10)}`;
    const [row] = await db
      .insert(patientsTable)
      .values({ mobileNumber, status: 'active', fullName: `Lifecycle Patient ${tag}`, dateOfBirth: '1992-05-01', ...overrides })
      .returning({ id: patientsTable.id });
    createdPatientIds.push(row.id);
    const tokenService = app.get(IdentityTokenService);
    const token = (await tokenService.mintTokenPair('patient', row.id, 0)).accessToken;
    return { id: row.id, mobileNumber, token };
  }

  async function seedDoctor(tag: string): Promise<{ id: string; mobileNumber: string; token: string }> {
    const mobileNumber = `+9198${runId.slice(0, 3)}${tag}${String(Math.floor(Math.random() * 90) + 10)}`;
    const [row] = await db
      .insert(doctorsTable)
      .values({ mobileNumber, fullName: `Lifecycle Doctor ${tag}`, verificationStatus: 'verified', isListed: true })
      .returning({ id: doctorsTable.id });
    createdDoctorIds.push(row.id);
    const token = (await app.get(IdentityTokenService).mintTokenPair('doctor', row.id, 0)).accessToken;
    return { id: row.id, mobileNumber, token };
  }

  beforeAll(async () => {
    loadEnvFiles();
    app = await createConfiguredApp();
    db = getDb();
    runId = randomUUID().slice(0, 6);

    const [admin] = await db.insert(adminsTable).values({ mobileNumber: `+9196${runId}01`, fullName: `Lifecycle Admin ${runId}` }).returning({ id: adminsTable.id });
    adminId = admin.id;
    const [perm] = await db.select({ id: permissionsTable.id }).from(permissionsTable).where(eq(permissionsTable.key, 'compliance.manage_deletion_requests'));
    if (!perm) throw new Error('Expected compliance.manage_deletion_requests to be seeded.');
    await db.insert(adminPermissionGrantsTable).values({ adminId, permissionId: perm.id });
    adminToken = (await app.get(IdentityTokenService).mintTokenPair('admin', adminId, 0)).accessToken;
  });

  afterAll(async () => {
    try {
      if (createdRequestIds.length) {
        await db.delete(deletedAccountsTable).where(inArray(deletedAccountsTable.deletionRequestId, createdRequestIds));
        await db.delete(dataDeletionRequestsTable).where(inArray(dataDeletionRequestsTable.id, createdRequestIds));
      }
      if (createdPatientIds.length) {
        await db.delete(patientsTable).where(inArray(patientsTable.id, createdPatientIds));
      }
      if (createdDoctorIds.length) {
        await db.delete(doctorsTable).where(inArray(doctorsTable.id, createdDoctorIds));
      }
      await db.delete(adminPermissionGrantsTable).where(eq(adminPermissionGrantsTable.adminId, adminId));
      await db.delete(adminsTable).where(eq(adminsTable.id, adminId));
    } finally {
      if (app) await app.close();
    }
  });

  it('raise -> cancel -> raise again -> approve -> execute -> restore, with the account usable the whole way through', async () => {
    const patient = await seedPatient('f');

    // 1. Raise. Status requested, a scheduledFor is set, account stays active.
    const raised = payload<{ id: string; status: string; scheduledFor: string | null }>(
      await app.inject({ method: 'POST', url: '/api/data-deletion-requests', headers: auth(patient.token), payload: { reason: 'Testing.' } }),
    );
    expect(raised.status).toBe('requested');
    expect(raised.scheduledFor).not.toBeNull();
    createdRequestIds.push(raised.id);

    const [stillActive] = await db.select({ status: patientsTable.status, deletedAt: patientsTable.deletedAt }).from(patientsTable).where(eq(patientsTable.id, patient.id));
    expect(stillActive.status).toBe('active');
    expect(stillActive.deletedAt).toBeNull();

    // 2. Cancel — "the cancel deletion option".
    const cancelled = payload<{ status: string }>(await app.inject({ method: 'POST', url: `/api/data-deletion-requests/${raised.id}/cancel`, headers: auth(patient.token) }));
    expect(cancelled.status).toBe('cancelled');

    // A second cancel is refused — the request is terminal.
    const secondCancel = await app.inject({ method: 'POST', url: `/api/data-deletion-requests/${raised.id}/cancel`, headers: auth(patient.token) });
    expect(secondCancel.statusCode).toBe(409);
    expect(payload<{ code: string }>(secondCancel).code).toBe('DATA_DELETION_NOT_CANCELLABLE');

    // 3. Raise again — a fresh decision, not blocked by the cancelled one.
    const raisedAgain = payload<{ id: string; status: string }>(
      await app.inject({ method: 'POST', url: '/api/data-deletion-requests', headers: auth(patient.token), payload: {} }),
    );
    expect(raisedAgain.id).not.toBe(raised.id);
    expect(raisedAgain.status).toBe('requested');
    createdRequestIds.push(raisedAgain.id);

    // 4. Admin approves.
    const approved = payload<{ status: string }>(
      await app.inject({ method: 'PATCH', url: `/api/admin/data-deletion-requests/${raisedAgain.id}/review`, headers: auth(adminToken), payload: { status: 'approved' } }),
    );
    expect(approved.status).toBe('approved');

    // 5. Admin executes. The account is soft-deleted for real.
    const executed = payload<{ status: string }>(await app.inject({ method: 'POST', url: `/api/admin/data-deletion-requests/${raisedAgain.id}/execute`, headers: auth(adminToken) }));
    expect(executed.status).toBe('executed');

    const [afterExecute] = await db.select().from(patientsTable).where(eq(patientsTable.id, patient.id));
    expect(afterExecute.status).toBe('deleted');
    expect(afterExecute.deletedAt).not.toBeNull();
    expect(afterExecute.fullName).toBe('Lifecycle Patient f'); // kept — soft delete, not the old destructive anonymize
    expect(afterExecute.mobileNumber).not.toBe(patient.mobileNumber);

    const [snapshot] = await db.select().from(deletedAccountsTable).where(eq(deletedAccountsTable.deletionRequestId, raisedAgain.id));
    expect(snapshot).toBeDefined();
    expect(snapshot.originalMobileNumber).toBe(patient.mobileNumber);
    expect(snapshot.restoredAt).toBeNull();

    // Deleted account no longer authenticates — a fresh token for this id is now refused.
    const deadToken = (await app.get(IdentityTokenService).mintTokenPair('patient', patient.id, 0)).accessToken;
    const meAfterDelete = await app.inject({ method: 'GET', url: '/api/auth/me', headers: auth(deadToken) });
    expect(meAfterDelete.statusCode).toBe(401);

    // 6. Admin restores — "forever", proven here as "right after", which is the weakest case that must still work.
    const restored = payload<{ restoredAt: string | null; accountId: string }>(
      await app.inject({ method: 'POST', url: `/api/admin/deleted-accounts/${snapshot.id}/restore`, headers: auth(adminToken) }),
    );
    expect(restored.restoredAt).not.toBeNull();

    const [afterRestore] = await db.select().from(patientsTable).where(eq(patientsTable.id, patient.id));
    expect(afterRestore.status).toBe('active');
    expect(afterRestore.deletedAt).toBeNull();
    expect(afterRestore.mobileNumber).toBe(patient.mobileNumber);
    expect(afterRestore.fullName).toBe('Lifecycle Patient f');

    // A restored account authenticates again — minted against its CURRENT
    // tokenVersion, which the deletion's own session revocation bumped
    // past 0 (restore does not, and must not, reset that counter: every
    // token issued before the deletion must stay dead).
    const liveToken = (await app.get(IdentityTokenService).mintTokenPair('patient', patient.id, afterRestore.tokenVersion)).accessToken;
    const meAfterRestore = await app.inject({ method: 'GET', url: '/api/auth/me', headers: auth(liveToken) });
    expect(meAfterRestore.statusCode).toBe(200);
  });

  it('"sign up again": the vacated mobile number resolves to a BRAND NEW account, never the old (deleted) one', async () => {
    const patient = await seedPatient('s');

    const raised = payload<{ id: string }>(await app.inject({ method: 'POST', url: '/api/data-deletion-requests', headers: auth(patient.token), payload: {} }));
    createdRequestIds.push(raised.id);
    await app.inject({ method: 'PATCH', url: `/api/admin/data-deletion-requests/${raised.id}/review`, headers: auth(adminToken), payload: { status: 'approved' } });
    await app.inject({ method: 'POST', url: `/api/admin/data-deletion-requests/${raised.id}/execute`, headers: auth(adminToken) });

    // The exact mechanism `identity.service.ts#resolveAccount`'s patient
    // branch uses at OTP-verify time — exercised directly here since
    // driving it through the real Slide vendor is out of reach for a test.
    const identityRepo = app.get(IdentityRepository);
    const result = await identityRepo.findOrCreatePatientByMobile(patient.mobileNumber);

    expect(result.isNewAccount).toBe(true);
    expect(result.id).not.toBe(patient.id);
    createdPatientIds.push(result.id);
  });

  it('restore is refused with MOBILE_NUMBER_REASSIGNED once a newer signup has taken the vacated number', async () => {
    const patient = await seedPatient('r');

    const raised = payload<{ id: string }>(await app.inject({ method: 'POST', url: '/api/data-deletion-requests', headers: auth(patient.token), payload: {} }));
    createdRequestIds.push(raised.id);
    await app.inject({ method: 'PATCH', url: `/api/admin/data-deletion-requests/${raised.id}/review`, headers: auth(adminToken), payload: { status: 'approved' } });
    await app.inject({ method: 'POST', url: `/api/admin/data-deletion-requests/${raised.id}/execute`, headers: auth(adminToken) });

    const [snapshot] = await db.select().from(deletedAccountsTable).where(eq(deletedAccountsTable.deletionRequestId, raised.id));

    // A newer signup takes the vacated number for real.
    const identityRepo = app.get(IdentityRepository);
    const newer = await identityRepo.findOrCreatePatientByMobile(patient.mobileNumber);
    createdPatientIds.push(newer.id);
    expect(newer.isNewAccount).toBe(true);

    const restoreAttempt = await app.inject({ method: 'POST', url: `/api/admin/deleted-accounts/${snapshot.id}/restore`, headers: auth(adminToken) });
    expect(restoreAttempt.statusCode).toBe(409);
    expect(payload<{ code: string }>(restoreAttempt).code).toBe('MOBILE_NUMBER_REASSIGNED');

    // Refused cleanly — the old account is left exactly as it was, still deleted, not half-restored.
    const [stillDeleted] = await db.select().from(patientsTable).where(eq(patientsTable.id, patient.id));
    expect(stillDeleted.status).toBe('deleted');
    expect(stillDeleted.deletedAt).not.toBeNull();
  });

  describe('the doctor path — the same public routes, widened, not a parallel implementation', () => {
    it('a doctor can raise, an admin can approve and execute, and the doctors table (only) is soft-deleted', async () => {
      const doctor = await seedDoctor('d');

      const raised = payload<{ id: string; status: string }>(
        await app.inject({ method: 'POST', url: '/api/data-deletion-requests', headers: auth(doctor.token), payload: {} }),
      );
      expect(raised.status).toBe('requested');
      createdRequestIds.push(raised.id);

      await app.inject({ method: 'PATCH', url: `/api/admin/data-deletion-requests/${raised.id}/review`, headers: auth(adminToken), payload: { status: 'approved' } });
      const executed = payload<{ status: string; doctorId: string | null; patientId: string | null }>(
        await app.inject({ method: 'POST', url: `/api/admin/data-deletion-requests/${raised.id}/execute`, headers: auth(adminToken) }),
      );
      expect(executed.status).toBe('executed');
      expect(executed.doctorId).toBe(doctor.id);
      expect(executed.patientId).toBeNull();

      const [afterExecute] = await db.select().from(doctorsTable).where(eq(doctorsTable.id, doctor.id));
      expect(afterExecute.deletedAt).not.toBeNull();
      expect(afterExecute.verificationStatus).toBe('suspended');
      expect(afterExecute.isListed).toBe(false);
      expect(afterExecute.fullName).toBe('Lifecycle Doctor d'); // kept, same soft-delete posture as the patient path
      expect(afterExecute.registrationNumber).toBeNull(); // never set here, but deliberately never vacated by softDelete either way

      const [snapshot] = await db.select().from(deletedAccountsTable).where(eq(deletedAccountsTable.deletionRequestId, raised.id));
      expect(snapshot.accountType).toBe('doctor');
      expect(snapshot.accountId).toBe(doctor.id);

      const restored = payload<{ restoredAt: string | null }>(
        await app.inject({ method: 'POST', url: `/api/admin/deleted-accounts/${snapshot.id}/restore`, headers: auth(adminToken) }),
      );
      expect(restored.restoredAt).not.toBeNull();

      const [afterRestore] = await db.select().from(doctorsTable).where(eq(doctorsTable.id, doctor.id));
      expect(afterRestore.deletedAt).toBeNull();
      // Restored to the SNAPSHOT's own verificationStatus ('verified', this doctor's original), not assumed.
      expect(afterRestore.verificationStatus).toBe('verified');
      expect(afterRestore.mobileNumber).toBe(doctor.mobileNumber);
    });
  });
});
