import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import { AccountType, CurrentUser, RequirePermission } from '../../shared/auth/auth.decorator';
import type { AuthContext } from '../../shared/auth/auth.types';
import { PERMISSIONS } from '../../shared/auth/permission.catalog';
import { createUuidValidationPipe } from '../../shared/errors/uuid-param.pipe';
import { AgentCredentialService } from './agent-credential.service';
import { AgentProfileService } from './agent-profile.service';
import {
  CreateAgentCredentialDto,
  CreateAgentProfileDto,
  UpdateAgentCredentialDto,
  UpdateAgentProfileDto,
} from './ai.dto';
import { toPublicAgentCredential, toPublicAgentProfile } from './ai.mapper';

/**
 * The whole admin surface for the AI gateway. Admin-only (`@AccountType`),
 * and split across two permissions:
 *
 *   - `ai.read`   — see which providers/models are configured and how each
 *                   key is doing. In the `operations` bundle: diagnosing "why
 *                   is symptom search degraded" is day-to-day support work.
 *   - `ai.manage` — create/edit/delete profiles and credentials, and run a
 *                   live test. `super_admin` ONLY, deliberately, and for the
 *                   same reason `admins.manage` is: it controls third-party
 *                   credentials and it controls SPEND. The client's provider
 *                   account is billed at actuals, so whoever holds this can
 *                   point the platform at an expensive model, or paste a key
 *                   belonging to an account that is not the client's.
 *
 * Every `:id` goes through `createUuidValidationPipe` so a malformed path
 * segment is a clean 400 rather than a Postgres `22P02` surfacing as a 500 —
 * see `shared/errors/uuid-param.pipe.ts`.
 *
 * Note there is no "reveal key" route anywhere here, and no route that
 * returns `encrypted_key`. The mappers have no field for either.
 */
@Controller('admin/ai')
@AccountType('admin')
export class AiAdminController {
  constructor(
    private readonly profiles: AgentProfileService,
    private readonly credentials: AgentCredentialService,
  ) {}

  /* ---------------------------------------------------------------------- */
  /* Profiles                                                                */
  /* ---------------------------------------------------------------------- */

  @Get('profiles')
  @RequirePermission(PERMISSIONS.AI_READ)
  async listProfiles() {
    const rows = await this.profiles.adminList();
    return rows.map(toPublicAgentProfile);
  }

  @Get('profiles/:id')
  @RequirePermission(PERMISSIONS.AI_READ)
  async getProfile(@Param('id', createUuidValidationPipe('id')) id: string) {
    return toPublicAgentProfile(await this.profiles.adminGetById(id));
  }

  @Post('profiles')
  @RequirePermission(PERMISSIONS.AI_MANAGE)
  async createProfile(@CurrentUser() auth: AuthContext, @Body() dto: CreateAgentProfileDto) {
    return toPublicAgentProfile(await this.profiles.adminCreate(auth.accountId, dto));
  }

  @Patch('profiles/:id')
  @RequirePermission(PERMISSIONS.AI_MANAGE)
  async updateProfile(
    @CurrentUser() auth: AuthContext,
    @Param('id', createUuidValidationPipe('id')) id: string,
    @Body() dto: UpdateAgentProfileDto,
  ) {
    return toPublicAgentProfile(await this.profiles.adminUpdate(auth.accountId, id, dto));
  }

  /** 409 when the profile still has credentials — they must be deleted individually first. See `agent-profile.service.ts#adminDelete`. */
  @Delete('profiles/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(PERMISSIONS.AI_MANAGE)
  async deleteProfile(@CurrentUser() auth: AuthContext, @Param('id', createUuidValidationPipe('id')) id: string) {
    await this.profiles.adminDelete(auth.accountId, id);
  }

  /* ---------------------------------------------------------------------- */
  /* Credentials                                                             */
  /* ---------------------------------------------------------------------- */

  @Get('profiles/:id/credentials')
  @RequirePermission(PERMISSIONS.AI_READ)
  async listCredentials(@Param('id', createUuidValidationPipe('id')) id: string) {
    const rows = await this.credentials.adminListByProfile(id);
    return rows.map(toPublicAgentCredential);
  }

  @Post('profiles/:id/credentials')
  @RequirePermission(PERMISSIONS.AI_MANAGE)
  async createCredential(
    @CurrentUser() auth: AuthContext,
    @Param('id', createUuidValidationPipe('id')) id: string,
    @Body() dto: CreateAgentCredentialDto,
  ) {
    return toPublicAgentCredential(await this.credentials.adminCreate(auth.accountId, id, dto));
  }

  /**
   * Addressed by credential id, not nested under its profile: a credential id
   * is globally unique and the panel already holds it from the list above, so
   * nesting would add a path segment the server would then have to check for
   * consistency with the id it was given anyway.
   */
  @Patch('credentials/:id')
  @RequirePermission(PERMISSIONS.AI_MANAGE)
  async updateCredential(
    @CurrentUser() auth: AuthContext,
    @Param('id', createUuidValidationPipe('id')) id: string,
    @Body() dto: UpdateAgentCredentialDto,
  ) {
    return toPublicAgentCredential(await this.credentials.adminUpdate(auth.accountId, id, dto));
  }

  @Delete('credentials/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermission(PERMISSIONS.AI_MANAGE)
  async deleteCredential(@CurrentUser() auth: AuthContext, @Param('id', createUuidValidationPipe('id')) id: string) {
    await this.credentials.adminDelete(auth.accountId, id);
  }

  /**
   * Live probe. `ai.manage`, not `ai.read`: it spends the client's money (one
   * real, billed completion) and it MUTATES the credential's health columns,
   * so it is not a read however much it looks like one from the panel.
   *
   * Answers 200 with `{ ok: false, failureKind }` when the provider rejects
   * the key — that is the answer to the question asked, not an error. It
   * throws only when no call could be made at all. See
   * `agent-credential.service.ts#adminTest`.
   */
  @Post('credentials/:id/test')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(PERMISSIONS.AI_MANAGE)
  async testCredential(@CurrentUser() auth: AuthContext, @Param('id', createUuidValidationPipe('id')) id: string) {
    return this.credentials.adminTest(auth.accountId, id);
  }
}
