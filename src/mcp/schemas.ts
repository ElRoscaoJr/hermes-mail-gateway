import { z } from "zod";
const id = z.string().min(1).max(128);
const queryOperation = z.enum(["list", "search", "read", "thread", "attachments", "verifySent"]);
export const mailAccountsSchema = z.strictObject({ includeHealth: z.boolean().default(true) });
export const mailQuerySchema = z.strictObject({ accountId: id, operation: queryOperation, folder: z.string().max(200).optional(), query: z.string().max(1000).optional(), messageReference: id.optional(), cursor: z.string().max(500).optional(), limit: z.number().int().min(1).max(100).default(20) });
export const mailPrepareSchema = z.strictObject({ accountId: id, idempotencyKey: z.string().min(8).max(200), recipients: z.array(z.string().email()).min(1).max(100), subject: z.string().max(998), textBody: z.string().max(1_000_000).optional(), htmlBody: z.string().max(1_000_000).optional(), attachments: z.array(z.strictObject({ path: z.string().min(1).max(4096), size: z.number().int().nonnegative().max(25_000_000), sha256: z.string().regex(/^[a-f0-9]{64}$/), contentType: z.string().max(128) })).max(32).default([]) });
export const mailExecuteSchema = z.strictObject({ accountId: id, messageId: id, verifyOnly: z.boolean().default(false) });
export const toolSchemas = { mail_accounts: mailAccountsSchema, mail_query: mailQuerySchema, mail_prepare: mailPrepareSchema, mail_execute: mailExecuteSchema } as const;
