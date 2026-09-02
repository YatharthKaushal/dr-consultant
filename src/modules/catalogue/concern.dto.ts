import { IsOptional, IsUUID } from 'class-validator';

/**
 * The optional `specialtyId` filter shared by BOTH the admin list
 * (`concern-admin.controller.ts`) and the public list
 * (`concern.controller.ts`) — not admin-only, so it lives here rather than
 * in `concern-admin.dto.ts`.
 */
export class ListConcernsQueryDto {
  @IsOptional()
  @IsUUID()
  specialtyId?: string;
}
