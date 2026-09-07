import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("keychain helper keeps the password out of arguments, environment, and output", () => {
  const source = readFileSync("scripts/store-keychain-credential.mjs", "utf8");
  assert.match(source, /setPassword\(service, account, password\)/);
  assert.match(source, /process\.stdin\.isTTY/);
  assert.match(source, /process\.stdin\.setRawMode\(true\)/);
  assert.match(source, /finally\s*\{/);
  assert.match(source, /process\.stdin\.setRawMode\(false\)/);
  assert.doesNotMatch(source, /process\.env/);
  assert.doesNotMatch(source, /getPassword/);
  assert.doesNotMatch(source, /password.*process\.argv|process\.argv.*password/i);
  assert.doesNotMatch(source, /console\.(log|error)\(.*password/i);
});
