import nodemailer from "nodemailer";
import type { ForwardedAttachment, PreparedMessage } from "../domain/types.js";
import { SafeError } from "../errors.js";
import { validateAttachment } from "../security/attachments.js";

export interface MimeBuildOptions {
  readonly attachmentRoots: readonly string[];
  readonly maxAttachmentBytes?: number;
  readonly forwardedAttachments?: readonly ForwardedAttachment[];
}

function assertHeaderSafe(value: string, label: string): void {
  if (/[\r\n]/.test(value)) throw new SafeError("INVALID_INPUT", `${label} contains an invalid line break.`);
}

/** Builds a complete, owned MIME buffer; it performs no network operation. */
export async function buildMime(message: PreparedMessage, options: MimeBuildOptions): Promise<Buffer> {
  if (!message.textBody && !message.htmlBody) throw new SafeError("INVALID_INPUT", "A text or HTML body is required.");
  assertHeaderSafe(message.subject, "Subject");
  if (message.replyTo !== undefined) assertHeaderSafe(message.replyTo, "Reply-To");
  if (message.inReplyTo !== undefined) assertHeaderSafe(message.inReplyTo, "In-Reply-To");
  for (const reference of message.references) assertHeaderSafe(reference, "References");
  if (message.forwarding !== undefined) {
    assertHeaderSafe(message.forwarding.originalMessageReference, "Forwarding reference");
    if (message.forwarding.originalMessageId !== undefined) assertHeaderSafe(message.forwarding.originalMessageId, "Forwarding Message-ID");
    if (message.forwarding.originalSubject !== undefined) assertHeaderSafe(message.forwarding.originalSubject, "Forwarding subject");
  }
  const attachments = [] as Array<{ filename: string; path?: string; content?: Buffer; contentType: string }>;
  for (const manifest of message.attachments) {
    const validated = await validateAttachment(manifest.path, options.attachmentRoots, manifest.sha256, options.maxAttachmentBytes);
    if (validated.size !== manifest.size) throw new SafeError("ATTACHMENT_CHANGED", "Attachment size does not match the declared manifest.");
    attachments.push({ filename: manifest.path.split(/[\\/]/).pop() ?? "attachment", path: validated.path, contentType: manifest.contentType });
  }
  for (const attachment of options.forwardedAttachments ?? []) attachments.push({ filename: attachment.filename, content: attachment.content, contentType: attachment.contentType });
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "windows" });
  const info = await transport.sendMail({
    messageId: message.messageIdHeader,
    from: message.fromAddress,
    to: [...message.recipients],
    ...(message.cc.length === 0 ? {} : { cc: [...message.cc] }),
    subject: message.subject,
    ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
    ...(message.inReplyTo === undefined ? {} : { inReplyTo: message.inReplyTo }),
    ...(message.references.length === 0 ? {} : { references: message.references.join(" ") }),
    ...(message.forwarding === undefined ? {} : { headers: {
      "X-Hermes-Forwarded-Message-Reference": message.forwarding.originalMessageReference,
      ...(message.forwarding.originalMessageId === undefined ? {} : { "X-Hermes-Forwarded-Message-ID": message.forwarding.originalMessageId }),
      ...(message.forwarding.originalSubject === undefined ? {} : { "X-Hermes-Forwarded-Subject": message.forwarding.originalSubject }),
    } }),
    ...(message.textBody === undefined ? {} : { text: message.textBody }),
    ...(message.htmlBody === undefined ? {} : { html: message.htmlBody }),
    attachments,
  });
  return Buffer.from(info.message as Buffer);
}
