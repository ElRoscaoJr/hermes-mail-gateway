import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const migration = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../migrations/001_initial.sql"), "utf8");
export function openDatabase(filename: string): Database.Database {
  const db = new Database(filename); db.pragma("journal_mode = WAL"); db.pragma("foreign_keys = ON"); db.pragma("busy_timeout = 5000");
  db.exec("BEGIN;" + migration + "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, datetime('now')); COMMIT;");
  return db;
}
