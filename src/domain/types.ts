export const OUTBOX_STATES = ["PREPARED", "SEND_ATTEMPTED", "SENT_UNVERIFIED", "SENT_VERIFIED", "OUTCOME_UNKNOWN", "FAILED_PERMANENT", "FAILED_RETRY_BLOCKED", "CANCELLED"] as const;
export type OutboxState = typeof OUTBOX_STATES[number];
export type ProviderKind = "gmail" | "zoho" | "generic_imap_smtp";
export type SentPolicy = "provider_managed" | "gateway_append";
export interface AccountProjection { accountId: string; displayName: string; providerKind: ProviderKind; imapEndpoint: string; smtpEndpoint: string; credentialRef: string; smtpCredentialRef?: string | undefined; sentPolicy: SentPolicy; enabled: boolean; allowedSender: string; allowedAttachmentRoots: readonly string[]; inboxFolder: string; sentFolder: string; }
export interface AttachmentManifest { path: string; size: number; sha256: string; contentType: string; }
export interface ForwardingMetadata { originalMessageReference: string; originalMessageId?: string; originalSubject?: string; }
export interface ForwardedAttachment { readonly filename: string; readonly contentType: string; readonly size: number; readonly content: Buffer; }
export interface PreparedMessage { messageId: string; accountId: string; idempotencyKey: string; messageIdHeader: string; fromAddress: string; recipients: readonly string[]; cc: readonly string[]; bcc: readonly string[]; replyTo?: string; inReplyTo?: string; references: readonly string[]; forwarding?: ForwardingMetadata; subject: string; textBody?: string; htmlBody?: string; attachments: readonly AttachmentManifest[]; state: OutboxState; }
