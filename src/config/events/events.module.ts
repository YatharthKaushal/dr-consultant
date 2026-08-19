import { Global, Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import {
  EVENTS_CONFIG,
  OUTBOX_CONFIG,
  buildEventsConfig,
  buildEventEmitterConfig,
  buildOutboxConfig,
  type EventsConfig,
  type OutboxConfig,
} from './events.config';

/**
 * Global events module.
 *
 * Configures and registers `@nestjs/event-emitter` globally using factory configuration,
 * providing the shared event mechanism for decoupled inter-module reactivity and
 * making the Outbox and EventEmitter configs injectable across all modules.
 */
@Global()
@Module({
  imports: [EventEmitterModule.forRoot(buildEventEmitterConfig())],
  providers: [
    {
      provide: EVENTS_CONFIG,
      useFactory: (): EventsConfig => buildEventsConfig(),
    },
    {
      provide: OUTBOX_CONFIG,
      useFactory: (): OutboxConfig => buildOutboxConfig(),
    },
  ],
  exports: [EventEmitterModule, EVENTS_CONFIG, OUTBOX_CONFIG],
})
export class EventsModule {}
