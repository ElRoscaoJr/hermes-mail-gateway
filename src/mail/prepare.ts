import { createHash, randomUUID } from "node:crypto";
import type { AttachmentManifest, ForwardedAttachment, PreparedMessage } from "../domain/types.js";
import { SafeError } from "../errors.js";
import { AccountRepository } from "../outbox/accounts.js";
import { OutboxRepository, type PrepareInput } from "../outbox/repository.js";
import { buildMime } from "./mime.js";
export function messageIdHeader(id = randomUUID()): string { return `<${id}@hermes-mail-gateway.local>`; }
export type PublicPrepareInput = Omit<PrepareInput, "fromAddress" | "messageId" | "messageIdHeader" | "requestDigest" | "rawMime"> & { fromAddress?: string };
export async function prepareMessage(repo: OutboxRepository, accounts: AccountRepository, input: PublicPrepareInput, forwardedAttachments: readonly ForwardedAttachment[] = [], digestInput: unknown = input): Promise<PreparedMessage> {
  const account = accounts.get(input.accountId);
  if (!account) throw new SafeError("ACCOUNT_NOT_FOUND", "Account was not found.");
  if (!account.enabled) throw new SafeError("ACCOUNT_DISABLED", "Account is disabled.");
  const configuredSender = account.allowedSender.trim().toLowerCase();
  if (input.fromAddress !== undefined && input.fromAddress.trim().toLowerCase() !== configuredSender) throw new SafeError("INVALID_INPUT", "From address does not match the account sender policy.");
  const effectiveInput = { ...input, fromAddress: account.allowedSender };
  const messageId = randomUUID();
  const messageIdHeaderValue = messageIdHeader();
  const message: PreparedMessage = {
    messageId,
    accountId: effectiveInput.accountId,
    idempotencyKey: effectiveInput.idempotencyKey,
    messageIdHeader: messageIdHeaderValue,
    intent: effectiveInput.intent ?? "send",
    fromAddress: effectiveInput.fromAddress,
    recipients: effectiveInput.recipients,
    cc: effectiveInput.cc ?? [],
    bcc: effectiveInput.bcc ?? [],
    ...(effectiveInput.replyTo === undefined ? {} : { replyTo: effectiveInput.replyTo }),
    ...(effectiveInput.inReplyTo === undefined ? {} : { inReplyTo: effectiveInput.inReplyTo }),
    references: effectiveInput.references ?? [],
    ...(effectiveInput.forwarding === undefined ? {} : { forwarding: effectiveInput.forwarding }),
    subject: effectiveInput.subject,
    ...(effectiveInput.textBody === undefined ? {} : { textBody: effectiveInput.textBody }),
    ...(effectiveInput.htmlBody === undefined ? {} : { htmlBody: effectiveInput.htmlBody }),
    attachments: effectiveInput.attachments as AttachmentManifest[],
    state: "PREPARED",
  };
  const canonicalInput = digestInput;
  const canonical = JSON.stringify(canonicalInput);
  const requestDigest = createHash("sha256").update(canonical).digest("hex");
  const existing = repo.findByIdempotencyKey(input.accountId, input.idempotencyKey);
  if (existing) { if (existing.requestDigest !== requestDigest) throw new SafeError("IDEMPOTENCY_CONFLICT", "Idempotency key was reused with a different request."); return repo.get(existing.messageId); }
  const rawMime = await buildMime(message, { attachmentRoots: account.allowedAttachmentRoots, forwardedAttachments });
  return repo.prepare({ ...effectiveInput, rawMime, requestDigest, messageId, messageIdHeader: messageIdHeaderValue });
}
