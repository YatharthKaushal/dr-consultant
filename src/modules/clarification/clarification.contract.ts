import type { ClarificationStatus, ClarificationUrgency } from '../../schema/enums.schema';

/**
 * One entry in `clarification_cases.messages` — the shape the schema's own
 * comment names: "author_id, author_type, message_type, body, at".
 *
 * `authorType` is deliberately `'doctor' | 'admin'` and nothing wider —
 * `docs/MODULES.md`'s M-17 done-when is explicit that "nothing reaches the
 * patient automatically", and there is no route anywhere in this module a
 * patient account could call to write one of these. `'doctor'` covers BOTH
 * the treating doctor and the expert; which one authored a given message is
 * read off `authorId` against the case's own `treatingDoctorId`/
 * `expertDoctorId`, exactly the way a consultation's `doctorId` disambiguates
 * elsewhere in this codebase — there is no separate "expert" account type
 * (`schema/enums.schema.ts#ACCOUNT_TYPES` has only `patient`/`doctor`/`admin`).
 */
export interface ClarificationMessage {
  authorId: string;
  authorType: 'doctor' | 'admin';
  messageType: 'comment' | 'clinical_consideration' | 'clarification_request' | 'followup_advice';
  body: string;
  /** ISO-8601. Stored as a string, not a `Date` — `messages` is `jsonb`, and a `Date` would round-trip through Postgres as a string anyway. */
  at: string;
}

/**
 * The governance-shaped summary M-17 exposes to other modules — deliberately
 * NOT the case content, and NOT `sourceConsultationId`.
 *
 * `docs/MODULES.md` names M-20 (Governance and Quality) as depending on M-17
 * for its "case clarification tracker" working queue. M-20 is unbuilt, so
 * nothing calls this method yet — until it exists, this module's own
 * `admin/clarification-cases` routes serve that tracker directly against
 * `ClarificationService`, the same way `clinical-admin.controller.ts` already
 * serves what will become M-20's clinical-records read ahead of M-20 itself.
 * This method is the seam M-20 will use instead of reaching into this
 * module's tables, per `backend/README.md` §2.
 */
export interface ClarificationCaseSummaryView {
  id: string;
  treatingDoctorId: string;
  expertDoctorId: string | null;
  status: ClarificationStatus;
  urgency: ClarificationUrgency;
  postedAt: Date | null;
  assignedAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
}

/**
 * M-17's public surface (`backend/README.md` §2).
 *
 * Narrow on purpose, matching `clinical.contract.ts`'s own restraint: the one
 * NAMED future consumer (M-20) needs a governance-shaped summary, not the
 * case content, and definitely not `sourceConsultationId` — that field's own
 * doc comment in `clarification-cases.schema.ts` says it is "for the treating
 * doctor and audit ONLY — never exposed to the reviewer", and a facade method
 * that let another module read it would be exactly that exposure, one hop
 * removed.
 *
 * WHAT IS DELIBERATELY ABSENT: every write, and every read of case CONTENT
 * (title, history, diagnosis, doubt, messages). Posting a case, assigning an
 * expert and exchanging messages are this module's own acts, reached through
 * its own controllers with the caller's own credentials — a facade method
 * that let another module post or respond on a doctor's behalf would put
 * FR-12.7's "the treating doctor decides all patient communication" one
 * indirection away from being true.
 */
export interface ClarificationContract {
  /** One case's governance summary, or `null` if the id does not exist. No ownership check — the caller (an admin-only consumer) authorizes, same rule `ClinicalContract`'s two methods state. */
  getCaseSummary(caseId: string): Promise<ClarificationCaseSummaryView | null>;
}
