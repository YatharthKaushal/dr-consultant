import type { LegalDocumentType } from '../../schema/enums.schema';

/**
 * HTTP-facing shapes for this module's controllers. Deliberately NOT in
 * `consent.contract.ts`: that file is the cross-module surface and its shape is
 * frozen by M-14's local mirror, so nothing that only an HTTP client consumes
 * belongs in it.
 *
 * Timestamps are ISO strings here (`promotion.mapper.ts`, `mcp.mapper.ts` do
 * the same) — a response body crosses a JSON boundary, so it carries no `Date`.
 * `ConsentCheck.acceptedAt` on the contract stays a `Date`: that one is an
 * in-process facade call, and M-14's mirror types it that way.
 */

/** The listing projection — no `body`, so a legal-section index is one small response. */
export interface LegalDocumentSummary {
  id: string;
  documentType: LegalDocumentType;
  version: string;
  title: string;
  isCurrent: boolean;
  createdAt: string;
}

/** The full document, as shown on the screen a patient reads and accepts. */
export interface LegalDocumentDetail extends LegalDocumentSummary {
  body: string;
}

/**
 * One acceptance, as the accepting account sees it. `ipAddress` is
 * deliberately ABSENT: `consents.ip_address` is the legal evidence of
 * acceptance, kept for the client's compliance obligations (SRS §8) and not
 * echoed back over the API — a read of it belongs to the audit trail, not to a
 * patient-facing endpoint.
 */
export interface ConsentRecord {
  id: string;
  documentType: LegalDocumentType;
  legalDocumentId: string;
  version: string;
  title: string;
  acceptedAt: string;
}
