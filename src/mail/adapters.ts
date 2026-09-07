import nodemailer from "nodemailer";
import type { CredentialResolver } from "./credentials.js";

export interface ImapAdapter { verifySent(messageIdHeader: string): Promise<boolean>; }
export type SmtpOutcome = "ACKNOWLEDGED" | "REJECTED" | "PRE_SUBMISSION_FAILURE" | "UNKNOWN";
export interface SmtpAdapter { submit(messageIdHeader: string, mime: Buffer): Promise<SmtpOutcome>; }

export interface NodemailerSmtpOptions {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly credentialRef: string;
  readonly credentials: CredentialResolver;
  readonly transport?: Pick<ReturnType<typeof nodemailer.createTransport>, "sendMail">;
}

type MailError = { code?: string; command?: string; responseCode?: number; response?: string; rejected?: unknown[] };

function isProviderRejection(error: MailError): boolean {
  return typeof error.responseCode === "number" || Array.isArray(error.rejected);
}

function isPreSubmissionConnectionFailure(error: MailError): boolean {
  return error.command === "CONN" || error.code === "ECONNECTION" || error.code === "ETIMEDOUT";
}

/** Nodemailer SMTP adapter. It never retries and never emits message content. */
export class NodemailerSmtpAdapter implements SmtpAdapter {
  private readonly transport: Pick<ReturnType<typeof nodemailer.createTransport>, "sendMail"> | undefined;
  constructor(private readonly options: NodemailerSmtpOptions) { this.transport = options.transport; }

  async submit(_messageIdHeader: string, mime: Buffer): Promise<SmtpOutcome> {
    let credential;
    try {
      credential = await this.options.credentials.get(this.options.credentialRef);
    } catch {
      return "PRE_SUBMISSION_FAILURE";
    }
    if (!credential) return "PRE_SUBMISSION_FAILURE";
    try {
      const transport = this.transport ?? nodemailer.createTransport({ host: this.options.host, port: this.options.port, secure: this.options.secure, auth: credential });
      const info = await transport.sendMail({ raw: Buffer.from(mime) });
      return Array.isArray(info.rejected) && info.rejected.length > 0 ? "REJECTED" : "ACKNOWLEDGED";
    } catch (error) {
      const mailError = error as MailError;
      if (isProviderRejection(mailError)) return "REJECTED";
      if (isPreSubmissionConnectionFailure(mailError)) return "PRE_SUBMISSION_FAILURE";
      return "UNKNOWN";
    }
  }
}

export class FakeSmtpAdapter implements SmtpAdapter { readonly submissions: Array<{ messageIdHeader: string; mime: Buffer }> = []; constructor(private readonly outcome: SmtpOutcome = "ACKNOWLEDGED") {} async submit(messageIdHeader: string, mime: Buffer): Promise<SmtpOutcome> { this.submissions.push({ messageIdHeader, mime }); return this.outcome; } }
export class FakeImapAdapter implements ImapAdapter { constructor(private readonly verified = new Set<string>()) {} async verifySent(messageIdHeader: string): Promise<boolean> { return this.verified.has(messageIdHeader); } }
