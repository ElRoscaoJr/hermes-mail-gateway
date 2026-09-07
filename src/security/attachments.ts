import { createHash } from "node:crypto";
import { createReadStream, lstatSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { SafeError } from "../errors.js";
import type { AttachmentManifest } from "../domain/types.js";
export async function validateAttachment(filePath: string, roots: readonly string[], expectedSha256: string, maxBytes = 25_000_000): Promise<AttachmentManifest> {
  let resolved: string;
  try { resolved = await realpath(filePath); } catch { throw new SafeError("ATTACHMENT_FORBIDDEN", "Attachment is not accessible."); }
  const allowed = roots.some((root) => { const r = path.resolve(root); return resolved === r || resolved.startsWith(`${r}${path.sep}`); });
  if (!allowed) throw new SafeError("ATTACHMENT_FORBIDDEN", "Attachment is outside the configured roots.");
  const stat = lstatSync(resolved);
  if (!stat.isFile() || stat.size > maxBytes) throw new SafeError("ATTACHMENT_FORBIDDEN", "Attachment is not an allowed regular file.");
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => { const stream = createReadStream(resolved); stream.on("data", (chunk: string | Buffer) => hash.update(typeof chunk === "string" ? Buffer.from(chunk) : chunk)); stream.on("end", resolve); stream.on("error", reject); });
  const sha256 = hash.digest("hex");
  if (sha256 !== expectedSha256) throw new SafeError("ATTACHMENT_CHANGED", "Attachment hash does not match the declared manifest.");
  return { path: resolved, size: stat.size, sha256, contentType: "application/octet-stream" };
}
