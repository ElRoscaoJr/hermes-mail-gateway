declare module "nodemailer" {
  interface SendMailOptions {
    messageId?: string;
    from?: string;
    to?: string | readonly string[];
    subject?: string;
    text?: string;
    html?: string;
    raw?: Buffer;
    envelope?: { from?: string; to?: string | readonly string[] };
    attachments?: readonly { filename?: string; path?: string; contentType?: string }[];
  }
  interface SentMessageInfo { message: Buffer; rejected?: readonly string[]; }
  interface Transport { sendMail(options: SendMailOptions): Promise<SentMessageInfo>; }
  interface TransportOptions { streamTransport?: boolean; buffer?: boolean; newline?: "unix" | "windows"; host?: string; port?: number; secure?: boolean; auth?: { username: string; password: string }; }
  function createTransport(options?: TransportOptions): Transport;
  export default { createTransport };
}
