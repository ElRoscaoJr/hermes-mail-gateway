declare module "mailparser" {
  export interface ParsedMail { text?: string; html?: string | false; attachments: Array<{ filename?: string; contentType?: string; size?: number }>; }
  export function simpleParser(source: Buffer): Promise<ParsedMail>;
}
