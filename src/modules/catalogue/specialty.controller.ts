import { Controller, Get, Param } from '@nestjs/common';
import { AccountType, CurrentUser } from '../../shared/auth/auth.decorator';
import type { AuthContext } from '../../shared/auth/auth.types';
import { SpecialtyService } from './specialty.service';

/**
 * No logic here — parse, authorise via decorators, delegate. Any
 * authenticated account type; there is no self-editable surface (specialties
 * are wholly admin-authored), so unlike `doctor.controller.ts` there is no
 * `me`-shaped route here.
 */
@Controller('specialties')
@AccountType('patient', 'doctor', 'admin')
export class SpecialtyController {
  constructor(private readonly service: SpecialtyService) {}

  /** Active specialties only — the "what can I book" list, not the admin management list (`GET /admin/specialties`). Same for an admin caller. */
  @Get()
  list() {
    return this.service.listActive();
  }

  /** Visible when active, or when the caller is an admin. 404 (never 403) otherwise — see `specialty.service.ts#getByIdForCaller`. */
  @Get(':id')
  getById(@CurrentUser() auth: AuthContext, @Param('id') id: string) {
    return this.service.getByIdForCaller(id, auth);
  }
}
