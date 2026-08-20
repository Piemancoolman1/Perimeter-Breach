// Plain node entry points (this server, tools/migrate.js) don't get .env.local loaded
// automatically the way the game client's Vite build does — read it directly here instead of
// requiring every entry point to remember to export everything by hand first. Must be imported
// before anything that reads process.env at module-load time (db.js's Pool construction, etc.) —
// ES module imports execute in file order, so putting `import "./loadEnv.js"` as the very first
// import anywhere it's needed guarantees this runs first. Existing process.env values always win
// (e.g. a real deployment's platform-injected env vars), matching how .env loaders conventionally
// behave.
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const envPath = path.join(ROOT, ".env.local");

if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] === undefined) process.env[key] = rawValue.replace(/^"(.*)"$/, "$1");
  }
}
