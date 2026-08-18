import { Global, Module, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { connectDatabase, disconnectDatabase, getDb, type Database } from './database.config';

/** Injection token for the Drizzle instance. */
export const DATABASE = Symbol('DATABASE');

/**
 * Makes the Drizzle instance injectable application-wide and ties the pool to
 * the Nest lifecycle: connect (and fail fast) on boot, drain on shutdown.
 *
 * Usage:  constructor(@Inject(DATABASE) private readonly db: Database) {}
 */
@Global()
@Module({
  providers: [
    {
      provide: DATABASE,
      useFactory: (): Database => getDb(),
    },
  ],
  exports: [DATABASE],
})
export class DatabaseModule implements OnModuleInit, OnApplicationShutdown {
  async onModuleInit(): Promise<void> {
    await connectDatabase();
  }

  async onApplicationShutdown(): Promise<void> {
    await disconnectDatabase();
  }
}
