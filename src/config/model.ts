import { z } from "zod";
export const accountConfigSchema = z.strictObject({ accountId: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,63}$/), displayName: z.string().min(1).max(100), providerKind: z.enum(["gmail", "zoho", "generic_imap_smtp"]), imapEndpoint: z.string().url(), smtpEndpoint: z.string().url(), credentialRef: z.string().min(1).max(200), sentPolicy: z.enum(["provider_managed", "gateway_append"]), enabled: z.boolean(), allowedSender: z.string().min(3).max(320), allowedAttachmentRoots: z.array(z.string().min(1)).max(32) });
export const serverConfigSchema = z.strictObject({ databasePath: z.string().min(1), attachmentRoots: z.array(z.string()).max(32), accounts: z.array(accountConfigSchema), limits: z.strictObject({ maxRecipients: z.number().int().positive(), maxAttachmentBytes: z.number().int().positive() }) });
export type AccountConfig = z.infer<typeof accountConfigSchema>;
export type ServerConfig = z.infer<typeof serverConfigSchema>;
