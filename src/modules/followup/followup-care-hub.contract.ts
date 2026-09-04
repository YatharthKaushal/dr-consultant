/**
 * *** THE M-16 -> M-18 (POST-CONSULTATION CARE HUB) SEAM. READ BEFORE
 * TOUCHING. ***
 *
 * `modules/carehub` does not exist yet — `docs/MODULES.md`'s build order
 * ships it AFTER M-16 ("M-17 and M-18: ... Care Hub completes the recommended
 * self-help part of the Care Plan"), and M-16's own done-when note says so
 * explicitly: "the Care Plan lands in two steps. Plan, prescription, check-in
 * and follow-up booking ship with this module; recommended self-help appears
 * once M-18 is built."
 *
 * This file declares the interface LOCALLY and binds it to the `CARE_HUB_PORT`
 * DI token (`followup.constants.ts`) — the exact pattern `pricing-discount
 * .contract.ts` used for `DISCOUNT_PORT` before `modules/promotion` existed.
 * `followup.module.ts` binds it to `UnavailableCareHubProvider`, which returns
 * an empty list — the Care Plan's "recommended self-help" section renders
 * empty, never an error, until the coordinator rebinds this token to M-18's
 * real facade.
 *
 * *** THE SHAPE IS A GUESS, NOT A FROZEN CONTRACT. *** Unlike the notification
 * port (mirrored verbatim off a merged module's real contract), M-18 has not
 * been designed yet, so nothing constrains this shape today. It is
 * deliberately minimal — FR-15.4's "doctor-recommended" tools, id + title +
 * a client-navigable reference — so a real `CareHubPort` can satisfy it with
 * little more than a field rename. The coordinator should expect to adjust
 * this file (and `getCarePlan`'s call site) once M-18's actual shape exists.
 */

export interface RecommendedCareHubItem {
  contentId: string;
  title: string;
  /** e.g. 'self_help_tool' | 'education_module' | 'ngo_directory_entry' — FR-15.1/15.2/15.6. Left as a string since M-18's own vocabulary does not exist yet. */
  kind: string;
}

export interface CareHubPort {
  /** Doctor-recommended items for one consultation (FR-15.4: "the patient sees them tagged 'Recommended by your doctor'"). Empty array, never a throw, when there is nothing recommended or the provider is unavailable. */
  getRecommendedForConsultation(consultationId: string): Promise<RecommendedCareHubItem[]>;
}
