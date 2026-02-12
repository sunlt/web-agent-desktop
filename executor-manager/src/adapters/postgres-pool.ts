import { Pool } from "pg";

export function createPostgresPool(): Pool {
  return new Pool({
    host: process.env.PGHOST ?? "127.0.0.1",
    port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER ?? "app",
    password: process.env.PGPASSWORD ?? "app123456",
    database: process.env.PGDATABASE ?? "app",
    max: Number(process.env.PG_MAX_POOL ?? 20),
    idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS ?? 30000),
  });
}
