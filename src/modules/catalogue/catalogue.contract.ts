/**
 * The listable/booking-time projection of a specialty — deliberately
 * excludes `prescriptionTemplate`/`adviceTemplate` (admin-authored clinical
 * starter content meant for a doctor to apply while documenting a
 * consultation, not for a patient/doctor browsing the catalogue — see
 * `specialty.mapper.ts`) and the `createdAt`/`updatedAt` audit columns.
 */
export interface PublicSpecialty {
  id: string;
  code: string;
  name: string;
  description: string | null;
  canPrescribe: boolean;
  intakeForm: unknown;
  firstConsultForm: unknown;
  requiredDocuments: string[];
  isActive: boolean;
}

export interface PublicConcern {
  id: string;
  specialtyId: string;
  code: string;
  name: string;
  matchPhrases: string[];
  matchWeight: number;
  isActive: boolean;
}

/**
 * Catalogue's public surface — every other module talks to specialties/
 * concerns through this, never through `specialties`/`concerns` directly
 * (`backend/README.md` §2). Exactly the near-term real consumers named in
 * the M-06 build task, nothing more:
 *   - getSpecialtyById / getConcernById: the "copy at point of use" reads —
 *     M-11 (booking) and M-14 (clinical) snapshot a specialty/concern into
 *     their own row at the moment it's used, so a later admin edit here can
 *     never retroactively alter a finalised consultation/clinical record
 *     (see `specialties.schema.ts`'s own doc comment). Deliberately NOT
 *     filtered by `isActive` — a consultation already booked under a
 *     specialty that's since been deactivated must still be able to read it;
 *     "may this be newly selected right now" is `listActiveSpecialties`'s
 *     job, not this one's.
 *   - listActiveSpecialties: M-07 (availability)/M-11 (booking) — "what can
 *     currently be selected."
 */
export interface CatalogueContract {
  /** `null` only if the specialty id doesn't exist. Not gated on `isActive` — see class doc comment. */
  getSpecialtyById(id: string): Promise<PublicSpecialty | null>;

  /** Active specialties only, ordered by name — the "what can I book" list. */
  listActiveSpecialties(): Promise<PublicSpecialty[]>;

  /** `null` only if the concern id doesn't exist. Not gated on `isActive` — same reasoning as `getSpecialtyById`. */
  getConcernById(id: string): Promise<PublicConcern | null>;

  /**
   * ADDITIVE (M-09/search): THE MAPPING CORPUS. Active concerns with their
   * `matchPhrases`/`matchWeight`, optionally narrowed to one specialty —
   * everything M-09's deterministic matcher scores a query against, and the
   * live taxonomy its LLM system prompt is built from (FR-19.1: a specialty
   * or concern added in the admin panel must change search behaviour with no
   * code change and no release).
   *
   * `ConcernService.listActive` already existed and backed `GET /concerns`;
   * it simply was not on the facade, so no other module could reach it
   * without the deep import `backend/README.md` §2 forbids.
   */
  listActiveConcerns(specialtyId?: string): Promise<PublicConcern[]>;

  /**
   * ADDITIVE (M-09/search): resolves `search_queries.matched_concern_ids`
   * (and any other stored id list) to display rows in ONE round trip instead
   * of N `getConcernById` calls. Deliberately NOT gated on `isActive`, same
   * reasoning as `getConcernById`: a logged historical match must still
   * render after the concern behind it is retired — that table's ids are a
   * deliberately FK-free historical record (`search-queries.schema.ts`).
   *
   * Unknown ids are omitted rather than returned as holes; the caller
   * compares lengths if it cares. Order follows `id ASC`, not the order of
   * `ids` — callers that need the caller's order re-map by id.
   */
  getConcernsByIds(ids: readonly string[]): Promise<PublicConcern[]>;
}
