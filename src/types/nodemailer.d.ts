declare module "nodemailer" {
  interface SendMailOptions {
    messageId?: string;
    from?: string;
    to?: string | readonly string[];
    cc?: string | readonly string[];
    replyTo?: string;
    inReplyTo?: string;
    references?: string | readonly string[];
    headers?: Record<string, string>;
    subject?: string;
    text?: string;
    html?: string;
    raw?: Buffer;
    envelope?: { from?: string; to?: string | readonly string[]; cc?: string | readonly string[]; bcc?: string | readonly string[] };
    attachments?: readonly { filename?: string; path?: string; content?: Buffer; contentType?: string }[];
  }
  interface SentMessageInfo { message: Buffer; rejected?: readonly string[]; }
  interface Transport { sendMail(options: SendMailOptions): Promise<SentMessageInfo>; }
  interface TransportOptions { streamTransport?: boolean; buffer?: boolean; newline?: "unix" | "windows"; host?: string; port?: number; secure?: boolean; auth?: { user: string; pass: string }; }
  function createTransport(options?: TransportOptions): Transport;
  export default { createTransport };
}
