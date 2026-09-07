import nodemailer from "nodemailer";
import type { PreparedMessage } from "../domain/types.js";
import { SafeError } from "../errors.js";
import { validateAttachment } from "../security/attachments.js";

export interface MimeBuildOptions {
  readonly attachmentRoots: readonly string[];
  readonly maxAttachmentBytes?: number;
}

/** Builds a complete, owned MIME buffer; it performs no network operation. */
export async function buildMime(message: PreparedMessage, options: MimeBuildOptions): Promise<Buffer> {
  if (!message.textBody && !message.htmlBody) throw new SafeError("INVALID_INPUT", "A text or HTML body is required.");
  const attachments = [] as Array<{ filename: string; path: string; contentType: string }>;
  for (const manifest of message.attachments) {
    const validated = await validateAttachment(manifest.path, options.attachmentRoots, manifest.sha256, options.maxAttachmentBytes);
    if (validated.size !== manifest.size) throw new SafeError("ATTACHMENT_CHANGED", "Attachment size does not match the declared manifest.");
    attachments.push({ filename: manifest.path.split(/[\\/]/).pop() ?? "attachment", path: validated.path, contentType: manifest.contentType });
  }
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "unix" });
  const info = await transport.sendMail({
    messageId: message.messageIdHeader,
    from: message.fromAddress,
    to: [...message.recipients],
    subject: message.subject,
    ...(message.textBody === undefined ? {} : { text: message.textBody }),
    ...(message.htmlBody === undefined ? {} : { html: message.htmlBody }),
    attachments,
  });
  return Buffer.from(info.message as Buffer);
}
