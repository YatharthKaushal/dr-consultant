import { IsBoolean, IsOptional } from 'class-validator';

/**
 * ADDITIVE (open-obligations round). `override` lets an admin who has
 * genuinely reviewed `openObligations` on the preview proceed anyway —
 * defaults to `false`/absent, the safe default. `DataRightsService
 * #executeForRequest` is what actually enforces that only an admin actor
 * may ever honour this; the DTO only shapes the body, it does not decide
 * who may set it.
 */
export class ExecuteDataDeletionRequestDto {
  @IsOptional()
  @IsBoolean()
  override?: boolean;
}
