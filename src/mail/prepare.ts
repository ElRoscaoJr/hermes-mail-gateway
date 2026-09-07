import { createHash, randomUUID } from "node:crypto";
import type { PreparedMessage } from "../domain/types.js";
import { SafeError } from "../errors.js";
import { AccountRepository } from "../outbox/accounts.js";
import { OutboxRepository, type PrepareInput } from "../outbox/repository.js";
export function messageIdHeader(id = randomUUID()): string { return `<${id}@hermes-mail-gateway.local>`; }
export type PublicPrepareInput = Omit<PrepareInput, "fromAddress" | "messageId" | "messageIdHeader" | "requestDigest"> & { fromAddress?: string };
export function prepareMessage(repo: OutboxRepository, accounts: AccountRepository, input: PublicPrepareInput): PreparedMessage {
  const account = accounts.get(input.accountId);
  if (!account) throw new SafeError("ACCOUNT_NOT_FOUND", "Account was not found.");
  if (!account.enabled) throw new SafeError("ACCOUNT_DISABLED", "Account is disabled.");
  const configuredSender = account.allowedSender.trim().toLowerCase();
  if (input.fromAddress !== undefined && input.fromAddress.trim().toLowerCase() !== configuredSender) throw new SafeError("INVALID_INPUT", "From address does not match the account sender policy.");
  const effectiveInput = { ...input, fromAddress: account.allowedSender };
  const canonical = JSON.stringify(effectiveInput);
  return repo.prepare({ ...effectiveInput, requestDigest: createHash("sha256").update(canonical).digest("hex"), messageId: randomUUID(), messageIdHeader: messageIdHeader() });
}
export function immutableMime(message: PreparedMessage): Buffer { const headers = [`Message-ID: ${message.messageIdHeader}`, `From: ${message.fromAddress}`, `To: ${message.recipients.join(", ")}`, `Subject: ${message.subject}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8"]; return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${message.textBody ?? ""}`, "utf8"); }
