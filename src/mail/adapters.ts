export interface ImapAdapter { verifySent(messageIdHeader: string): Promise<boolean>; }
export type SmtpOutcome = "ACKNOWLEDGED" | "REJECTED" | "PRE_SUBMISSION_FAILURE" | "UNKNOWN";
export interface SmtpAdapter { submit(messageIdHeader: string, mime: Buffer): Promise<SmtpOutcome>; }
export class FakeSmtpAdapter implements SmtpAdapter { readonly submissions: Array<{ messageIdHeader: string; mime: Buffer }> = []; constructor(private readonly outcome: SmtpOutcome = "ACKNOWLEDGED") {} async submit(messageIdHeader: string, mime: Buffer): Promise<SmtpOutcome> { this.submissions.push({ messageIdHeader, mime }); return this.outcome; } }
export class FakeImapAdapter implements ImapAdapter { constructor(private readonly verified = new Set<string>()) {} async verifySent(messageIdHeader: string): Promise<boolean> { return this.verified.has(messageIdHeader); } }
