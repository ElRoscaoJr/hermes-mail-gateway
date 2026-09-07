import { z } from "zod";
const imapEndpoint = z.string().url().refine((value) => { try { const url = new URL(value); return (url.protocol === "imap:" || url.protocol === "imaps:") && !url.username && !url.password && !url.search && !url.hash && Boolean(url.hostname); } catch { return false; } }, "IMAP endpoint must be an imap:// or imaps:// URL without embedded credentials or parameters.");
const smtpEndpoint = z.string().url().refine((value) => { try { const url = new URL(value); return (url.protocol === "smtp:" || url.protocol === "smtps:") && !url.username && !url.password && !url.search && !url.hash && Boolean(url.hostname); } catch { return false; } }, "SMTP endpoint must be an smtp:// or smtps:// URL without embedded credentials or parameters.");
export const accountConfigSchema = z.strictObject({ accountId: z.string().regex(/^[a-z0-9][a-z0-9_-]{1,63}$/), displayName: z.string().min(1).max(100), providerKind: z.enum(["gmail", "zoho", "generic_imap_smtp"]), imapEndpoint, smtpEndpoint, credentialRef: z.string().min(1).max(200), sentPolicy: z.enum(["provider_managed", "gateway_append"]), enabled: z.boolean(), allowedSender: z.string().email(), allowedAttachmentRoots: z.array(z.string().min(1)).max(32), inboxFolder: z.string().min(1).max(200), sentFolder: z.string().min(1).max(200) });
export const serverConfigSchema = z.strictObject({ databasePath: z.string().min(1), attachmentRoots: z.array(z.string()).max(32), accounts: z.array(accountConfigSchema), limits: z.strictObject({ maxRecipients: z.number().int().positive().max(100), maxAttachmentBytes: z.number().int().positive().max(25_000_000) }) }).superRefine((config, context) => {
  const seen = new Set<string>();
  for (const account of config.accounts) {
    if (seen.has(account.accountId)) context.addIssue({ code: "custom", path: ["accounts"], message: "accountId values must be unique." });
    seen.add(account.accountId);
  }
});
export type AccountConfig = z.infer<typeof accountConfigSchema>;
export type ServerConfig = z.infer<typeof serverConfigSchema>;
