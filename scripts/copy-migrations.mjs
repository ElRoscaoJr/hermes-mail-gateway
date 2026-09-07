import { cpSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

for (const name of ["001_initial.sql", "002_smtp_credential_ref.sql"]) {
  const source = resolve("migrations", name);
  const destination = resolve("dist/migrations", name);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination);
}
