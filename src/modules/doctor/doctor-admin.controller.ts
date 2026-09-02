import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import { AccountType, CurrentUser, RequirePermission } from '../../shared/auth/auth.decorator';
import type { AuthContext } from '../../shared/auth/auth.types';
import { PERMISSIONS } from '../../shared/auth/permission.catalog';
import { createUuidValidationPipe } from '../../shared/errors/uuid-param.pipe';
import {
  AssignDoctorSpecialtyDto,
  CreateDoctorDto,
  ReviewDoctorDocumentDto,
  UpdateDoctorDto,
  UpdateDoctorExpertRoleDto,
  UpdateDoctorFeeDto,
  UpdateDoctorListingDto,
  UpdateDoctorVerificationDto,
} from './doctor-admin.dto';
import { DoctorDocumentService } from './doctor-document.service';
import { DoctorReliabilityService } from './doctor-reliability.service';
import { DoctorSpecialtyService } from './doctor-specialty.service';
import { DoctorVerificationService } from './doctor-verification.service';
import { DoctorService } from './doctor.service';

/** Every route is admin-only, gated by its own permission — mirrors `identity-admin.controller.ts`. */
@Controller('admin/doctors')
@AccountType('admin')
export class DoctorAdminController {
  constructor(
    private readonly doctorService: DoctorService,
    private readonly verificationService: DoctorVerificationService,
    private readonly specialtyService: DoctorSpecialtyService,
    private readonly documentService: DoctorDocumentService,
    private readonly reliabilityService: DoctorReliabilityService,
  ) {}

  @Get()
  @RequirePermission(PERMISSIONS.DOCTORS_READ)
  list() {
    return this.doctorService.adminList();
  }

  @Get(':id')
  @RequirePermission(PERMISSIONS.DOCTORS_READ)
  getDetail(@Param('id', createUuidValidationPipe('id')) id: string) {
    return this.doctorService.adminGetDetail(id);
  }

  @Post()
  @RequirePermission(PERMISSIONS.DOCTORS_CREATE)
  create(@CurrentUser() auth: AuthContext, @Body() dto: CreateDoctorDto) {
    return this.doctorService.adminCreate(auth.accountId, dto);
  }

  @Patch(':id')
  @RequirePermission(PERMISSIONS.DOCTORS_UPDATE)
  update(@CurrentUser() auth: AuthContext, @Param('id', createUuidValidationPipe('id')) id: string, @Body() dto: UpdateDoctorDto) {
    return this.doctorService.adminUpdateProfileFields(auth.accountId, id, dto);
  }

  @Patch(':id/verification')
  @RequirePermission(PERMISSIONS.DOCTORS_VERIFY)
  setVerification(
    @CurrentUser() auth: AuthContext,
    @Param('id', createUuidValidationPipe('id')) id: string,
    @Body() dto: UpdateDoctorVerificationDto,
  ) {
    return this.verificationService.setVerificationStatus(auth.accountId, id, dto);
  }

  @Patch(':id/listing')
  @RequirePermission(PERMISSIONS.DOCTORS_MANAGE_LISTING)
  setListing(
    @CurrentUser() auth: AuthContext,
    @Param('id', createUuidValidationPipe('id')) id: string,
    @Body() dto: UpdateDoctorListingDto,
  ) {
    return this.verificationService.setListing(auth.accountId, id, dto);
  }

  @Patch(':id/fee')
  @RequirePermission(PERMISSIONS.DOCTORS_MANAGE_FEE)
  setFee(@CurrentUser() auth: AuthContext, @Param('id', createUuidValidationPipe('id')) id: string, @Body() dto: UpdateDoctorFeeDto) {
    return this.verificationService.setFee(auth.accountId, id, dto);
  }

  @Patch(':id/expert-role')
  @RequirePermission(PERMISSIONS.DOCTORS_MANAGE_EXPERT_ROLE)
  setExpertRole(
    @CurrentUser() auth: AuthContext,
    @Param('id', createUuidValidationPipe('id')) id: string,
    @Body() dto: UpdateDoctorExpertRoleDto,
  ) {
    return this.verificationService.setExpertRole(auth.accountId, id, dto);
  }

  @Post(':id/specialties')
  @RequirePermission(PERMISSIONS.DOCTORS_UPDATE)
  assignSpecialty(
    @CurrentUser() auth: AuthContext,
    @Param('id', createUuidValidationPipe('id')) id: string,
    @Body() dto: AssignDoctorSpecialtyDto,
  ) {
    return this.specialtyService.assign(auth.accountId, id, dto);
  }

  @Delete(':id/specialties/:specialtyId')
  @RequirePermission(PERMISSIONS.DOCTORS_UPDATE)
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeSpecialty(
    @CurrentUser() auth: AuthContext,
    @Param('id', createUuidValidationPipe('id')) id: string,
    @Param('specialtyId', createUuidValidationPipe('specialtyId')) specialtyId: string,
  ): Promise<void> {
    await this.specialtyService.remove(auth.accountId, id, specialtyId);
  }

  @Get(':id/documents')
  @RequirePermission(PERMISSIONS.DOCTORS_READ)
  listDocuments(@Param('id', createUuidValidationPipe('id')) id: string) {
    return this.documentService.listForAdmin(id);
  }

  @Patch(':id/documents/:documentId/review')
  @RequirePermission(PERMISSIONS.DOCTORS_VERIFY)
  reviewDocument(
    @CurrentUser() auth: AuthContext,
    @Param('id', createUuidValidationPipe('id')) id: string,
    @Param('documentId', createUuidValidationPipe('documentId')) documentId: string,
    @Body() dto: ReviewDoctorDocumentDto,
  ) {
    return this.documentService.review(auth.accountId, id, documentId, dto);
  }

  @Get(':id/reliability')
  @RequirePermission(PERMISSIONS.GOVERNANCE_READ_QUALITY)
  getReliability(@Param('id', createUuidValidationPipe('id')) id: string) {
    return this.reliabilityService.getMetrics(id);
  }
}
