import { createHash, randomUUID } from "node:crypto";
import type { AttachmentManifest, PreparedMessage } from "../domain/types.js";
import { SafeError } from "../errors.js";
import { AccountRepository } from "../outbox/accounts.js";
import { OutboxRepository, type PrepareInput } from "../outbox/repository.js";
import { buildMime } from "./mime.js";
export function messageIdHeader(id = randomUUID()): string { return `<${id}@hermes-mail-gateway.local>`; }
export type PublicPrepareInput = Omit<PrepareInput, "fromAddress" | "messageId" | "messageIdHeader" | "requestDigest" | "rawMime"> & { fromAddress?: string };
export async function prepareMessage(repo: OutboxRepository, accounts: AccountRepository, input: PublicPrepareInput): Promise<PreparedMessage> {
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
    fromAddress: effectiveInput.fromAddress,
    recipients: effectiveInput.recipients,
    subject: effectiveInput.subject,
    ...(effectiveInput.textBody === undefined ? {} : { textBody: effectiveInput.textBody }),
    ...(effectiveInput.htmlBody === undefined ? {} : { htmlBody: effectiveInput.htmlBody }),
    attachments: effectiveInput.attachments as AttachmentManifest[],
    state: "PREPARED",
  };
  const rawMime = await buildMime(message, { attachmentRoots: account.allowedAttachmentRoots });
  const canonical = JSON.stringify(effectiveInput);
  return repo.prepare({ ...effectiveInput, rawMime, requestDigest: createHash("sha256").update(canonical).digest("hex"), messageId, messageIdHeader: messageIdHeaderValue });
}
