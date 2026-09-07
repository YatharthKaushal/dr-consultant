import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { DELETABLE_ACCOUNT_TYPES, type DeletableAccountType } from '../../schema/enums.schema';
import { DEFAULT_DELETED_ACCOUNTS_PAGE_SIZE, MAX_DELETED_ACCOUNTS_PAGE_SIZE } from './deleted-accounts.constants';

/** The admin queue. Both filters optional; omitted means every snapshot, restored or not. */
export class ListDeletedAccountsQueryDto {
  @IsOptional()
  @IsIn(DELETABLE_ACCOUNT_TYPES)
  accountType?: DeletableAccountType;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  restored?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_DELETED_ACCOUNTS_PAGE_SIZE)
  limit?: number = DEFAULT_DELETED_ACCOUNTS_PAGE_SIZE;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number = 0;
}
