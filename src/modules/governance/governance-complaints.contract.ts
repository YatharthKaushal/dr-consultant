import type { ComplaintStatus } from '../../schema/enums.schema';

/**
 * *** THE GOVERNANCE -> FEEDBACK/COMPLAINTS SEAM. READ BEFORE TOUCHING. ***
 *
 * `modules/feedback` (M-19) is being built in a PARALLEL WORKTREE and does not
 * exist in this one, so a direct `import from '../feedback/feedback.contract'`
 * would not compile. This file declares the interface LOCALLY and binds it to
 * the `GOVERNANCE_COMPLAINTS_PORT` DI token — precisely the pattern
 * `pricing/pricing-discount.contract.ts` uses for `DiscountPort`/
 * `DISCOUNT_PORT`, `booking/booking-payment.contract.ts` for
 * `BookingPaymentPort`, and `document/document-storage.contract.ts` for
 * `DocumentStoragePort`.
 *
 * The shape below is a VERBATIM mirror of the shape the M-19 worktree is
 * exporting (as specified by the coordinator for this build). Because
 * TypeScript is structural, its facade will satisfy `GovernanceComplaintsPort`
 * with no adapter, no cast and no change on either side.
 *
 * *** THE SHAPE IS FROZEN. *** Do not rename a field, do not tighten a type,
 * do not add a required argument. If M-19's signature ever changes, change it
 * HERE too — a structural mismatch will surface as a `tsc` error at the
 * binding in `governance.module.ts`, which is the point.
 *
 * *** POST-MERGE, THE COORDINATOR REBINDS `GOVERNANCE_COMPLAINTS_PORT` FROM
 * `UnavailableComplaintsProvider` TO THE FEEDBACK/COMPLAINTS FACADE. *** That
 * is the whole handover: one line in `governance.module.ts`'s `providers`
 * array.
 *
 * This is the ONLY M-19 dependency anywhere in this module. FR-18.8's
 * feedback review is M-19's own admin screen, not something this module
 * builds a second copy of, and there is no second port for it — see this
 * module's build report for the full reasoning.
 *
 * Do NOT "fix" this into a cross-module import of `modules/feedback`:
 * `backend/README.md` §2 says a module's only public surface is its facade,
 * resolved through DI, and the token is exactly that.
 */

/** DI token. `governance.module.ts` binds it to the null object until M-19 (feedback and complaints) merges. */
export const GOVERNANCE_COMPLAINTS_PORT = Symbol('GOVERNANCE_COMPLAINTS_PORT');

/**
 * FR-18.6's "complaints" quality-dashboard figure, broken down by
 * `complaint_status` — the exact set `COMPLAINT_STATUSES`
 * (`schema/enums.schema.ts`) names. Every key is present, even a status with
 * zero rows: this is a dashboard tile, not a paged list, so a caller reading
 * `counts.open` should never have to guard against a missing key.
 */
export interface GovernanceComplaintsPort {
  countComplaintsByStatus(): Promise<Record<ComplaintStatus, number>>;
}
