declare module "mailparser" {
  export interface ParsedMail { text?: string; html?: string | false; headers?: Map<string, unknown>; attachments: Array<{ filename?: string; contentType?: string; size?: number; content: Buffer }>; }
  export function simpleParser(source: Buffer): Promise<ParsedMail>;
}
