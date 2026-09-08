import { z } from "zod";
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const headerText = (max: number) => z.string().max(max).refine((value) => !/[\r\n]/.test(value), "Header values may not contain line breaks.");
const messageIdHeader = z.string().regex(/^<[^<>\r\n]+>$/).max(998);
const boundedDate = z.string().min(1).max(30).refine((value) => /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/.test(value) && !Number.isNaN(Date.parse(value.includes("T") ? value : `${value}T00:00:00.000Z`)), "Date must be an ISO date or UTC timestamp.");
export const mailSearchFiltersSchema = z.strictObject({
  from: z.string().email().max(320).optional(),
  to: z.string().email().max(320).optional(),
  cc: z.string().email().max(320).optional(),
  subject: z.string().max(998).refine((value) => !/[\r\n]/.test(value), "Subject may not contain line breaks.").optional(),
  since: boundedDate.optional(),
  before: boundedDate.optional(),
  hasAttachment: z.boolean().optional(),
  isRead: z.boolean().optional(),
  isFlagged: z.boolean().optional(),
  messageId: messageIdHeader.optional(),
}).superRefine((value, context) => {
  if (value.since && value.before && Date.parse(value.since.includes("T") ? value.since : `${value.since}T00:00:00.000Z`) >= Date.parse(value.before.includes("T") ? value.before : `${value.before}T00:00:00.000Z`)) context.addIssue({ code: "custom", path: ["before"], message: "before must be later than since." });
});
const recipientList = z.array(z.string().email()).max(100).default([]);
const queryOperation = z.enum(["folders", "list", "search", "read", "thread", "attachments", "verifySent"]);
export const mailAccountsSchema = z.strictObject({ includeHealth: z.boolean().default(true) });
export const mailQuerySchema = z.strictObject({ accountId: id, operation: queryOperation, folder: z.string().min(1).max(200).optional(), query: z.string().max(1000).optional(), search: mailSearchFiltersSchema.optional(), messageReference: z.union([id, messageIdHeader]).optional(), attachmentIndex: z.number().int().min(0).max(31).optional(), cursor: z.string().max(500).optional(), limit: z.number().int().min(1).max(100).default(20) }).superRefine((value, context) => {
  if (value.search !== undefined && value.operation !== "search") context.addIssue({ code: "custom", path: ["search"], message: "Structured search filters are valid only for search." });
  if (value.attachmentIndex !== undefined && value.operation !== "attachments") context.addIssue({ code: "custom", path: ["attachmentIndex"], message: "attachmentIndex is valid only for attachment queries." });
});
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
const preparedAction = z.union([mutationAction, z.strictObject({ type: z.literal("cancelPrepared"), messageId: id }), z.strictObject({ type: z.literal("saveDraft"), messageId: id })]);
export const mailExecuteSchema = z.strictObject({ accountId: id, messageId: id.optional(), verifyOnly: z.boolean().default(false), action: preparedAction.optional() }).refine((value) => value.action !== undefined || value.messageId !== undefined, "An execution messageId or action is required.");
export const toolSchemas = { mail_accounts: mailAccountsSchema, mail_query: mailQuerySchema, mail_prepare: mailPrepareSchema, mail_execute: mailExecuteSchema } as const;
