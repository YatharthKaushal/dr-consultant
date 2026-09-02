import type { PatientFileRow } from '../../schema/patient-files.schema';

/** Safe to return to ANY client — `storageKey` is an internal object-store key, "never exposed to the client" per `patient-files.schema.ts`. Same discipline as `doctor.mapper.ts`'s `SafeDoctorDocumentRow`. */
export type SafePatientFileRow = Omit<PatientFileRow, 'storageKey'>;

export function toSafePatientFileRow(row: PatientFileRow): SafePatientFileRow {
  const { storageKey: _storageKey, ...rest } = row;
  return rest;
}

export function toSafePatientFileRows(rows: PatientFileRow[]): SafePatientFileRow[] {
  return rows.map(toSafePatientFileRow);
}
