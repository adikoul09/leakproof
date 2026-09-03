import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

/**
 * One postgres.js pool per process. Next dev reloads modules on every edit,
 * so the client is stashed on globalThis to avoid leaking connections into
 * Neon's pooler.
 */
const globalForDb = globalThis as unknown as { __leakproofSql?: postgres.Sql };

const connectionString = process.env.DATABASE_URL_POOLED || process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL (or DATABASE_URL_POOLED) is not set');

export const sql =
  globalForDb.__leakproofSql ??
  postgres(connectionString, {
    max: 5,
    idle_timeout: 20,
    // Neon terminates idle connections; keep the pool small and short-lived.
    prepare: false,
  });

if (process.env.NODE_ENV !== 'production') globalForDb.__leakproofSql = sql;

export const db = drizzle(sql, { schema });
export { schema };
export type Db = typeof db;
