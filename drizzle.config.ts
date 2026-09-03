import { config } from 'dotenv';

config({ path: '.env.local' });
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    // migrations run over the direct (non-pooled) connection
    url: process.env.DATABASE_URL!,
  },
  verbose: true,
  strict: true,
});
