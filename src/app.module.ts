import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './config/db/database.module';
import { getEnv } from './config/env/env.validation';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    // .env files are read and validated by `getEnv()`, so ConfigModule is told
    // to skip its own dotenv pass and just serve the already-validated object.
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      ignoreEnvFile: true,
      load: [() => getEnv()],
    }),
    DatabaseModule,
    HealthModule,
  ],
})
export class AppModule {}
