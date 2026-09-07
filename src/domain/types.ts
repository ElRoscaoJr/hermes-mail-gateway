export const OUTBOX_STATES = ["PREPARED", "SEND_ATTEMPTED", "SENT_UNVERIFIED", "SENT_VERIFIED", "OUTCOME_UNKNOWN", "FAILED_PERMANENT", "FAILED_RETRY_BLOCKED", "CANCELLED"] as const;
export type OutboxState = typeof OUTBOX_STATES[number];
export type ProviderKind = "gmail" | "zoho" | "generic_imap_smtp";
export type SentPolicy = "provider_managed" | "gateway_append";
export interface AccountProjection { accountId: string; displayName: string; providerKind: ProviderKind; imapEndpoint: string; smtpEndpoint: string; credentialRef: string; sentPolicy: SentPolicy; enabled: boolean; allowedSender: string; allowedAttachmentRoots: readonly string[]; }
export interface AttachmentManifest { path: string; size: number; sha256: string; contentType: string; }
export interface PreparedMessage { messageId: string; accountId: string; idempotencyKey: string; messageIdHeader: string; fromAddress: string; recipients: readonly string[]; subject: string; textBody?: string; htmlBody?: string; attachments: readonly AttachmentManifest[]; state: OutboxState; }
