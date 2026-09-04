import type { LegalDocumentRow } from '../../schema/legal-documents.schema';
import type { ConsentAcceptance } from './consent.repository';
import type { ConsentRecord, LegalDocumentDetail, LegalDocumentSummary } from './consent.types';

/**
 * Explicit projections, not row spreads. `legal_documents.body` is a whole
 * legal text — a listing that accidentally carried it would quietly ship the
 * privacy policy, the terms and the refund policy in one response — and a
 * `consents` row carries `ip_address`, which is legal evidence and never
 * belongs in an API response (`consent.types.ts`).
 */

export function toLegalDocumentSummary(row: LegalDocumentRow): LegalDocumentSummary {
  return {
    id: row.id,
    documentType: row.documentType,
    version: row.version,
    title: row.title,
    isCurrent: row.isCurrent,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toLegalDocumentDetail(row: LegalDocumentRow): LegalDocumentDetail {
  return { ...toLegalDocumentSummary(row), body: row.body };
}

export function toConsentRecord(acceptance: ConsentAcceptance): ConsentRecord {
  return {
    id: acceptance.id,
    documentType: acceptance.documentType,
    legalDocumentId: acceptance.legalDocumentId,
    version: acceptance.version,
    title: acceptance.title,
    acceptedAt: acceptance.acceptedAt.toISOString(),
  };
}
