// Applies every server/migrations/*.sql file that hasn't run yet, in filename order, tracked in
// a schema_migrations table. Uses DATABASE_URL_UNPOOLED (Neon's direct, non-pgbouncer connection)
// rather than the pooled DATABASE_URL the running server uses — Neon recommends the direct
// connection for DDL/migrations, and it's a one-off script, not a long-lived pool.
//
//   node tools/migrate.js

import "../server/loadEnv.js";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MIGRATIONS_DIR = path.join(ROOT, "server", "migrations");

if (!process.env.DATABASE_URL_UNPOOLED) {
  console.error("DATABASE_URL_UNPOOLED is not set (checked process.env and .env.local).");
  process.exit(1);
}

const { Client } = pg;
const client = new Client({
  connectionString: process.env.DATABASE_URL_UNPOOLED,
  ssl: { rejectUnauthorized: false },
});

await client.connect();
try {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const applied = new Set((await client.query("SELECT filename FROM schema_migrations")).rows.map((r) => r.filename));
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  let ranAny = false;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    console.log(`Applying ${file}...`);
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
      await client.query("COMMIT");
      ranAny = true;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  }

  console.log(ranAny ? "Migrations applied." : "Already up to date — nothing to apply.");
} finally {
  await client.end();
}
