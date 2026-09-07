import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { validateAttachment } from "../../src/security/attachments.js";
import { redact } from "../../src/observability/redaction.js";
import { file } from "../helpers.js";
test("attachment roots and hashes are enforced", async () => { const dir = "/tmp"; const path = file(dir, `hermes-attachment-${Date.now()}.txt`, "safe"); const hash = createHash("sha256").update("safe").digest("hex"); const manifest = await validateAttachment(path, [dir], hash); assert.equal(manifest.sha256, hash); await assert.rejects(validateAttachment(path, ["/var/empty"], hash), { code: "ATTACHMENT_FORBIDDEN" }); await assert.rejects(validateAttachment(path, [dir], "0".repeat(64)), { code: "ATTACHMENT_CHANGED" }); });
test("redaction removes secrets and bearer tokens", () => { assert.deepEqual(redact({ token: "secret", nested: { password: "pw" }, text: "Bearer abc" }), { token: "[REDACTED]", nested: { password: "[REDACTED]" }, text: "Bearer [REDACTED]" }); });
