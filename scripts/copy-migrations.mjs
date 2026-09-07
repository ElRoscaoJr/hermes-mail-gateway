import { cpSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const source = resolve("migrations/001_initial.sql");
const destination = resolve("dist/migrations/001_initial.sql");
mkdirSync(dirname(destination), { recursive: true });
cpSync(source, destination);
