import { z } from "zod";
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const headerText = (max: number) => z.string().max(max).refine((value) => !/[\r\n]/.test(value), "Header values may not contain line breaks.");
const messageIdHeader = z.string().regex(/^<[^<>\r\n]+>$/).max(998);
const recipientList = z.array(z.string().email()).max(100).default([]);
const queryOperation = z.enum(["folders", "list", "search", "read", "thread", "attachments", "verifySent"]);
export const mailAccountsSchema = z.strictObject({ includeHealth: z.boolean().default(true) });
export const mailQuerySchema = z.strictObject({ accountId: id, operation: queryOperation, folder: z.string().min(1).max(200).optional(), query: z.string().max(1000).optional(), messageReference: z.union([id, messageIdHeader]).optional(), cursor: z.string().max(500).optional(), limit: z.number().int().min(1).max(100).default(20) });
export const mailPrepareSchema = z.strictObject({
  accountId: id,
  intent: z.enum(["send", "draft"]).default("send"),
  idempotencyKey: z.string().min(8).max(200),
  recipients: z.array(z.string().email()).min(1).max(100),
  cc: recipientList,
  bcc: recipientList,
  replyTo: z.string().email().optional(),
  inReplyTo: messageIdHeader.optional(),
  references: z.array(messageIdHeader).max(100).default([]),
  forwarding: z.strictObject({
    originalMessageReference: id,
    originalMessageId: messageIdHeader.optional(),
    originalSubject: headerText(998).optional(),
  }).optional(),
  subject: headerText(998),
  textBody: z.string().max(1_000_000).optional(),
  htmlBody: z.string().max(1_000_000).optional(),
  attachments: z.array(z.strictObject({ path: z.string().min(1).max(4096), size: z.number().int().nonnegative().max(25_000_000), sha256: z.string().regex(/^[a-f0-9]{64}$/), contentType: z.string().max(128) })).max(32).default([]),
});
const mailboxReference = z.string().min(1).max(500);
const mutationAction = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("markRead"), messageReference: mailboxReference }),
  z.strictObject({ type: z.literal("markUnread"), messageReference: mailboxReference }),
  z.strictObject({ type: z.literal("addFlag"), messageReference: mailboxReference, flag: z.enum(["\\Flagged", "\\Answered"]) }),
  z.strictObject({ type: z.literal("removeFlag"), messageReference: mailboxReference, flag: z.enum(["\\Flagged", "\\Answered"]) }),
  z.strictObject({ type: z.literal("move"), messageReference: mailboxReference, destinationFolder: z.string().min(1).max(200) }),
  z.strictObject({ type: z.literal("copy"), messageReference: mailboxReference, destinationFolder: z.string().min(1).max(200) }),
  z.strictObject({ type: z.literal("trash"), messageReference: mailboxReference }),
  z.strictObject({ type: z.literal("restore"), messageReference: mailboxReference }),
]);
const preparedAction = z.union([mutationAction, z.strictObject({ type: z.literal("cancelPrepared"), messageId: id })]);
export const mailExecuteSchema = z.strictObject({ accountId: id, messageId: id.optional(), verifyOnly: z.boolean().default(false), action: preparedAction.optional() }).refine((value) => value.action !== undefined || value.messageId !== undefined, "An execution messageId or action is required.");
export const toolSchemas = { mail_accounts: mailAccountsSchema, mail_query: mailQuerySchema, mail_prepare: mailPrepareSchema, mail_execute: mailExecuteSchema } as const;
