import { defineConfig } from 'drizzle-kit';
import { getEnv } from './src/config/env/env.validation';

const env = getEnv();

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/**/*.schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: env.DATABASE_URL,
    ssl: env.DB_SSL ? { rejectUnauthorized: false } : false,
  },
  verbose: true,
  strict: true,
});
