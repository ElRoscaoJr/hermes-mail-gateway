import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const migrationDirectory = join(dirname(fileURLToPath(import.meta.url)), "../../migrations");
const migrations = [
  { version: 1, sql: readFileSync(join(migrationDirectory, "001_initial.sql"), "utf8") },
  { version: 2, sql: readFileSync(join(migrationDirectory, "002_smtp_credential_ref.sql"), "utf8") },
  { version: 3, sql: readFileSync(join(migrationDirectory, "003_message_routing_metadata.sql"), "utf8") },
] as const;

function applyMigrations(db: Database.Database): void {
  const applied = new Set((db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>).map((row) => row.version));
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    db.exec("BEGIN;");
    try {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, datetime('now'))").run(migration.version);
      db.exec("COMMIT;");
      applied.add(migration.version);
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
  }
}

export function openDatabase(filename: string): Database.Database {
  const db = new Database(filename);
  try {
    db.pragma("journal_mode = WAL"); db.pragma("foreign_keys = ON"); db.pragma("busy_timeout = 5000");
    db.exec("BEGIN;");
    try { db.exec(migrations[0].sql); db.exec("COMMIT;"); } catch (error) { db.exec("ROLLBACK;"); throw error; }
    if (!db.prepare("SELECT 1 FROM schema_migrations WHERE version = 1").get()) db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (1, datetime('now'))").run();
    applyMigrations(db);
    return db;
  } catch (error) { db.close(); throw error; }
}
