import type { ConcernRow } from '../../schema/concerns.schema';
import type { PublicConcern } from './catalogue.contract';

/**
 * `concerns` carries no admin-only/internal column (unlike `specialties`'
 * templates) — this is an explicit projection anyway, so the contract type
 * stays insulated from a future schema addition rather than implicitly
 * relying on the row shape.
 */
export function toPublicConcern(row: ConcernRow): PublicConcern {
  return {
    id: row.id,
    specialtyId: row.specialtyId,
    code: row.code,
    name: row.name,
    matchPhrases: row.matchPhrases,
    matchWeight: row.matchWeight,
    isActive: row.isActive,
  };
}
