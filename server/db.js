import pg from "pg";

const { Pool } = pg;

// One shared connection pool for the whole server process, reused by every query — Neon's
// pooled endpoint (the `-pooler` host baked into DATABASE_URL) is meant for exactly this kind of
// long-lived Node process making many short queries, unlike the unpooled URL tools/migrate.js
// uses for DDL. `rejectUnauthorized: false` is the standard approach for Neon's TLS-terminating
// proxy in front of the actual database — sslmode=require in the connection string still forces
// the connection itself to be encrypted, this only skips strict CA chain validation.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

export function query(text, params) {
  return pool.query(text, params);
}
