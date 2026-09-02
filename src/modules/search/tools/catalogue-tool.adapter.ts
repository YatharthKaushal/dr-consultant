import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { CatalogueFacade } from '../../catalogue/catalogue.facade';
import type { PublicConcern, PublicSpecialty } from '../../catalogue/catalogue.contract';
import { TOOL_ERROR_CODES } from './search-tool.constants';
import type { CatalogueToolPort } from './search-tool.contract';

/**
 * The subset of `CatalogueToolPort` the parallel search worktree (M-09) is
 * adding to `CatalogueFacade`. Typed as `Partial<...>` because in THIS
 * worktree's checkout `CatalogueFacade` genuinely does not have them yet, so
 * a plain cast would be a lie the compiler would later have to be told to
 * ignore.
 */
type PendingCatalogueMethods = Partial<Pick<CatalogueToolPort, 'listActiveConcerns' | 'getConcernsByIds'>>;

/**
 * Binds `CATALOGUE_TOOL_PORT` to the real `CatalogueFacade`.
 *
 * `listActiveSpecialties` exists today and is a straight delegation.
 * `listActiveConcerns`/`getConcernsByIds` are being added to
 * `CatalogueFacade` by the parallel search worktree and are absent here, so
 * each is resolved at call time and, when missing, refused with a clean
 * `CATALOGUE_CAPABILITY_UNAVAILABLE` rather than being reimplemented against
 * the `concerns` table. Reimplementing would be both a duplicate of their
 * work and a `backend/README.md` §2 boundary violation — `concerns` is a
 * table `modules/catalogue` owns, and it already has a live facade.
 *
 * (Contrast `availability`'s `ConsultationBusyIntervalProvider`, which DOES
 * read `consultations` directly: that table's owning module M-11 does not
 * exist at all, so there was no facade to go through. Here there is one.)
 *
 * POST-MERGE: once the methods land on `CatalogueFacade`, `has(...)` starts
 * returning true and these guards become dead code that never fires. Nothing
 * needs to be edited for the tools to start working — deleting the guards is
 * optional tidying, not a required merge step.
 */
@Injectable()
export class CatalogueToolAdapter implements CatalogueToolPort {
  constructor(private readonly catalogue: CatalogueFacade) {}

  async listActiveSpecialties(): Promise<PublicSpecialty[]> {
    return this.catalogue.listActiveSpecialties();
  }

  /**
   * Called with NO arguments deliberately. The parallel worktree may well
   * ship `listActiveConcerns(specialtyId?: string)`; calling it with zero
   * arguments is correct under both that signature and the bare
   * `listActiveConcerns()` the coordination note named, whereas passing an
   * argument would break under the latter. Specialty filtering therefore
   * happens in `list-concern-taxonomy.tool.ts`, on the returned rows.
   */
  async listActiveConcerns(): Promise<PublicConcern[]> {
    const method = this.pending().listActiveConcerns;
    if (typeof method !== 'function') {
      throw this.unavailable('listActiveConcerns');
    }
    return method.call(this.catalogue);
  }

  async getConcernsByIds(ids: string[]): Promise<PublicConcern[]> {
    if (ids.length === 0) {
      return [];
    }
    const method = this.pending().getConcernsByIds;
    if (typeof method !== 'function') {
      throw this.unavailable('getConcernsByIds');
    }
    return method.call(this.catalogue, ids);
  }

  private pending(): PendingCatalogueMethods {
    return this.catalogue as CatalogueFacade & PendingCatalogueMethods;
  }

  private unavailable(method: string): ServiceUnavailableException {
    return new ServiceUnavailableException({
      code: TOOL_ERROR_CODES.CATALOGUE_CAPABILITY_UNAVAILABLE,
      message: `The concern taxonomy is not available in this deployment (CatalogueFacade.${method} is not bound yet).`,
    });
  }
}
