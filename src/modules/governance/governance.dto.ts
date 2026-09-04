import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { GOVERNANCE_DEFAULT_PAGE_SIZE, GOVERNANCE_MAX_PAGE_SIZE } from './governance.constants';

/** Shared by both working-queue reads — mirrors `followup.dto.ts`'s `ListOpenAlertsQueryDto`. */
export class ListGovernanceQueueQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(GOVERNANCE_MAX_PAGE_SIZE)
  limit?: number = GOVERNANCE_DEFAULT_PAGE_SIZE;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number = 0;
}
