import { ArrayMaxSize, IsArray, IsOptional, IsString, Length } from 'class-validator';

/**
 * Self-editable fields ONLY (`PATCH /doctors/me`). Everything else on
 * `doctors` — qualification, registrationNumber, fee, verificationStatus,
 * listing, expert role — is admin-controlled; a doctor must never be able to
 * set their own verification status or fee. There is no `@IsOptional()`-less
 * required field here on purpose: both fields are independently patchable.
 */
export class UpdateOwnDoctorProfileDto {
  @IsOptional()
  @IsString()
  @Length(0, 4000)
  bio?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @Length(1, 40, { each: true })
  languages?: string[];
}

/**
 * `POST /doctors/me/documents` is a real `multipart/form-data` upload, not a
 * JSON body — `documentType` arrives as a plain form field read off
 * `parseSingleFileRequest`'s `fields` (`doctor.controller.ts`), validated in
 * `doctor-document.service.ts#validateDocumentType` the same way
 * `patient-file.service.ts#validateCategory` validates its own raw field.
 * There is deliberately no DTO class here: a `class-validator`/`ValidationPipe`
 * DTO binds to `@Body()`, and a multipart request's non-file fields never
 * reach that pipe (`multipart-file.util.ts`'s own header comment).
 *
 * There used to be a `CreateDoctorDocumentDto` here that took a
 * caller-supplied `storageKey` directly and trusted it as a real object-store
 * key with zero verification — a placeholder from before `modules/storage`
 * existed. Replaced outright (not kept as a legacy dual path — this is
 * pre-launch code with nothing depending on the old shape): the server now
 * mints `storageKey` itself from a real `StorageFacade.store()` call.
 */
