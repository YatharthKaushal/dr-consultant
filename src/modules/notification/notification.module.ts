import { Module } from '@nestjs/common';
import { FcmPushAdapter } from './fcm-push.adapter';
import { NotificationAdminController } from './notification-admin.controller';
import { NotificationConfigRepository } from './notification-config.repository';
import { NotificationController } from './notification.controller';
import { NotificationDeviceRepository } from './notification-device.repository';
import { NotificationFacade } from './notification.facade';
import { NotificationRepository } from './notification.repository';
import { NotificationService } from './notification.service';
import { NotificationTemplateService } from './notification-template.service';
import { NOTIFICATION_PUSH_PORT } from './notification.constants';

/**
 * Not `@Global()` — like `StorageModule`/`AiModule`/`SearchModule`, nothing
 * outside this module resolves a DI token from here; a consuming module
 * (M-11, M-12, M-13, M-16, ...) imports `NotificationModule` and injects
 * `NotificationFacade` through a normal constructor.
 *
 * *** `NotificationFacade` IS THE ONLY EXPORT. *** `NotificationService`, the
 * template service, the FCM adapter and all three repositories are
 * deliberately internal. A module that could inject `NotificationService`
 * could reach the in-app inbox and the device tokens, and M-08's done-when —
 * "other modules raise notifications without knowing the delivery channel" —
 * is a structural property of this export list, not a convention.
 *
 * No `imports`: `DATABASE`, `AuditService` and `AppConfigService` all come
 * from `@Global()` modules, and M-08 depends on no feature module.
 * `docs/MODULES.md` puts M-08's dependencies at M-01 and M-02 only, and that
 * holds at the code level too — device tokens are M-08's own data
 * (`notification-device.repository.ts` sets out why), so there is no
 * `PatientModule`/`DoctorModule` facade call to make.
 *
 * `NOTIFICATION_PUSH_PORT` is bound to `FcmPushAdapter`. Mirrors
 * `SEARCH_AI_PORT` -> `AiFacade`: `notification.service.ts` depends on the
 * `PushProvider` interface, so rebinding this one line takes push out of the
 * request path at the DI level — a harder kill switch than unsetting the
 * credentials, which only degrades each send. Adding a second push backend
 * (a web-push provider for the panel, say) is a second binding here and no
 * change anywhere else.
 */
@Module({
  controllers: [NotificationController, NotificationAdminController],
  providers: [
    NotificationRepository,
    NotificationDeviceRepository,
    NotificationConfigRepository,
    NotificationTemplateService,
    FcmPushAdapter,
    { provide: NOTIFICATION_PUSH_PORT, useExisting: FcmPushAdapter },
    NotificationService,
    NotificationFacade,
  ],
  exports: [NotificationFacade],
})
export class NotificationModule {}
